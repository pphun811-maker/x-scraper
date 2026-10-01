'use strict';
/**
 * 验收脚本：检查某个账号的抓取产物是否完整、字段是否可用。
 *   node _test/verify-output.js georgerussell63
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');

const handle = U.safeHandle(process.argv[2] || 'georgerussell63');
const dir = U.dataDir(handle);
const twPath = path.join(dir, 'tweets.jsonl');

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

if (!fs.existsSync(twPath)) { fail('找不到 ' + twPath); process.exit(1); }

const rows = U.readJsonl(twPath);
console.log(`数据目录：${dir}`);
console.log(`tweets.jsonl 行数：${rows.length}`);

const ids = new Set(rows.map((r) => r.id));
console.log(`唯一推文 id：${ids.size}${ids.size === rows.length ? '（无重复 ✓）' : '（有重复 ✗）'}`);
if (ids.size !== rows.length) fail('存在重复推文');

const kinds = {};
for (const r of rows) kinds[r.kind || '?'] = (kinds[r.kind || '?'] || 0) + 1;
console.log('类型分布：', JSON.stringify(kinds));

const withText = rows.filter((r) => (r.text || '').trim().length > 0).length;
const withTime = rows.filter((r) => r.time_iso).length;
const withMetrics = rows.filter((r) => r.metrics && (r.metrics.likes != null || r.metrics.views != null)).length;
const withMedia = rows.filter((r) => (r.media || []).length > 0);
const mediaCount = withMedia.reduce((a, r) => a + r.media.length, 0);
console.log(`有正文 ${withText}/${rows.length}｜有精确时间 ${withTime}/${rows.length}｜有互动数据 ${withMetrics}/${rows.length}`);
console.log(`带媒体 ${withMedia.length} 条，媒体条目 ${mediaCount} 条`);

// 图片落地情况
const imgDir = U.imagesDir(handle);
let files = [];
try { files = fs.readdirSync(imgDir); } catch (_) { files = []; }
const referenced = [];
for (const r of rows) for (const m of (r.media || [])) if (m.local) referenced.push(m.local.replace(/^images\//, ''));
const missing = referenced.filter((f) => !files.includes(f));
console.log(`图片目录文件数 ${files.length}｜数据里引用 ${referenced.length} 张｜缺失 ${missing.length} 张`);
if (referenced.length && missing.length === referenced.length) fail('所有图片都没下载下来');
else if (missing.length) console.log(`  （缺的那几张会在报告里自动回退成远程链接，例如 ${missing.slice(0, 2).join('、')}）`);
else if (referenced.length) ok('引用的图片全部已在本地');

if (!rows.length) fail('一条数据都没抓到');
if (rows.length && withText / rows.length < 0.5) fail('超过一半的记录没有正文，选择器可能失效');
if (rows.length && withTime / rows.length < 0.8) fail('时间字段缺失过多');

// 报告
const rep = U.reportPath(handle);
if (fs.existsSync(rep)) {
  const size = fs.statSync(rep).size;
  const html = fs.readFileSync(rep, 'utf8');
  ok(`报告存在：${rep}（${U.fmtBytes(size)}）`);
  if (size < 5000) fail('报告体积过小，可能是空页面');
  const first = rows[0];
  const probe = (first.text || '').slice(0, 18);
  if (probe && html.indexOf(probe) < 0) fail('报告里找不到第一条推文的正文片段');
  else if (probe) ok('报告里能找到推文正文（数据确实写进去了）');
} else {
  fail('报告 index.html 不存在');
}

// state.json
const st = U.readJsonSafe(U.statePath(handle), null);
console.log('state.json：', JSON.stringify(st));
if (!st) fail('state.json 不存在');

console.log('\n结果：' + (process.exitCode ? '有失败项' : '全部通过'));
