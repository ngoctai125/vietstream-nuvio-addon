'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FshareProvider, cleanFolderName, VIDEO_EXT } = require('../src/providers/fshare');

const cfg = {
  id: 'fshare', name: 'Fshare', prefix: 'fs_',
  apiUrl: 'https://api.fshare.test', referer: 'https://www.fshare.vn/',
  email: 'user@example.com', password: 'secret-pass',
  appKey: 'app-key-test', userAgent: 'fs-ua', topUserAgent: 'fs-top-ua',
  timeout: 5000, authTimeout: 5000
};

function mockFshare() {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const body = options.body ? String(options.body) : '';
    if (String(url).includes('/api/user/login')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, token: 'TOK', session_id: 'SID', msg: 'ok' }) };
    }
    if (String(url).includes('/api/fileops/getTopFollowMovie')) {
      return { ok: true, status: 200, json: async () => ([
        { name: 'Dune Part Two 2024 4K', linkcode: 'FOLDER1' },
        { name: 'Phim bộ hay', linkcode: 'FOLDER2' }
      ]) };
    }
    if (String(url).includes('/api/fileops/getFolderList')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([
        { name: 'Dune.Part.Two.2024.2160p.mkv', linkcode: 'FILE1', size: '18000000000', type: '1' },
        { name: 'Dune.Part.Two.srt', linkcode: 'FILE2', size: '1200', type: '1' }
      ]) };
    }
    if (String(url).includes('/api/session/download')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ location: 'https://download.fshare.test/FILE1' }) };
    }
    if (String(url).includes('/v1/api/tim-kiem')) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [{ name: 'Dune: Part Two', year: '2024', poster_url: '/poster.jpg', thumb_url: '/bg.jpg' }] } }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('Fshare catalog lists top folders with fs_ ids and posters', async () => {
  const mock = mockFshare();
  try {
    const provider = new FshareProvider(cfg);
    const metas = await provider.listCatalog('top', {});
    assert.equal(metas.length, 2);
    assert.equal(metas[0].id, 'fs_FOLDER1');
    assert.equal(metas[0].type, 'series');
    assert.match(metas[0].name, /Dune/);
    assert.match(metas[0].poster, /phimimg\.com\/poster\.jpg/);
    assert.match(metas[0].releaseInfo, /4K/);
    const login = mock.calls.find((call) => call.url.includes('/api/user/login'));
    assert.ok(login);
    const loginBody = JSON.parse(login.options.body);
    assert.equal(loginBody.app_key, 'app-key-test');
    assert.equal(loginBody.user_email, 'user@example.com');
    assert.equal(loginBody.password, 'secret-pass');
    const top = mock.calls.find((call) => call.url.includes('getTopFollowMovie'));
    assert.equal(top.options.headers.Cookie, 'session_id=SID');
  } finally {
    mock.restore();
  }
});

test('Fshare detail exposes one video per video file and skips subtitles', async () => {
  const mock = mockFshare();
  try {
    const provider = new FshareProvider(cfg);
    const detail = await provider.detail('FOLDER1');
    assert.ok(detail);
    assert.equal(detail.videos.length, 1);
    assert.equal(detail.videos[0].id, 'fs_FOLDER1:1:1');
    assert.match(detail.videos[0].title, /Dune/);
    assert.equal(detail.videos[0].episode, 1);
  } finally {
    mock.restore();
  }
});

test('Fshare stream returns a direct link without credentials in the payload', async () => {
  const mock = mockFshare();
  try {
    const provider = new FshareProvider(cfg);
    const streams = await provider.streamsFromSlug('FOLDER1', 'series', 1, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://download.fshare.test/FILE1');
    assert.match(streams[0].name, /Fshare/);
    assert.match(streams[0].behaviorHints.filename, /2160p/);
    const serialized = JSON.stringify(streams);
    assert.doesNotMatch(serialized, /secret-pass|TOK|SID|app-key-test/);
  } finally {
    mock.restore();
  }
});

test('Fshare reports a failed download instead of emitting a broken url', async () => {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/api/user/login')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'TOK', session_id: 'SID' }) };
    }
    if (String(url).includes('getTopFollowMovie')) {
      return { ok: true, status: 200, json: async () => ([{ name: 'Movie 4K', linkcode: 'F1' }]) };
    }
    if (String(url).includes('getFolderList')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ name: 'Movie.2160p.mkv', linkcode: 'FILE9', size: '9000000000', type: '1' }]) };
    }
    if (String(url).includes('session/download')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 404, msg: 'File not found' }) };
    }
    if (String(url).includes('tim-kiem')) {
      return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  try {
    const provider = new FshareProvider({ ...cfg, id: 'fshare2' });
    await assert.rejects(() => provider.streamsFromSlug('F1', 'movie', 1, 1), /File not found/);
  } finally {
    global.fetch = original;
  }
});

test('Fshare helpers keep folder names clean and recognise video files', () => {
  assert.equal(cleanFolderName('Dune.2024.2160p.mkv'), 'Dune.2024.2160p');
  assert.equal(VIDEO_EXT.test('Movie.2160p.mkv'), true);
  assert.equal(VIDEO_EXT.test('Movie.srt'), false);
});

test('Fshare only exposes public top-follow folders, never the personal library', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/providers/fshare'), 'utf8');
  assert.doesNotMatch(source, /\/api\/fileops\/getListFollow|\/api\/Fileops\/ListFavorite/i);
  assert.match(source, /getTopFollowMovie/);
});
