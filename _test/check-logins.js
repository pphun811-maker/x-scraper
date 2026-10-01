'use strict';
/** 看看各配置里保存的密码条目（只读 origin_url 与计数，不解密、不打印任何密码）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const out = [];

for (const dir of fs.readdirSync(UD)) {
  if (dir !== 'Default' && !/^Profile \d+$/.test(dir)) continue;
  const src = path.join(UD, dir, 'Login Data');
  const entry = { dir, exists: fs.existsSync(src) };
  if (!entry.exists) { out.push(entry); continue; }
  const tmp = path.join(os.tmpdir(), `logins-${Math.random().toString(36).slice(2)}.db`);
  try {
    fs.copyFileSync(src, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    entry.savedLogins = db.prepare('select count(*) as n from logins').get().n;
    entry.xLogins = db.prepare(
      "select count(*) as n from logins where origin_url like '%x.com%' or origin_url like '%twitter.com%'",
    ).get().n;
    entry.xOrigins = db.prepare(
      "select distinct origin_url from logins where origin_url like '%x.com%' or origin_url like '%twitter.com%'",
    ).all().map((r) => r.origin_url);
    db.close();
  } catch (err) {
    entry.error = err.message;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
  out.push(entry);
}

fs.writeFileSync(path.join(__dirname, 'logins.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 1));
