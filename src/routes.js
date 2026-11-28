'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { CONFIG, PROVIDERS } = require('./config');
const cinemeta = require('./cinemeta');
const { cached, cachedOutcome, getJson, getText, normTitle, qualityRank, qualityFromHlsText, parseHlsVariants, isFakeImagePlaylist, normalizeQuality, classifyFetchError, isHdrOrTenBit } = require('./utils');
const { router: hlsRouter, getBaseUrl, b64e } = require('./hls-proxy');
const subtitles = require('./subtitles');
const TOP_4K = require('./data/top-4k.json');
const { buildManifest, enabledProviders } = require('./manifest');
const aggregate = require('./aggregate');
const { recordStreamQuality, overlayStreamQuality } = require('./stream-quality');

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
  xem20: 'Xem20Provider',
  fshare: 'FshareProvider',
  film4k: 'Film4kProvider',
  xiaoya: 'XiaoyaProvider',
  comet: 'CometProvider',
  torrentio: 'TorrentioProvider',
  torrentsdb: 'TorrentsDBProvider'
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

// ---------- Phụ đề Việt ----------
// Danh sách phụ đề của một phim/tập: giữ track gốc từ OpenSubtitles v3 và thêm track
// tiếng Việt (dịch bám timeline) khi nguồn không có bản Việt.
router.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json'], async (req, res) => {
  const type = req.params.type === 'series' ? 'series' : 'movie';
  const id = String(req.params.id || '');
  const extra = String(req.params.extra || '');
  try {
    const subs = await subtitles.listSubtitles(type, id, extra, getBaseUrl(req));
    res.json({ subtitles: subs, cacheMaxAge: 1800 });
  } catch (e) {
    console.warn('[subtitles] lỗi:', e.message);
    res.json({ subtitles: [] });
  }
});

