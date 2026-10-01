'use strict';
/**
 * 看门狗集成测试：页面卡住时，产品代码真的能发现并自救吗？
 *
 * 背景（2026-09-29 真实事故）：副本浏览器实例不健康时，`Runtime.evaluate` 会连续 30 秒超时，
 * 老版本一路 `页面操作失败（已忽略）` 硬撑 13 分钟、一条都没抓到，日志里只留下"新增 0 条"。
 * 现在加了看门狗：连续 N 次读不到页面 → 重载页面 → 再不行重启浏览器 → 还是不行就明确报错。
 *
 * 这个测试**不碰真 X**：用 `_test/fake-timeline.html`（先跑 make-fixture.js 生成），
 * 在页面里注入一段"主线程死循环"来模拟卡死，然后调用**产品代码里真实的**
 * Runner.safeEval / notePageFailure / decideRecovery / recover / closePageCdp。
 *
 * 用法：node _test/test-watchdog.js
 * 副作用：会启动/关闭一个测试用 Chrome（端口 9333，配置目录 _test\profile）。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');
const { Runner, decideRecovery } = require('../app/scraper');

const PORT = 9333;
const PROFILE_DIR = path.join(U.ROOT, '_test', 'profile');
const PAGE_FILE = path.join(U.ROOT, '_test', 'fake-timeline.html');
const PAGE_URL = 'file:///' + PAGE_FILE.replace(/\\/g, '/');

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

/** 让页面主线程死循环 ms 毫秒（异步触发，注入调用本身会立刻返回） */
const busyLoop = (ms) => `(() => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < ${ms}) { /* 冻住主线程 */ } }, 50); return 'scheduled'; })()`;

