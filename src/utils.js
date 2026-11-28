'use strict';

const { CONFIG } = require('./config');

// ---------- HTTP ----------

async function fetchWithTimeout(url, opts = {}, timeoutMs = CONFIG.timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const externalSignal = opts.signal;
  const abortFromCaller = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    return await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
  }
}

async function fetchBodyWithTimeout(url, opts, timeoutMs, consume) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const externalSignal = opts.signal;
  const abortFromCaller = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    const response = await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal });
    return await consume(response);
  } finally {
    clearTimeout(t);
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
  }
}

async function getJson(url, { headers = {}, timeout, signal } = {}) {
  try {
    return await fetchBodyWithTimeout(
      url,
      { headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json, text/plain, */*', ...headers }, signal },
      timeout || CONFIG.timeout,
      async (res) => res.ok ? res.json() : null
    );
  } catch (error) {
    if (signal && signal.aborted && error && error.name === 'AbortError') throw error;
    return null;
  }
}

async function getJsonOutcome(url, { headers = {}, timeout, signal } = {}) {
  try {
    const response = await fetchBodyWithTimeout(
      url,
      { headers: { 'User-Agent': CONFIG.userAgent, Accept: 'application/json, text/plain, */*', ...headers }, signal },
      timeout || CONFIG.timeout,
      async (res) => {
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          error.status = res.status;
          throw error;
        }
        return res.json();
      }
    );
    return { status: 'success', value: response };
  } catch (error) {
    if (error && error.name === 'AbortError') return { status: 'timeout', error };
    const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
    const failed = error instanceof SyntaxError || error instanceof TypeError || Number.isInteger(error && error.status) ||
      codes.has(error && error.code) || /network|fetch failed|dns|socket|connection/i.test(String(error && error.message));
    return { status: failed ? 'failed' : 'unknown', error };
  }
}

async function getText(url, { headers = {}, timeout, signal } = {}) {
  try {
    return await fetchBodyWithTimeout(
      url,
      { headers: { 'User-Agent': CONFIG.userAgent, ...headers }, signal },
      timeout || CONFIG.timeout,
      async (res) => res.ok ? res.text() : null
    );
  } catch (error) {
    if (signal && signal.aborted && error && error.name === 'AbortError') throw error;
    return null;
  }
}

// ---------- Chuẩn hoá tên phim ----------

