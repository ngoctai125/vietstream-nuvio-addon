'use strict';

const BaseProvider = require('./base');
const { CONFIG } = require('../config');
const { cachedOutcome, isHdrOrTenBit } = require('../utils');
const { ProviderOutcome } = require('./base');

const UHD_RE = /(?<![a-z0-9])(2160p?|4k|uhd)(?![a-z0-9])/i;
const RECOMMENDED_TRACKERS = [
  'tracker:udp://tracker.opentrackr.org:1337/announce',
  'tracker:udp://open.stealth.si:80/announce',
  'tracker:udp://tracker.torrent.eu.org:451/announce',
  'tracker:udp://explodie.org:6969/announce',
  'tracker:udp://tracker.openbittorrent.com:6969/announce',
  'tracker:udp://exodus.desync.com:6969/announce',
  'tracker:udp://tracker1.bt.moack.co.kr:80/announce',
  'tracker:udp://tracker.tiny-vps.com:6969/announce'
];

function streamFilename(stream) {
  return (stream.behaviorHints && stream.behaviorHints.filename) ||
    String(stream.description || '').split('\n')[0].replace(/^📄\s*/, '').trim();
}

function isRealUhd(stream) {
  if (!stream || stream.url || stream.externalUrl || stream.nzbUrl) return false;
  if (!/^[0-9a-f]{40}$/i.test(String(stream.infoHash || ''))) return false;
  const filename = streamFilename(stream);
  const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${filename}`;
  if (!UHD_RE.test(text)) return false;
  const detailText = `${filename} ${stream.description || ''}`;
  if (/(?<![a-z0-9])(1080p|720p|480p)(?![a-z0-9])/i.test(detailText) && !/2160p|uhd/i.test(detailText)) return false;
  if (/obsolete configuration|❌/i.test(text)) return false;
  const size = (stream.behaviorHints && stream.behaviorHints.videoSize) || 0;
  return size >= 1_000_000_000 && size <= 20_000_000_000;
}

class CometProvider extends BaseProvider {
  get headers() {
    return { 'User-Agent': CONFIG.userAgent, Referer: this.cfg.referer };
  }

  async resolveStreamWithOutcome({ imdbId, type, season, episode }) {
    if (!imdbId || !/^tt\d+$/.test(imdbId)) return new ProviderOutcome('empty');
    const id = type === 'series' ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId;
    const url = `${this.cfg.apiUrl}/stream/${type === 'series' ? 'series' : 'movie'}/${id}.json`;
    const outcome = await cachedOutcome(`comet:stream:${url}`, 10 * 60 * 1000, () =>
      this.requestOutcome(url, { timeout: CONFIG.streamTimeout })
    );
    if (outcome.status !== 'success') return new ProviderOutcome(outcome.status, [], outcome.error);
    const data = outcome.value;
    if (!data || !Array.isArray(data.streams)) return new ProviderOutcome('failed', [], new Error('Comet response malformed'));
    const candidates = data.streams.filter(isRealUhd);
    candidates.sort((a, b) => {
      const aCompat = isHdrOrTenBit(`${streamFilename(a)} ${a.description || ''}`) ? -10_000 : 0;
      const bCompat = isHdrOrTenBit(`${streamFilename(b)} ${b.description || ''}`) ? -10_000 : 0;
      if (aCompat !== bCompat) return bCompat - aCompat;
      const aAac = /\baac(?:\d|[\s._-]|$)/i.test(`${streamFilename(a)} ${a.description || ''}`) ? 1 : 0;
      const bAac = /\baac(?:\d|[\s._-]|$)/i.test(`${streamFilename(b)} ${b.description || ''}`) ? 1 : 0;
      if (aAac !== bAac) return bAac - aAac;
      const aSize = (a.behaviorHints && a.behaviorHints.videoSize) || 0;
      const bSize = (b.behaviorHints && b.behaviorHints.videoSize) || 0;
      return aSize - bSize;
    });
    const streams = candidates.slice(0, 6).map((stream) => this.mapStream(stream));
    return new ProviderOutcome(streams.length ? 'ok' : 'empty', streams);
  }

  async resolveStream(args) {
    return (await this.resolveStreamWithOutcome(args)).streams;
  }

  mapStream(stream) {
    const filename = streamFilename(stream);
    const size = (stream.behaviorHints && stream.behaviorHints.videoSize) || 0;
    const mapped = {
      name: 'Comet\n4K · P2P',
      title: [filename, size ? `~${(size / 1_000_000_000).toFixed(1)} GB` : null, 'AAC ưu tiên'].filter(Boolean).join(' • '),
      infoHash: stream.infoHash,
      fileIdx: stream.fileIdx,
      behaviorHints: {
        bingeGroup: `comet|2160p|${stream.infoHash}`,
        filename,
        videoSize: Math.round(size || 0)
      },
      sources: Array.from(new Set([
        ...(Array.isArray(stream.sources) ? stream.sources.filter((source) => typeof source === 'string') : []),
        ...RECOMMENDED_TRACKERS
      ]))
    };
    Object.defineProperty(mapped, '_providerId', { value: this.id, enumerable: false });
    return mapped;
  }
}

module.exports = { CometProvider, isRealUhd, RECOMMENDED_TRACKERS };
