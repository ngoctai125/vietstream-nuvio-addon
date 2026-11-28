'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const aggregate = require('../src/aggregate');
const data = require('../src/data/top-4k.json');

test('4K catalog only exposes titles verified with 2160p streams', async () => {
  const metas = await aggregate.listCatalog('4k', {});
  assert.ok(metas.length > 0, 'catalog has entries');
  assert.ok(metas.length <= 20, 'page is capped at 20');
  const ids = new Set(data.items.map((item) => item.imdbId));
  for (const meta of metas) {
    assert.match(meta.id, /^tt\d+$/);
    assert.equal(meta.type, 'movie');
    assert.match(meta.releaseInfo, /^4K/);
    assert.ok(ids.has(meta.id), `${meta.id} comes from verified data`);
  }
});

test('4K catalog pages and searches without leaking unverified titles', async () => {
  const first = await aggregate.listCatalog('4k', {});
  const second = await aggregate.listCatalog('4k', { skip: 20 });
  assert.notDeepEqual(first.map((m) => m.id), second.map((m) => m.id));
  const query = first[0].name.split(/\s+/)[0];
  const search = await aggregate.listCatalog('4k', { search: query });
  assert.ok(search.length > 0);
  assert.ok(search.every((meta) => meta.name.toLowerCase().includes(query.toLowerCase())));
});

test('verified 4K data recorded per title has a source timestamp', () => {
  assert.ok(data.items.length >= 10, 'enough verified titles');
  assert.doesNotThrow(() => new Date(data.generatedAt).toISOString());
  assert.ok(data.items.every((item) => item.uhd >= 2));
});
