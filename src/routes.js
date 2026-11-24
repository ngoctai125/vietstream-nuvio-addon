'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { CONFIG, PROVIDERS } = require('./config');
const cinemeta = require('./cinemeta');
const { cached, getJson, getText, normTitle } = require('./utils');
const { router: hlsRouter, getBaseUrl, b64e } = require('./hls-proxy');
const { buildManifest, enabledProviders } = require('./manifest');
const aggregate = require('./aggregate');

// ---------- Khởi tạo provider ----------
const CTORS = {
  kkphim: 'KKphimProvider',
  ophim: 'OphimProvider',
  nguonc: 'NguoncProvider',
  vnstream: 'VnstreamProvider',
  phim4k: 'Phim4kProvider',
  tophim: 'TophimProvider',
  hdvnn: 'HdvnnProvider',
  k20: 'K20Provider',
  xem20: 'Xem20Provider'
};

const providers = {};
for (const cfg of enabledProviders()) {
  try {
    const mod = require(`./providers/${cfg.id}`);
    providers[cfg.id] = new mod[CTORS[cfg.id]](cfg);
  } catch (e) {
    console.warn(`[init] Không tải được nguồn ${cfg.id}:`, e.message);
  }
}

const ADSCAN_FILE = path.join(__dirname, '..', 'data', 'adscan.json');
let ADSCAN = { banUrls: [], warnUrls: {}, warnTitles: {} };
try { ADSCAN = JSON.parse(fs.readFileSync(ADSCAN_FILE, 'utf8')); } catch { /* chưa có kết quả quét */ }

function applyAdScan(list) {
  const out = [];
  for (const s of list) {
    const url = s.url || '';
    if ((ADSCAN.banUrls || []).includes(url)) continue;
    let note = (ADSCAN.warnUrls || {})[url];
    if (!note) {
      const t = normTitle(s.title || '');
      for (const [k, v] of Object.entries(ADSCAN.warnTitles || {})) {
        if (k && t.includes(k)) { note = v; break; }
      }
    }
    if (note) {
      s.title = '⚠️ watermark: ' + note + ' • ' + s.title;
      s._warn = true;
    }
    out.push(s);
  }
  return out.sort((a, b) => (a._warn ? 1 : 0) - (b._warn ? 1 : 0));
}

const router = express.Router();
router.use(hlsRouter);

// ---------- Helpers ----------

function parseId(id) {
  const parts = String(id).split(':').filter(Boolean);
  const head = parts[0] || '';
  if (/^tt\d+/.test(head)) {
    return { imdbId: head, season: parseInt(parts[1], 10) || 1, episode: parseInt(parts[2], 10) || 1 };
  }
  for (const p of Object.values(providers)) {
    if (head.startsWith(p.prefix)) {
      return { provider: p, slug: head.slice(p.prefix.length), season: parseInt(parts[1], 10) || 1, episode: parseInt(parts[2], 10) || 1 };
    }
  }
  return null;
}

// extra dạng "genre=Hành Động&skip=20" (phần path, có thể đuôi .json)
function parseExtra(str) {
  const extra = {};
  String(str || '')
    .replace(/\.json$/i, '')
    .split('&')
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx < 0) return;
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      if (['search', 'genre', 'skip'].includes(k)) extra[k] = v;
    });
  return extra;
}

function shouldProxy(providerId) {
  const cfg = PROVIDERS[providerId];
  if (!cfg || !cfg.proxy) return false;
  const list = CONFIG.proxyProviders;
  if (list.includes('none')) return false;
  return list.includes('*') || list.includes(providerId);
}

function wrapProxy(stream, baseUrl) {
  const pid = stream._providerId;
  if (stream.url && shouldProxy(pid)) {
    const h = (stream.behaviorHints && stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) || {};
    stream.url = `${baseUrl}/hls/manifest.m3u8?url=${b64e(stream.url)}&ref=${b64e(h.Referer || '')}&origin=${b64e(h.Origin || '')}`;
  }
  return stream;
}

