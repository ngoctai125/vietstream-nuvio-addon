'use strict';

const { CONFIG, PROVIDERS } = require('./config');

// Catalog gộp theo MỤC PHIM (không theo nguồn).
// Item dùng IMDb ID để Nuvio lấy meta từ Cinemeta; stream sẽ hỏi mọi nguồn.
const CATALOG_DEFS = [];

const AGG_CATALOGS = [
  { type: 'movie', id: 'agg-hot-tuan', name: 'Phim hot tuần 🔥' },
  { type: 'movie', id: 'agg-4k', name: 'Phim 4K' },
  { type: 'movie', id: 'agg-phim-le', name: 'Phim lẻ' },
  { type: 'series', id: 'agg-phim-bo', name: 'Phim bộ' },
  { type: 'movie', id: 'agg-chieu-rap', name: 'Chiếu rạp' },
  { type: 'series', id: 'agg-hoat-hinh', name: 'Hoạt hình' },
  { type: 'series', id: 'agg-thuyet-minh', name: 'Thuyết Minh' },
  { type: 'series', id: 'agg-long-tieng', name: 'Lồng Tiếng' }
];

function enabledProviders() {
  return Object.values(PROVIDERS).filter((p) => p.enabled);
}

function buildManifest(baseUrl) {
  const on = enabledProviders();
  const prefixes = on.map((p) => p.prefix);

  const catalogs = AGG_CATALOGS.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [{ name: 'search' }, { name: 'skip' }]
  }));

  for (const provider of on) {
    for (const c of provider.catalogs || []) {
      catalogs.push({
        type: c.type,
        id: `${provider.id}-${c.id}`,
        name: c.name,
        extra: [{ name: 'search' }, { name: 'skip' }]
      });
    }
  }

  const names = on.map((p) => p.name).join(' · ');
  return {
    id: CONFIG.manifest.id,
    version: CONFIG.manifest.version,
    name: CONFIG.manifest.name,
    description: `${CONFIG.manifest.description}\nNguồn: ${names}`,
    logo: `${baseUrl}/logo.svg`,
    resources: [
      { name: 'catalog', types: ['movie', 'series'], idPrefixes: ['agg-'] },
      { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', ...prefixes] },
      { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', ...prefixes] },
      // Phụ đề Việt: giữ track gốc OpenSubtitles v3 + thêm track dịch bám timeline.
      { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
    ],
    types: ['movie', 'series'],
    catalogs,
    idPrefixes: ['tt', ...prefixes],
    behaviorHints: { configurable: false }
  };
}

module.exports = { buildManifest, CATALOG_DEFS, AGG_CATALOGS, enabledProviders };
