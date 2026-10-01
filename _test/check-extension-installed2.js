'use strict';
/** 从 Secure Preferences 里确认扩展是否已加载（只读）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const out = [];

for (const dir of fs.readdirSync(UD)) {
  if (dir !== 'Default' && !/^Profile \d+$/.test(dir)) continue;
  for (const file of ['Secure Preferences', 'Preferences']) {
    const p = path.join(UD, dir, file);
    if (!fs.existsSync(p)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { continue; }
    const settings = (j.extensions && j.extensions.settings) || {};
    const all = Object.keys(settings);
    const ours = all.map((id) => {
      const v = settings[id] || {};
      return {
        id,
        path: String(v.path || ''),
        name: String((v.manifest && v.manifest.name) || ''),
        state: v.state,
        location: v.location,
      };
    }).filter((x) => x.path.toLowerCase().includes('x-scraper') || x.name.includes('登录态同步'));
    if (all.length) {
      out.push({ dir, file, total: all.length, ours });
    }
  }
}

console.log(JSON.stringify(out, null, 1));
