'use strict';

const { normalizeQuality, qualityRank } = require('./utils');

const STREAM_QUALITY_TTL = 6 * 60 * 60 * 1000;
const MAX_STREAM_QUALITY_ENTRIES = 2000;
const streamQualityIndex = new Map();

function pruneStreamQualityIndex() {
  const now = Date.now();
  for (const [key, entry] of streamQualityIndex) {
    if (now - entry.updatedAt > STREAM_QUALITY_TTL) streamQualityIndex.delete(key);
  }
  while (streamQualityIndex.size > MAX_STREAM_QUALITY_ENTRIES) {
    const oldest = streamQualityIndex.entries().next().value;
    if (!oldest) break;
    streamQualityIndex.delete(oldest[0]);
  }
}

function streamQualityIndexSize() {
  return streamQualityIndex.size;
}

function streamQualityKey(type, imdbId) {
  return `${type}:${String(imdbId || '').toLowerCase()}`;
}

function streamQualityEntry(type, imdbId) {
  const key = streamQualityKey(type, imdbId);
  const entry = streamQualityIndex.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > STREAM_QUALITY_TTL) {
    streamQualityIndex.delete(key);
    return null;
  }
  return entry;
}

function recordStreamQuality(type, imdbId, streams, providerOutcomes = null, probeOutcomes = []) {
  if (!imdbId || !/^tt\d+$/i.test(String(imdbId))) return;
  let best = null;
  for (const stream of streams) {
    if (stream._outcome && stream._outcome !== 'ok') continue;
    const quality = stream._quality || (stream.infoHash
      ? normalizeQuality(`${stream.name || ''} ${stream.title || ''}`)
      : null);
    if (qualityRank(quality) > qualityRank(best)) best = quality;
  }
  // 4K đã xác minh là bằng chứng tích cực, không cần chờ provider khác.
  if (best === '4K') {
    streamQualityIndex.set(streamQualityKey(type, imdbId), { quality: best, updatedAt: Date.now() });
    pruneStreamQualityIndex();
    return;
  }
  if (!providerOutcomes) return;
  const relevant = providerOutcomes.filter((outcome) => outcome.status !== 'excluded');
  if (!relevant.length) return;
  const providersSettled = relevant.every((outcome) => ['ok', 'empty'].includes(outcome.status));
  const probesSettled = streams.every((stream) => stream._outcome === 'ok') &&
    probeOutcomes.every((probe) => probe.outcome === 'ok' || probe.outcome === 'excluded');
  if (!providersSettled || !probesSettled) return;
  streamQualityIndex.set(streamQualityKey(type, imdbId), { quality: best, updatedAt: Date.now() });
  pruneStreamQualityIndex();
}

function releaseInfoWithoutQuality(releaseInfo) {
  return String(releaseInfo || '')
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !normalizeQuality(part))
    .join(' · ') || undefined;
}

function releaseInfoWithQuality(releaseInfo, quality) {
  if (!quality) return releaseInfoWithoutQuality(releaseInfo);
  return [quality, releaseInfoWithoutQuality(releaseInfo)].filter(Boolean).join(' · ');
}

function overlayStreamQuality(metas, type) {
  return (metas || []).map((meta) => {
    const entry = streamQualityEntry(type, meta.imdbId || meta.id);
    if (!entry) {
      return normalizeQuality(meta.releaseInfo) === '4K'
        ? { ...meta, releaseInfo: releaseInfoWithoutQuality(meta.releaseInfo) }
        : meta;
    }
    return { ...meta, releaseInfo: releaseInfoWithQuality(meta.releaseInfo, entry.quality) };
  });
}

module.exports = {
  recordStreamQuality,
  overlayStreamQuality,
  releaseInfoWithQuality,
  releaseInfoWithoutQuality,
  pruneStreamQualityIndex,
  streamQualityIndexSize
};
