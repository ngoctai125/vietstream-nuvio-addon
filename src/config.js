'use strict';

// Cấu hình trung tâm — mọi giá trị đều có thể ghi đè bằng biến môi trường.

// Nạp .env cạnh repo (Node thuần, không thêm dependency). File .env không bị
// commit; biến đã có trong môi trường luôn thắng file.
function loadDotEnv() {
  // Test chạy với môi trường riêng; đừng để .env của máy làm đổi bộ provider.
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* thiếu quyền đọc thì bỏ qua */ }
}

loadDotEnv();

function csv(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : fallback;
}

const ENABLED_LIST = csv('PROVIDERS', null); // VD: PROVIDERS=kkphim,nguonc → chỉ bật 2 nguồn này

const PROVIDERS = {
  kkphim: {
    id: 'kkphim',
    name: 'KKphim',
    prefix: 'kk_',
    apiUrl: process.env.KKPHIM_API_URL || 'https://phimapi.com',
    cdnImage: process.env.KKPHIM_CDN_IMAGE || 'https://phimimg.com',
    referer: 'https://phimapi.com/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('kkphim') : true,
    proxy: false
  },
  ophim: {
    id: 'ophim',
    name: 'OPhim',
    prefix: 'op_',
    apiUrl: process.env.OPHIM_API_URL || 'https://www.ophim.live',
    cdnImage: process.env.OPHIM_CDN_IMAGE || 'https://img.ophim.live',
    siteUrl: process.env.OPHIM_SITE_URL || 'https://www.ophim.live',
    referer: 'https://www.ophim.live/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('ophim') : false,
    proxy: false
  },
  nguonc: {
    id: 'nguonc',
    name: 'NguonC',
    prefix: 'nc_',
    apiUrl: process.env.NGUONC_API_URL || 'https://phim.nguonc.com/api',
    apiFallbacks: ['https://nguonc.com/api'],
    siteUrl: 'https://phim.nguonc.com',
    referer: 'https://phim.nguonc.com/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('nguonc') : true,
    // Link StreamC của NguonC cần Referer → mặc định đi qua HLS proxy của addon
    proxy: true
  },
  vnstream: {
    id: 'vnstream',
    name: 'VnStream',
    prefix: 'vn_',
    apiUrl: process.env.VNSTREAM_API_URL || 'https://egluy2hhb21vaw5ndw9pbmhl.darkbytes.xyz/api/v1',
    siteUrl: process.env.VNSTREAM_SITE_URL || 'https://cobephim.biz',
    referer: 'https://cobephim.biz/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('vnstream') : false,
    proxy: false
  },
  phim4k: {
    id: 'phim4k',
    name: 'Phim4K',
    prefix: 'p4k_',
    apiUrl: process.env.PHIM4K_API_URL || 'https://vsmov.com/api',
    siteUrl: process.env.PHIM4K_SITE_URL || 'https://vsmov.com',
    referer: 'https://vsmov.com/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('phim4k') : true,
    proxy: false
  },
  tophim: {
    id: 'tophim',
    name: 'Tophim (Motchill)',
    prefix: 'tp_',
    apiUrl: process.env.TOPHIM_API_URL || 'https://tophim.top',
    referer: 'https://tophim.top/',
    // tophim.top chết DNS từ 23/11/2026 — tắt mặc định để không kéo dài thời gian tìm nguồn
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('tophim') : false,
    proxy: false
  },
  hdvnn: {
    id: 'hdvnn',
    name: 'HDVNN',
    prefix: 'hd_',
    apiUrl: process.env.HDVNN_SITE_URL || 'https://hdvnn.xyz',
    referer: 'https://hdvnn.xyz/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('hdvnn') : true,
    proxy: false
  },
  k20: {
    id: 'k20',
    name: 'K20',
    prefix: 'k20_',
    apiUrl: process.env.K20_API_URL || 'https://sc.k-20.xyz',
    referer: 'https://sc.k-20.xyz/',
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('k20') : true,
    proxy: false
  },
  torrentsdb: {
    id: 'torrentsdb',
    name: 'TorrentsDB 4K P2P',
    prefix: 'tdb_',
    apiUrl: process.env.TORRENTSDB_API_URL || 'https://torrentsdb.com',
    referer: `${process.env.TORRENTSDB_API_URL || 'https://torrentsdb.com'}/`,
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('torrentsdb') : true,
    proxy: false
  },
  torrentio: {
    id: 'torrentio',
    name: 'Torrentio 4K P2P',
    prefix: 'to_',
    apiUrl: process.env.TORRENTIO_API_URL || 'https://torrentio.strem.fun',
    referer: `${process.env.TORRENTIO_API_URL || 'https://torrentio.strem.fun'}/`,
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('torrentio') : true,
    proxy: false
  },
  comet: {
    id: 'comet',
    name: 'Comet 4K P2P',
    prefix: 'cm_',
    apiUrl: process.env.COMET_API_URL || 'https://comet.feels.legal',
    referer: `${process.env.COMET_API_URL || 'https://comet.feels.legal'}/`,
    enabled: ENABLED_LIST ? ENABLED_LIST.includes('comet') : true,
    proxy: false
  },
  xiaoya: {
    id: 'xiaoya',
    name: 'Xiaoya Alist',
    prefix: 'xy_',
    apiUrl: process.env.XIAOYA_API_URL || '',
    token: process.env.XIAOYA_TOKEN || '',
    username: process.env.XIAOYA_USERNAME || '',
    password: process.env.XIAOYA_PASSWORD || '',
    catalogs: [
      { id: '4k-remux', type: 'movie', name: 'Xiaoya 4K' },
      { id: '4k', type: 'movie', name: 'Xiaoya 4K' },
      { id: 'dolby', type: 'movie', name: 'Xiaoya Dolby Vision' }
    ],
    // Chỉ bật khi có Alist URL + tài khoản WebDAV do chính user cung cấp.
    // Token API là tùy chọn; username/password bắt buộc để đọc file .strm qua /dav.
    enabled: !!process.env.XIAOYA_API_URL &&
      !!(process.env.XIAOYA_USERNAME && process.env.XIAOYA_PASSWORD) &&
      (ENABLED_LIST ? ENABLED_LIST.includes('xiaoya') : true),
    proxy: false
  },
  xem20: {
    id: 'xem20',
    name: 'Xem20',
    prefix: 'x20_',
    apiUrl: process.env.XEM20_SITE_URL || 'https://xem20.net',
    referer: `${process.env.XEM20_SITE_URL || 'https://xem20.net'}/`,
    login: process.env.XEM20_LOGIN || '',
    password: process.env.XEM20_PASSWORD || '',
    enabled: !!(process.env.XEM20_LOGIN && process.env.XEM20_PASSWORD) &&
      (ENABLED_LIST ? ENABLED_LIST.includes('xem20') : true),
    proxy: false,
    authTimeout: parseInt(process.env.XEM20_AUTH_TIMEOUT, 10) || 12000,
    searchTimeout: parseInt(process.env.XEM20_SEARCH_TIMEOUT, 10) || 8000,
    detailTimeout: parseInt(process.env.XEM20_DETAIL_TIMEOUT, 10) || 10000,
    streamTimeout: parseInt(process.env.XEM20_STREAM_TIMEOUT, 10) || 12000
  },
  fshare: {
    id: 'fshare',
    name: 'Fshare',
    prefix: 'fs_',
    apiUrl: process.env.FSHARE_API_URL || 'https://api.fshare.vn',
    referer: 'https://www.fshare.vn/',
    email: process.env.FSHARE_EMAIL || '',
    password: process.env.FSHARE_PASSWORD || '',
    appKey: process.env.FSHARE_APP_KEY || 'dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt',
    // Fshare đã chặn UA Kodivietmediaf cũ; pyLoad vẫn được whitelist (đo 28/11/2026).
    userAgent: process.env.FSHARE_UA || 'pyLoad-B1RS5N',
    topUserAgent: process.env.FSHARE_TOP_UA || 'Vietmediaf /Kodi1.1.99-092019',
    enabled: !!(process.env.FSHARE_EMAIL && process.env.FSHARE_PASSWORD) &&
      (ENABLED_LIST ? ENABLED_LIST.includes('fshare') : true),
    proxy: false,
    timeout: parseInt(process.env.FSHARE_TIMEOUT, 10) || 12000,
    authTimeout: parseInt(process.env.FSHARE_AUTH_TIMEOUT, 10) || 12000,
    // Không đưa kho Fshare lên Home; giữ provider cho tương lai.
    catalogs: []
  },
  film4k: {
    id: 'film4k',
    name: 'Film4k',
    prefix: 'f4k_',
    apiUrl: process.env.FILM4K_API_URL || 'https://film4k.pl',
    cookie: process.env.FILM4K_COOKIE || '',
    referer: `${process.env.FILM4K_API_URL || 'https://film4k.pl'}/`,
    // Film4k chỉ trả HLS thật khi có phiên đăng nhập; khách nhận playlist quảng cáo.
    enabled: !!process.env.FILM4K_COOKIE && (ENABLED_LIST ? ENABLED_LIST.includes('film4k') : true),
    proxy: false,
    timeout: parseInt(process.env.FILM4K_TIMEOUT, 10) || 12000,
    catalogs: [
      { id: 'movies', type: 'movie', name: 'Film4k Phim lẻ' },
      { id: 'series', type: 'series', name: 'Film4k Phim bộ' },
      { id: '4k', type: 'movie', name: 'Film4k 4K' }
    ]
  }
};

const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 7001,
  timeout: parseInt(process.env.TIMEOUT, 10) || 8000,
  streamTimeout: parseInt(process.env.TIMEOUT_STREAM, 10) || 9000,
  cinemetaUrl: process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Danh sách nguồn được bọc qua HLS proxy của addon ("*" = tất cả, "none" = không nguồn nào)
  proxyProviders: csv('PROXY_PROVIDERS', ['nguonc']),
  manifest: {
    id: 'community.vietstream',
    version: process.env.VERSION || '1.7.0',
    name: 'VietStream · Phim Việt',
    description:
      'Xem phim Việt với 7 danh mục gộp: Phim 4K, Phim lẻ, Phim bộ, Chiếu rạp, Hoạt hình, Thuyết Minh, Lồng Tiếng. Tương thích Nuvio & Stremio.'
  }
};

module.exports = { CONFIG, PROVIDERS };
