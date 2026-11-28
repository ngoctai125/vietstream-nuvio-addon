'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes');
const { streamLooksBad } = router._test;

test('stream validation rejects a one-image media playlist', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    text: async () => '#EXTM3U\nhttps://example.com/frame.png'
  });
  try {
    const result = await streamLooksBad({ url: 'https://example.com/one-image.m3u8' });
    assert.equal(result.bad, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('stream validation rejects a master whose variants are all image playlists', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200,
    text: async () => String(url).includes('master.m3u8')
      ? '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nvariant.m3u8'
      : '#EXTM3U\nhttps://example.com/frame.png'
  });
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master.m3u8' });
    assert.equal(result.bad, true);
    assert.equal(result.quality, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fake 4K variant does not override a valid FHD variant', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('master-fhd.m3u8')) {
      return {
        status: 200,
        text: async () => [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:RESOLUTION=3840x2160',
          'fake-4k.m3u8',
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
          'valid-fhd.m3u8'
        ].join('\n')
      };
    }
    if (String(url).includes('fake-4k.m3u8')) {
      return { status: 200, text: async () => '#EXTM3U\nhttps://example.com/frame.png' };
    }
    return { status: 200, text: async () => '#EXTM3U\nhttps://example.com/segment.ts' };
  };
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-fhd.m3u8' });
    assert.equal(result.bad, false);
    assert.equal(result.quality, 'FHD');
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolution-less fake variant is still validated and rejected', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200,
    text: async () => String(url).includes('master-no-resolution.m3u8')
      ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8'
      : '#EXTM3U\nhttps://example.com/frame.png'
  });
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-no-resolution.m3u8' });
    assert.equal(result.bad, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('404 HTML variant is not accepted as a playable HLS variant', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('master-404.m3u8')
    ? {
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nvariant.m3u8'
      }
    : { status: 404, text: async () => '<html><body>Not Found</body></html>' };
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-404.m3u8' });
    assert.equal(result.bad, true);
    assert.equal(result.quality, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('top-level 404 HTML response is not accepted as HLS', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 404, text: async () => '<html><body>Not Found</body></html>' });
  try {
    const result = await streamLooksBad({ url: 'https://example.com/top-level-404.m3u8' });
    assert.equal(result.bad, true);
    assert.equal(result.probeOk, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('empty 4K variant is not accepted as playable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('master-empty.m3u8')
    ? {
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nempty.m3u8'
      }
    : { status: 200, text: async () => '#EXTM3U\n#EXT-X-ENDLIST' };
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-empty.m3u8' });
    assert.equal(result.bad, true);
    assert.equal(result.quality, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('nested fake 4K variant does not override a valid nested FHD variant', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('master-nested.m3u8')) {
      return {
        status: 200,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=3840x2160\nnested.m3u8'
      };
    }
    if (String(url).includes('nested.m3u8')) {
      return {
        status: 200,
        text: async () => [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:RESOLUTION=3840x2160',
          'nested-fake.m3u8',
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
          'nested-valid.m3u8'
        ].join('\n')
      };
    }
    if (String(url).includes('nested-fake.m3u8')) {
      return { status: 200, text: async () => '#EXTM3U\nhttps://example.com/frame.png' };
    }
    return { status: 200, text: async () => '#EXTM3U\nhttps://example.com/segment.ts' };
  };
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-nested.m3u8' });
    assert.equal(result.bad, false);
    assert.equal(result.quality, 'FHD');
  } finally {
    global.fetch = originalFetch;
  }
});

test('all-timeout variants and a fake fourth variant are rejected', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('master-timeout.m3u8')) {
      return {
        status: 200,
        text: async () => [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
          'one.m3u8',
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
          'two.m3u8',
          '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
          'three.m3u8',
          '#EXT-X-STREAM-INF:RESOLUTION=3840x2160',
          'four.m3u8'
        ].join('\n')
      };
    }
    if (String(url).includes('four.m3u8')) {
      return { status: 200, text: async () => '#EXTM3U\nhttps://example.com/frame.png' };
    }
    return { status: 0, text: async () => '' };
  };
  try {
    const result = await streamLooksBad({ url: 'https://example.com/master-timeout.m3u8' });
    assert.equal(result.bad, true);
    assert.equal(result.quality, null);
  } finally {
    global.fetch = originalFetch;
  }
});
