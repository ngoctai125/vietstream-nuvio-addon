'use strict';

const { getJson, mapImageUrl, normTitle, cached, normalizeQuality, qualityRank } = require('./utils');
const { PROVIDERS, CONFIG } = require('./config');
const TOP_4K = require('./data/top-4k.json');

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

function resolveItemType(item, fallbackType) {
  if (item.tmdb && item.tmdb.type === 'tv') return 'series';
  if (item.tmdb && item.tmdb.type === 'movie') return 'movie';
  if (['series', 'hoathinh', 'tvshows', 'tv'].includes(item.type)) return 'series';
  if (['single', 'movie'].includes(item.type)) return 'movie';
  return fallbackType;
}

function kkItem(it, type) {
  const imdb = it.imdb && it.imdb.id;
  if (!imdb) return null;
  return {
    imdbId: imdb,
    name: it.name,
    originalName: it.origin_name,
    year: parseInt(it.year, 10) || null,
    type: resolveItemType(it, type),
    poster: mapImageUrl(it.poster_url, 'https://phimimg.com'),
    background: mapImageUrl(it.thumb_url, 'https://phimimg.com'),
    quality: normalizeQuality(it.quality),
    lang: it.lang || null,
    modified: it.modified && it.modified.time,
    sources: ['KKPhim']
  };
}

function vsItem(it, fallbackType, kind, strictAudio = false) {
  const imdb = it.imdb && it.imdb.id;
  if (!imdb) return null;
  const type = resolveItemType(it, fallbackType);
  const categoryAudio = kind === 'thuyet-minh' ? 'Thuyết Minh' : kind === 'long-tieng' ? 'Lồng Tiếng' : null;
  const lang = it.lang || (!strictAudio ? categoryAudio : null);
  if (strictAudio && categoryAudio && !normTitle(lang).includes(normTitle(categoryAudio))) return null;
  return {
    imdbId: imdb,
    name: it.name,
    originalName: it.origin_name,
    year: parseInt(it.year, 10) || null,
    type,
    poster: mapImageUrl(it.poster_url, null),
    background: mapImageUrl(it.thumb_url, null),
    quality: normalizeQuality(it.quality),
    lang,
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
  if (qualityRank(item.quality) > qualityRank(cur.quality)) cur.quality = item.quality;
  if (!cur.lang && item.lang) cur.lang = item.lang;
  if (!cur.poster && item.poster) cur.poster = item.poster;
  for (const s of item.sources || []) if (!cur.sources.includes(s)) cur.sources.push(s);
}

function toMeta(it) {
  return {
    id: it.imdbId,
    type: it.type,
    name: it.name || it.originalName,
    poster: it.poster,
    posterShape: 'poster',
    background: it.background || it.poster,
    releaseInfo: [normalizeQuality(it.quality), it.lang, it.year].filter(Boolean).join(' · ') || undefined,
    year: it.year || undefined,
    imdbId: it.imdbId
  };
}

async function listCatalog(kind, extra = {}) {
  // Danh mục 4K kiểm chứng sẵn: Cinemeta top đối chiếu Torrentio 2160p
  // (tools/build-4k-catalog.js). Không lấy quality từ listing Việt vì các
  // nguồn đó chỉ ghi FHD.
  if (kind === '4k') {
    const query = normTitle(extra.search || '');
    const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
    return (TOP_4K.items || [])
      .filter((item) => !query || normTitle(item.name).includes(query))
      .slice(skip, skip + 20)
      .map((item) => ({
        id: item.imdbId,
        type: 'movie',
        name: item.name,
        poster: item.poster || undefined,
        posterShape: 'poster',
        background: item.background || item.poster || undefined,
        releaseInfo: ['4K', item.year].filter(Boolean).join(' · '),
        year: item.year || undefined,
        imdbId: item.imdbId
      }));
  }
  const def = SRC[kind];
  if (!def) return [];
  const page = Math.max(1, Math.floor((parseInt(extra.skip, 10) || 0) / 20) + 1);
  const metaMap = new Map();

  if (extra.search) {
    const q = String(extra.search);
    const results = await Promise.allSettled(def.sources.map(async ([src]) => {
      const items = src === 'kk' ? await searchKk(q) : await searchVs(q);
      return items
        .map((it) => src === 'kk' ? kkItem(it, def.type) : vsItem(it, def.type, kind, true))
        .filter(Boolean);
    }));
    results.forEach((result, index) => {
      const src = def.sources[index][0];
      if (result.status === 'fulfilled') {
        for (const item of result.value) if (item.type === def.type) merge(metaMap, item);
      } else {
        console.warn('[aggregate]', src, 'search', result.reason && result.reason.message);
      }
    });
  } else {
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
  }

  return Array.from(metaMap.values())
    .filter((it) => it.type === def.type)
    .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality) || (b.year || 0) - (a.year || 0))
    .slice(0, 20)
    .map(toMeta);
}

module.exports = { listCatalog, SRC };
