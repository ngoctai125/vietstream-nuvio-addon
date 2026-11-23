'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'adscan.json'), 'utf8'));
const pluginPath = path.join(root, 'nuvio-plugin', 'providers', 'vietstream.js');
let src = fs.readFileSync(pluginPath, 'utf8');

const ban = JSON.stringify(data.banUrls || []);
const warnUrls = JSON.stringify(data.warnUrls || {});
const warnTitles = JSON.stringify(data.warnTitles || {});

src = src.replace(/var AD_BAN_URLS = .*?;\r?\n/, `var AD_BAN_URLS = ${ban};\n`);
src = src.replace(/var AD_WARN_URLS = .*?;\r?\n/, `var AD_WARN_URLS = ${warnUrls};\n`);
src = src.replace(/var AD_WARN_TITLES = .*?;\r?\n/, `var AD_WARN_TITLES = ${warnTitles};\n`);

fs.writeFileSync(pluginPath, src);
console.log('injected', {
  ban: (data.banUrls || []).length,
  warnUrls: Object.keys(data.warnUrls || {}).length,
  warnTitles: Object.keys(data.warnTitles || {}).length
});
