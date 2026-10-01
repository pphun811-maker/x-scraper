'use strict';
/** 损伤评估：cookie 库被删行之后，文件里是否还留着原始记录（SQLite 会把它标记为空闲页而不是清零）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const UD = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

function byteCount(buf, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const p = buf.indexOf(needle, i, 'latin1');
    if (p < 0) break;
    n += 1;
    i = p + 1;
  }
  return n;
}

const report = [];
for (const dir of fs.readdirSync(UD)) {
  if (dir !== 'Default' && !/^Profile \d+$/.test(dir)) continue;
  const ck = path.join(UD, dir, 'Network', 'Cookies');
  const entry = { dir, exists: fs.existsSync(ck) };
  if (!entry.exists) { report.push(entry); continue; }

  const st = fs.statSync(ck);
  entry.bytes = st.size;
  entry.mtime = st.mtime.toISOString();
  const buf = fs.readFileSync(ck);
  entry.rawAuthToken = byteCount(buf, 'auth_token');
  entry.rawCt0 = byteCount(buf, 'ct0');
  entry.rawV20 = byteCount(buf, 'v20');
  entry.rawXcom = byteCount(buf, '.x.com');

  const tmp = path.join(os.tmpdir(), `dmg-${Math.random().toString(36).slice(2)}.db`);
  try {
    fs.copyFileSync(ck, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    entry.rows = db.prepare('select count(*) as n from cookies').get().n;
    entry.xRows = db.prepare(
      "select count(*) as n from cookies where host_key like '%x.com%' or host_key like '%twitter.com%'",
    ).get().n;
    const pragma = (name) => db.prepare(`pragma ${name}`).get();
    entry.pageSize = pragma('page_size').page_size;
    entry.pageCount = pragma('page_count').page_count;
    entry.freelist = pragma('freelist_count').freelist_count;
    entry.journalMode = pragma('journal_mode').journal_mode;
    db.close();
  } catch (err) {
    entry.error = err.message;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
  const jr = ck + '-journal';
  entry.journalBytes = fs.existsSync(jr) ? fs.statSync(jr).size : null;
  report.push(entry);
}

fs.writeFileSync(path.join(__dirname, 'damage.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 1));
