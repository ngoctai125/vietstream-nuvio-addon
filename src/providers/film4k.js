'use strict';

// Film4k.pl — catalog công khai cập nhật liên tục, HLS phát trực tiếp.
// API không cần đăng nhập: /api/home, /api/title, /api/watch, /api/search/suggest.

const BaseProvider = require('./base');
const { ProviderOutcome } = require('./base');
const { CONFIG } = require('../config');
const { getJson, cached, normalizeQuality, qualityFromText, detectAudio, parseEpNum } = require('../utils');

const PAGE_SIZE = 24;

class Film4kProvider extends BaseProvider {
  get headers() {
    return {
      'User-Agent': CONFIG.userAgent,
      Accept: 'application/json, text/plain, */*',
      Referer: `${this.cfg.apiUrl}/`,
      ...(this.cfg.cookie ? { Cookie: this.cfg.cookie } : {})
    };
  }

  async api(path) {
    return getJson(`${this.cfg.apiUrl}${path}`, { headers: this.headers, timeout: this.cfg.timeout });
  }

  homePage(page) {
    return cached(`film4k:home:${page}`, 10 * 60 * 1000, async () => {
      const data = await this.api(`/api/home?page=${page}`);
      return data && Array.isArray(data.list) ? data.list : [];
    });
  }

  itemType(item) {
    return item && (item.mediaType === 'tv' || item.mediaType === 'series') ? 'series' : 'movie';
  }

  is4k(item) {
    return /2160|4k/i.test(String(item && item.maxRes || '')) || (parseInt(item && item.maxHeight, 10) || 0) >= 2160;
  }

  toMeta(item) {
    const title = item.title || {};
    const poster = item.poster || {};
    return {
      id: `${this.prefix}${item.slug}`,
      type: this.itemType(item),
      name: title.vi || title.en || item.slug,
      poster: poster.vi || poster.en || item.backdrop || undefined,
      posterShape: 'poster',
      background: item.backdrop || poster.vi || poster.en || undefined,
      releaseInfo: [normalizeQuality(item.maxRes), item.year].filter(Boolean).join(' · ') || undefined,
      year: parseInt(item.year, 10) || undefined
    };
  }

  async listCatalog(kind, extra = {}) {
    const wanted = kind === 'series' ? 'series' : 'movie';
    const query = String(extra.search || '').trim();
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    const want4k = kind === '4k';

    if (query) {
      const data = await this.api(`/api/search/suggest?q=${encodeURIComponent(query)}`);
      const list = data && Array.isArray(data.list) ? data.list : [];
      return list
        .filter((item) => this.itemType(item) === wanted)
        .map((item) => this.toMeta(item));
    }

    const collected = [];
    const seen = new Set();
    const startPage = Math.floor(skip / PAGE_SIZE) + 1;
    for (let page = startPage; page < startPage + 12 && collected.length < skip + 20; page++) {
      const list = await this.homePage(page);
      if (!list.length) break;
      for (const item of list) {
        if (!item || !item.slug || seen.has(item.slug)) continue;
        if (this.itemType(item) !== wanted) continue;
        if (want4k && !this.is4k(item)) continue;
        seen.add(item.slug);
        collected.push(item);
      }
    }
    return collected.slice(skip, skip + 20).map((item) => this.toMeta(item));
  }

