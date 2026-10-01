// 续抓搜索页 URL 纯函数自测（离线，不开浏览器不碰面板）。
// 覆盖：buildResumeSearchUrl（补更早，until）+ buildNewPostsSearchUrl（补最新，since）。
// 运行：node _test/test-resume-urls.js
const assert = require('assert');
const S = require('../app/scraper.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const mapOf = (recs) => new Map(recs.map((r, i) => [String(i), r]));
// 用本地时区构造时间戳的 ISO 串（让"本地日期是几号"与运行环境无关）
const localIso = (y, mo, d, hh = 12, mi = 0) => new Date(y, mo - 1, d, hh, mi).toISOString();

// ---------- buildResumeSearchUrl（补更早） ----------
console.log('1) buildResumeSearchUrl（补更早，until 边界）');
{
  const recs = mapOf([
    { time_iso: '2020-07-02T11:22:33.000Z' },
    { time_iso: '2019-10-27T08:00:00.000Z' },
  ]);
  const url = S.buildNewPostsSearchUrl && S.buildResumeSearchUrl(recs, 'alice');
  ok(url && url.includes('until=') === false && decodeURIComponent(url).includes('until:2019-10-28'),
    '取最老记录日期+1 天作 until（2019-10-27 → until:2019-10-28）');
  ok(decodeURIComponent(url).includes('from:alice'), '带 from:handle');
  ok(url.endsWith('&f=live'), '带 f=live（最新标签）');
}
{
  // 最老记录当天晚间的推文也要能被 until 盖住（+1 天的由来；until 用本地日期）
  const recs = mapOf([{ time_iso: localIso(2011, 10, 22, 23, 59) }]);
  const url = S.buildResumeSearchUrl(recs, 'bob');
  ok(decodeURIComponent(url).includes('until:2011-10-23'), '最老记录本地当天 23:59 → until 仍是次日（盖住全天）');
}
{
  const url = S.buildResumeSearchUrl(mapOf([{ time_iso: '2020-01-01T00:00:00Z' }]), 'alice', { excludeReplies: true });
  ok(decodeURIComponent(url).includes('-filter:replies'), 'posts 模式带 -filter:replies');
  const url2 = S.buildResumeSearchUrl(mapOf([{ time_iso: '2020-01-01T00:00:00Z' }]), 'alice');
  ok(!decodeURIComponent(url2).includes('-filter:replies'), 'with_replies 模式不带 -filter:replies');
}
ok(S.buildResumeSearchUrl(mapOf([{ text: '没有时间戳' }]), 'alice') === null, '无时间戳记录 → null');
ok(S.buildResumeSearchUrl(new Map(), 'alice') === null, '空记录 → null');
ok(S.buildResumeSearchUrl(mapOf([{ time_iso: '2020-01-01T00:00:00Z' }]), '') === null, '无 handle → null');

// ---------- buildNewPostsSearchUrl（补最新） ----------
console.log('2) buildNewPostsSearchUrl（补最新，since 边界）');
{
  const recs = mapOf([
    { time_iso: '2026-09-28T09:30:00.000Z' },
    { time_iso: '2020-01-01T00:00:00.000Z' },
    { time_iso: '2024-06-15T12:00:00.000Z' },
  ]);
  const url = S.buildNewPostsSearchUrl(recs, 'georgerussell63');
  ok(!!url, '正常返回 URL');
  ok(decodeURIComponent(url).includes('since:2026-09-28'), '取最新记录日期（不加 1 天）作 since');
  ok(decodeURIComponent(url).includes('from:georgerussell63'), '带 from:handle');
  ok(url.endsWith('&f=live'), '带 f=live');
  ok(!url.includes('until'), '不含 until（两阶段各管一个方向）');
}
{
  // since 用 UTC 日期：UTC 当天更晚的推文必须盖住（北京 16:00 后发的推文 UTC 还是当天）
  const recs = mapOf([
    { time_iso: '2026-09-28T09:00:00.000Z' },
    { time_iso: '2026-09-28T21:00:00.000Z' },
  ]);
  const url = S.buildNewPostsSearchUrl(recs, 'bob');
  ok(decodeURIComponent(url).includes('since:2026-09-28'), '最新记录 UTC 当天 21:00 → since 仍是当日（UTC 日期不留缺口）');
}
{
  const url = S.buildNewPostsSearchUrl(mapOf([{ time_iso: '2026-01-01T00:00:00Z' }]), 'alice', { excludeReplies: true });
  ok(decodeURIComponent(url).includes('-filter:replies'), 'posts 模式带 -filter:replies');
}
ok(S.buildNewPostsSearchUrl(new Map(), 'alice') === null, '空记录 → null');
ok(S.buildNewPostsSearchUrl(mapOf([{ text: '乱数据' }]), 'alice') === null, '无时间戳 → null');

// ---------- 两阶段不相交性（补最新 ∩ 补更早 = ∅ 的边界自洽） ----------
console.log('3) 两阶段边界自洽');
{
  // 最老 2011-10-22 / 最新 2026-09-28：until:2011-10-23 只收 ≤2011-10-22，since:2026-09-28 只收 ≥2026-09-28
  const recs = mapOf([
    { time_iso: '2011-10-22T15:00:00.000Z' },
    { time_iso: '2026-09-28T09:30:00.000Z' },
  ]);
  const older = decodeURIComponent(S.buildResumeSearchUrl(recs, 'gr'));
  const newer = decodeURIComponent(S.buildNewPostsSearchUrl(recs, 'gr'));
  ok(older.includes('until:2011-10-23') && newer.includes('since:2026-09-28'),
    'until 与 since 边界互不重叠（中间已知区域不重扫）');
}

console.log(`\n续抓 URL 自测：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