// File .srt đã dịch; key = base64url của URL phụ đề gốc (stateless qua restart).
router.get('/subvi/:key.srt', async (req, res) => {
  try {
    const srt = await subtitles.srtByKey(req.params.key);
    res.set('Content-Type', 'application/x-subrip; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=43200');
    res.send(srt);
  } catch (e) {
    console.warn('[subvi] lỗi:', e.message);
    res.status(404).send('');
  }
});

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
    const k = s.url || s.externalUrl || (
      s.infoHash
        ? `torrent:${String(s.infoHash).toLowerCase()}:${s.fileIdx ?? ''}:${(s.behaviorHints && s.behaviorHints.filename) || ''}`
        : null
    );
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
async function probeUrlText(url, headers, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': CONFIG.userAgent, ...headers, Range: 'bytes=0-40000' },
      signal: ctrl.signal
    });
    return { status: res.status, txt: await res.text(), outcome: 'ok' };
  } catch (error) {
    return { status: 0, txt: '', outcome: ctrl.signal.aborted || (error && error.name === 'AbortError') ? 'timeout' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function validateVariantPlaylist(url, headers, depth = 0) {
  const result = await probeUrlText(url, headers, 5000);
  if (result.outcome === 'timeout') return { outcome: 'timeout', quality: null };
  if (result.outcome !== 'ok' || result.status < 200 || result.status >= 300 || !result.txt) return { outcome: 'failed', quality: null };
  if (!/^\s*#EXTM3U/i.test(result.txt) || BAD_BODY_RE.test(result.txt) || isFakeImagePlaylist(result.txt)) return { outcome: 'failed', quality: null };
  const children = parseHlsVariants(result.txt);
  if (children.length) {
    if (depth >= 1) return { outcome: 'failed', quality: null };
    const validated = await Promise.all(children.map(async (child) => {
      let childUrl;
      try { childUrl = new URL(child.url, url).href; } catch { return { outcome: 'failed', quality: null }; }
      const playable = await validateVariantPlaylist(childUrl, headers, depth + 1);
      return playable && playable.outcome === 'ok'
        ? { ...playable, quality: playable.quality || child.quality }
        : playable;
    }));
    const playable = validated.filter((item) => item.outcome === 'ok');
    if (!playable.length) return {
      outcome: validated.some((item) => item.outcome === 'timeout') ? 'timeout' : 'failed',
      quality: null
    };
    return {
      outcome: 'ok',
      quality: playable.reduce((best, item) =>
        item.quality && qualityRank(item.quality) > qualityRank(best) ? item.quality : best, null)
    };
  }
  const segments = result.txt.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!segments.length) return { outcome: 'failed', quality: null };
  return { outcome: 'ok', quality: qualityFromHlsText(result.txt) };
}

async function streamLooksBad(s) {
  if (!s.url) {
    if (s.externalUrl && /embed\.php|\/embed\//i.test(s.externalUrl)) {
      return { bad: true, probeOk: false, latencyMs: Infinity, quality: null, outcome: 'failed' };
    }
    if (s.infoHash) {
      const quality = normalizeQuality(`${s.name || ''} ${s.title || ''} ${(s.behaviorHints && s.behaviorHints.filename) || ''}`);
      return { bad: false, probeOk: false, latencyMs: Infinity, quality, outcome: quality ? 'ok' : 'unknown' };
    }
    const quality = normalizeQuality(`${s.name || ''} ${s.title || ''}`);
    return { bad: false, probeOk: false, latencyMs: Infinity, quality, outcome: quality ? 'ok' : 'unknown' };
  }
  if (!/\.m3u8(\?|$)/i.test(s.url)) {
    const quality = normalizeQuality(`${s.name || ''} ${s.title || ''}`);
    return { bad: false, probeOk: false, latencyMs: Infinity, quality, outcome: quality ? 'ok' : 'unknown' };
  }
  const outcome = await cachedOutcome('bad:' + s.url, 5 * 60 * 1000, async () => {
    const h = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
    const t0 = Date.now();
    const result = await probeUrlText(s.url, h);
    const status = result.status;
    const txt = result.txt;
    const latencyMs = Date.now() - t0;
    const finish = (outcome, quality = null) => ({
      status: 'success',
      value: { bad: outcome === 'failed' || outcome === 'timeout', probeOk: outcome === 'ok', latencyMs, quality, outcome }
    });
    if (result.outcome === 'timeout') return finish('timeout');
    if (result.outcome !== 'ok' || status < 200 || status >= 300 || !txt || !/^\s*#EXTM3U/i.test(txt)) return finish('failed');
    if (BAD_BODY_RE.test(txt) || isFakeImagePlaylist(txt)) return finish('failed');
    const segs = txt.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    if (!segs.length) return finish('failed');
    const variants = parseHlsVariants(txt);
    let verifiedQuality = qualityFromHlsText(txt);
    if (variants.length) {
      const checked = await Promise.all(variants.map(async (variant) => {
        let url;
        try { url = new URL(variant.url, s.url).href; } catch { return { outcome: 'failed', quality: null }; }
        const validated = await validateVariantPlaylist(url, h);
        return validated && validated.outcome === 'ok'
          ? { ...validated, quality: validated.quality || variant.quality }
          : validated;
      }));
      const valid = checked.filter((item) => item.outcome === 'ok');
      if (!valid.length) return finish(checked.some((item) => item.outcome === 'timeout') ? 'timeout' : 'failed');
      verifiedQuality = valid.reduce((best, item) =>
        item.quality && qualityRank(item.quality) > qualityRank(best) ? item.quality : best, null);
    }
    if (/proxy-segment/i.test(txt) && segs.length) {
      let first = null;
      try { first = new URL(segs[0], s.url).href; } catch { /* bỏ qua segment lạ */ }
      if (first) {
        const seg = await probeUrlText(first, h);
        if (seg.outcome === 'timeout') return finish('timeout');
        if (seg.outcome !== 'ok' || seg.status < 200 || seg.status >= 300 || !seg.txt || BAD_BODY_RE.test(seg.txt)) return finish('failed');
      }
    }
    return finish(verifiedQuality ? 'ok' : 'unknown', verifiedQuality);
  }, 30 * 1000);
  return outcome.status === 'success' ? outcome.value : {
    bad: outcome.status === 'failed', probeOk: false, latencyMs: Infinity,
    quality: null, outcome: outcome.status
  };
}

const BLOCKED_STREAM_PROVIDERS = new Set(
  String(process.env.STREAM_BLOCKLIST || 'phim4k').split(',').map((x) => x.trim()).filter(Boolean)
);

async function resolveProviderOutcome(provider, args) {
  if (BLOCKED_STREAM_PROVIDERS.has(provider && provider.id)) return { providerId: provider.id, status: 'excluded', streams: [] };
  if (!provider) return { providerId: args.providerId || 'unknown', status: 'unknown', streams: [] };
  try {
    const result = typeof provider.resolveStreamWithOutcome === 'function'
      ? await provider.resolveStreamWithOutcome(args)
      : await provider.resolveStream(args);
    if (result && typeof result.status === 'string') {
      return { providerId: provider.id, status: result.status, streams: Array.isArray(result.streams) ? result.streams : [] };
    }
    if (!Array.isArray(result)) return { providerId: provider.id, status: 'unknown', streams: [] };
    return { providerId: provider.id, status: result.length ? 'ok' : 'empty', streams: result };
  } catch (error) {
    return { providerId: provider.id, status: classifyFetchError(error), streams: [] };
  }
}

function mergeProviderOutcomes(target, incoming) {
  for (const next of incoming) {
    const previous = target.find((item) => item.providerId === next.providerId);
    if (!previous) target.push(next);
    else if (previous.status !== 'ok' || next.status === 'ok') previous.status = next.status;
    if (previous && next.streams.length) previous.streams = next.streams;
  }
}

async function filterBadStreams(list, probeOutcomes = null) {
  const probes = await Promise.all(
    list.map((s) => {
      if (BLOCKED_STREAM_PROVIDERS.has(s._providerId)) return { bad: true, probeOk: false, latencyMs: Infinity, quality: null, outcome: 'excluded' };
      return streamLooksBad(s).catch((error) => ({ bad: false, probeOk: false, latencyMs: Infinity, quality: null, outcome: classifyFetchError(error) }));
    })
  );
  const out = [];
  if (probeOutcomes) {
    list.forEach((stream, index) => probeOutcomes.push({
      providerId: stream._providerId,
      outcome: (probes[index] || {}).outcome || 'unknown'
    }));
  }
  list.forEach((s, i) => {
    const r = probes[i] || {};
    if (r.bad) return;
    // Tag chỉ dùng để sort; để non-enumerable nên JSON /stream không đổi.
    Object.defineProperties(s, {
      _probeOk: { value: !!r.probeOk, enumerable: false, configurable: true, writable: true },
      _latencyMs: { value: Number.isFinite(r.latencyMs) ? r.latencyMs : Infinity, enumerable: false, configurable: true, writable: true },
      _quality: { value: r.quality || null, enumerable: false, configurable: true, writable: true },
      _outcome: { value: r.outcome || 'unknown', enumerable: false, configurable: true, writable: true }
    });
    out.push(s);
  });
  return out;
}

// Tìm metadata localized từ chính KKphim/Phim4K để phủ lên Cinemeta.
// Cinemeta vẫn giữ episodes/cast; provider chỉ bổ sung tên, mô tả, ảnh và releaseInfo.
async function localizedProviderMeta(type, imdbId, hint) {
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return { status: 'missing' };
  const cacheKey = `localizedMeta:${type}:${String(imdbId).toLowerCase()}`;
  const result = await cachedOutcome(cacheKey, 30 * 60 * 1000, async () => {
    const sources = [providers.kkphim, providers.phim4k].filter(Boolean);
    if (!sources.length) return { status: 'unavailable' };
    const queries = Array.from(new Set([imdbId, hint && hint.name, hint && hint.originalName]
      .map((value) => String(value || '').trim())
      .filter(Boolean)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const results = await Promise.allSettled(sources.map(async (provider) => {
        const groups = await Promise.allSettled(queries.map((query) => provider.searchOutcome(query, { signal: controller.signal })));
        const searches = groups.filter((group) => group.status === 'fulfilled').map((group) => group.value);
        const hits = searches.filter((search) => ['ok', 'empty'].includes(search.status)).flatMap((search) => search.streams || []);
        const exact = hits.find((item) => String(item.imdbId || '').toLowerCase() === String(imdbId).toLowerCase());
        const matched = hint ? provider.matchItem(hits, {
          title: hint.name,
          year: hint.year || hint.releaseInfo,
          imdbId,
          type,
          season: 1
        }) : null;
        const candidates = exact ? [exact] : (matched ? [matched] : []);
        for (const hit of candidates) {
          if (!hit || !hit.slug) continue;
          const detail = await provider.detail(hit.slug, { signal: controller.signal });
          if (!detail || String(detail.imdbId || '').toLowerCase() !== String(imdbId).toLowerCase()) continue;
          const meta = provider.buildMeta(detail, { withVideos: false });
          if (meta) return { status: 'found', value: { ...meta, id: imdbId, imdb_id: imdbId, type } };
        }
        return searches.some((search) => ['failed', 'timeout', 'unknown'].includes(search.status))
          ? { status: 'unavailable' }
          : { status: 'missing' };
      }));
      const found = results.find((item) => item.status === 'fulfilled' && item.value.status === 'found');
      if (found) return found.value;
      return results.some((item) => item.status === 'rejected' || item.value.status === 'unavailable')
        ? { status: 'unavailable' }
        : { status: 'missing' };
    } finally {
      clearTimeout(timer);
    }
  }, 30 * 1000);
  return result.status === 'found' ? result : { status: result.status === 'success' ? 'missing' : result.status };
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
    if (hit && (hit.name || hit.originalName)) {
      const localized = await localizedProviderMeta(type, imdbId, hit);
      if (localized.status === 'found') return localized.value;
      return hit;
    }
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

// Các provider torrent chỉ nhận IMDb ID — dùng cho bước bổ sung link bên dưới.
const TORRENT_STREAM_PROVIDERS = new Set(['torrentio', 'comet', 'torrentsdb']);

function pickImdbId(detail) {
  if (!detail) return null;
  const v = detail.imdbId || detail.imdb_id || (detail.imdb && detail.imdb.id);
  return v && /^tt\d+$/.test(String(v)) ? String(v) : null;
}

// Tìm IMDb ID theo tên phim qua search của Cinemeta.
async function cinemetaSearchImdb(type, name, year) {
  if (!name) return null;
  try {
    const raw = await cached(`cinemetaSearch:${type}:${name}:${year || ''}`, 6 * 3600 * 1000, () =>
      getJson(`${CONFIG.cinemetaUrl}/catalog/${type}/search/search=${encodeURIComponent(name)}.json`)
    );
    const metas = (raw && raw.metas) || [];
    const want = String(name).toLowerCase();
    const hit = metas.find((m) => String(m.name || '').toLowerCase() === want)
      || metas.find((m) => String(m.name || '').toLowerCase().includes(want) && (!year || Number(m.year) === Number(year)));
    return hit && /^tt\d+$/.test(String(hit.id)) ? hit.id : null;
  } catch { return null; }
}

// Phim mở theo ID nguồn (kk_/nc_/hd_/k20_/p4k_) vẫn được dò thêm link torrent:
// resolve IMDb từ detail của provider (hoặc search theo tên) rồi hỏi các provider torrent.
async function enrichTorrentStreams(parsed, type) {
  let detail = null;
  try { detail = await parsed.provider.detail(parsed.slug); } catch { /* bỏ qua */ }
  let imdbId = pickImdbId(detail);
  if (!imdbId && detail) {
    // Tên tiếng Việt thường không khớp Cinemeta — thử tên gốc (origin_name) trước.
    const candidates = [detail.originalName, detail.name].filter(Boolean);
    for (const title of candidates) {
      imdbId = await cinemetaSearchImdb(type, title, detail.year);
      if (imdbId) break;
    }
  }
  if (!imdbId) return { results: [], detail };
  const torrentCfgs = Object.values(PROVIDERS)
    .filter((cfg) => cfg.enabled && TORRENT_STREAM_PROVIDERS.has(cfg.id) && !BLOCKED_STREAM_PROVIDERS.has(cfg.id));
  const results = await Promise.all(torrentCfgs.map((cfg) => resolveProviderOutcome(providers[cfg.id], {
    providerId: cfg.id, imdbId, title: detail && detail.name, year: detail && detail.year,
    type, season: parsed.season, episode: parsed.episode
  })));
  return { results, detail };
}

// Điểm IMDb cho lưới "Xem tất cả": catalog agg trả item id tt… nhưng không kèm
// imdbRating, nên bổ sung từ Cinemeta (cache 6 giờ) để app vẽ badge IMDb.
// Chạy theo lô 8 để không dội 20 request cùng lúc vào Cinemeta.
async function enrichImdbRatings(metas, type) {
  const list = Array.isArray(metas) ? metas : [];
  const pending = list.filter((m) => m && /^tt\d+$/.test(String(m.id)) && m.imdbRating == null);
  const CHUNK = 8;
  for (let i = 0; i < pending.length; i += CHUNK) {
    await Promise.all(pending.slice(i, i + CHUNK).map(async (m) => {
      try {
        const raw = await cached(`imdbRating:${m.id}`, 6 * 3600 * 1000, () =>
          getJson(`${CONFIG.cinemetaUrl}/meta/${type}/${m.id}.json`, { timeout: 5000 }));
        const rating = raw && raw.meta && raw.meta.imdbRating;
        if (rating) m.imdbRating = String(rating);
      } catch { /* thiếu rating thì thôi, không chặn catalog */ }
    }));
  }
  return list;
}

// /stream/movie/tt123.json hoặc /stream/series/tt123:1:2.json
router.get('/stream/:type/:id.json', async (req, res) => {
  const type = req.params.type === 'series' ? 'series' : 'movie';
  const parsed = parseId(req.params.id);
  const base = getBaseUrl(req);
  let streams = [];
  const probeOutcomes = [];
  const providerOutcomes = Object.values(PROVIDERS).filter((cfg) => cfg.enabled).map((cfg) => ({
    providerId: cfg.id,
    status: BLOCKED_STREAM_PROVIDERS.has(cfg.id) ? 'excluded' : 'unknown',
    streams: []
  }));
  try {
    if (parsed && parsed.provider) {
      if (BLOCKED_STREAM_PROVIDERS.has(parsed.provider.id)) {
        mergeProviderOutcomes(providerOutcomes, [{ providerId: parsed.provider.id, status: 'excluded', streams: [] }]);
      } else {
        // Dò torrent song song ngay từ đầu để không kéo dài thời gian phản hồi.
        const enrichPromise = enrichTorrentStreams(parsed, type);
        // ID nguồn dùng đúng slug, không tìm kiếm lại theo title.
        const direct = { providerId: parsed.provider.id, status: 'unknown', streams: [] };
        try {
          streams = await parsed.provider.streamsFromSlug(parsed.slug, type, parsed.season, parsed.episode);
          direct.streams = streams;
          direct.status = streams.length ? 'ok' : 'empty';
        } catch (error) {
          direct.status = classifyFetchError(error);
        }
        mergeProviderOutcomes(providerOutcomes, [direct]);
        streams = await filterBadStreams(streams, probeOutcomes);
        // Ghép link torrent của cùng phim đó (nếu có) vào sheet nguồn.
        let enrich = { results: [], detail: null };
        try { enrich = await enrichPromise; } catch { /* bỏ qua */ }
        mergeProviderOutcomes(providerOutcomes, enrich.results);
        for (const result of enrich.results) streams.push(...result.streams);
        if (!streams.length) {
          try {
            const d = enrich.detail || (await parsed.provider.detail(parsed.slug));
            if (d && d.name) {
              const others = Object.values(PROVIDERS).filter((cfg) => cfg.enabled
                && cfg.id !== parsed.provider.id && !TORRENT_STREAM_PROVIDERS.has(cfg.id));
              const results = await Promise.all(others.map((cfg) => resolveProviderOutcome(providers[cfg.id], {
                providerId: cfg.id, title: d.name, year: d.year, type,
                season: parsed.season, episode: parsed.episode
              })));
              mergeProviderOutcomes(providerOutcomes, results);
              for (const result of results) streams.push(...result.streams);
            }
          } catch { /* bỏ qua fallback */ }
        }
      }
    } else if (parsed) {
      const meta = await cinemeta.getMeta(type, parsed.imdbId);
      const ask = async (name, year) => {
        const active = Object.values(PROVIDERS).filter((cfg) => cfg.enabled && !BLOCKED_STREAM_PROVIDERS.has(cfg.id));
        const results = await Promise.all(active.map((cfg) => resolveProviderOutcome(providers[cfg.id], {
          providerId: cfg.id,
          imdbId: parsed.imdbId,
          title: name,
          year,
          type,
          season: parsed.season,
          episode: parsed.episode
        })));
        mergeProviderOutcomes(providerOutcomes, results);
        for (const result of results) streams.push(...result.streams);
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
  streams = dedupe(streams);
  streams = await filterBadStreams(streams, probeOutcomes);
  const qrank = (x) => qualityRank(x._quality || `${x.name || ''} ${x.title || ''}`);
  const latency = (x) => Number.isFinite(x._latencyMs) ? x._latencyMs : Number.MAX_SAFE_INTEGER;
  const probeRank = (x) => {
    if (!x.url && !x.externalUrl && x.infoHash) return 1;
    return x._probeOk === false ? 2 : x._probeOk === true ? 0 : 1;
  };
  // Ưu tiên 4K lên đầu (chất lượng trước, rồi mới tới probe/latency),
  // nhưng trong cùng mức 4K thì bản 8-bit SDR đứng trước 10-bit/HDR/DV vì
  // Chromecast/emulator hay lỗi NO_EXCEEDS_CAPABILITIES với profile 10-bit.
  const hdrRank = (x) => isHdrOrTenBit(`${(x.behaviorHints && x.behaviorHints.filename) || ''} ${x.title || ''} ${x.description || ''}`) ? 1 : 0;
  // Trong cùng 4K SDR, nhiều seeder hơn = vào buffer nhanh hơn; torrent không
  // có nhãn 👤 thì xếp sau các torrent có số liệu.
  const seederRank = (x) => {
    const match = String(x.title || '').match(/👤\s*([\d,]+)/u);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) || 0 : -1;
  };
  // TorrentsDB khai báo seeder cao nhưng đã gặp torrent chết (65/658 seeder
  // nhưng 0 tốc độ); Torrentio kiểm chứng ổn định hơn. Giữ TDB làm dự phòng.
  const providerRank = (x) => x._providerId === 'torrentio' ? 0 : x._providerId === 'torrentsdb' ? 2 : 1;
  streams.sort((a, b) =>
    qrank(b) - qrank(a) ||
    hdrRank(a) - hdrRank(b) ||
    providerRank(a) - providerRank(b) ||
    probeRank(a) - probeRank(b) ||
    seederRank(b) - seederRank(a) ||
    latency(a) - latency(b)
  );
  if (parsed && parsed.imdbId) recordStreamQuality(type, parsed.imdbId, streams, providerOutcomes, probeOutcomes);
  streams = streams.map((stream) => wrapProxy(stream, base));
  // App bind videoSize kiểu Long: số thực (vd 4190000000.0000005) làm cả sheet nguồn
  // báo lỗi parse. Ép nguyên cho mọi provider, kể cả stream lấy từ upstream.
  streams.forEach((stream) => {
    const hints = stream && stream.behaviorHints;
    if (hints && hints.videoSize != null) {
      const size = Math.round(Number(hints.videoSize));
      hints.videoSize = Number.isFinite(size) && size > 0 ? size : undefined;
      if (hints.videoSize === undefined) delete hints.videoSize;
    }
  });
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
    const cleanMetas = (aggMetas || []).filter((m) => m && m.id).filter((m) => !m.type || m.type === type0);
    // agg-4k đã được kiểm chứng 2160p lúc sinh dữ liệu, nên giữ nguyên nhãn 4K;
    // overlay thường sẽ bỏ quality chưa có entry /stream và làm mất badge.
    const aggFiltered = aggKind === '4k' ? cleanMetas : overlayStreamQuality(cleanMetas, type0);
    // Không còn hàng "Phim 4K" riêng: gộp phim 4K đã kiểm chứng vào Phim lẻ (nối sau
    // phim Việt, giữ nhãn 4K vì overlay ở trên sẽ xoá quality của các item này).
    if (aggKind === 'phim-le' && !ex.search) {
      const seen = new Set(aggFiltered.map((m) => String(m.id)));
      let added = 0;
      for (const item of TOP_4K.items || []) {
        if (added >= 20) break;
        if (!item.imdbId || seen.has(String(item.imdbId))) continue;
        seen.add(String(item.imdbId));
        added += 1;
        aggFiltered.push({
          id: item.imdbId,
          type: 'movie',
          name: item.name,
          poster: item.poster || undefined,
          posterShape: 'poster',
          background: item.background || item.poster || undefined,
          releaseInfo: ['4K', item.year].filter(Boolean).join(' · '),
          year: item.year || undefined,
          imdbId: item.imdbId
        });
      }
      // Xếp lại: 4K lên đầu (đã kiểm chứng), sau đó tới phim Việt theo năm.
      aggFiltered.sort((a, b) =>
        qualityRank(b.releaseInfo) - qualityRank(a.releaseInfo) ||
        (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
    }
    await enrichImdbRatings(aggFiltered, type0);
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

  // IMDb ID -> giữ meta Cinemeta giàu dữ liệu, phủ metadata localized lên trên.
  const raw = await cached(`cinemetaRaw:${type}:${parsed.imdbId}`, 6 * 3600 * 1000, () =>
    getJson(`${CONFIG.cinemetaUrl}/meta/${type}/${parsed.imdbId}.json`)
  );
  if (raw && raw.meta) {
    const localized = await localizedProviderMeta(type, parsed.imdbId, raw.meta);
    const meta = { ...raw.meta };
    if (localized.status === 'found') {
      const found = localized.value;
      for (const field of ['name', 'description', 'poster', 'background', 'logo', 'releaseInfo', 'country', 'language']) {
        const value = found[field];
        if (typeof value === 'string' && value.trim()) meta[field] = value;
      }
    }
    meta.id = parsed.imdbId;
    meta.imdb_id = parsed.imdbId;
    meta.type = type;
    return res.json({ meta, cacheMaxAge: 1800 });
  }
  // Dự phòng trước khi 404: item cùng IMDb trong 6 catalog agg / provider.search.
  const fb = await imdbFallback(type, parsed.imdbId);
  if (fb) {
    const meta = {
      ...fb,
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
module.exports._test = { streamLooksBad, resolveProviderOutcome, localizedProviderMeta, dedupe, validateVariantPlaylist };