function dedupe(streams) {
  const seen = new Set();
  return streams.filter((s) => {
    const k = s.url || s.externalUrl;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Routes ----------

router.get('/manifest.json', (req, res) => {
  res.json(buildManifest(getBaseUrl(req)));
});

router.get('/logo.svg', (req, res) => {
  res.type('image/svg+xml').send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff4d4d"/><stop offset="1" stop-color="#ffb347"/>
      </linearGradient></defs>
      <rect width="256" height="256" rx="52" fill="#12141c"/>
      <circle cx="128" cy="128" r="74" fill="url(#g)"/>
      <path d="M108 92 L172 128 L108 164 Z" fill="#12141c"/>
    </svg>`
  );
});

// ---------- Host plugin Nuvio trên chính server này ----------
// (tránh phụ thuộc raw.githubusercontent.com — hay bị chặn ở Việt Nam)
const PLUGIN_DIR = path.join(__dirname, '..', 'nuvio-plugin');

router.get('/nuvio-plugin/manifest.json', (req, res) => {
  const base = getBaseUrl(req);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8'));
    (m.scrapers || []).forEach((s) => {
      if (s.logo) s.logo = `${base}/nuvio-plugin/logo.svg`;
    });
    res.json(m);
  } catch (e) {
    res.status(500).json({ err: 'plugin manifest missing' });
  }
});

router.use('/nuvio-plugin', express.static(PLUGIN_DIR));

router.get('/', (req, res) => {
  const base = getBaseUrl(req);
  const rows = Object.values(providers)
    .map((p) => `<li><b>${p.name}</b> <code>${p.cfg.apiUrl}</code>${p.cfg.proxy ? ' (qua proxy)' : ''}</li>`)
    .join('');
  res.type('html').send(
    `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>VietStream Addon</title>
     <style>body{font-family:system-ui;background:#12141c;color:#eee;max-width:680px;margin:48px auto;padding:0 16px}
     a{color:#ffb347}code{background:#1e2230;padding:2px 6px;border-radius:6px}</style></head><body>
     <h1>🎬 VietStream — Addon phim Việt cho Nuvio / Stremio</h1>
     <p>Cài addon bằng manifest URL:</p>
     <p><code>${base}/manifest.json</code></p>
     <h3>Nguồn đang bật</h3><ul>${rows}</ul>
     <p>Nguồn khác (đã tắt hoặc chết sẽ tự bỏ qua, không ảnh hưởng addon).</p>
     </body></html>`
  );
});

// Lọc stream hỏng / chèn quảng cáo:
// - externalUrl dạng embed.php/embed/ (không phát được trên TV)
// - HLS trả JSON lỗi (vsmov "Thiếu signature")
// - HLS toàn segment .png (playlist giả của Phim4K)
const BAD_BODY_RE = /Thiếu signature|"error"\s*:|Could not resolve embed|Segment fetch failed/i;

// Đọc playlist/segment kèm HTTP status: 5xx hoặc timeout (status 0) đều là hỏng.
async function probeUrlText(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': CONFIG.userAgent, ...headers, Range: 'bytes=0-40000' },
      signal: ctrl.signal
    });
    return { status: res.status, txt: await res.text() };
  } catch {
    return { status: 0, txt: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function streamLooksBad(s) {
  if (!s.url) return {
    bad: !!(s.externalUrl && /embed\.php|\/embed\//i.test(s.externalUrl)),
    probeOk: false,
    latencyMs: Infinity
  };
  if (!/\.m3u8(\?|$)/i.test(s.url)) return { bad: false, probeOk: null, latencyMs: Infinity };
  return cached('bad:' + s.url, 5 * 60 * 1000, async () => {
    const h = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
    const t0 = Date.now();
    const { status, txt } = await probeUrlText(s.url, h);
    const latencyMs = Date.now() - t0;
    if (status >= 500 || !txt) return { bad: true, probeOk: false, latencyMs };
    if (BAD_BODY_RE.test(txt)) return { bad: true, probeOk: false, latencyMs };
    const segs = txt.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    if (segs.length >= 3) {
      const png = segs.filter((x) => /\.png(\?|$)/i.test(x)).length;
      if (png / segs.length > 0.8) return { bad: true, probeOk: false, latencyMs };
    }
    // Playlist dạng proxy-segment: thử thêm đoạn đầu; lỗi ở đây cũng là stream hỏng.
    if (/proxy-segment/i.test(txt) && segs.length) {
      let first = null;
      try { first = new URL(segs[0], s.url).href; } catch { /* bỏ qua segment lạ */ }
      if (first) {
        const seg = await probeUrlText(first, h);
        if (seg.status >= 500 || !seg.txt || BAD_BODY_RE.test(seg.txt)) {
          return { bad: true, probeOk: false, latencyMs };
        }
      }
    }
    return { bad: false, probeOk: status > 0 && status < 500, latencyMs };
  });
}

const BLOCKED_STREAM_PROVIDERS = new Set(
  String(process.env.STREAM_BLOCKLIST || 'phim4k').split(',').map((x) => x.trim()).filter(Boolean)
);

async function filterBadStreams(list) {
  const probes = await Promise.all(
    list.map((s) => {
      if (BLOCKED_STREAM_PROVIDERS.has(s._providerId)) return { bad: true, probeOk: false, latencyMs: Infinity };
      return streamLooksBad(s).catch(() => ({ bad: false, probeOk: false, latencyMs: Infinity }));
    })
  );
  const out = [];
  list.forEach((s, i) => {
    const r = probes[i] || {};
    if (r.bad) return;
    // Tag chỉ dùng để sort; để non-enumerable nên JSON /stream không đổi.
    Object.defineProperties(s, {
      _probeOk: { value: !!r.probeOk, enumerable: false, configurable: true, writable: true },
      _latencyMs: { value: Number.isFinite(r.latencyMs) ? r.latencyMs : Infinity, enumerable: false, configurable: true, writable: true }
    });
    out.push(s);
  });
  return out;
}

// Tìm item cùng IMDb trong 6 catalog agg (cache dùng chung với /catalog),
// rồi tới provider.search — nguồn title/year dự phòng khi Cinemeta thiếu.
async function imdbFallback(type, imdbId) {
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return null;
  const want = String(imdbId).toLowerCase();
  const kinds = Object.keys(aggregate.SRC || {});
  const agg = await Promise.allSettled(
    kinds.map((k) => cached('agg:' + k + ':' + type + ':|0', 10 * 60 * 1000, () => aggregate.listCatalog(k, {})))
  );
  for (const r of agg) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    const hit = r.value.find((m) => m && m.imdbId && String(m.imdbId).toLowerCase() === want);
    if (hit && (hit.name || hit.originalName)) return hit;
  }
  const searched = await Promise.allSettled(
    Object.values(providers).map((p) => Promise.resolve().then(() => p.search(imdbId)))
  );
  for (const r of searched) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    const hit = r.value.find((h) => h && h.imdbId && String(h.imdbId).toLowerCase() === want && (h.name || h.originalName));
    if (!hit) continue;
    return {
      imdbId,
      name: hit.name || hit.originalName,
      originalName: hit.originalName || hit.name,
      year: parseInt(hit.year, 10) || null,
      type,
      poster: hit.poster,
      background: hit.background || hit.poster,
      releaseInfo: hit.releaseInfo
    };
  }
  return null;
}

// /stream/movie/tt123.json hoặc /stream/series/tt123:1:2.json
router.get('/stream/:type/:id.json', async (req, res) => {
  const type = req.params.type === 'series' ? 'series' : 'movie';
  const parsed = parseId(req.params.id);
  const base = getBaseUrl(req);
  let streams = [];
  try {
    if (parsed && parsed.provider) {
      // ID có prefix nguồn (kk_..., nc_...) -> lấy trực tiếp, không cần Cinemeta
      streams = await parsed.provider.streamsFromSlug(parsed.slug, type, parsed.season, parsed.episode);
      streams = await filterBadStreams(streams);
      if (!streams.length) {
        try {
          const d = await parsed.provider.detail(parsed.slug);
          if (d && d.name) {
            const others = Object.values(providers).filter((p) => p.id !== parsed.provider.id);
            const results = await Promise.allSettled(
              others.map((p) => p.resolveStream({ title: d.name, year: d.year, type, season: parsed.season, episode: parsed.episode }))
            );
            for (const r of results) if (r.status === 'fulfilled' && Array.isArray(r.value)) streams.push(...r.value);
          }
        } catch { /* bỏ qua fallback */ }
      }
    } else if (parsed) {
      // IMDb ID -> Cinemeta trước; thiếu tên hoặc không ra stream thì lấy
      // title/year dự phòng từ 6 catalog agg / provider.search rồi vẫn gọi resolveStream.
      const meta = await cinemeta.getMeta(type, parsed.imdbId);
      const ask = async (name, year) => {
        const results = await Promise.allSettled(
          Object.values(providers).map((p) =>
            p.resolveStream({
              imdbId: parsed.imdbId,
              title: name,
              year,
              type,
              season: parsed.season,
              episode: parsed.episode
            })
          )
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) streams.push(...r.value);
        }
      };
      if (meta && meta.name) await ask(meta.name, meta.year);
      if (!streams.length) {
        const fb = await imdbFallback(type, parsed.imdbId);
        if (fb && (fb.name || fb.originalName)) await ask(fb.name || fb.originalName, fb.year);
        else if (!meta || !meta.name) await ask(parsed.imdbId, null);
      }
    }
  } catch (e) {
    console.warn('[stream] lỗi:', e.message);
  }
  streams = applyAdScan(streams);
  streams = dedupe(streams.map((s) => wrapProxy(s, base)));
  streams = await filterBadStreams(streams);
  const qrank = (x) => {
    const t = String((x.name || '') + ' ' + (x.title || ''));
    if (/4k|2160/i.test(t)) return 4;
    if (/1080|fhd/i.test(t)) return 3;
    if (/720/i.test(t)) return 2;
    if (/360|480/i.test(t)) return 1;
    return 0;
  };
  const latency = (x) => Number.isFinite(x._latencyMs) ? x._latencyMs : Number.MAX_SAFE_INTEGER;
  const probeRank = (x) => x._probeOk === false ? 2 : x._probeOk === true ? 0 : 1;
  streams.sort((a, b) =>
    probeRank(a) - probeRank(b) ||
    latency(a) - latency(b) ||
    qrank(b) - qrank(a)
  );
  res.json({ streams, cacheMaxAge: 600 });
});

// /catalog/movie/kkphim-phim-le.json và /catalog/movie/kkphim-phim-le/genre=X&skip=20.json
router.get('/catalog/:type/:id.json', (req, res, next) => {
  req._catalogId = req.params.id;
  req._extra = { ...req.query };
  next();
}, catalogSend);

router.get('/catalog/:type/:id/:extra', (req, res) => {
  req._catalogId = req.params.id;
  const fromPath = parseExtra(req.params.extra);
  req._extra = { ...req.query, ...fromPath };
  catalogSend(req, res);
});

async function catalogSend(req, res) {
  const type0 = req.params.type === 'series' ? 'series' : 'movie';
  const cid0 = String(req._catalogId || '').replace(/.json$/i, '');
  if (cid0.indexOf('agg-') === 0) {
    const aggKind = cid0.slice(4);
    const ex = req._extra || {};
    const aggKey = `agg:${aggKind}:${type0}:${ex.search || ''}|${ex.skip || 0}`;
    const aggMetas = await cached(aggKey, 10 * 60 * 1000, () => aggregate.listCatalog(aggKind, ex));
    const aggFiltered = (aggMetas || []).filter((m) => m && m.id).filter((m) => !m.type || m.type === type0);
    return res.json({ metas: aggFiltered, cacheMaxAge: 600 });
  }
  const type = req.params.type === 'series' ? 'series' : 'movie';
  const catalogId = String(req._catalogId || '').replace(/\.json$/i, '');
  const dash = catalogId.indexOf('-');
  const providerId = dash > 0 ? catalogId.slice(0, dash) : catalogId;
  const kind = dash > 0 ? catalogId.slice(dash + 1) : '';
  const p = providers[providerId];
  if (!p) return res.json({ metas: [] });

  const extra = req._extra || {};
  if (process.env.DEBUG) console.log('[catalog]', providerId, kind, JSON.stringify(extra));
  const key = `cat:${providerId}:${kind}:${type}:${extra.search || ''}|${extra.genre || ''}|${extra.skip || 0}`;
  const metas = await cached(key, 10 * 60 * 1000, () => p.listCatalog(kind, extra));
  const filtered = (metas || [])
    .filter((m) => m && m.id)
    .filter((m) => !m.type || m.type === type);
  if (process.env.DEBUG) console.log('[catalog] raw:', (metas || []).length, '-> filtered:', filtered.length);
  res.json({ metas: filtered, cacheMaxAge: 600 });
}

// /meta/series/kk_slug.json
router.get('/meta/:type/:id.json', async (req, res) => {
  const type = req.params.type === 'series' ? 'series' : 'movie';
  const parsed = parseId(req.params.id);
  if (!parsed) return res.status(404).json({ err: 'not found' });

  if (parsed.provider) {
    const d = await cached(`meta:${parsed.provider.id}:${parsed.slug}`, 30 * 60 * 1000, () =>
      parsed.provider.detail(parsed.slug)
    );
    if (!d) return res.status(404).json({ err: 'not found' });
    const meta = parsed.provider.buildMeta(d, { withVideos: true });
    if (meta) meta.type = type === 'series' || d.type === 'series' ? 'series' : 'movie';
    return res.json({ meta, cacheMaxAge: 1800 });
  }

  // IMDb ID -> trả nguyên meta Cinemeta (dùng khi app chưa có Cinemeta)
  const raw = await cached(`cinemetaRaw:${type}:${parsed.imdbId}`, 6 * 3600 * 1000, () =>
    getJson(`${CONFIG.cinemetaUrl}/meta/${type}/${parsed.imdbId}.json`)
  );
  if (raw && raw.meta) return res.json({ meta: raw.meta, cacheMaxAge: 1800 });
  // Dự phòng trước khi 404: item cùng IMDb trong 6 catalog agg / provider.search.
  const fb = await imdbFallback(type, parsed.imdbId);
  if (fb) {
    const meta = {
      id: parsed.imdbId,
      imdb_id: parsed.imdbId,
      type,
      name: fb.name || fb.originalName,
      poster: fb.poster,
      posterShape: 'poster',
      background: fb.background || fb.poster,
      releaseInfo: fb.releaseInfo,
      year: fb.year
    };
    return res.json({ meta, cacheMaxAge: 1800 });
  }
  res.status(404).json({ err: 'not found' });
});

module.exports = router;
