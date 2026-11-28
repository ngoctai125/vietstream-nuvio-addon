'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../src/config');
const { CometProvider } = require('../src/providers/comet');
const router = require('../src/routes');
const { dedupe } = router._test;

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

function provider() {
  return new CometProvider({
    id: 'comet',
    name: 'Comet 4K P2P',
    prefix: 'cm_',
    apiUrl: 'https://comet.test',
    referer: 'https://comet.test/',
    enabled: true
  });
}

test('Comet provider is enabled by default and needs no credential', () => {
  assert.equal(PROVIDERS.comet.enabled, true);
  assert.equal(PROVIDERS.comet.apiUrl, 'https://comet.feels.legal');
});

test('Comet resolveStream keeps real 2160p torrents and prefers small AAC encodes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.equal(url, 'https://comet.test/stream/movie/tt15239678.json');
    return {
      ok: true,
      json: async () => ({
        streams: [
          {
            name: '[TORRENT🧲] Comet 2160p',
            description: 'Dune 2160p WEB-DL H265 AAC.mkv',
            infoHash: HASH_B,
            fileIdx: 0,
            behaviorHints: { filename: 'Dune.2160p.WEB-DL.H265.AAC.mkv', videoSize: 8_000_000_000 },
            sources: ['dht:' + HASH_B]
          },
          {
            name: '[TORRENT🧲] Comet 2160p',
            description: 'Dune 2160p x265 AAC small.mkv',
            infoHash: HASH_A,
            fileIdx: 0,
            behaviorHints: { filename: 'Dune.2160p.x265.AAC.mkv', videoSize: 3_000_000_000 },
            sources: ['dht:' + HASH_A]
          },
          {
            name: '[TORRENT🧲] Comet 2160p',
            description: 'Dune REMUX DTS.mkv',
            infoHash: HASH_C,
            fileIdx: 0,
            behaviorHints: { filename: 'Dune.REMUX.DTS.mkv', videoSize: 60_000_000_000 },
            sources: []
          },
          {
            name: '[TORRENT🧲] Comet 1080p',
            infoHash: 'd'.repeat(40),
            fileIdx: 0,
            behaviorHints: { filename: 'Dune.1080p.mkv', videoSize: 2_000_000_000 }
          },
          {
            name: '[TORRENT🧲] Comet 2160p',
            infoHash: 'f'.repeat(40),
            fileIdx: 0,
            description: 'Dune 1080p DS4K HDR.mkv',
            behaviorHints: { filename: 'Dune.2024.1080p.DS4K.BDRip.AAC.mkv', videoSize: 1_300_000_000 }
          },
          {
            name: '[TORRENT🧲] Comet 2160p',
            infoHash: 'e'.repeat(40),
            url: 'https://comet.test/configure'
          }
        ]
      })
    };
  };

  try {
    const streams = await provider().resolveStream({ imdbId: 'tt15239678', type: 'movie' });
    assert.equal(streams.length, 2);
    assert.equal(streams[0].infoHash, HASH_A);
    assert.ok(!streams[0].url);
    assert.match(streams[0].name, /4K/);
    assert.ok(streams[0].sources.some((source) => source.startsWith('tracker:')));
    assert.ok(!streams.some((stream) => stream.infoHash === 'f'.repeat(40)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('dedupe preserves distinct torrent streams without url', () => {
  const streams = [
    { infoHash: HASH_A, fileIdx: 0, behaviorHints: { filename: 'a.mkv' } },
    { infoHash: HASH_A, fileIdx: 0, behaviorHints: { filename: 'a.mkv' } },
    { infoHash: HASH_B, fileIdx: 0, behaviorHints: { filename: 'b.mkv' } },
    { url: 'https://example.com/a.m3u8' },
    { url: 'https://example.com/a.m3u8' }
  ];
  assert.equal(dedupe(streams).length, 3);
});
