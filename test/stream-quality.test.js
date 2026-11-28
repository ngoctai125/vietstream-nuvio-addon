'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordStreamQuality, overlayStreamQuality, streamQualityIndexSize } = require('../src/stream-quality');

test('verified 4K upgrades catalog quality', () => {
  recordStreamQuality('movie', 'tt4154796', [{ _quality: '4K' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154796', releaseInfo: 'FHD · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('verified FHD downgrades an advertised 4K label', () => {
  recordStreamQuality('movie', 'tt4154796', [{ _quality: 'FHD', _outcome: 'ok' }], [{ status: 'ok' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154796', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, 'FHD · Vietsub · 2019');
});

test('failed provider does not remove a historical 4K label', () => {
  recordStreamQuality('movie', 'tt4154796', [{ _quality: '4K' }]);
  recordStreamQuality('movie', 'tt4154796', [], [{ status: 'failed' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154796', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('settled empty providers remove a historical 4K label', () => {
  recordStreamQuality('movie', 'tt4154797', [{ _quality: '4K' }]);
  recordStreamQuality('movie', 'tt4154797', [], [{ status: 'empty' }, { status: 'excluded' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154797', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, 'Vietsub · 2019');
});

test('verified 4K upgrades even when another provider times out', () => {
  recordStreamQuality('movie', 'tt4154798', [{ _quality: '4K', _outcome: 'ok' }], [{ status: 'ok' }, { status: 'timeout' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154798', releaseInfo: 'FHD · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('unknown probe blocks a downgrade', () => {
  recordStreamQuality('movie', 'tt4154799', [{ _quality: '4K' }]);
  recordStreamQuality('movie', 'tt4154799', [{ _outcome: 'unknown' }], [{ status: 'ok' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154799', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('timed-out probe blocks a downgrade even if provider returned ok', () => {
  recordStreamQuality('movie', 'tt4154800', [{ _quality: '4K' }]);
  recordStreamQuality('movie', 'tt4154800', [], [{ status: 'ok' }], [{ providerId: 'k20', outcome: 'timeout' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154800', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('torrent streams keep verified 4K label from name', () => {
  recordStreamQuality('movie', 'tt8888888', [{
    infoHash: 'a'.repeat(40),
    name: 'Torrentio\n4K · P2P',
    title: 'Movie 2160p'
  }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt8888888', releaseInfo: 'Vietsub · 2026' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2026');
});

test('label-only unknown streams do not verify or remove 4K', () => {
  recordStreamQuality('movie', 'tt4154796', [{ name: 'K20 4K', title: 'Avengers', _outcome: 'unknown' }], [{ status: 'ok' }]);
  const [meta] = overlayStreamQuality([
    { id: 'tt4154796', releaseInfo: '4K · Vietsub · 2019' }
  ], 'movie');
  assert.equal(meta.releaseInfo, '4K · Vietsub · 2019');
});

test('never-probed catalog entries do not advertise 4K', () => {
  const [meta] = overlayStreamQuality([
    { id: 'tt9999999', releaseInfo: '4K · Vietsub · 2026' }
  ], 'movie');
  assert.equal(meta.releaseInfo, 'Vietsub · 2026');
});

test('quality index sweeps expired entries and stays bounded', () => {
  const originalNow = Date.now;
  try {
    recordStreamQuality('movie', 'tt10000001', [{ _quality: '4K', _outcome: 'ok' }], [{ status: 'ok' }]);
    Date.now = () => originalNow() + 7 * 60 * 60 * 1000;
    recordStreamQuality('movie', 'tt10000002', [{ _quality: 'FHD', _outcome: 'ok' }], [{ status: 'ok' }]);
    assert.equal(streamQualityIndexSize(), 1);
  } finally {
    Date.now = originalNow;
  }

  for (let index = 0; index < 2005; index++) {
    recordStreamQuality('movie', `tt${20000000 + index}`, [{ _quality: 'FHD', _outcome: 'ok' }], [{ status: 'ok' }]);
  }
  assert.equal(streamQualityIndexSize(), 2000);
});
