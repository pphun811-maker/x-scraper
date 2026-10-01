'use strict';
/**
 * 诊断脚本：真实 x.com 页面上 Runtime.evaluate 为什么会反复 30 秒超时？
 *
 * 用法：node _test/diag-live-freeze.js <handle> <seconds> <visible:0|1>
 * 产物：_test/diag-freeze-<时间戳>-<offscreen|onscreen>.jsonl（每行一个采样点）
 *
 * 只做「导航 + 滚轮 + 测量」，**不写 data\ 下任何产物**（不抓取、不下载、不生成报告）。
 *
 * 关键测量：
 *   1) evalMs            —— Runtime.evaluate 往返耗时（>5000 = 超时）
 *   2) hbMax / hbStale   —— 页面内 250ms 心跳的最大间隔 / 距上次心跳多久
 *                            （直接测出渲染进程主线程被"冻住"了多长时间）
 *   3) perfTask          —— Performance.getMetrics 的 TaskDuration 增量
 *                            （主线程真的在跑 JS？还是根本没跑）
 *   4) rendererCpu       —— SystemInfo.getProcessInfo 里渲染进程的 CPU 时间增量
 *   5) lifecycle 事件     —— Chrome 是否把页面标记为 hidden / frozen
 *   6) vis/hidden/focus  —— 页面自己看到的可见性
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');
const { CDP, version } = require('../app/cdp');

const HANDLE = U.safeHandle(process.argv[2] || 'georgerussell63');
const SECONDS = Math.max(20, Number(process.argv[3] || 70));
const VISIBLE = process.argv[4] === '1';
const PORT = U.loadConfig().debugPort || U.DEFAULT_DEBUG_PORT;
const STAMP = `${U.ymd()}-${String(Date.now()).slice(-6)}-${VISIBLE ? 'onscreen' : 'offscreen'}`;
const OUT = path.join(U.ROOT, '_test', `diag-freeze-${STAMP}.jsonl`);
const log = (m) => console.log(`   ${m}`);
const sleep = U.sleep;

/** 页面内 250ms 心跳：主线程被冻住时，心跳会直接停/出现巨大间隔 */
const HB_INSTALL = `(() => {
  if (window.__hb) return 'exists';
  const st = { t: [], max: 0, ticks: 0, visLog: [] };
  window.__hb = st;
  let last = performance.now();
  window.__hbTimer = setInterval(function () {
    const now = performance.now();
    const gap = now - last; last = now;
    st.ticks += 1;
    if (gap > st.max) st.max = gap;
    st.t.push(now);
    if (st.t.length > 3000) st.t.splice(0, 1500);
  }, 250);
  document.addEventListener('visibilitychange', function () {
    st.visLog.push([Math.round(performance.now()), document.visibilityState]);
  });
  return 'installed';
})()`;

const PROBE = `(() => {
  const hb = window.__hb || { t: [], max: -1, ticks: -1, visLog: [] };
  const last = hb.t.length ? hb.t[hb.t.length - 1] : null;
  return {
    url: location.href,
    readyState: document.readyState,
    vis: document.visibilityState,
    hidden: !!document.hidden,
    focus: (typeof document.hasFocus === 'function') ? document.hasFocus() : null,
    tweets: document.querySelectorAll('article[data-testid="tweet"]').length,
    scrollY: Math.round(window.scrollY || 0),
    scrollHeight: Math.round(document.documentElement ? document.documentElement.scrollHeight : 0),
    hbMax: Math.round(hb.max),
    hbStale: last == null ? -1 : Math.round(performance.now() - last),
    hbTicks: hb.ticks,
    visLog: hb.visLog
  };
})()`;

async function safeSend(cdp, method, params, timeoutMs) {
  try { return await cdp.send(method, params, timeoutMs); } catch (err) { return { __err: err.message }; }
}

