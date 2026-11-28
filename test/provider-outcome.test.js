'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getJsonOutcome, cachedOutcome } = require('../src/utils');
const BaseProvider = require('../src/providers/base');
const { KKphimProvider } = require('../src/providers/kkphim');
const { CometProvider, isRealUhd } = require('../src/providers/comet');
const router = require('../src/routes');

const cfg = {
  id: 'kkphim', name: 'KKphim', prefix: 'kk_', apiUrl: 'https://kkphim.test',
  cdnImage: 'https://img.test', referer: 'https://kkphim.test/'
};

test('getJsonOutcome separates malformed JSON, HTTP, DNS, timeout and unknown errors', async () => {
  const originalFetch = global.fetch;
  const cases = [
    [() => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }), 'failed'],
    [() => ({ ok: false, status: 503 }), 'failed'],
    [() => { const error = new Error('dns'); error.code = 'ENOTFOUND'; throw error; }, 'failed'],
    [() => { const error = new Error('stop'); error.name = 'AbortError'; throw error; }, 'timeout'],
    [() => { throw new Error('unclassified'); }, 'unknown']
  ];
  try {
    for (let index = 0; index < cases.length; index++) {
      const [value, expected] = cases[index];
      global.fetch = async () => value();
      const result = await getJsonOutcome(`https://outcome.test/${index}`);
      assert.equal(result.status, expected);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('cachedOutcome caches successful empty results but retries failures', async () => {
  let successCalls = 0;
  const success = () => cachedOutcome('outcome:empty-success', 60_000, async () => {
    successCalls++;
    return { status: 'success', value: [] };
  });
  await success();
  await success();
  assert.equal(successCalls, 1);

  let failedCalls = 0;
  const failed = () => cachedOutcome('outcome:failed', 60_000, async () => {
    failedCalls++;
    return { status: 'failed', error: new Error('HTTP 500') };
  });
  await failed();
  await failed();
  assert.equal(failedCalls, 2);
});

test('ProviderOutcome exposes the six provider states and stream adapter shape', () => {
  for (const status of ['ok', 'empty', 'failed', 'timeout', 'unknown', 'excluded']) {
    const outcome = BaseProvider.ProviderOutcome.from(status, status === 'ok' ? [{ url: 'https://x.test/a.m3u8' }] : []);
    assert.equal(outcome.status, status);
    assert.equal(Array.isArray(outcome.streams), true);
  }
});

test('KKphim malformed search is failed and is not cached as empty', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ unexpected: true }) };
  };
  try {
    const provider = new KKphimProvider(cfg);
    assert.equal((await provider.searchOutcome('malformed-outcome')).status, 'failed');
    assert.equal((await provider.searchOutcome('malformed-outcome')).status, 'failed');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Comet HTTP failure returns failed instead of an empty stream list', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 502 });
  try {
    const provider = new CometProvider({
      id: 'comet', name: 'Comet', prefix: 'cm_', apiUrl: 'https://comet.outcome.test', referer: 'https://comet.outcome.test/'
    });
    const result = await provider.resolveStreamWithOutcome({ imdbId: 'tt1234567', type: 'movie' });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.streams, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Comet UHD candidates keep HDR releases but sort SDR first', () => {
  for (const filename of ['Movie.2160p.10bit.x265.mkv', 'Movie.2160p.HDR10.x265.mkv', 'Movie.2160p.Dolby.Vision.mkv', 'Movie.2160p.DV.x265.mkv']) {
    assert.equal(isRealUhd({
      infoHash: 'a'.repeat(40),
      behaviorHints: { filename, videoSize: 5_000_000_000 }
    }), true, filename);
  }
  assert.equal(isRealUhd({
    infoHash: 'a'.repeat(40),
    behaviorHints: { filename: 'Movie.2160p.8bit.SDR.x265.mkv', videoSize: 5_000_000_000 }
  }), true);
});

test('blocked provider is excluded before resolveStream is called', async () => {
  let calls = 0;
  const result = await router._test.resolveProviderOutcome({
    id: 'phim4k',
    resolveStreamWithOutcome: async () => { calls++; return { status: 'ok', streams: [] }; }
  }, {});
  assert.equal(result.status, 'excluded');
  assert.equal(calls, 0);
});

test('probe distinguishes timeout from malformed body and missing resolution', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    const timeout = await router._test.streamLooksBad({ url: 'https://probe.test/timeout.m3u8' });
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.bad, true);

    global.fetch = async () => ({ status: 200, text: async () => '<html>broken</html>' });
    const malformed = await router._test.streamLooksBad({ url: 'https://probe.test/malformed.m3u8' });
    assert.equal(malformed.outcome, 'failed');

    global.fetch = async () => ({ status: 200, text: async () => '#EXTM3U\nhttps://probe.test/segment.ts' });
    const unknown = await router._test.streamLooksBad({ url: 'https://probe.test/no-resolution.m3u8' });
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(unknown.bad, false);
  } finally {
    global.fetch = originalFetch;
  }
});
