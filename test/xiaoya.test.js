'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS } = require('../src/config');
const { XiaoyaProvider, CATALOG_PATHS, encodeSlug } = require('../src/providers/xiaoya');

function providerWithToken() {
  return new XiaoyaProvider({
    id: 'xiaoya',
    name: 'Xiaoya Alist',
    prefix: 'xy_',
    apiUrl: 'https://alist.example',
    token: 'SECRET_ALIST_TOKEN',
    username: 'alist-user',
    password: 'alist-pass',
    catalogs: []
  });
}

test('Xiaoya provider is disabled without user-supplied Alist configuration', () => {
  assert.equal(PROVIDERS.xiaoya.enabled, false);
});

test('Xiaoya 4K catalog maps Alist files to direct-playable metas', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://alist.example/api/fs/list');
    const body = JSON.parse(options.body);
    assert.equal(body.path, CATALOG_PATHS['4k-remux']);
    assert.equal(options.headers.Authorization, 'SECRET_ALIST_TOKEN');
    return {
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          content: [{
            name: 'Dune Part Two 2024 2160p REMUX.mkv',
            is_dir: false,
            thumb: 'https://img.example/poster.jpg'
          }]
        }
      })
    };
  };

  try {
    const provider = providerWithToken();
    const metas = await provider.listCatalog('4k-remux');
    assert.equal(metas.length, 1);
    assert.equal(metas[0].name, 'Dune Part Two 2024 2160p REMUX');
    assert.match(metas[0].releaseInfo, /Xiaoya 4K · 2024/);
    assert.ok(metas[0].id.startsWith('xy_'));
    assert.equal(metas[0].slug, metas[0].id.slice('xy_'.length));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Xiaoya detail reads a .strm file and uses the URL inside it', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.includes('/dav/')) {
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('alist-user:alist-pass').toString('base64')}`);
      return {
        ok: true,
        text: async () => '#EXTM3U\nhttps://cdn.example/actual-2160p.m3u8\n'
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const provider = providerWithToken();
    const slug = encodeSlug('/strm/电影/4K REMUX/Dune 2024 2160p.strm');
    const streams = await provider.streamsFromSlug(slug);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://cdn.example/actual-2160p.m3u8');
    assert.match(streams[0].name, /4K|2160p/);
    assert.doesNotMatch(streams[0].title || '', /Vietsub/);
    const serialized = JSON.stringify(streams[0]);
    assert.doesNotMatch(serialized, /SECRET_ALIST_TOKEN|alist-pass|Authorization/i);
  } finally {
    global.fetch = originalFetch;
  }
});
