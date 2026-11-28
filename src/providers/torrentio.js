'use strict';

const BaseProvider = require('./base');
const { CONFIG } = require('../config');
const { cachedOutcome, isHdrOrTenBit } = require('../utils');
const { ProviderOutcome } = require('./base');

const UHD_RE = /(?<![a-z0-9])(2160p?|4k|uhd)(?![a-z0-9])/i;
const TRACKERS = [
  'tracker:udp://tracker.opentrackr.org:1337/announce',
  'tracker:udp://open.stealth.si:80/announce',
  'tracker:udp://tracker.torrent.eu.org:451/announce',
  'tracker:udp://tracker.openbittorrent.com:6969/announce',
  'tracker:udp://exodus.desync.com:6969/announce',
  'tracker:udp://tracker1.bt.moack.co.kr:80/announce',
  'tracker:udp://tracker.tiny-vps.com:6969/announce'
];

function seeders(stream) {
  const match = String(stream.title || stream.description || '').match(/👤\s*([\d,]+)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) || 0 : 0;
}

function sizeBytes(stream) {
  const match = String(stream.title || stream.description || '').match(/💾\s*([\d.,]+)\s*(TB|GB|MB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1].replace(/,/g, '.'));
  if (/tb/i.test(match[2])) return value * 1_000_000_000_000;
  if (/gb/i.test(match[2])) return value * 1_000_000_000;
  return value * 1_000_000;
}

function filename(stream) {
  return (stream.behaviorHints && stream.behaviorHints.filename) ||
    String(stream.title || stream.description || '').split('\n')[0].trim();
}

class TorrentioProvider extends BaseProvider {
  get headers() {
    return { 'User-Agent': CONFIG.userAgent, Referer: this.cfg.referer };
  }

  async resolveStreamWithOutcome({ imdbId, type, season, episode }) {
    if (!imdbId || !/^tt\d+$/.test(imdbId)) return new ProviderOutcome('empty');
    const id = type === 'series' ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId;
    const url = `${this.cfg.apiUrl}/stream/${type === 'series' ? 'series' : 'movie'}/${id}.json`;
    const outcome = await cachedOutcome(`${this.id}:stream:${url}`, 10 * 60 * 1000, () =>
      this.requestOutcome(url, { timeout: CONFIG.streamTimeout })
    );
    if (outcome.status !== 'success') return new ProviderOutcome(outcome.status, [], outcome.error);
    const data = outcome.value;
    if (!data || !Array.isArray(data.streams)) return new ProviderOutcome('failed', [], new Error('Torrentio response malformed'));
    const candidates = data.streams.filter((stream) => {
      if (!stream || stream.url || stream.externalUrl || stream.nzbUrl) return false;
      if (!/^[0-9a-f]{40}$/i.test(String(stream.infoHash || ''))) return false;
      const name = filename(stream);
      const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''} ${name}`;
      if (!UHD_RE.test(text)) return false;
      if (/(?<![a-z0-9])(1080p|720p|480p)(?![a-z0-9])/i.test(text) && !/2160p|uhd/i.test(text)) return false;
      const size = sizeBytes(stream);
      return size >= 1_000_000_000 && size <= 20_000_000_000;
    });
    candidates.sort((a, b) => {
      const aName = filename(a);
      const bName = filename(b);
      const aAac = /\baac(?:\d|[\s._-]|$)/i.test(aName) ? 1 : 0;
      const bAac = /\baac(?:\d|[\s._-]|$)/i.test(bName) ? 1 : 0;
      // Torrentio/Comet nhãn chung có thể ghi HDR/DV dù filename SDR; filename
      // và mô tả release mới quyết định khả năng giải mã 8-bit.
      const compatText = `${filename(a)} ${a.description || ''}`;
      const aCompat = isHdrOrTenBit(compatText) ? -10_000 : 0;
      const bCompat = isHdrOrTenBit(`${filename(b)} ${b.description || ''}`) ? -10_000 : 0;
      const sa = seeders(a) + aAac * 50 + aCompat;
      const sb = seeders(b) + bAac * 50 + bCompat;
      if (sa !== sb) return sb - sa;
      return sizeBytes(a) - sizeBytes(b);
    });
    const streams = candidates.slice(0, 6).map((stream) => this.mapStream(stream));
    return new ProviderOutcome(streams.length ? 'ok' : 'empty', streams);
  }

  async resolveStream(args) {
    return (await this.resolveStreamWithOutcome(args)).streams;
  }

  mapStream(stream) {
    const name = filename(stream);
    const size = sizeBytes(stream);
    const original = Array.isArray(stream.sources) ? stream.sources.filter((s) => typeof s === 'string') : [];
    const mapped = {
      name: `${this.name.split(/\s+/)[0]}\n4K · P2P`,
      title: [name, size ? `~${(size / 1_000_000_000).toFixed(1)} GB` : null, `👤 ${seeders(stream)}`].filter(Boolean).join(' • '),
      infoHash: stream.infoHash,
      fileIdx: stream.fileIdx,
      behaviorHints: {
        bingeGroup: `torrentio|2160p|${stream.infoHash}`,
        filename: name,
        videoSize: size
      },
      sources: Array.from(new Set([...original, ...TRACKERS]))
    };
    Object.defineProperty(mapped, '_providerId', { value: this.id, enumerable: false });
    return mapped;
  }
}

module.exports = { TorrentioProvider, seeders, sizeBytes };
