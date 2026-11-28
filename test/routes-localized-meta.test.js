'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes');
const { localizedProviderMeta } = router._test;

test('localized provider lookup rejects a detail whose IMDb ID does not match', async () => {
  const originalFetch = global.fetch;
  const imdbId = 'tt1234567';
  global.fetch = async (url) => {
    if (url.includes('/v1/api/tim-kiem')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [{
              slug: 'wrong-title',
              name: 'Wrong Title',
              year: 2026,
              type: 'single',
              imdb: { id: imdbId }
            }]
          }
        })
      };
    }
    if (url.includes('/phim/wrong-title')) {
      return {
        ok: true,
        json: async () => ({
          status: true,
          movie: {
            slug: 'wrong-title',
            name: 'Wrong Title',
            year: 2026,
            type: 'single',
            imdb: { id: 'tt9999999' }
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
    const result = await localizedProviderMeta('movie', imdbId, { name: 'Wrong Title', year: 2026 });
    assert.equal(result.status, 'missing');
    assert.equal(result.value, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('localized provider lookup aborts slow providers at the deadline', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const started = Date.now();
  try {
    const result = await localizedProviderMeta('movie', 'tt7654321', { name: 'Slow Title' });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 'unavailable');
    assert.ok(elapsed >= 2000, `deadline fired too early: ${elapsed}ms`);
    assert.ok(elapsed < 4000, `lookup did not abort promptly: ${elapsed}ms`);
  } finally {
    global.fetch = originalFetch;
  }
});
