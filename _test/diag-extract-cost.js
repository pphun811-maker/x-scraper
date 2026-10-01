'use strict';
/**
 * 诊断脚本 2：产品每轮真正执行的三个注入脚本，在真实 x.com 上到底要跑多久？
 *   SCROLL_INFO / EXTRACT / CHECK_STOP（见 app/extract.js）
 *
 * 用法：node _test/diag-extract-cost.js <handle> <轮数>
 * 产物：_test/diag-cost-<时间戳>.jsonl
 *
 * 关键点：这里**故意把超时设得很大**（90~180 秒），目的是量出"真实耗时"而不是被
 * 30 秒的客户端超时截断 —— 区分「慢但能跑完」和「永远回不来」。
 *
 * 只做导航 + 滚轮 + 计时，不写 data\ 下任何产物。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');
const P = require('../app/extract');
const { CDP, version } = require('../app/cdp');

const HANDLE = U.safeHandle(process.argv[2] || 'georgerussell63');
const ROUNDS = Math.max(5, Number(process.argv[3] || 25));
const PORT = U.loadConfig().debugPort || U.DEFAULT_DEBUG_PORT;
const OUT = path.join(U.ROOT, '_test', `diag-cost-${U.ymd()}-${String(Date.now()).slice(-6)}.jsonl`);
const log = (m) => console.log(`   ${m}`);
const sleep = U.sleep;
const BIG = 180000;   // 量真实耗时，故意放宽

async function timed(cdp, expr, timeoutMs) {
  const t = Date.now();
  try {
    const v = await cdp.eval(expr, { timeoutMs });
    return { ms: Date.now() - t, ok: true, value: v };
  } catch (err) {
    return { ms: Date.now() - t, ok: false, err: err.message };
  }
}

async function main() {
  fs.writeFileSync(OUT, '', 'utf8');
  console.log(`=== 提取脚本成本实测：handle=${HANDLE} 轮数=${ROUNDS} ===`);
  console.log(`   采样文件：${OUT}`);

  if (await CH.portAlive(PORT)) {
    await CH.closeShadowBrowser(PORT, log);
    let w = 0;
    while (w < 20000 && await CH.portAlive(PORT)) { await sleep(1000); w += 1000; }
    if (await CH.portAlive(PORT)) throw new Error('旧浏览器没退出，中止');
  }

  const tL = Date.now();
  await CH.ensureBrowser({ mode: 'shadow', config: U.loadConfig(), visible: false, log });
  const launchMs = Date.now() - tL;
  log(`浏览器启动 ${launchMs} ms`);

  const page = await CH.openPage(PORT, 'about:blank', log);
  const cdp = page.cdp;
  await cdp.send('Performance.enable', {}, 8000).catch(() => {});

  const tN = Date.now();
  await CH.navigate(cdp, `https://x.com/${HANDLE}`, log, 60000);
  log(`导航 ${Date.now() - tN} ms`);

  let w = 0;
  while (w < 120000) {
    const probe = await timed(cdp, `document.querySelectorAll('article[data-testid="tweet"]').length`, 10000);
    if (probe.ok && probe.value > 0) break;
    await sleep(1500); w += 1500;
  }

  const m0 = await cdp.send('Performance.getMetrics', {}, 8000).catch(() => null);
  const taskOf = (m) => { const x = m && m.metrics && m.metrics.find((y) => y.name === 'TaskDuration'); return x ? Number(x.value) : null; };
  const nodesOf = (m) => { const x = m && m.metrics && m.metrics.find((y) => y.name === 'Nodes'); return x ? Number(x.value) : null; };
  const heapOf = (m) => { const x = m && m.metrics && m.metrics.find((y) => y.name === 'JSHeapUsedSize'); return x ? Number(x.value) : null; };
  const task0 = taskOf(m0);

  const dur = { SCROLL_INFO: [], EXTRACT: [], CHECK_STOP: [] };
  const rows = [];

  for (let i = 1; i <= ROUNDS; i += 1) {
    const r = { round: i, t: U.nowIso() };
    const t0 = Date.now();

    const si = await timed(cdp, P.SCROLL_INFO, BIG);
    r.scrollInfoMs = si.ms; r.scrollInfoErr = si.err || null;
    if (si.ok) dur.SCROLL_INFO.push(si.ms);
    r.articles = si.ok && si.value ? si.value.articles : null;
    r.scrollTop = si.ok && si.value ? si.value.scrollTop : null;
    r.scrollHeight = si.ok && si.value ? si.value.scrollHeight : null;
    r.spinner = si.ok && si.value ? si.value.spinner : null;

    const ex = await timed(cdp, P.EXTRACT, BIG);
    r.extractMs = ex.ms; r.extractErr = ex.err || null;
    if (ex.ok) { dur.EXTRACT.push(ex.ms); r.extracted = Array.isArray(ex.value) ? ex.value.length : null; }
    else r.extracted = null;

    const cs = await timed(cdp, P.CHECK_STOP, BIG);
    r.checkStopMs = cs.ms; r.checkStopErr = cs.err || null;
    if (cs.ok) dur.CHECK_STOP.push(cs.ms);

    // 每轮滚一次（真滚轮，和产品一致）
    const w0 = Date.now();
    try {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 700, button: 'none', modifiers: 0,
      }, 30000);
      r.wheelMs = Date.now() - w0;
    } catch (err) { r.wheelMs = -1; r.wheelErr = err.message; }

    if (i % 5 === 0) {
      const m = await cdp.send('Performance.getMetrics', {}, 10000).catch(() => null);
      const task = taskOf(m);
      if (task != null && task0 != null) r.perfTaskDelta = Number((task - task0).toFixed(2));
      r.nodes = nodesOf(m);
      r.heapMB = heapOf(m) != null ? Math.round(heapOf(m) / 1048576) : null;
      r.wallSec = Number(((Date.now() - t0) / 1000).toFixed(1));
    }

    r.roundMs = Date.now() - t0;
    rows.push(r);
    fs.appendFileSync(OUT, JSON.stringify(r) + '\n', 'utf8');
    console.log(`   #${String(i).padStart(2)} articles=${r.articles} | SCROLL_INFO ${r.scrollInfoMs}ms`
      + ` | EXTRACT ${r.extractMs}ms${r.extractErr ? ' <' + r.extractErr + '>' : ` (${r.extracted} 条)`}`
      + ` | CHECK_STOP ${r.checkStopMs}ms${r.checkStopErr ? ' <' + r.checkStopErr + '>' : ''}`
      + ` | wheel ${r.wheelMs}ms | 本轮 ${r.roundMs}ms`
      + `${r.perfTaskDelta != null ? ` | taskΔ=${r.perfTaskDelta}s nodes=${r.nodes} heap=${r.heapMB}MB` : ''}`);
    await sleep(1200);
  }

  const stat = (a) => {
    if (!a.length) return '全部超时/失败';
    const s = a.slice().sort((x, y) => x - y);
    return `n=${a.length} min=${s[0]}ms 中位=${s[Math.floor(s.length / 2)]}ms p90=${s[Math.floor(s.length * 0.9)]}ms max=${s[s.length - 1]}ms`;
  };
  console.log('\n=== 汇总（真实耗时，超时上限故意放到 180 秒）===');
  console.log(`   启动 ${launchMs}ms；共 ${ROUNDS} 轮`);
  console.log(`   SCROLL_INFO : ${stat(dur.SCROLL_INFO)}`);
  console.log(`   EXTRACT     : ${stat(dur.EXTRACT)}`);
  console.log(`   CHECK_STOP  : ${stat(dur.CHECK_STOP)}`);
  const anyTimeout = rows.filter((r) => r.scrollInfoErr || r.extractErr || r.checkStopErr);
  console.log(`   出现超时/失败的轮次：${anyTimeout.length ? JSON.stringify(anyTimeout.map((r) => ({ round: r.round, si: r.scrollInfoErr, ex: r.extractErr, cs: r.checkStopErr }))) : '（无）'}`);
  const worst = rows.reduce((a, b) => (a.roundMs > b.roundMs ? a : b), rows[0]);
  console.log(`   最慢一轮：#${worst.round} 共 ${worst.roundMs}ms（EXTRACT ${worst.extractMs}ms）`);
  const exTop = rows.slice().sort((a, b) => b.extractMs - a.extractMs).slice(0, 5)
    .map((r) => `#${r.round}:${r.extractMs}ms/${r.articles}篇`);
  console.log(`   EXTRACT 最慢 5 轮：${exTop.join('  ')}`);

  fs.appendFileSync(OUT, JSON.stringify({
    summary: true, handle: HANDLE, rounds: ROUNDS, launchMs,
    stats: {
      SCROLL_INFO: dur.SCROLL_INFO, EXTRACT: dur.EXTRACT, CHECK_STOP: dur.CHECK_STOP,
    },
    timeouts: anyTimeout.map((r) => ({ round: r.round, si: r.scrollInfoErr, ex: r.extractErr, cs: r.checkStopErr })),
    worstRound: { round: worst.round, roundMs: worst.roundMs, extractMs: worst.extractMs },
  }) + '\n', 'utf8');

  await CH.closeShadowBrowser(PORT, log);
  console.log(`   采样文件：${OUT}`);
}

main().catch((err) => { console.error('诊断异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
