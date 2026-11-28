'use strict';

// Sinh catalog "Phim 4K" từ Cinemeta top + kiểm chứng 2160p thật qua Torrentio.
// Chỉ giữ phim có ít nhất 2 stream 2160p để tránh nhãn 4K khống.
// Chạy: node tools/build-4k-catalog.js

const fs = require('node:fs');
const path = require('node:path');
const { getJson } = require('../src/utils');

const OUT = path.join(__dirname, '..', 'src', 'data', 'top-4k.json');
const PAGES = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450];
const BATCH = 6;
const UHD_RE = /(?<![a-z0-9])(2160p?|4k|uhd)(?![a-z0-9])/i;
const HDR_RE = /10[\s._-]?bit|hdr10(?:\+)?|hdr(?:[\s._-]|$)|dolby[\s._-]*vision|(?<![a-z0-9])dv(?![a-z0-9])|bt\.2020|hlg/i;

async function cinemetaPage(skip) {
  const url = skip === 0
    ? 'https://v3-cinemeta.strem.io/catalog/movie/top.json'
    : `https://v3-cinemeta.strem.io/catalog/movie/top/skip=${skip}.json`;
  const json = await getJson(url, { timeout: 15000 });
  return (json && json.metas) || [];
}

function streamText(stream) {
  return [
    stream.name || '',
    stream.title || '',
    stream.description || '',
    (stream.behaviorHints && stream.behaviorHints.filename) || ''
  ].join(' ');
}

async function checkTorrentio(meta) {
  const json = await getJson(`https://torrentio.strem.fun/stream/movie/${meta.id}.json`, { timeout: 20000 });
  const streams = (json && json.streams) || [];
  let uhd = 0;
  let uhdSdr = 0;
  for (const stream of streams) {
    const text = streamText(stream);
    if (!UHD_RE.test(text)) continue;
    uhd++;
    if (!HDR_RE.test(text)) uhdSdr++;
  }
  if (uhd < 2) return null;
  return {
    imdbId: meta.id,
    name: meta.name,
    year: meta.year || null,
    poster: meta.poster || null,
    background: meta.background || null,
    uhd,
    uhdSdr
  };
}

(async () => {
  const metas = [];
  for (const skip of PAGES) {
    try {
      metas.push(...await cinemetaPage(skip));
    } catch (error) {
      console.warn(`[cinemeta] skip=${skip}: ${error.message}`);
    }
  }
  const seen = new Set();
  const unique = metas.filter((meta) => {
    if (!meta || !/^tt\d+$/.test(String(meta.id || '')) || seen.has(meta.id)) return false;
    seen.add(meta.id);
    return true;
  });
  console.log(`[cinemeta] ${unique.length} phim, kiểm Torrentio...`);

  const items = [];
  for (let index = 0; index < unique.length; index += BATCH) {
    const batch = unique.slice(index, index + BATCH);
    const checked = await Promise.all(batch.map((meta) =>
      checkTorrentio(meta).catch((error) => {
        console.warn(`[torrentio] ${meta.id}: ${error.message}`);
        return null;
      })
    ));
    for (const item of checked) if (item) items.push(item);
    process.stdout.write(`  ${Math.min(index + BATCH, unique.length)}/${unique.length}\r`);
  }

  items.sort((a, b) => (b.year || 0) - (a.year || 0) || b.uhdSdr - a.uhdSdr || b.uhd - a.uhd);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Cinemeta top + Torrentio 2160p check (>=2 stream)',
    items
  }, null, 2)}\n`);
  console.log(`\n[done] ${items.length}/${unique.length} phim có 4K -> ${OUT}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
