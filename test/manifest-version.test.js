'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG } = require('../src/config');
const { buildManifest, AGG_CATALOGS } = require('../src/manifest');

test('addon manifest exposes patch version 1.4.2', () => {
  assert.equal(CONFIG.manifest.version, '1.4.3');
  assert.equal(buildManifest('https://addon.test').version, '1.4.3');
});

test('addon manifest exposes the verified 4K catalog first', () => {
  assert.equal(AGG_CATALOGS[0].id, 'agg-4k');
  const manifest = buildManifest('https://addon.test');
  assert.equal(manifest.catalogs[0].id, 'agg-4k');
  assert.equal(manifest.catalogs[0].name, 'Phim 4K');
});
