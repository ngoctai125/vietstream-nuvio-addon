'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Film4kProvider } = require('../src/providers/film4k');

const cfg = {
  id: 'film4k', name: 'Film4k', prefix: 'f4k_',
  apiUrl: 'https://film4k.test', referer: 'https://film4k.test/', timeout: 5000
};

const HOME = [
  {
    slug: 'movie-4k', mediaType: 'movie', maxRes: '4K', maxHeight: 2160, year: 2026,
    title: { vi: 'Phim 4K', en: 'Movie 4K' },
    poster: { vi: 'https://img.test/4k.jpg', en: 'https://img.test/4k-en.jpg' },
    backdrop: 'https://img.test/4k-bg.jpg', overview: { vi: 'Mô tả' }, genres: { vi: ['Hành động'] }
  },
  {
    slug: 'show-1080', mediaType: 'tv', maxRes: '1080p', year: 2025,
    title: { vi: 'Phim bộ', en: 'Show' }, poster: { vi: 'https://img.test/show.jpg' }
  },
  {
    slug: 'movie-1080', mediaType: 'movie', maxRes: '1080p', year: 2024,
    title: { vi: 'Phim lẻ', en: 'Movie' }, poster: { vi: 'https://img.test/movie.jpg' }
  }
];

const TITLES = {
  'movie-4k': {
    movie: {
      slug: 'movie-4k', mediaType: 'movie', maxRes: '4K', year: 2026,
      title: { vi: 'Phim 4K', en: 'Movie 4K' }, poster: { vi: 'https://img.test/4k.jpg' },
      backdrop: 'https://img.test/4k-bg.jpg', overview: { vi: 'Mô tả' }, genres: { vi: ['Hành động'] },
      hlsUrl: '/api/hls/TITLE/master.m3u8'
    },
    episodes: []
  },
  'show-1080': {
    movie: {
      slug: 'show-1080', mediaType: 'tv', maxRes: '1080p', year: 2025,
      title: { vi: 'Phim bộ', en: 'Show' }, poster: { vi: 'https://img.test/show.jpg' }
    },
    episodes: [
      { season: 1, episode: 1, title: 'Tập 1', sources: [{ url: '/api/hls/EP1/master.m3u8', label: 'Server 1' }] }
    ]
  }
};

function mockFilm4k() {
  const original = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/api/home')) {
      return { ok: true, status: 200, json: async () => ({ list: HOME, total: HOME.length }) };
    }
    if (value.includes('/api/search/suggest')) {
      return { ok: true, status: 200, json: async () => ({ list: [HOME[0], HOME[1]] }) };
    }
    if (value.includes('/api/watch/movie-4k')) {
      return { ok: true, status: 200, json: async () => ({ movie: TITLES['movie-4k'].movie, sources: [{ url: '/api/hls/WATCH/master.m3u8', label: 'Server 1' }] }) };
    }
    if (value.includes('/api/title/')) {
      const slug = value.split('/api/title/')[1].split('?')[0];
      const data = TITLES[decodeURIComponent(slug)];
      if (!data) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
      return { ok: true, status: 200, json: async () => data };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  };
  return { restore: () => { global.fetch = original; } };
}

test('Film4k catalogs split movies, series and 4K', async () => {
  const mock = mockFilm4k();
  try {
    const provider = new Film4kProvider(cfg);
    const movies = await provider.listCatalog('movies', {});
    const series = await provider.listCatalog('series', {});
    const fourK = await provider.listCatalog('4k', {});
    assert.deepEqual(movies.map((m) => m.id), ['f4k_movie-4k', 'f4k_movie-1080']);
    assert.deepEqual(series.map((m) => m.id), ['f4k_show-1080']);
    assert.deepEqual(fourK.map((m) => m.id), ['f4k_movie-4k']);
    assert.match(movies[0].releaseInfo, /4K/);
    assert.equal(movies[0].name, 'Phim 4K');
  } finally {
    mock.restore();
  }
});

test('Film4k detail exposes series episodes and movie metadata', async () => {
  const mock = mockFilm4k();
  try {
    const provider = new Film4kProvider(cfg);
    const movie = await provider.detail('movie-4k');
    const show = await provider.detail('show-1080');
    assert.equal(movie.type, 'movie');
    assert.equal(movie.quality, '4K');
    assert.equal(show.videos.length, 1);
    assert.equal(show.videos[0].id, 'f4k_show-1080:1:1');
  } finally {
    mock.restore();
  }
});

test('Film4k streams use the public HLS endpoint with playback headers', async () => {
  const mock = mockFilm4k();
  try {
    const provider = new Film4kProvider(cfg);
    const movie = await provider.streamsFromSlug('movie-4k', 'movie', 1, 1);
    const episode = await provider.streamsFromSlug('show-1080', 'series', 1, 1);
    assert.equal(movie.length, 1);
    assert.equal(movie[0].url, 'https://film4k.test/api/hls/WATCH/master.m3u8');
    assert.match(movie[0].name, /Film4k 4K/);
    assert.equal(episode[0].url, 'https://film4k.test/api/hls/EP1/master.m3u8');
    assert.equal(episode[0].behaviorHints.proxyHeaders.request.Referer, 'https://film4k.test/');
    assert.doesNotMatch(JSON.stringify(movie), /token|password/i);
  } finally {
    mock.restore();
  }
});

test('Film4k search returns the public suggestion list', async () => {
  const mock = mockFilm4k();
  try {
    const provider = new Film4kProvider(cfg);
    const results = await provider.search('phim');
    assert.equal(results.length, 2);
    assert.equal(results[0].slug, 'movie-4k');
  } finally {
    mock.restore();
  }
});
