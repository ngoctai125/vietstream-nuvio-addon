'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getJson, getText, cached, normalizeQuality, qualityRank, qualityFromHlsText, parseHlsVariants, isFakeImagePlaylist } = require('../src/utils');

test('HTTP timeout remains active until fetch settles', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  const started = Date.now();
  try {
    const result = await getJson('https://timeout.test', { timeout: 25 });
    const elapsed = Date.now() - started;
    assert.equal(result, null);
    assert.ok(elapsed >= 15, `timeout fired too early: ${elapsed}ms`);
    assert.ok(elapsed < 500, `timeout did not fire: ${elapsed}ms`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('quality normalization ranks real resolution labels', () => {
  assert.equal(normalizeQuality('4K'), '4K');
  assert.equal(normalizeQuality('2160p BluRay'), '4K');
  assert.equal(normalizeQuality('FHD'), 'FHD');
  assert.equal(normalizeQuality('1080p'), 'FHD');
  assert.equal(normalizeQuality('720p'), 'HD');
  assert.equal(normalizeQuality('HDVNN'), null);
  assert.equal(normalizeQuality('4Kids'), null);
  assert.equal(normalizeQuality('UHDTV'), null);
  assert.equal(normalizeQuality('https://example.com/4k/uhd/video.m3u8'), null);
  assert.ok(qualityRank('4K') > qualityRank('FHD'));
  assert.ok(qualityRank('FHD') > qualityRank('HD'));
});

test('HLS resolution is preferred over marketing labels', () => {
  assert.equal(qualityFromHlsText('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nvideo.m3u8'), '4K');
  assert.equal(qualityFromHlsText('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nvideo.m3u8'), 'FHD');
  assert.equal(qualityFromHlsText('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nvideo.m3u8'), 'HD');
  assert.equal(qualityFromHlsText('https://example.com/4k/uhd/video.m3u8'), null);
});

test('fake image playlists are rejected for all-PNG and mostly-PNG segment lists', () => {
  assert.equal(isFakeImagePlaylist('#EXTM3U\nhttps://example.com/frame.png'), true);
  assert.equal(isFakeImagePlaylist('#EXTM3U\n1.png\n2.png\n3.png\n4.png\n5.ts'), true);
  assert.equal(isFakeImagePlaylist('#EXTM3U\n1.ts\n2.ts\n3.ts'), false);
});

test('HLS variant parser keeps each variant resolution', () => {
  const variants = parseHlsVariants([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:RESOLUTION=3840x2160',
    '4k.m3u8',
    '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
    '1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'unknown.m3u8'
  ].join('\n'));
  assert.deepEqual(variants, [
    { url: '4k.m3u8', quality: '4K' },
    { url: '1080.m3u8', quality: 'FHD' },
    { url: 'unknown.m3u8', quality: null }
  ]);
});

test('getText returns body text and null for HTTP errors', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => 'playlist-body' });
    assert.equal(await getText('https://text.test/ok'), 'playlist-body');
    global.fetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
    assert.equal(await getText('https://text.test/error'), null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getText propagates caller abort', async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  global.fetch = async (_url, options) => {
    markStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };

  try {
    const pending = getText('https://text.test/slow', { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, /aborted/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getJson keeps caller abort active while consuming the body', async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    json: () => {
      markBodyStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  });

  try {
    const pending = getJson('https://json.test/slow-body', { signal: controller.signal });
    await bodyStarted;
    controller.abort();
    await assert.rejects(pending, /aborted/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getText keeps caller abort active while consuming the body', async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    text: () => {
      markBodyStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
  });

  try {
    const pending = getText('https://text.test/slow-body', { signal: controller.signal });
    await bodyStarted;
    controller.abort();
    await assert.rejects(pending, /aborted/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('caller abort propagates and does not poison cached results', async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  global.fetch = async (_url, options) => {
    calls++;
    if (calls === 1) {
      markStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return { ok: true, status: 200, json: async () => ({ value: 'fresh' }) };
  };

  try {
    const pending = cached('abort-cache-test', 60_000, () => getJson('https://cache.test/data', { signal: controller.signal }));
    await started;
    controller.abort();
    await assert.rejects(pending, /aborted/);
    const fresh = await cached('abort-cache-test', 60_000, () => getJson('https://cache.test/data'));
    assert.deepEqual(fresh, { value: 'fresh' });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
