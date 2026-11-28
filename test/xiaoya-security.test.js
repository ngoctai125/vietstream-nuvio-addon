'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { XiaoyaProvider, CATALOG_PATHS, decodeSlug, encodeSlug, validateCatalogPath } = require('../src/providers/xiaoya');

function provider() {
  return new XiaoyaProvider({
    id: 'xiaoya', name: 'Xiaoya', prefix: 'xy_', apiUrl: 'https://alist.test',
    token: 'static-token', username: 'user', password: 'pass'
  });
}

test('Xiaoya accepts only catalog roots and direct children with dotted filenames', () => {
  for (const root of Object.values(CATALOG_PATHS)) {
    assert.equal(decodeSlug(encodeSlug(root)), root);
    assert.equal(decodeSlug(encodeSlug(`${root}/Movie.2024.2160p.mkv`)), `${root}/Movie.2024.2160p.mkv`);
    assert.equal(decodeSlug(encodeSlug(`${root}/.hidden/file..name.mkv`)), `${root}/.hidden/file..name.mkv`);
  }
});

test('Xiaoya rejects traversal, encoded separators, NUL, backslash and foreign roots', () => {
  const root = CATALOG_PATHS['4k'];
  const rejected = [
    `${root}/../secret`, `${root}/a/./b`, `${root}/a/..`,
    `${root}/a\\b`, `${root}/a\0b`, `${root}/a%2fb`, `${root}/a%5Cb`,
    `${root}//file`, `${root}/file/`
  ];
  for (const value of rejected) assert.equal(validateCatalogPath(value), false, value);
  assert.equal(decodeSlug('not-base64!'), null);
  assert.equal(decodeSlug(`${encodeSlug(`${root}/file`)}!`), null);
});

test('Xiaoya validates list/get paths before any filesystem request', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('must not fetch'); };
  try {
    const p = provider();
    await assert.rejects(p.fsGet('/etc/passwd'), /ngoài catalog/);
    await assert.rejects(p.fsList('/strm/电影/4K系列/../4K REMUX'), /ngoài catalog/);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya discards a static token on 401, logs in again and retries once', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) {
      assert.equal(options.headers.Authorization, undefined);
      return { ok: true, json: async () => ({ code: 200, data: { token: 'fresh-token' } }) };
    }
    if (calls.filter((call) => call.url.endsWith('/api/fs/get')).length === 1) {
      assert.equal(options.headers.Authorization, 'static-token');
      return { ok: false, status: 401 };
    }
    assert.equal(options.headers.Authorization, 'fresh-token');
    return { ok: true, json: async () => ({ code: 200, data: { raw_url: 'https://cdn.test/video.m3u8' } }) };
  };
  try {
    const p = provider();
    const url = await p.fsGet(`${CATALOG_PATHS['4k']}/movie.mkv`);
    assert.equal(url, 'https://cdn.test/video.m3u8');
    assert.equal(p._token, 'fresh-token');
    assert.equal(p.authPromise, null);
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya login timeout covers JSON body and clears authPromise', async () => {
  const originalFetch = global.fetch;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  global.fetch = async (_url, options) => ({
    ok: true,
    json: () => {
      bodyStarted();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('body aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true }));
    }
  });
  try {
    const p = new XiaoyaProvider({
      id: 'xiaoya', name: 'Xiaoya', prefix: 'xy_', apiUrl: 'https://alist.test',
      username: 'user', password: 'pass', authTimeout: 20
    });
    const oldTimeout = require('../src/config').CONFIG.timeout;
    require('../src/config').CONFIG.timeout = 30;
    try {
      const pending = p.ensureAuth();
      await started;
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(p.authPromise, null);
    } finally {
      require('../src/config').CONFIG.timeout = oldTimeout;
    }
  } finally {
    global.fetch = originalFetch;
  }
});
