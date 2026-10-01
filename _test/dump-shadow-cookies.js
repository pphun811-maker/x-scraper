'use strict';
/** 看副本人 cookie 库里到底有哪些行、加密前缀是什么。不做解密，只统计。 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'E:/beta/x-scraper/chrome-shadow/Default/Network/Cookies';
const st = fs.statSync(FILE);
console.log('文件:', FILE);
console.log('大小:', st.size, '字节，改动时间:', st.mtime.toISOString());
const tmp = path.join(require('os').tmpdir(), `shadowck-${Math.random().toString(36).slice(2)}.db`);
fs.copyFileSync(FILE, tmp);
const db = new DatabaseSync(tmp, { readOnly: true });
const rows = db.prepare(
  'select host_key, name, hex(substr(encrypted_value,1,3)) as prefix, length(encrypted_value) as len, '
  + 'cast(expires_utc as text) as expires_utc, is_persistent, has_expires from cookies order by host_key, name',
).all();
console.log('总行数:', rows.length);
for (const r of rows) {
  const micros = Number(BigInt(r.expires_utc || '0') / 1000000n);
  const exp = micros > 0 ? new Date(micros - 11644473600000).toISOString() : '(会话级)';
  console.log(`  ${r.host_key} | ${r.name} | prefix=${r.prefix} | len=${r.len} | persistent=${r.is_persistent} | expires=${exp}`);
}
db.close();
fs.rmSync(tmp, { force: true });
