'use strict';

// Phụ đề Việt: lấy danh sách phụ đề thật từ OpenSubtitles v3 (Stremio), ưu tiên bản
// tiếng Việt có sẵn; nếu phim không có bản Việt thì dịch bám timeline từ bản tiếng Anh
// (Google translate keyless, nhiều engine dự phòng) và trả thành một track riêng.

const { getJson } = require('./utils');
const { b64e, b64d } = require('./hls-proxy');

const OSV3 = 'https://opensubtitles-v3.strem.io';
const LIST_TTL = 30 * 60 * 1000;
const SRT_TTL = 12 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const listCache = new Map(); // key -> {at, value}
const srtCache = new Map();  // url -> {at, value}
const srtInflight = new Map();

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) { map.delete(key); return null; }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
  if (map.size > 400) {
    // Bỏ các mục cũ nhất để bộ nhớ Render free không phình.
    for (const k of [...map.keys()].slice(0, 100)) map.delete(k);
  }
  return value;
}

// ---------- SRT ----------
function parseSrt(text) {
  const clean = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const blocks = clean.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timing = lines[i] && lines[i].includes('-->') ? lines[i] : null;
    if (!timing) continue;
    const body = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean);
    if (!body.length) continue;
    cues.push({ timing, text: body.join(' ') });
  }
  return cues;
}

function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${c.timing}\n${c.text}`).join('\n\n') + '\n';
}

// ---------- dịch ----------
function stripTags(line) {
  // Giữ chỗ trống cho thẻ <i>/<b> để câu không dính chữ, dịch xong không cần khôi phục.
  return line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function googleDict(text) {
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=vi&q=${encodeURIComponent(text)}`;
  return fetchWithUa(url).then((body) => {
    const json = JSON.parse(body);
    const arr = Array.isArray(json) ? json : [];
    return arr.map((x) => (Array.isArray(x) ? x[0] : x)).join('');
  });
}

function googleGtx(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
  return fetchWithUa(url).then((body) => {
    const json = JSON.parse(body);
    const seg = (json && json[0]) || [];
    return seg.map((x) => (Array.isArray(x) ? x[0] || '' : '')).join('');
  });
}

function myMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|vi`;
  return fetchWithUa(url).then((body) => {
    const json = JSON.parse(body);
    return (json && json.responseData && json.responseData.translatedText) || '';
  });
}

function fetchWithUa(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept-Language': 'vi,en;q=0.8' }
  }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }).finally(() => clearTimeout(timer));
}

// Dịch một lô dòng, giữ đúng số dòng để ghép lại theo timeline.
async function translateBatch(lines) {
  const text = lines.join('\n');
  const engines = [googleDict, googleGtx];
  for (const engine of engines) {
    try {
      const out = await engine(text);
      if (!out) continue;
      const parts = out.split('\n');
      if (parts.length === lines.length) return parts;
      // Lệch số dòng: chỉ nhận khi lô 1 dòng, còn lại thử engine khác.
      if (lines.length === 1 && parts.join(' ').trim()) return [parts.join(' ').trim()];
    } catch { /* thử engine kế tiếp */ }
  }
  // Cuối cùng: dịch từng dòng bằng MyMemory (giới hạn 500 ký tự/dòng).
  const out = [];
  for (const line of lines) {
    try {
      const vi = await myMemory(line.slice(0, 480));
      out.push(vi || line);
    } catch {
      out.push(line);
    }
  }
  return out;
}

async function translateCues(cues) {
  const texts = cues.map((c) => stripTags(c.text) || '…');
  const batches = [];
  let current = [];
  let chars = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i].length + 1;
    if (current.length && (chars + len > 3500 || current.length >= 40)) {
      batches.push({ start: i - current.length, lines: current });
      current = [];
      chars = 0;
    }
    current.push(texts[i]);
    chars += len;
  }
  if (current.length) batches.push({ start: texts.length - current.length, lines: current });

  const out = cues.map((c) => c.text);
  for (const batch of batches) {
    const translated = await translateBatch(batch.lines);
    translated.forEach((line, idx) => {
      const target = batch.start + idx;
      if (target < out.length && line) out[target] = line;
    });
  }
  return cues.map((c, i) => ({ timing: c.timing, text: out[i] }));
}

// ---------- OpenSubtitles v3 ----------
function subtitleListPath(type, id, extra) {
  return `${OSV3}/subtitles/${type}/${id}${extra ? '/' + extra : ''}.json`;
}

async function listFromOpenSubtitles(type, id, extra) {
  const path = subtitleListPath(type, id, extra);
  const hit = cacheGet(listCache, path, LIST_TTL);
  if (hit) return hit;
  try {
    const data = await getJson(path);
    const subs = Array.isArray(data && data.subtitles) ? data.subtitles : [];
    return cacheSet(listCache, path, subs);
  } catch {
    return [];
  }
}

function pickBaseSubtitle(subs) {
  const usable = subs.filter((s) => s && s.url);
  const vi = usable.find((s) => /^vi/i.test(s.lang || '') || /vietnam/i.test(s.lang || ''));
  if (vi) return { sub: vi, human: true };
  const eng = usable.find((s) => /^en/i.test(s.lang || ''));
  if (eng) return { sub: eng, human: false };
  return usable.length ? { sub: usable[0], human: false } : null;
}

async function translatedSrtFor(url) {
  const hit = cacheGet(srtCache, url, SRT_TTL);
  if (hit) return hit;
  if (srtInflight.has(url)) return srtInflight.get(url);
  const job = (async () => {
    const raw = await fetchWithUa(url);
    const cues = parseSrt(raw);
    if (!cues.length) throw new Error('empty srt');
    const translated = await translateCues(cues);
    return cacheSet(srtCache, url, buildSrt(translated));
  })();
  srtInflight.set(url, job);
  try {
    return await job;
  } finally {
    srtInflight.delete(url);
  }
}

// Trả danh sách phụ đề cho Stremio/Nuvio: chỉ trả track tiếng Việt (bản thật nếu có,
// ngược lại là bản dịch bám timeline). Track gốc đã do OpenSubtitles v3 phục vụ nên
// không trả lại để tránh menu phụ đề bị nhân đôi.
async function listSubtitles(type, id, extra, baseUrl) {
  const subs = await listFromOpenSubtitles(type, id, extra);
  const chosen = pickBaseSubtitle(subs);
  if (!chosen) return [];

  if (chosen.human) {
    return [{
      ...chosen.sub,
      id: `vi-human-${chosen.sub.id || 'x'}`
    }];
  }

  const key = b64e(chosen.sub.url);
  const fileName = `Vietsub (dịch) - ${chosen.sub.subtitleFileName || chosen.sub.movieReleaseName || 'phim'}`;
  // Dịch sẵn ở nền để lúc người dùng chọn là có ngay.
  translatedSrtFor(chosen.sub.url).catch(() => {});
  return [{
    id: `vi-auto-${chosen.sub.id || key}`,
    url: `${baseUrl}/subvi/${key}.srt`,
    lang: 'vi',
    SubEncoding: 'UTF-8',
    subtitleFileName: fileName,
    movieReleaseName: chosen.sub.movieReleaseName || '',
    releaseGroup: chosen.sub.releaseGroup || '',
    fpsMilli: chosen.sub.fpsMilli || 0
  }];
}

async function srtByKey(key) {
  const url = b64d(key);
  if (!/^https?:\/\//i.test(url)) throw new Error('bad key');
  return translatedSrtFor(url);
}

module.exports = { listSubtitles, srtByKey, parseSrt, buildSrt, translateCues };
