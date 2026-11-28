'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listCatalog } = require('../src/aggregate');

test('catalog merge keeps the highest real quality for one IMDb title', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (url.includes('/v1/api/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [{
              imdb: { id: 'tt4154796' },
              name: 'Avengers: Endgame',
              origin_name: 'Avengers: Endgame',
              year: 2019,
              type: 'single',
              quality: 'FHD',
              lang: 'Vietsub'
            }]
          }
        })
      };
    }
    if (url.includes('/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          items: [{
            imdb: { id: 'tt4154796' },
            name: 'Avengers: Hồi Kết',
            origin_name: 'Avengers: Endgame',
            year: 2019,
            type: 'single',
            quality: '4K',
            lang: 'Lồng Tiếng'
          }]
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const metas = await listCatalog('phim-le', { search: 'Avengers Endgame quality merge' });
    assert.equal(metas.length, 1);
    assert.equal(metas[0].id, 'tt4154796');
    assert.match(metas[0].releaseInfo, /^4K · /);
    assert.ok(calls.every((url) => url.includes('tim-kiem')), 'search must not load default catalog pages');
  } finally {
    global.fetch = originalFetch;
  }
});

test('category search only queries sources configured for that catalog', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (url.includes('/v1/api/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [{
              imdb: { id: 'tt1234567' },
              name: 'Phim chiếu rạp',
              year: 2026,
              type: 'single',
              quality: 'FHD'
            }]
          }
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const metas = await listCatalog('chieu-rap', { search: 'phim chieu rap category source' });
    assert.equal(metas.length, 1);
    assert.ok(calls.every((url) => url.includes('phimapi.com')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('audio-category search excludes hits without the requested audio label', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              imdb: { id: 'tt1111111' },
              name: 'Phim Vietsub',
              year: 2026,
              type: 'series',
              lang: 'Vietsub'
            },
            {
              imdb: { id: 'tt2222222' },
              name: 'Phim Thuyết Minh',
              year: 2026,
              type: 'series',
              lang: 'Thuyết Minh'
            }
          ]
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const metas = await listCatalog('thuyet-minh', { search: 'phim thuyet minh category audio' });
    assert.deepEqual(metas.map((meta) => meta.id), ['tt2222222']);
    assert.match(metas[0].releaseInfo, /Thuyết Minh/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mixed-type search results are filtered by their actual media type', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/v1/api/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [
              { imdb: { id: 'tt3333333' }, name: 'Phim lẻ', year: 2026, type: 'single' },
              { imdb: { id: 'tt4444444' }, name: 'Phim bộ', year: 2026, type: 'series' }
            ]
          }
        })
      };
    }
    if (url.includes('/tim-kiem')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const movies = await listCatalog('phim-le', { search: 'mixed type movie catalog' });
    assert.deepEqual(movies.map((meta) => meta.id), ['tt3333333']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('series catalog excludes movie hits from mixed search results', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/v1/api/tim-kiem')) {
      return { ok: true, json: async () => ({ data: { items: [] } }) };
    }
    if (url.includes('/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            { imdb: { id: 'tt5555555' }, name: 'Phim lẻ', year: 2026, type: 'single' },
            { imdb: { id: 'tt6666666' }, name: 'Phim bộ', year: 2026, type: 'series' }
          ]
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const series = await listCatalog('phim-bo', { search: 'mixed type series catalog' });
    assert.deepEqual(series.map((meta) => meta.id), ['tt6666666']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('catalog search queries configured providers concurrently', async () => {
  const originalFetch = global.fetch;
  let active = 0;
  let maxActive = 0;
  global.fetch = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active--;
    if (url.includes('/v1/api/tim-kiem')) {
      return { ok: true, json: async () => ({ data: { items: [] } }) };
    }
    if (url.includes('/tim-kiem')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await listCatalog('phim-le', { search: 'concurrent provider search' });
    assert.equal(maxActive, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VSMOV catalog quality is preserved instead of forced to null', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('phimapi.com')) {
      return { ok: true, json: async () => ({ data: { items: [] } }) };
    }
    if (url.includes('/danh-sach/phim-le')) {
      return {
        ok: true,
        json: async () => ({
          items: [{
            imdb: { id: 'tt51547822' },
            name: 'Chiara Ferragni: Trực Diện',
            origin_name: 'Chiara Ferragni: Front Facing',
            year: 2026,
            type: 'single',
            quality: '2160p'
          }]
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const metas = await listCatalog('phim-le', {});
    assert.equal(metas.length, 1);
    assert.match(metas[0].releaseInfo, /^4K · /);
  } finally {
    global.fetch = originalFetch;
  }
});