  async detail(slug) {
    const data = await cached(`film4k:title:${slug}`, 10 * 60 * 1000, () => this.api(`/api/title/${encodeURIComponent(slug)}`));
    if (!data || !data.movie) return null;
    const movie = data.movie;
    const title = movie.title || {};
    const poster = movie.poster || {};
    const type = this.itemType(movie);
    const detail = {
      slug,
      name: title.vi || title.en || slug,
      originalName: title.en || title.vi,
      type,
      year: parseInt(movie.year, 10) || null,
      quality: normalizeQuality(movie.maxRes),
      poster: poster.vi || poster.en || movie.backdrop || undefined,
      background: movie.backdrop || poster.vi || poster.en || undefined,
      description: (movie.overview && (movie.overview.vi || movie.overview.en)) || '',
      genres: (movie.genres && (movie.genres.vi || movie.genres.en)) || undefined,
      score: movie.score || undefined
    };
    if (type === 'series') {
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      detail.videos = episodes
        .sort((a, b) => (a.season || 1) - (b.season || 1) || (a.episode || 0) - (b.episode || 0))
        .map((ep) => ({
          id: `${this.prefix}${slug}:${ep.season || 1}:${ep.episode || 1}`,
          title: ep.title || `Tập ${ep.episode || 1}`,
          season: ep.season || 1,
          episode: ep.episode || 1,
          released: ep.airDate || new Date().toISOString()
        }));
    }
    return detail;
  }

  async streamsFromSlug(slug, type, season, episode) {
    const titleData = await cached(`film4k:title:${slug}`, 10 * 60 * 1000, () => this.api(`/api/title/${encodeURIComponent(slug)}`));
    if (!titleData || !titleData.movie) return [];
    const movie = titleData.movie;
    const quality = normalizeQuality(movie.maxRes) || 'HD';
    let sources = [];
    let epLabel = 'Full';

    if (type === 'series') {
      const episodes = Array.isArray(titleData.episodes) ? titleData.episodes : [];
      const wantedSeason = parseInt(season, 10) || 1;
      const wantedEpisode = parseInt(episode, 10) || 1;
      const ep = episodes.find((item) =>
        (item.season || 1) === wantedSeason && (item.episode || 1) === wantedEpisode
      );
      if (!ep || !Array.isArray(ep.sources)) return [];
      sources = ep.sources;
      epLabel = ep.title || `Tập ${wantedEpisode}`;
    } else {
      const watch = await cached(`film4k:watch:${slug}`, 5 * 60 * 1000, () => this.api(`/api/watch/${encodeURIComponent(slug)}`));
      if (watch && Array.isArray(watch.sources)) sources = watch.sources;
      else if (movie.hlsUrl) sources = [{ url: movie.hlsUrl, label: 'Server 1' }];
    }

    const streams = [];
    for (const source of sources) {
      const url = source && source.url;
      if (!url || !/^\/?(api\/hls|https?:)/i.test(url)) continue;
      const absolute = /^https?:/i.test(url) ? url : `${this.cfg.apiUrl}${url.startsWith('/') ? '' : '/'}${url}`;
      streams.push(this.makeStream({
        movieName: (movie.title && (movie.title.vi || movie.title.en)) || slug,
        epLabel,
        audio: detectAudio(`${epLabel} ${movie.title && movie.title.vi || ''}`, 'Vietsub'),
        quality: qualityFromText(absolute, quality) || quality,
        url: absolute,
        headers: {
          'User-Agent': CONFIG.userAgent,
          Referer: `${this.cfg.apiUrl}/`,
          ...(this.cfg.cookie ? { Cookie: this.cfg.cookie } : {})
        }
      }));
    }
    return streams;
  }

  async searchOutcome(query) {
    try {
      const data = await this.api(`/api/search/suggest?q=${encodeURIComponent(query)}`);
      const list = data && Array.isArray(data.list) ? data.list : [];
      const mapped = list.map((item) => ({
        ...this.toMeta(item),
        slug: item.slug,
        name: (item.title && (item.title.vi || item.title.en)) || item.slug,
        originalName: item.title && (item.title.en || item.title.vi),
        year: parseInt(item.year, 10) || null
      }));
      return new ProviderOutcome(mapped.length ? 'ok' : 'empty', mapped);
    } catch (error) {
      return new ProviderOutcome('failed', [], error);
    }
  }

  async search(query) {
    return (await this.searchOutcome(query)).streams;
  }

  async resolveStreamWithOutcome() {
    return new ProviderOutcome('empty');
  }
}

module.exports = { Film4kProvider };
