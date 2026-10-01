'use strict';
/** 检查用户 Chrome 是否已经加载了我们的扩展（只读 Preferences，不解密任何东西）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const out = [];

for (const dir of fs.readdirSync(UD)) {
  if (dir !== 'Default' && !/^Profile \d+$/.test(dir)) continue;
  const pref = path.join(UD, dir, 'Preferences');
  if (!fs.existsSync(pref)) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(pref, 'utf8')); } catch (err) { out.push({ dir, error: err.message }); continue; }
  const settings = (j.extensions && j.extensions.settings) || {};
  const hits = [];
  for (const [id, val] of Object.entries(settings)) {
    const p = String((val && val.path) || '');
    const n = String((val && val.manifest && val.manifest.name) || '');
    if (p.toLowerCase().includes('x-scraper') || n.includes('登录态同步')) {
      hits.push({ id, path: p, name: n, state: val.state, location: val.location });
    }
  }
  out.push({ dir, totalExtensions: Object.keys(settings).length, ours: hits });
}

console.log(JSON.stringify(out, null, 1));
