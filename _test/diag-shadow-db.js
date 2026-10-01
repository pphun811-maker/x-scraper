'use strict';
/** 检查影子 cookie 库现状：Chrome 跑过之后，加密 cookie 还在不在、前缀是什么。不做任何解密。 */
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'E:/beta/x-scraper/chrome-shadow/Default/Network/Cookies';
const TMP = 'E:/beta/x-scraper/_test/shadow-now.db';

fs.copyFileSync(FILE, TMP);
const db = new DatabaseSync(TMP, { readOnly: true });
const total = db.prepare('select count(*) as n from cookies').get().n;
const xRows = db.prepare(
  "select count(*) as n from cookies where host_key like '%x.com%' or host_key like '%twitter.com%'",
).get().n;
const prefixes = db.prepare(
  'select hex(substr(encrypted_value,1,3)) as prefix, count(*) as n from cookies group by 1 order by n desc',
).all();
const keyCookies = db.prepare(
  "select name, host_key, length(encrypted_value) as len from cookies "
  + "where host_key like '%x.com%' and name in ('auth_token','ct0','twid','auth_multi','kdt') order by name",
).all();
const hostRows = db.prepare(
  "select host_key, count(*) as n from cookies where host_key like '%x.com%' group by 1 order by n desc",
).all();
db.close();
fs.rmSync(TMP, { force: true });

console.log(JSON.stringify({ total, xRows, prefixes, keyCookies, hostRows }, null, 1));
