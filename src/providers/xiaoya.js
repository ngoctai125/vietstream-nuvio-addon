'use strict';

const BaseProvider = require('./base');
const { CONFIG } = require('../config');
const { cachedOutcome, fetchBodyWithTimeout, getText, normTitle, qualityFromText } = require('../utils');
const { ProviderOutcome } = require('./base');

const PAGE_SIZE = 200;
const SEARCH_DEADLINE_MS = 5000;

// Đường dẫn thư mục Alist/Xiaoya được xác nhận từ stremio-xiaoya-alist:
// https://github.com/Keglr/stremio-xiaoya-alist/blob/main/lib/manifest.js
const CATALOG_PATHS = {
  '4k-remux': '/strm/电影/4K REMUX',
  '4k': '/strm/电影/4K系列',
  dolby: '/strm/电影/杜比视界'
};

const CATALOG_QUALITY = {
  '4k-remux': 'Xiaoya 4K',
  '4k': 'Xiaoya 4K',
  dolby: 'Xiaoya Dolby Vision'
};

function encodeSlug(path) {
  return Buffer.from(String(path || ''), 'utf8').toString('base64url');
}

function decodeSlug(slug) {
  if (typeof slug !== 'string' || !slug || /[\\\0]|%2f|%5c/i.test(slug)) return null;
  let value;
  try {
    value = Buffer.from(slug, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (/[\\\0]|%2f|%5c/i.test(value)) return null;
  if (!Object.values(CATALOG_PATHS).some((root) => value === root || value.startsWith(`${root}/`))) return null;
  if (encodeSlug(value) !== slug) return null;
  const segments = value.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return value;
}

function validateCatalogPath(path) {
  return typeof path === 'string' && !/[\\\0]|%2f|%5c/i.test(path) && decodeSlug(encodeSlug(path)) === path;
}

function cleanName(name) {
  return String(name || '')
    .replace(/\.(strm|mkv|mp4|m2ts|ts|mov|avi)$/i, '')
    .trim();
}

function encodePath(path) {
  return String(path || '').split('/').map(encodeURIComponent).join('/');
}

class XiaoyaProvider extends BaseProvider {
  get headers() {
    const headers = {
      'User-Agent': CONFIG.userAgent,
      Accept: 'application/json, text/plain, */*'
    };
    if (this._token) headers.Authorization = this._token;
    return headers;
  }

  get basicAuth() {
    if (!this.cfg.username || !this.cfg.password) return null;
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}`;
  }

  async ensureAuth(force = false) {
    if (!force && this.cfg.token) {
      this._token = this.cfg.token;
      return this._token;
    }
    if (!force && this._token && Date.now() < this._tokenExpiresAt) return this._token;
    if (this.authPromise) return this.authPromise;

    this.authPromise = (async () => {
      if (!this.cfg.username || !this.cfg.password) throw new Error('Xiaoya cần username/password để đăng nhập lại');
      this._token = null;
      const response = await fetchBodyWithTimeout(
        `${this.cfg.apiUrl}/api/auth/login`,
        {
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password })
        },
        CONFIG.timeout,
        async (res) => {
          if (!res.ok) {
            const error = new Error(`Xiaoya login HTTP ${res.status}`);
            error.status = res.status;
            throw error;
          }
          return res.json();
        }
      );
      if (response && response.code !== undefined && response.code !== 200) {
        throw new Error(`Xiaoya login error ${response.code}: ${response.message || ''}`);
      }
      const token = response && response.data && response.data.token;
      if (!token) throw new Error('Xiaoya login returned no token');
      this._token = token;
      const ttlSeconds = parseInt(response.data.tokenExpire, 10) || 23 * 60 * 60;
      this._tokenExpiresAt = Date.now() + Math.max(60, ttlSeconds - 300) * 1000;
      return token;
    })().finally(() => { this.authPromise = null; });

    return this.authPromise;
  }

  async postJson(url, body, signal) {
    await this.ensureAuth();
    const send = () => fetchBodyWithTimeout(url, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }, CONFIG.timeout, async (res) => {
      if (!res.ok) {
        const error = new Error(`Xiaoya HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    });
    try {
      return await send();
    } catch (error) {
      if (!error || error.status !== 401) throw error;
      // Token tĩnh không được giữ lại sau 401; đăng nhập lại bằng credential hiện có.
      await this.ensureAuth(true);
      return send();
    }
  }

  async fsListPage(path, page = 1, signal) {
    if (!validateCatalogPath(path)) throw new Error('Xiaoya path nằm ngoài catalog');
    const data = await this.postJson(`${this.cfg.apiUrl}/api/fs/list`, {
      path,
      page,
      per_page: PAGE_SIZE,
      refresh: false
    }, signal);
    if (data && data.code !== undefined && data.code !== 200) {
      throw new Error(`Xiaoya list error ${data.code}: ${data.message || ''}`);
    }
    if (!data || !Array.isArray(data.data && data.data.content)) throw new Error('Xiaoya list malformed');
    const total = parseInt(data.data.total, 10) || 0;
    if (!this._pageTotals) this._pageTotals = new Map();
    this._pageTotals.set(`${path}:${page}`, total);
    return { items: data.data.content, total };
  }

  async fsList(path) {
    return (await this.fsListPage(path)).items;
  }

  async readStrmUrl(path, signal) {
    const auth = this.basicAuth;
    if (!auth) return null;
    const text = await getText(`${this.cfg.apiUrl}/dav${encodePath(path)}`, {
      headers: { Authorization: auth },
      timeout: CONFIG.streamTimeout,
      signal
    });
    if (!text) return null;
    for (const line of String(text).split(/\r?\n/)) {
      const url = line.split('#')[0].trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    return null;
  }

  async fsGet(path, signal) {
    if (!validateCatalogPath(path)) throw new Error('Xiaoya path nằm ngoài catalog');
    if (/\.strm$/i.test(path)) return this.readStrmUrl(path, signal);
    const data = await this.postJson(`${this.cfg.apiUrl}/api/fs/get`, { path, password: '' }, signal);
    if (data && data.code !== undefined && data.code !== 200) return null;
    return (data && data.data && (data.data.raw_url || data.data.url)) || null;
  }

  toMeta(item, kind, path) {
    if (!item || item.is_dir) return null;
    const name = cleanName(item.name);
    if (!name) return null;
    const year = name.match(/\b(19|20)\d{2}\b/);
    const slug = encodeSlug(`${path}/${item.name}`);
    return {
      id: `${this.prefix}${slug}`,
      slug,
      type: 'movie',
      name,
      poster: /^https?:\/\//i.test(item.thumb || '') ? item.thumb : undefined,
      posterShape: 'poster',
      background: /^https?:\/\//i.test(item.thumb || '') ? item.thumb : undefined,
      description: '',
      releaseInfo: [CATALOG_QUALITY[kind], year && year[0]].filter(Boolean).join(' · '),
      year: year ? parseInt(year[0], 10) : undefined,
      imdbId: item.imdbId
    };
  }

  async listCatalogPage(kind, page, signal) {
    const path = CATALOG_PATHS[kind];
    if (!path) return { status: 'empty', value: [] };
    const outcome = await cachedOutcome(`xy:list:${this.cfg.apiUrl}:${kind}:${page}`, 10 * 60 * 1000, async () => {
      const data = await this.fsListPage(path, page, signal);
      return { status: 'success', value: data.items.map((item) => this.toMeta(item, kind, path)).filter(Boolean) };
    });
    return outcome.status === 'success'
      ? { status: outcome.value.length ? 'ok' : 'empty', value: outcome.value }
      : outcome;
  }

  async listCatalog(kind, extra = {}) {
    const page = Math.max(1, Math.floor((parseInt(extra.skip, 10) || 0) / PAGE_SIZE) + 1);
    const result = await this.listCatalogPage(kind, page);
    if (extra.search) return this.search(extra.search, { kind, signal: extra.signal });
    return result.value || [];
  }

  async searchResult(q, opts = {}) {
    if (!q) return [];
    const query = normTitle(q);
    const deadline = Date.now() + (parseInt(opts.timeout, 10) || SEARCH_DEADLINE_MS);
    const kinds = opts.kind ? [opts.kind] : Object.keys(CATALOG_PATHS);
    const matched = [];
    let empty = true;
    const errors = [];
    for (const kind of kinds) {
      for (let page = 1; Date.now() < deadline; page++) {
        const controller = new AbortController();
        const signal = opts.signal || controller.signal;
        const abortFromCaller = () => controller.abort();
        const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        if (opts.signal && opts.signal.aborted) controller.abort();
        if (opts.signal) opts.signal.addEventListener('abort', abortFromCaller, { once: true });
        try {
          const result = await this.listCatalogPage(kind, page, signal);
          if (!['ok', 'empty'].includes(result.status)) errors.push(result.status);
          const items = result.value || [];
          if (items.length) empty = false;
          matched.push(...items.filter((meta) => normTitle(meta.name).includes(query)));
          const total = await this.catalogPageTotal(kind, page);
          const knownTotal = total > 0;
          if (items.length < PAGE_SIZE || (knownTotal && total <= page * PAGE_SIZE)) break;
        } catch (error) {
          errors.push(error && error.name === 'AbortError' ? 'timeout' : 'failed');
          break;
        } finally {
          clearTimeout(timer);
          if (opts.signal) opts.signal.removeEventListener('abort', abortFromCaller);
        }
      }
    }
    const status = matched.length || (!empty && !errors.length)
      ? 'ok'
      : errors.includes('failed') ? 'failed' : errors.includes('timeout') ? 'timeout' : errors.length ? 'unknown' : 'empty';
    return { status, value: matched };
  }

  async search(q, opts = {}) {
    if (!q) return [];
    return (await this.searchResult(q, opts)).value;
  }

  async searchOutcome(q, opts = {}) {
    try {
      const result = await this.searchResult(q, opts);
      return new ProviderOutcome(result.status, result.value);
    } catch (error) {
      return new ProviderOutcome(require('../utils').classifyFetchError(error), [], error);
    }
  }

  async catalogPageTotal(kind, page) {
    const path = CATALOG_PATHS[kind];
    if (!path || !this._pageTotals) return 0;
    return this._pageTotals.get(`${path}:${page}`) || 0;
  }

  async detail(slug) {
    const path = decodeSlug(slug);
    if (!path) return null;
    const rawUrl = await this.fsGet(path);
    if (!rawUrl) return null;
    const name = cleanName(path.split('/').pop());
    const kind = Object.keys(CATALOG_PATHS).find((key) => CATALOG_PATHS[key] === path.slice(0, path.lastIndexOf('/')));
    const year = name.match(/\b(19|20)\d{2}\b/);
    const servers = [{
      serverName: 'Xiaoya',
      items: [{ name: 'Full', slug, filename: name, m3u8: rawUrl }]
    }];
    return {
      slug,
      name,
      originalName: name,
      year: year ? parseInt(year[0], 10) : null,
      type: 'movie',
      quality: CATALOG_QUALITY[kind] || '',
      lang: '',
      description: '',
      poster: undefined,
      background: undefined,
      servers,
      videos: this.videosFromServers(servers, `${this.prefix}${slug}`)
    };
  }

  async streamsFromSlug(slug) {
    const detail = await this.detail(slug);
    if (!detail) return [];
    const episode = detail.servers[0] && detail.servers[0].items && detail.servers[0].items[0];
    if (!episode) return [];
    const source = await this.extractStreamItem(episode);
    if (!source) return [];
    return [this.makeStream({
      movieName: detail.name,
      epLabel: 'Full',
      audio: 'Original',
      quality: qualityFromText(episode.filename || episode.name, detail.quality),
      url: source.url,
      externalUrl: source.externalUrl,
      // URL từ .strm/raw_url đã là direct link; không đưa Authorization vào
      // stream metadata vì /stream trả object này cho client công khai.
      headers: { 'User-Agent': CONFIG.userAgent }
    })];
  }
  async resolveStreamWithOutcome(args = {}) {
    try {
      const hits = await this.searchOutcome(args.title);
      if (!['ok', 'empty'].includes(hits.status)) return new ProviderOutcome(hits.status, [], hits.error);
      const candidates = this.matchCandidates(hits.streams, args).slice(0, 3);
      for (const candidate of candidates) {
        try {
          const streams = await this.streamsFromSlug(candidate.slug, args.type, args.season, args.episode);
          if (streams.length) return new ProviderOutcome('ok', streams);
        } catch (error) {
          const status = require('../utils').classifyFetchError(error);
          if (status !== 'unknown') return new ProviderOutcome(status, [], error);
        }
      }
      return new ProviderOutcome(candidates.length ? 'unknown' : 'empty');
    } catch (error) {
      return new ProviderOutcome(require('../utils').classifyFetchError(error), [], error);
    }
  }
}

module.exports = {
  XiaoyaProvider,
  CATALOG_PATHS,
  encodeSlug,
  decodeSlug,
  validateCatalogPath
};
