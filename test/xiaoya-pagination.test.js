'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, CONFIG } = require('../src/config');
const { XiaoyaProvider, CATALOG_PATHS } = require('../src/providers/xiaoya');
const { buildManifest } = require('../src/manifest');

function provider(apiUrl) {
  return new XiaoyaProvider({
    id: 'xiaoya', name: 'Xiaoya Alist', prefix: 'xy_', apiUrl,
    token: 'token', username: 'user', password: 'pass'
  });
}

test('Xiaoya maps skip to Alist page and caches each page independently', async () => {
  const originalFetch = global.fetch;
  const pages = [];
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://page.test/api/fs/list');
    const body = JSON.parse(options.body);
    pages.push(body.page);
    return {
      ok: true,
      json: async () => ({ code: 200, data: { total: 201, content: body.page === 2
        ? [{ name: 'Page Two 2024.mkv', is_dir: false }]
        : [{ name: 'Page One 2024.mkv', is_dir: false }] } })
    };
  };
  try {
    const p = provider('https://page.test');
    const first = await p.listCatalog('4k', { skip: 0 });
    const second = await p.listCatalog('4k', { skip: 200 });
    const cachedSecond = await p.listCatalog('4k', { skip: 200 });
    assert.equal(first[0].name, 'Page One 2024');
    assert.equal(second[0].name, 'Page Two 2024');
    assert.deepEqual(cachedSecond, second);
    assert.deepEqual(pages, [1, 2]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya search visits later pages and keeps matches found before the deadline', async () => {
  const originalFetch = global.fetch;
  const pages = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    pages.push(body.page);
    const content = body.page === 1
      ? Array.from({ length: 200 }, (_, index) => ({ name: `Other ${index}.mkv`, is_dir: false }))
      : [{ name: 'Dune Part Two 2024 2160p.mkv', is_dir: false }];
    return { ok: true, json: async () => ({ code: 200, data: { total: 201, content } }) };
  };
  try {
    const p = provider('https://search.test');
    const hits = await p.search('Dune Part Two', { kind: '4k', timeout: 1000 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'Dune Part Two 2024 2160p');
    assert.deepEqual(pages, [1, 2]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya failed page is retried instead of cached as a positive page', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ code: 200, data: { total: 1, content: [{ name: 'Recovered.mkv', is_dir: false }] } }) };
  };
  try {
    const p = provider('https://retry.test');
    assert.deepEqual(await p.listCatalog('4k'), []);
    assert.equal((await p.listCatalog('4k'))[0].name, 'Recovered');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya manifest catalog names are Vietnamese and version is 1.6.0', () => {
  assert.deepEqual(PROVIDERS.xiaoya.catalogs.map((catalog) => catalog.name), [
    'Xiaoya 4K', 'Xiaoya 4K', 'Xiaoya Dolby Vision'
  ]);
  assert.equal(CONFIG.manifest.version, '1.6.0');
  const previous = PROVIDERS.xiaoya.enabled;
  PROVIDERS.xiaoya.enabled = true;
  try {
    const manifest = buildManifest('https://addon.test');
    assert.deepEqual(manifest.catalogs.filter((catalog) => catalog.id.startsWith('xiaoya-')).map((catalog) => catalog.name), [
      'Xiaoya 4K', 'Xiaoya 4K', 'Xiaoya Dolby Vision'
    ]);
    assert.ok(manifest.catalogs.some((catalog) => catalog.id === `xiaoya-${Object.keys(CATALOG_PATHS)[0]}`));
  } finally {
    PROVIDERS.xiaoya.enabled = previous;
  }
});
