'use strict';

const { getJson, mapImageUrl, normTitle, cached } = require('./utils');
const { PROVIDERS, CONFIG } = require('./config');

// Catalog gộp theo MỤC PHIM, không theo nguồn.
// Chỉ lấy item có IMDb ID để Nuvio dùng Cinemeta làm meta,
// nhờ vậy một phim chỉ xuất hiện 1 lần và stream được hỏi từ mọi nguồn.

const KK = (PROVIDERS.kkphim && PROVIDERS.kkphim.apiUrl) || 'https://phimapi.com';
const VS = (PROVIDERS.phim4k && PROVIDERS.phim4k.apiUrl) || 'https://vsmov.com/api';

const SRC = {
  'phim-le': { type: 'movie', sources: [['kk', 'phim-le'], ['vs', 'phim-le']] },
  'phim-bo': { type: 'series', sources: [['kk', 'phim-bo'], ['vs', 'phim-bo']] },
  'chieu-rap': { type: 'movie', sources: [['kk', 'phim-chieu-rap']] },
  'hoat-hinh': { type: 'series', sources: [['kk', 'hoat-hinh']] },
  'thuyet-minh': { type: 'series', sources: [['vs', 'thuyet-minh']] },
  'long-tieng': { type: 'series', sources: [['vs', 'long-tieng']] }
};

function kkItem(it, type) {
  const imdb = it.imdb && it.imdb.id;
  if (!imdb) return null;
  return {
    imdbId: imdb,
    name: it.name,
    originalName: it.origin_name,
    year: parseInt(it.year, 10) || null,
    type,
    poster: mapImageUrl(it.poster_url, 'https://phimimg.com'),
    background: mapImageUrl(it.thumb_url, 'https://phimimg.com'),
    quality: it.quality || null,
    lang: it.lang || null,
    modified: it.modified && it.modified.time,
    sources: ['KKPhim']
  };
}

function vsItem(it, fallbackType, kind) {
  const imdb = it.imdb && it.imdb.id;
  if (!imdb) return null;
  const type = it.tmdb && it.tmdb.type === 'tv' ? 'series' : fallbackType;
  return {
    imdbId: imdb,
    name: it.name,
    originalName: it.origin_name,
    year: parseInt(it.year, 10) || null,
    type,
    poster: mapImageUrl(it.poster_url, null),
    background: mapImageUrl(it.thumb_url, null),
    quality: null,
    lang: kind === 'thuyet-minh' ? 'Thuyết Minh' : kind === 'long-tieng' ? 'Lồng Tiếng' : null,
    modified: it.modified && it.modified.time,
    sources: ['Phim4K']
  };
}

async function fetchKk(path, page) {
  const j = await getJson(`${KK}/v1/api/danh-sach/${path}?page=${page}&limit=20`, { timeout: 9000 });
  return ((j && j.data && j.data.items) || []);
}

async function fetchVs(path, page) {
  const j = await getJson(`${VS}/danh-sach/${path}?page=${page}&limit=20`, { timeout: 9000 });
  return ((j && j.items) || []);
}

async function searchKk(q) {
  const j = await getJson(`${KK}/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}&page=1&limit=20`, { timeout: 9000 });
  return ((j && j.data && j.data.items) || []);
}

async function searchVs(q) {
  const j = await getJson(`${VS}/tim-kiem?keyword=${encodeURIComponent(q)}&page=1`, { timeout: 9000 });
  return ((j && j.items) || []);
}

function merge(map, item) {
  if (!item || !item.imdbId) return;
  const key = String(item.imdbId).toLowerCase();
  const cur = map.get(key);
  if (!cur) { map.set(key, item); return; }
  if (!cur.quality && item.quality) cur.quality = item.quality;
  if (!cur.lang && item.lang) cur.lang = item.lang;
  if (!cur.poster && item.poster) cur.poster = item.poster;
  for (const s of item.sources || []) if (!cur.sources.includes(s)) cur.sources.push(s);
}

function rank(q) {
  if (/4k|2160/i.test(String(q || ''))) return 4;
  if (/fhd|1080/i.test(String(q || ''))) return 3;
  if (/hd|720/i.test(String(q || ''))) return 2;
  return 1;
}

function toMeta(it) {
  return {
    id: it.imdbId,
    type: it.type,
    name: it.name || it.originalName,
    poster: it.poster,
    posterShape: 'poster',
    background: it.background || it.poster,
    releaseInfo: [it.quality, it.lang, it.year].filter(Boolean).join(' · ') || undefined,
    year: it.year || undefined,
    imdbId: it.imdbId
  };
}

async function listCatalog(kind, extra = {}) {
  const def = SRC[kind];
  if (!def) return [];
  const page = Math.max(1, Math.floor((parseInt(extra.skip, 10) || 0) / 20) + 1);
  const metaMap = new Map();

  for (const [src, path] of def.sources) {
    try {
      const items = src === 'kk' ? await fetchKk(path, page) : await fetchVs(path, page);
      for (const it of items) {
        const norm = src === 'kk' ? kkItem(it, def.type) : vsItem(it, def.type, kind);
        if (norm && norm.type === def.type) merge(metaMap, norm);
      }
    } catch (e) {
      console.warn('[aggregate]', src, path, e.message);
    }
  }

  if (!metaMap.size && extra.search) {
    const q = String(extra.search);
    const [a, b] = await Promise.allSettled([searchKk(q), searchVs(q)]);
    if (a.status === 'fulfilled') for (const it of a.value) merge(metaMap, kkItem(it, def.type));
    if (b.status === 'fulfilled') for (const it of b.value) merge(metaMap, vsItem(it, def.type, kind));
  }

  return Array.from(metaMap.values())
    .filter((it) => it.type === def.type)
    .sort((a, b) => rank(b.quality) - rank(a.quality) || (b.year || 0) - (a.year || 0))
    .slice(0, 20)
    .map(toMeta);
}

module.exports = { listCatalog, SRC };
