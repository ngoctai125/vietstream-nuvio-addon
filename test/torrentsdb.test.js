'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../src/config');
const { TorrentsDBProvider } = require('../src/providers/torrentsdb');

test('TorrentsDB is enabled by default without credentials', () => {
  assert.equal(PROVIDERS.torrentsdb.enabled, true);
  assert.equal(PROVIDERS.torrentsdb.apiUrl, 'https://torrentsdb.com');
});

test('TorrentsDB maps high-seeder 2160p streams for Nuvio', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      streams: [{
        name: 'TorrentsDB\n2160p',
        title: 'Dune 2160p x265 AAC • 👤 658 💾 7.40 GB',
        infoHash: 'a'.repeat(40),
        fileIdx: 0,
        behaviorHints: { filename: 'Dune.2160p.x265.AAC.mkv' },
        sources: ['tracker:udp://tracker.opentrackr.org:1337/announce']
      }]
    })
  });

  try {
    const provider = new TorrentsDBProvider({
      id: 'torrentsdb', name: 'TorrentsDB 4K P2P', prefix: 'tdb_',
      apiUrl: 'https://torrentsdb.test', referer: 'https://torrentsdb.test/'
    });
    const streams = await provider.resolveStream({ imdbId: 'tt15239678', type: 'movie' });
    assert.equal(streams.length, 1);
    assert.match(streams[0].name, /TorrentsDB/);
    assert.match(streams[0].title, /👤 658/);
    assert.ok(!streams[0].url);
  } finally {
    global.fetch = originalFetch;
  }
});