// "Harry Potter và Hòn Đá Phù Thủy" -> "harry potter va hon da phu thuy"
function normTitle(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripHtml(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
}

// "Tập 12" / "tap-12" / "Full" -> 12 / null
function parseEpNum(v) {
  const m = String(v == null ? '' : v).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Nhận diện nhãn audio từ tên server / trường lang
function detectAudio(text, fallback = 'Vietsub') {
  const s = String(text || '').toLowerCase();
  if (!s) return fallback;
  if (/song\s*ng[ữu]/.test(s)) return 'Song Ngữ';
  if (/thuy[ếe]t\s*minh|\btm\b/.test(s)) return 'Thuyết Minh';
  if (/l[ồo]ng\s*ti[ếe]ng/.test(s)) return 'Lồng Tiếng';
  if (/vietsub|ph[ụu]\s*[dđ][êe]|\bvs\b/.test(s)) return 'Vietsub';
  return fallback;
}

function audioKey(audio) {
  return String(audio || 'vietsub')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function qualityFromText(text, fallback) {
  const s = String(text || '');
  const normalized = normalizeQuality(s);
  if (normalized === '4K') return '4K';
  const m = s.match(/(?<![a-z0-9])(\d{3,4})p(?![a-z0-9])/i);
  if (m) return `${m[1]}p`;
  return fallback;
}

function normalizeQuality(value) {
  const s = String(value || '').trim();
  if (/^https?:\/\//i.test(s)) return null;
  if (/(?<![a-z0-9])(?:4k|2160p?|uhd)(?![a-z0-9])/i.test(s)) return '4K';
  if (/(?<![a-z0-9])(?:fhd|1080p?|full\s*hd)(?![a-z0-9])/i.test(s)) return 'FHD';
  if (/(?<![a-z0-9])(?:hd|720p?|1280x720)(?![a-z0-9])/i.test(s)) return 'HD';
  if (/(?<![a-z0-9])(?:sd|480p?|360p?)(?![a-z0-9])/i.test(s)) return 'SD';
  return null;
}

function isHdrOrTenBit(text) {
  return /10[\s._-]?bit|hdr10(?:\+)?|hdr(?:[\s._-]|$)|dolby[\s._-]*vision|(?<![a-z0-9])dv(?![a-z0-9])|bt\.2020|hlg/i.test(String(text || ''));
}

function qualityRank(value) {
  const q = normalizeQuality(value);
  return q === '4K' ? 4 : q === 'FHD' ? 3 : q === 'HD' ? 2 : q === 'SD' ? 1 : 0;
}

function qualityFromResolution(width, height) {
  if (height >= 2160 || width >= 3840) return '4K';
  if (height >= 1080 || width >= 1920) return 'FHD';
  if (height >= 720 || width >= 1280) return 'HD';
  if (height > 0) return 'SD';
  return null;
}

function qualityFromHlsText(text) {
  const s = String(text || '');
  const resolution = s.match(/RESOLUTION=(\d+)[xX](\d+)/i);
  if (!resolution) return null;
  return qualityFromResolution(parseInt(resolution[1], 10), parseInt(resolution[2], 10));
}

function parseHlsVariants(text) {
  const variants = [];
  let quality = null;
  let inVariant = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const resolution = line.match(/RESOLUTION=(\d+)[xX](\d+)/i);
      quality = resolution
        ? qualityFromResolution(parseInt(resolution[1], 10), parseInt(resolution[2], 10))
        : null;
      inVariant = true;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (inVariant) variants.push({ url: line, quality });
    inVariant = false;
    quality = null;
  }
  return variants;
}

function isFakeImagePlaylist(text) {
  const segments = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!segments.length) return false;
  const images = segments.filter((line) => /\.(?:png|jpe?g|webp)(\?|$)/i.test(line)).length;
  return images === segments.length || (segments.length >= 3 && images / segments.length >= 0.8);
}

function mapImageUrl(url, cdn) {
  if (!url || typeof url !== 'string') return undefined;
  const u = url.trim();
  if (!u) return undefined;
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u.replace(/^http:\/\//i, 'https://');
  if (u.startsWith('/')) return cdn ? `${cdn.replace(/\/+$/, '')}${u}` : undefined;
  return cdn ? `${cdn.replace(/\/+$/, '')}/${u}` : undefined;
}

// Link embed kiểu "https://player.../player/?url=https%3A%2F%2F....m3u8" -> m3u8
function extractUrlParam(embedUrl) {
  if (!embedUrl || typeof embedUrl !== 'string') return null;
  try {
    const u = new URL(embedUrl);
    for (const key of ['url', 'v', 'id']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch { /* ignore */ }
  return null;
}

function m3u8FromText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/i);
  return m ? m[0] : null;
}

// ---------- Cache in-memory với TTL ----------

const _cache = new Map();

function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return Promise.resolve(hit.value);
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      if (value !== null && value !== undefined) {
        if (_cache.size > 800) {
          for (const [k, v] of _cache) if (v.exp <= now) _cache.delete(k);
        }
        _cache.set(key, { value, exp: Date.now() + ttlMs });
      }
      return value;
    })
    .catch((error) => {
      if (error && error.name === 'AbortError') throw error;
      return null;
    });
}

function cachedOutcome(key, ttlMs, fn, retryMs = 0) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && hit.exp > now) return Promise.resolve(hit.value);
  return Promise.resolve()
    .then(fn)
    .then((outcome) => {
      const result = outcome && ['ok', 'empty', 'failed', 'timeout', 'unknown', 'excluded', 'success', 'found', 'missing', 'unavailable'].includes(outcome.status)
        ? outcome
        : { status: 'unknown', value: outcome };
      if ((result.status === 'success' || result.status === 'ok' || result.status === 'empty' || result.status === 'found') &&
          result.value !== null && result.value !== undefined) {
        if (_cache.size > 800) {
          for (const [k, v] of _cache) if (v.exp <= now) _cache.delete(k);
        }
        _cache.set(key, { value: result, exp: Date.now() + ttlMs });
      } else if (retryMs > 0) {
        _cache.set(key, { value: result, exp: Date.now() + retryMs });
      }
      return result;
    })
    .catch((error) => ({ status: error && error.name === 'AbortError' ? 'timeout' : 'unknown', error }));
}

function classifyFetchError(error) {
  if (error && error.name === 'AbortError') return 'timeout';
  const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
  if (error instanceof SyntaxError || error instanceof TypeError || Number.isInteger(error && error.status) || codes.has(error && error.code)) return 'failed';
  return /network|fetch failed|dns|socket|connection|http\s[45]\d\d/i.test(String(error && error.message)) ? 'failed' : 'unknown';
}

module.exports = {
  getJson,
  getJsonOutcome,
  fetchBodyWithTimeout,
  getText,
  normTitle,
  stripHtml,
  parseEpNum,
  detectAudio,
  audioKey,
  qualityFromText,
  normalizeQuality,
  qualityRank,
  isHdrOrTenBit,
  qualityFromHlsText,
  parseHlsVariants,
  isFakeImagePlaylist,
  mapImageUrl,
  extractUrlParam,
  m3u8FromText,
  cached,
  cachedOutcome,
  classifyFetchError
};
