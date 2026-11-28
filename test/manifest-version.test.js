'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../src/config');
const { buildManifest, AGG_CATALOGS } = require('../src/manifest');

test('addon manifest exposes patch version 1.4.2', () => {
  assert.equal(CONFIG.manifest.version, '1.6.0');
  assert.equal(buildManifest('https://addon.test').version, '1.6.0');
});

test('addon manifest exposes hot-week catalog first and verified 4K second', () => {
  assert.equal(AGG_CATALOGS[0].id, 'agg-hot-tuan');
  const manifest = buildManifest('https://addon.test');
  assert.equal(manifest.catalogs[0].id, 'agg-hot-tuan');
  assert.equal(manifest.catalogs[0].name, 'Phim hot tuần 🔥');
  assert.equal(manifest.catalogs[1].id, 'agg-4k');
  assert.equal(manifest.catalogs[1].name, 'Phim 4K');
});
