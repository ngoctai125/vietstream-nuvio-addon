'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../src/config');
const { TorrentioProvider, seeders, sizeBytes } = require('../src/providers/torrentio');

const HASH_HIGH = 'a'.repeat(40);
const HASH_LOW = 'b'.repeat(40);

test('Torrentio parses seeder count and size', () => {
  const title = '2160p HDR AAC • 👤 117 💾 4.20 GB ⚙️ Rutracker';
  assert.equal(seeders({ title }), 117);
  assert.equal(sizeBytes({ title }), 4_200_000_000);
  assert.equal(sizeBytes({ title: 'The Matrix 💾 1,5 GB' }), 1_500_000_000);
  assert.equal(sizeBytes({ title: 'Remux 💾 1.5 TB' }), 1_500_000_000_000);
  assert.equal(sizeBytes({ title: 'Unknown' }), 0);
});

test('Torrentio is enabled by default', () => {
  assert.equal(PROVIDERS.torrentio.enabled, true);
});

test('Torrentio rejects unknown or oversized streams and reads resolution from name', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      streams: [
        {
          name: 'Torrentio 2160p HDR',
          title: 'Generic movie.mkv • 👤 50 💾 4 GB',
          infoHash: 'a'.repeat(40),
          behaviorHints: { filename: 'movie.mkv' }
        },
        {
          name: 'Torrentio 2160p',
          title: 'Big REMUX • 👤 500 💾 1.5 TB',
          infoHash: 'b'.repeat(40),
          behaviorHints: { filename: 'big.mkv' }
        }
      ]
    })
  });

  try {
    const provider = new TorrentioProvider({
      id: 'torrentio', name: 'Torrentio', prefix: 'to_',
      apiUrl: 'https://torrentio.test', referer: 'https://torrentio.test/'
    });
    const streams = await provider.resolveStream({ imdbId: 'tt0111161', type: 'movie' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].infoHash, 'a'.repeat(40));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Torrentio prefers decodable 8-bit streams over high-seeder 10-bit HDR', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      streams: [
        {
          name: 'Torrentio 2160p',
          title: '10bit HDR • 👤 500 💾 7 GB',
          infoHash: 'a'.repeat(40),
          behaviorHints: { filename: 'Movie.2160p.10bit.HDR.x265.mkv' }
        },
        {
          name: 'Torrentio 2160p',
          title: '8bit SDR • 👤 98 💾 18 GB',
          infoHash: 'b'.repeat(40),
          behaviorHints: { filename: 'Movie.2160p.AMZN.WEB-DL.H.265.mkv' }
        }
      ]
    })
  });

  try {
    const provider = new TorrentioProvider({
      id: 'torrentio', name: 'Torrentio', prefix: 'to_',
      apiUrl: 'https://torrentio.test', referer: 'https://torrentio.test/'
    });
    const streams = await provider.resolveStream({ imdbId: 'tt15239678', type: 'movie' });
    assert.equal(streams[0].infoHash, 'b'.repeat(40));
    assert.match(streams[0].title, /👤 98/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Torrentio prefers high-seeder 2160p torrents', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      streams: [
        {
          name: 'Torrentio\n4k DV | HDR',
          title: 'Low 2160p AAC • 👤 2 💾 3 GB',
          infoHash: HASH_LOW,
          fileIdx: 0,
          behaviorHints: { filename: 'Low.2160p.AAC.mkv' },
          sources: ['dht:' + HASH_LOW]
        },
        {
          name: 'Torrentio\n4k DV | HDR',
          title: 'High 2160p AAC • 👤 117 💾 5 GB',
          infoHash: HASH_HIGH,
          fileIdx: 0,
          behaviorHints: { filename: 'High.2160p.AAC.mkv' },
          sources: ['dht:' + HASH_HIGH]
        },
        {
          name: 'Torrentio\n1080p',
          title: 'Wrong 1080p • 👤 500 💾 1 GB',
          infoHash: 'c'.repeat(40),
          fileIdx: 0,
          behaviorHints: { filename: 'Wrong.1080p.mkv' }
        }
      ]
    })
  });

  try {
    const provider = new TorrentioProvider({
      id: 'torrentio', name: 'Torrentio', prefix: 'to_',
      apiUrl: 'https://torrentio.test', referer: 'https://torrentio.test/'
    });
    const streams = await provider.resolveStream({ imdbId: 'tt9999999', type: 'movie' });
    assert.equal(streams.length, 2);
    assert.equal(streams[0].infoHash, HASH_HIGH);
    assert.match(streams[0].title, /👤 117/);
    assert.ok(!streams[0].url);
    assert.ok(streams[0].sources.some((source) => source.startsWith('tracker:')));
  } finally {
    global.fetch = originalFetch;
  }
});
