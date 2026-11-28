'use strict';

const { TorrentioProvider } = require('./torrentio');

// TorrentsDB trả cùng shape Stremio với Torrentio (infoHash/fileIdx/👤/💾),
// nhưng có seeder trên mọi stream và nhiều tracker có sẵn. Chỉ gọi HTTP,
// không vendored code vì repo/license không được công bố.
class TorrentsDBProvider extends TorrentioProvider {}

module.exports = { TorrentsDBProvider };
