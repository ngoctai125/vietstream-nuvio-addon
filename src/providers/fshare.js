'use strict';

// Fshare qua API chính thức (cùng luồng VietMediaF/Kodi): login lấy token +
// session_id, đọc danh sách folder "top follow", duyệt folder và lấy link tải
// trực tiếp. Chỉ bật khi có FSHARE_EMAIL/FSHARE_PASSWORD trong môi trường.

const BaseProvider = require('./base');
const { ProviderOutcome } = require('./base');
const { CONFIG, PROVIDERS } = require('../config');
const {
  getJson,
  getJsonOutcome,
  fetchBodyWithTimeout,
  cached,
  cachedOutcome,
  mapImageUrl,
  normalizeQuality,
  qualityFromText,
  detectAudio,
  parseEpNum
} = require('../utils');

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|wmv|mov|ts|m2ts|webm|flv|mpg|mpeg)$/i;
const FALLBACK_POSTER = 'https://i.imgur.com/8wyaJKv.png';
const KK_API = (PROVIDERS.kkphim && PROVIDERS.kkphim.apiUrl) || 'https://phimapi.com';

function cleanFolderName(name) {
  return String(name || '')
    .replace(/\.(mkv|mp4|avi|ts|m2ts)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchQuery(name) {
  return cleanFolderName(name)
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|4k|uhd|fhd|web-?dl|bluray|remux|x265|x264|h\.?26[45]|aac|dts|ddp?)\b/gi, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function folderIsSeries(name) {
  return /(phim\s*b[oộ]|tv\s*series|season|phần\s*\d+|tập\s*\d+|full\s*hd\s*-\s*tập)/i.test(String(name || ''));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function fileIsVideo(file) {
  return file && VIDEO_EXT.test(String(file.name || file.path || ''));
}

function fileSize(file) {
  const n = parseInt(file && file.size, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatSize(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

class FshareProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this._auth = null;
    this._authAt = 0;
  }

  get headers() {
    return {
      'User-Agent': this.cfg.userAgent,
      Accept: 'application/json, text/plain, */*',
      Referer: this.cfg.referer
    };
  }

  async postJson(url, payload, timeout, extraHeaders = {}) {
    return fetchBodyWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'User-Agent': this.cfg.userAgent,
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'cache-control': 'no-cache',
          ...extraHeaders
        },
        body: JSON.stringify(payload)
      },
      timeout || this.cfg.timeout,
      async (res) => {
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* body không phải JSON */ }
        if (!res.ok) {
          const error = new Error((json && (json.msg || json.error)) || `HTTP ${res.status}`);
          error.status = res.status;
          error.body = json;
          throw error;
        }
        return json;
      }
    );
  }

  async login() {
    if (this._auth && Date.now() - this._authAt < 30 * 60 * 1000) return this._auth;
    let data;
    try {
      data = await this.postJson(`${this.cfg.apiUrl}/api/user/login/`, {
        app_key: this.cfg.appKey,
        user_email: this.cfg.email,
        password: this.cfg.password
      }, this.cfg.authTimeout);
    } catch (error) {
      console.warn('[fshare] đăng nhập thất bại:', error.message);
      throw error;
    }
    if (!data || !data.token || !data.session_id) {
      const error = new Error((data && data.msg) || 'Fshare login failed');
      error.status = 401;
      throw error;
    }
    this._auth = { token: data.token, sessionId: data.session_id };
    this._authAt = Date.now();
    return this._auth;
  }

  async apiGet(path, { retry = true } = {}) {
    const auth = await this.login();
    const outcome = await getJsonOutcome(`${this.cfg.apiUrl}${path}`, {
      headers: { 'User-Agent': this.cfg.topUserAgent, Cookie: `session_id=${auth.sessionId}` },
      timeout: this.cfg.timeout
    });
    if (outcome.status === 'success') return outcome.value;
    if (retry && outcome.error && [401, 403].includes(outcome.error.status)) {
      this._auth = null;
      return this.apiGet(path, { retry: false });
    }
    throw outcome.error || new Error('Fshare request failed');
  }

  async apiPost(path, payload, { retry = true } = {}) {
    const auth = await this.login();
    const body = { token: auth.token, ...payload };
    const headers = {
      Cookie: `session_id=${auth.sessionId}`,
      'User-Agent': this.cfg.topUserAgent
    };
    try {
      return await this.postJson(`${this.cfg.apiUrl}${path}`, body, this.cfg.timeout, headers);
    } catch (error) {
      if (retry && [401, 403].includes(error.status)) {
        this._auth = null;
        return this.apiPost(path, payload, { retry: false });
      }
      throw error;
    }
  }

  async topFolders() {
    // Chỉ lấy folder công khai do cộng đồng upload/follow — không dùng kho
    // Fshare cá nhân của user (getListFollow/ListFavorite).
    return cached('fshare:folders:top', 10 * 60 * 1000, async () => {
      const data = await this.apiGet('/api/fileops/getTopFollowMovie');
      if (data && !Array.isArray(data) && data.code && data.code !== 200) {
        throw new Error(data.msg || 'Fshare top folders unavailable');
      }
      return asArray(data)
        .filter((item) => item && item.linkcode && item.name)
        .map((item) => ({ name: cleanFolderName(item.name), linkcode: String(item.linkcode) }));
    });
  }

  async folderFiles(linkcode) {
    return cached(`fshare:folder:${linkcode}`, 5 * 60 * 1000, async () => {
      const data = await this.apiPost('/api/fileops/getFolderList', {
        url: `https://www.fshare.vn/folder/${linkcode}`,
        dirOnly: 0,
        pageIndex: 0,
        limit: 200
      });
      if (data && !Array.isArray(data) && data.code && data.code !== 200) {
        throw new Error(data.msg || 'Fshare folder unavailable');
      }
      return asArray(data).filter((file) => file && file.linkcode && file.name);
    });
  }

  async getDownloadUrl(linkcode) {
    return cachedOutcome(`fshare:download:${linkcode}`, 30 * 60 * 1000, async () => {
      try {
        const data = await this.apiPost('/api/session/download', {
          url: `https://www.fshare.vn/file/${linkcode}`,
          password: ''
        }, { retry: false });
        if (!data || !data.location) {
          const error = new Error((data && (data.msg || data.error)) || 'Fshare download link missing');
          error.status = (data && data.code) || 502;
          return { status: 'failed', error };
        }
        return { status: 'success', value: data.location };
      } catch (error) {
        return { status: 'failed', error };
      }
    }, 60 * 1000);
  }

  async enrich(name) {
    const query = searchQuery(name);
    if (!query) return null;
    return cached(`fshare:enrich:${query.toLowerCase()}`, 6 * 60 * 60 * 1000, async () => {
      const json = await getJson(`${KK_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(query)}&page=1&limit=1`, { timeout: 5000 });
      const item = json && json.data && Array.isArray(json.data.items) ? json.data.items[0] : null;
      if (!item) return null;
      return {
        name: item.name || null,
        year: parseInt(item.year, 10) || null,
        poster: mapImageUrl(item.poster_url, 'https://phimimg.com') || null,
        background: mapImageUrl(item.thumb_url, 'https://phimimg.com') || null
      };
    });
  }

  async listCatalog(kind, extra = {}) {
    if (kind !== 'top') return [];
    const folders = (await this.topFolders().catch(() => null)) || [];
    const query = String(extra.search || '').trim().toLowerCase();
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    const page = folders
      .filter((folder) => !query || folder.name.toLowerCase().includes(query))
      .slice(skip, skip + 20);

    const metas = await Promise.all(page.map(async (folder) => {
      const info = await this.enrich(folder.name).catch(() => null);
      const quality = normalizeQuality(folder.name) || normalizeQuality(info && info.name);
      return {
        id: `${this.prefix}${folder.linkcode}`,
        type: 'series',
        name: folder.name,
        poster: (info && info.poster) || FALLBACK_POSTER,
        posterShape: 'poster',
        background: (info && info.background) || (info && info.poster) || FALLBACK_POSTER,
        releaseInfo: [quality || 'Fshare', 'Kho Fshare'].join(' · '),
        year: (info && info.year) || undefined
      };
    }));
    return metas.filter(Boolean);
  }

  async detail(slug) {
    const files = (await this.folderFiles(slug).catch(() => null)) || [];
    const videos = files.filter(fileIsVideo).sort((a, b) => {
      const ea = parseEpNum(a.name);
      const eb = parseEpNum(b.name);
      if (ea != null && eb != null && ea !== eb) return ea - eb;
      return String(a.name).localeCompare(String(b.name), 'vi');
    });
    if (!videos.length) return null;

    const top = await this.topFolders().catch(() => []);
    const folder = top.find((item) => item.linkcode === slug);
    const folderName = (folder && folder.name) || cleanFolderName(videos[0].name).replace(/\s+S\d+E\d+.*$/i, '') || `Fshare ${slug}`;
    const info = await this.enrich(folderName).catch(() => null);
    const quality = normalizeQuality(folderName) || qualityFromText(videos[0].name);

    return {
      slug,
      name: folderName,
      type: 'series',
      year: (info && info.year) || null,
      quality,
      poster: (info && info.poster) || FALLBACK_POSTER,
      background: (info && info.background) || (info && info.poster) || FALLBACK_POSTER,
      description: `Kho Fshare · ${videos.length} tệp video`,
      videos: videos.map((file, index) => ({
        id: `${this.prefix}${slug}:1:${index + 1}`,
        title: cleanFolderName(file.name) || `Tập ${index + 1}`,
        season: 1,
        episode: index + 1,
        released: new Date().toISOString()
      })),
      _files: videos
    };
  }

  async streamsFromSlug(slug, type, season, episode) {
    const detail = await this.detail(slug);
    if (!detail || !detail._files.length) return [];
    const files = detail._files;
    const index = type === 'movie' ? 0 : Math.max(0, (parseInt(episode, 10) || 1) - 1);
    const file = files[Math.min(index, files.length - 1)];
    if (!file) return [];

    const outcome = await this.getDownloadUrl(file.linkcode);
    if (outcome.status !== 'success' || !outcome.value) {
      throw outcome.error || new Error('Fshare link unavailable');
    }

    const quality = qualityFromText(file.name, detail.quality) || detail.quality;
    const size = fileSize(file);
    const stream = this.makeStream({
      movieName: file.name,
      epLabel: type === 'movie' ? 'Full' : `Tập ${index + 1}`,
      audio: detectAudio(file.name, 'Fshare'),
      quality,
      url: outcome.value,
      headers: {
        'User-Agent': this.cfg.userAgent,
        Referer: 'https://www.fshare.vn/'
      }
    });
    stream.title = [stream.title, formatSize(size)].filter(Boolean).join(' • ');
    stream.behaviorHints = {
      ...stream.behaviorHints,
      filename: file.name,
      videoSize: size ? Math.round(size) : undefined
    };
    return [stream];
  }

  // Không search được Fshare công khai; chỉ phục vụ id fs_ từ catalog.
  async search() {
    return [];
  }

  async resolveStreamWithOutcome() {
    return new ProviderOutcome('empty');
  }
}

module.exports = { FshareProvider, cleanFolderName, folderIsSeries, VIDEO_EXT, FALLBACK_POSTER };