async function main() {
  if (!fs.existsSync(PAGE_FILE)) throw new Error('先运行 make-fixture.js 生成测试页面');
  U.ensureDir(PROFILE_DIR);

  console.log('--- 0. 纯函数判定（和产品同一份 decideRecovery）---');
  const cases = [
    [{ consecutiveFailures: 0, recoveries: 0 }, 'continue'],
    [{ consecutiveFailures: 2, recoveries: 0 }, 'continue'],
    [{ consecutiveFailures: 3, recoveries: 0 }, 'reload'],
    [{ consecutiveFailures: 3, recoveries: 1 }, 'restart'],
    [{ consecutiveFailures: 3, recoveries: 2 }, 'abort'],
    [{ consecutiveFailures: 3, recoveries: 2, stuckAfter: 3, maxRecoveries: 4 }, 'reload'],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = decideRecovery(input).action;
    if (got !== want) { bad += 1; fail(`${JSON.stringify(input)} → ${got}（期望 ${want}）`); }
  }
  if (!bad) ok(`decideRecovery ${cases.length} 组边界全部正确`);

  console.log('--- 1. 启动测试浏览器 ---');
  if (await CH.portAlive(PORT)) await CH.closeShadowBrowser(PORT, () => {});
  CH.launchShadowChrome({ port: PORT, profileDir: PROFILE_DIR, url: PAGE_URL, visible: false });
  if (!await CH.waitPort(PORT, 60000, (m) => console.log('   ' + m))) throw new Error('调试端口没起来');
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  await CH.navigate(page.cdp, PAGE_URL, () => {});
  await CH.waitFor(page.cdp, `document.querySelectorAll('article[data-testid="tweet"]').length > 0`, 20000, 500, '假推文出现');
  ok('测试页面已就绪');

  // 用真实的 Runner 实例，只把 URL 换成测试页面（看门狗逻辑本身不动）
  const r = new Runner();
  r.T = U.loadTimeouts();
  r.T.effective = Object.assign({}, r.T.effective, { evalMs: 1500, responsiveMs: 30000, renderWaitMs: 20000, navigateMs: 20000 });
  r.port = PORT;
  r.mode = 'shadow';
  r.config = U.loadConfig();
  r.cdp = page.cdp;
  r.handle = 'fakehandle';
  r.tab = 'posts';
  r.urlFor = () => PAGE_URL;          // 只替换 URL，其余走产品代码
  r.log = () => {};                   // 测试里安静点

  console.log('--- 2. 健康页面：连读 3 次应当成功、计数归零 ---');
  let healthOk = true;
  for (let i = 0; i < 3; i += 1) {
    const v = await r.safeEval(`document.querySelectorAll('article[data-testid="tweet"]').length`);
    if (!v) healthOk = false;
  }
  if (!healthOk) fail('健康页面上读取失败，测试前提不成立');
  else if (r.consecutiveFailures !== 0) fail(`健康页面却累计了失败次数 ${r.consecutiveFailures}`);
  else ok('健康页面连续读取正常，consecutiveFailures = 0');

  console.log('--- 3. 注入 12 秒主线程死循环 → 看门狗必须发现 ---');
  await page.cdp.eval(busyLoop(12000), { timeoutMs: 5000 }).catch(() => {});
  await U.sleep(300);
  const t0 = Date.now();
  for (let i = 0; i < 3; i += 1) {
    const v = await r.safeEval('1+1');               // 每次 1.5 秒超时
    if (v !== null) console.log(`   （第 ${i + 1} 次竟然读到了 ${v}，继续）`);
  }
  const elapsed = Date.now() - t0;
  if (r.consecutiveFailures < r.T.effective.stuckAfter) {
    fail(`死循环期间只累计了 ${r.consecutiveFailures} 次失败（阈值 ${r.T.effective.stuckAfter}）`);
  } else {
    ok(`页面卡住被识别：连续失败 ${r.consecutiveFailures} 次（耗时 ${Math.round(elapsed / 1000)} 秒，不用等 30 秒才反应）`);
  }
  const decision = decideRecovery({
    consecutiveFailures: r.consecutiveFailures,
    recoveries: r.recoveries,
    stuckAfter: r.T.effective.stuckAfter,
    maxRecoveries: r.T.effective.maxRecoveries,
  });
  if (decision.action !== 'reload') fail(`第一次自救应当是 reload，实际 ${decision.action}`);
  else ok('第一次自救动作为「重载页面」');

  console.log('--- 4. 真的执行自救（产品代码的 recover()）---');
  const before = Date.now();
  await r.recover(decision, { handle: 'fakehandle', tab: 'posts' });
  const recoverMs = Date.now() - before;
  if (r.recoveries !== 1) fail(`recoveries 应为 1，实际 ${r.recoveries}`);
  else ok(`自救完成（用时 ${Math.round(recoverMs / 1000)} 秒），recoveries = 1、consecutiveFailures = ${r.consecutiveFailures}`);
  const after = await r.safeEval(`document.querySelectorAll('article[data-testid="tweet"]').length`);
  if (!after) fail('自救后页面仍然读不到推文');
  else ok(`自救后页面恢复：读到 ${after} 条假推文，连续失败计数已归零（${r.consecutiveFailures}）`);

  console.log('--- 5. 自救次数用尽后必须"明确报错停下"，而不是继续硬撑 ---');
  r.recoveries = r.T.effective.maxRecoveries;
  const abort = decideRecovery({
    consecutiveFailures: r.T.effective.stuckAfter,
    recoveries: r.recoveries,
    stuckAfter: r.T.effective.stuckAfter,
    maxRecoveries: r.T.effective.maxRecoveries,
  });
  if (abort.action !== 'abort') fail(`自救用尽时应为 abort，实际 ${abort.action}`);
  else {
    let thrown = null;
    try { await r.recover(abort, { handle: 'fakehandle', tab: 'posts' }); } catch (err) { thrown = err; }
    if (!thrown) fail('abort 分支没有抛错，任务会静默继续');
    else if (!/页面长时间没有响应/.test(thrown.message)) fail('报错信息不够清楚：' + thrown.message);
    else ok('abort 分支抛出可读错误：' + thrown.message.slice(0, 40) + '…');
  }

  console.log('--- 6. 页面调试连接必须被显式关闭 ---');
  r.closePageCdp();
  if (r.cdp !== null) fail('closePageCdp 之后 this.cdp 不为 null');
  else ok('closePageCdp 已把页面级调试连接置空（这是旧版本漏掉、导致 Chrome 退不干净的那一步）');

  console.log('--- 7. 关闭浏览器并确认真的关掉了 ---');
  const closed = await CH.closeShadowBrowser(PORT, (m) => console.log('   ' + m));
  await U.sleep(1500);
  const alive = await CH.portAlive(PORT);
  if (!closed || alive) fail('副本浏览器没有关干净（closeShadowBrowser 没能确认端口消失）');
  else ok('closeShadowBrowser 返回值与端口状态一致：已确认关闭');

  console.log('\n结果：' + (process.exitCode ? '有失败项，见上面的 ✗' : '全部通过'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