async function main() {
  fs.writeFileSync(OUT, '', 'utf8');
  console.log(`=== 诊断开始：handle=${HANDLE} 时长=${SECONDS}s 窗口=${VISIBLE ? '屏幕内(120,80)' : '屏幕外(-3200,-3200)'} ===`);
  console.log(`   采样文件：${OUT}`);

  // 0. 保证从"干净的浏览器实例"开始
  if (await CH.portAlive(PORT)) {
    log(`端口 ${PORT} 上已有浏览器，先关掉它以保证干净起点…`);
    await CH.closeShadowBrowser(PORT, log);
    let waited = 0;
    while (waited < 20000 && await CH.portAlive(PORT)) { await sleep(1000); waited += 1000; }
    if (await CH.portAlive(PORT)) throw new Error('旧浏览器 20 秒内没有退出，为避免两个实例抢同一个配置目录，本次中止');
    log('旧浏览器已退出');
  }

  // 1. 启动副本浏览器
  const tLaunch = Date.now();
  await CH.ensureBrowser({ mode: 'shadow', config: U.loadConfig(), visible: VISIBLE, log });
  const launchMs = Date.now() - tLaunch;
  log(`浏览器启动耗时 ${launchMs} ms（正常 4 秒以内；这是本次要对比的指标之一）`);

  const page = await CH.openPage(PORT, 'about:blank', log);
  const cdp = page.cdp;
  const events = [];

  // 事件监听：崩溃 / 弹窗 / 生命周期（hidden、frozen 会在这里现形）
  cdp.on('Inspector.targetCrashed', (p) => { events.push({ t: U.nowIso(), ev: 'targetCrashed', p }); });
  cdp.on('Inspector.detached', (p) => { events.push({ t: U.nowIso(), ev: 'detached', p }); });
  cdp.on('Page.javascriptDialogOpening', (p) => { events.push({ t: U.nowIso(), ev: 'dialogOpening', p }); });
  cdp.on('Page.lifecycleEvent', (p) => {
    const n = p && p.name;
    if (n === 'hidden' || n === 'frozen' || n === 'visible' || n === 'resumed') {
      events.push({ t: U.nowIso(), ev: 'lifecycle', name: n, frame: p.frameId });
    }
  });
  await safeSend(cdp, 'Page.setLifecycleEventsEnabled', { enabled: true }, 8000);
  await safeSend(cdp, 'Inspector.enable', {}, 8000);
  await safeSend(cdp, 'Performance.enable', {}, 8000);

  // 浏览器级连接：拿渲染进程 CPU 时间
  let bcdp = null;
  try {
    const v = await version(PORT, 5000);
    bcdp = new CDP(v.webSocketDebuggerUrl, 'browser');
    await bcdp.connect(8000);
    await safeSend(bcdp, 'SystemInfo.enable', {}, 5000);
  } catch (err) { log(`浏览器级连接失败（不影响主流程）：${err.message}`); bcdp = null; }

  // 2. 导航到目标主页
  const tNav = Date.now();
  await CH.navigate(cdp, `https://x.com/${HANDLE}`, log, 60000);
  const navMs = Date.now() - tNav;
  log(`导航耗时 ${navMs} ms`);

  // 等页面出现推文（最多 120 秒，记录实际等了多久）
  const tWait = Date.now();
  let firstTweets = 0;
  while (Date.now() - tWait < 120000) {
    try {
      firstTweets = await cdp.eval(`document.querySelectorAll('article[data-testid="tweet"]').length`, { timeoutMs: 8000 });
      if (firstTweets > 0) break;
    } catch (_) { /* 页面还在渲染 */ }
    await sleep(1500);
  }
  const tweetWaitMs = Date.now() - tWait;
  log(`首屏推文出现：${firstTweets} 条，等待 ${tweetWaitMs} ms`);

  await safeSend(cdp, 'Runtime.evaluate', { expression: HB_INSTALL, returnByValue: true }, 8000);
  let perf0 = await safeSend(cdp, 'Performance.getMetrics', {}, 8000);
  let proc0 = bcdp ? await safeSend(bcdp, 'SystemInfo.getProcessInfo', {}, 8000) : null;
  const task0 = metricOf(perf0, 'TaskDuration');
  const cpu0 = rendererCpu(proc0);

  // 3. 采样 + 滚轮
  const t0 = Date.now();
  let samples = 0, timeouts = 0, probeTimeouts = 0, wheelFails = 0, lastScrollAt = 0, scrolls = 0;
  let maxEvalMs = 0, maxHbStale = 0, maxHbMax = 0, lastY = 0, maxY = 0, tweetsSeen = 0;
  const visStates = new Set();

  while ((Date.now() - t0) / 1000 < SECONDS) {
    const s = { t: U.nowIso(), ms: Date.now() - t0 };

    // (1) 最小 evaluate：测往返延迟
    const e0 = Date.now();
    const ping = await safeSend(cdp, 'Runtime.evaluate', { expression: '1+1', returnByValue: true }, 5000);
    s.evalMs = ping && ping.__err ? -1 : (Date.now() - e0);
    if (ping && ping.__err) { s.evalErr = ping.__err; timeouts += 1; }
    if (s.evalMs > maxEvalMs) maxEvalMs = s.evalMs;

    // (2) 状态探针
    const p0 = Date.now();
    const probe = await safeSend(cdp, 'Runtime.evaluate', { expression: PROBE, returnByValue: true }, 5000);
    if (probe && probe.__err) { probeTimeouts += 1; s.probeErr = probe.__err; }
    else if (probe && probe.result && probe.result.value) {
      const v = probe.result.value;
      s.probeMs = Date.now() - p0;
      s.vis = v.vis; s.hidden = v.hidden; s.focus = v.focus;
      s.tweets = v.tweets; s.scrollY = v.scrollY; s.scrollHeight = v.scrollHeight;
      s.hbMax = v.hbMax; s.hbStale = v.hbStale; s.hbTicks = v.hbTicks;
      s.readyState = v.readyState; s.url = v.url;
      if (v.visLog && v.visLog.length) s.visLog = v.visLog;
      visStates.add(v.vis);
      if (v.hbMax > maxHbMax) maxHbMax = v.hbMax;
      if (v.hbStale > maxHbStale) maxHbStale = v.hbStale;
      if (v.tweets > tweetsSeen) tweetsSeen = v.tweets;
      maxY = Math.max(maxY, v.scrollY);
    }

    // (3) 每 3 秒滚一次（和产品同样的真滚轮事件）
    if (Date.now() - t0 - lastScrollAt >= 3000) {
      lastScrollAt = Date.now() - t0;
      const w0 = Date.now();
      const w = await safeSend(cdp, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: 700, button: 'none', modifiers: 0,
      }, 8000);
      s.wheelMs = w && w.__err ? -1 : (Date.now() - w0);
      if (w && w.__err) { s.wheelErr = w.__err; wheelFails += 1; }
      s.scrolls = ++scrolls;
    }

    // (4) 每 10 秒取一次主线程/进程指标
    if (samples % 5 === 0) {
      const perf = await safeSend(cdp, 'Performance.getMetrics', {}, 6000);
      const proc = bcdp ? await safeSend(bcdp, 'SystemInfo.getProcessInfo', {}, 6000) : null;
      const task = metricOf(perf, 'TaskDuration');
      const cpu = rendererCpu(proc);
      if (task != null && task0 != null) s.perfTaskDelta = Number((task - task0).toFixed(2));
      if (cpu != null && cpu0 != null) s.rendererCpuDelta = Number((cpu - cpu0).toFixed(2));
      const nodes = metricOf(perf, 'Nodes');
      const heap = metricOf(perf, 'JSHeapUsedSize');
      if (nodes != null) s.nodes = nodes;
      if (heap != null) s.heapMB = Math.round(heap / 1048576);
      s.wallSec = Number(((Date.now() - t0) / 1000).toFixed(1));
    }

    fs.appendFileSync(OUT, JSON.stringify(s) + '\n', 'utf8');
    samples += 1;
    console.log(`   [${String(s.ms).padStart(5)}ms] eval=${s.evalMs === -1 ? '超时' : s.evalMs + 'ms'}`
      + ` hbMax=${s.hbMax == null ? '?' : s.hbMax} hbStale=${s.hbStale == null ? '?' : s.hbStale}`
      + ` tweets=${s.tweets == null ? '?' : s.tweets} y=${s.scrollY == null ? '?' : s.scrollY}`
      + ` vis=${s.vis || '?'}${s.perfTaskDelta != null ? ` taskΔ=${s.perfTaskDelta}s` : ''}`
      + `${s.rendererCpuDelta != null ? ` cpuΔ=${s.rendererCpuDelta}s` : ''}`
      + `${s.evalErr ? ` <${s.evalErr}>` : ''}${s.wheelErr ? ` <wheel:${s.wheelErr}>` : ''}${s.probeErr ? ` <probe:${s.probeErr}>` : ''}`);
    await sleep(2000);
  }

  const wallSec = (Date.now() - t0) / 1000;
  const perfEnd = await safeSend(cdp, 'Performance.getMetrics', {}, 8000);
  const taskEnd = metricOf(perfEnd, 'TaskDuration');
  const totalTask = (taskEnd != null && task0 != null) ? Number((taskEnd - task0).toFixed(1)) : null;

  console.log('\n=== 汇总 ===');
  console.log(`   采样 ${samples} 次，用时 ${Math.round(wallSec)}s`);
  console.log(`   启动 ${launchMs}ms｜导航 ${navMs}ms｜首屏推文等待 ${tweetWaitMs}ms（首屏 ${firstTweets} 条）`);
  console.log(`   evaluate 超时次数 = ${timeouts}（另外探针超时 ${probeTimeouts} 次），最大单次往返 ${maxEvalMs}ms`);
  console.log(`   滚轮 ${scrolls} 次，失败 ${wheelFails} 次；最大 scrollY=${maxY}，DOM 里最多见到 ${tweetsSeen} 条推文`);
  console.log(`   主线程心跳最大间隔 hbMax=${maxHbMax}ms，最长"心跳停摆" hbStale=${maxHbStale}ms`);
  console.log(`   visibilityState 取值 = ${[...visStates].join(',') || '(没读到)'}`);
  console.log(`   主线程 JS 忙时 TaskDuration 总计 = ${totalTask}s / 墙钟 ${Math.round(wallSec)}s`);
  console.log(`   事件：${events.length ? JSON.stringify(events.slice(0, 12)) : '（无崩溃/弹窗/生命周期异常）'}`);

  // 4. 收尾：关掉浏览器，看能不能干净关掉
  const tClose = Date.now();
  await CH.closeShadowBrowser(PORT, log);
  let waited = 0;
  while (waited < 15000 && await CH.portAlive(PORT)) { await sleep(1000); waited += 1000; }
  const stillUp = await CH.portAlive(PORT);
  console.log(`   关闭副本浏览器：${stillUp ? '❌ 15 秒后端口仍在监听（关不掉！）' : `✅ 已关闭（${Date.now() - tClose}ms）`}`);

  fs.appendFileSync(OUT, JSON.stringify({
    summary: true, handle: HANDLE, visible: VISIBLE, launchMs, navMs, tweetWaitMs, firstTweets,
    samples, timeouts, probeTimeouts, wheelFails, scrolls, maxEvalMs, maxHbStale, maxHbMax,
    visStates: [...visStates], totalTaskSec: totalTask, wallSec: Math.round(wallSec),
    closedCleanly: !stillUp, events,
  }) + '\n', 'utf8');
  console.log(`   采样文件已写入：${OUT}`);
}

function metricOf(perf, name) {
  if (!perf || perf.__err || !perf.metrics) return null;
  const m = perf.metrics.find((x) => x.name === name);
  return m ? Number(m.value) : null;
}

/** 累加所有 renderer 进程的 CPU 秒数 */
function rendererCpu(proc) {
  if (!proc || proc.__err || !Array.isArray(proc.processInfo)) return null;
  let sum = 0;
  for (const p of proc.processInfo) if (p && p.type === 'renderer') sum += Number(p.cpuTime || 0);
  return Number(sum.toFixed(2));
}

main().catch((err) => {
  console.error('诊断异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
