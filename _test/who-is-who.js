'use strict';
/** 用正确的 UTF-8 输出每个 Chrome 配置的名字、绑定账号、以及 x.com 的 cookie 数量。 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const out = { userData: UD, profiles: [] };

for (const name of fs.readdirSync(UD)) {
  const dir = path.join(UD, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;

  let profileName = null;
  let emails = [];
  const pref = path.join(dir, 'Preferences');
  if (fs.existsSync(pref)) {
    try {
      const j = JSON.parse(fs.readFileSync(pref, 'utf8'));
      profileName = (j.profile || {}).name || null;
      emails = (j.account_info || []).map((a) => a.email).filter(Boolean);
    } catch (err) { profileName = '<parse error>'; }
  }

  let xRows = null;
  const ck = path.join(dir, 'Network', 'Cookies');
  if (fs.existsSync(ck)) {
    const tmp = path.join(os.tmpdir(), `whowho-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      fs.copyFileSync(ck, tmp);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(tmp, { readOnly: true });
      xRows = db.prepare(
        "select count(*) as n from cookies where host_key like '%x.com%' or host_key like '%twitter.com%'",
      ).get().n;
      db.close();
    } catch (err) { xRows = `err:${err.code || err.message}`; }
    finally { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ } }
  }

  out.profiles.push({ dir: name, name: profileName, emails, xCookieRows: xRows });
}

fs.writeFileSync(path.join(__dirname, 'profiles.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('written _test/profiles.json');
