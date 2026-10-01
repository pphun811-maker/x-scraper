'use strict';
/**
 * 端到端自测：不碰真 X，用假时间线验证
 *   Chrome 启动 -> 调试端口连接 -> 真滚轮滚动 -> DOM 提取 -> 到底判定 -> 停止信号双向验证
 * 注意：滚动/到底的判定调用的是产品代码里的 evaluateProgress，测的就是真正会跑的那份逻辑。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');
const P = require('../app/extract');
const { evaluateProgress } = require('../app/scraper');

const PORT = 9333;
const TEST_DIR = path.join(U.ROOT, '_test');
const PROFILE_DIR = path.join(TEST_DIR, 'profile');
const PAGE_FILE = path.join(TEST_DIR, 'fake-timeline.html');
const PAGE_URL = 'file:///' + PAGE_FILE.replace(/\\/g, '/');
const EXPECTED = 260;
const CFG = U.SPEED.fast;

const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('✓ ' + msg);

async function main() {
  if (!fs.existsSync(PAGE_FILE)) throw new Error('先运行 make-fixture.js 生成测试页面');
  U.ensureDir(PROFILE_DIR);

  console.log('--- 1. 启动影子 Chrome（测试用独立配置目录）---');
  CH.launchShadowChrome({ port: PORT, profileDir: PROFILE_DIR, url: PAGE_URL, visible: false });
  const up = await CH.waitPort(PORT, 60000, (m) => console.log('   ' + m));
  if (!up) throw new Error('调试端口没起来');
  ok(`调试端口 ${PORT} 已就绪；Chrome 版本 ${CH.chromeVersion()}`);

  console.log('--- 2. 打开页面并连接 CDP ---');
  const page = await CH.openPage(PORT, 'about:blank', (m) => console.log('   ' + m));
  await CH.navigate(page.cdp, PAGE_URL, (m) => console.log('   ' + m));
  await CH.waitFor(page.cdp, `document.querySelectorAll('article[data-testid="tweet"]').length > 0`, 20000, 500, '假推文出现');
  const wd = await page.cdp.eval('navigator.webdriver');
  ok(`页面已渲染；navigator.webdriver = ${wd}（必须是 false 或 undefined）`);
  if (wd) fail('navigator.webdriver 为真，自动化指纹暴露');

  console.log('--- 3. 真滚轮滚动 + 提取主循环（与产品同一份判定逻辑）---');
  const seen = new Set();
  let rounds = 0;
  let wheelFallback = 0;
  let lastHeight = 0;
  let endRounds = 0;
  let stuckRounds = 0;
  let firstSample = null;
  let stopSignalFalseAlarm = false;
  let stopReason = '（达到测试轮数上限）';

  const harvest = async () => {
    const batch = (await page.cdp.eval(P.EXTRACT)) || [];
    let added = 0;
    for (const t of batch) {
      if (!t.id) continue;
      if (!seen.has(t.id)) {
        seen.add(t.id);
        added += 1;
        if (!firstSample && t.kind === 'retweet') firstSample = t;
      }
    }
    return added;
  };

  await harvest();

  while (rounds < 600) {
    const before = (await page.cdp.eval(P.SCROLL_INFO)) || {};
    const delta = U.randInt(CFG.scrollDelta[0], CFG.scrollDelta[1]);
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400, button: 'none' });
    await page.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: delta, button: 'none', modifiers: 0,
    });
    rounds += 1;
    await U.sleep(90);

    let after = (await page.cdp.eval(P.SCROLL_INFO)) || {};
    let scrolledNow = (after.scrollTop || 0) > (before.scrollTop || 0);
    if (!scrolledNow) {
      wheelFallback += 1;
      await page.cdp.eval(P.scrollByExpr(delta));
      await U.sleep(120);
      after = (await page.cdp.eval(P.SCROLL_INFO)) || after;
      scrolledNow = (after.scrollTop || 0) > (before.scrollTop || 0);
    }

    const gained = await harvest();
    const heightGrew = (after.scrollHeight || 0) > lastHeight + 24;
    if (after.scrollHeight) lastHeight = after.scrollHeight;

    if (rounds % 5 === 0) {
      const sig = await page.cdp.eval(P.CHECK_STOP);
      if (sig && sig.stop) { stopSignalFalseAlarm = true; fail('停止信号被推文正文误触发：' + sig.reasons.join(',')); }
      if (sig && sig.loggedOut) fail('登录检测在普通页面上误判为已登出');
    }

    const verdict = evaluateProgress({
      gained,
      heightGrew,
      atBottom: !!after.atBottom,
      spinner: !!after.spinner,
      scrolled: scrolledNow,
      endRounds,
      stuckRounds,
      cfg: CFG,
    });
    endRounds = verdict.endRounds;
    stuckRounds = verdict.stuckRounds;
    if (verdict.stop) { stopReason = verdict.reason; break; }
  }

  ok(`滚动 ${rounds} 次，抓到 ${seen.size}/${EXPECTED} 条，判定停止原因：${stopReason}`);
  ok(`滚轮无效、走后备方案 ${wheelFallback} 次；滚动容器是 document = ${(await page.cdp.eval(P.SCROLL_INFO)).scrollerIsWindow}`);
  if (seen.size < EXPECTED) fail(`漏抓了 ${EXPECTED - seen.size} 条`);
  if (wheelFallback > rounds * 0.2) fail('滚轮事件经常不生效，后备方案用得太频繁');
  if (stopSignalFalseAlarm) fail('停止信号出现误判');
  if (!/划到底/.test(stopReason)) fail('没有正确判定为"划到底"：' + stopReason);

  console.log('--- 3.5 停止信号与长文展开的正向验证 ---');
  const beforeExpand = await page.cdp.eval(`document.querySelectorAll('[data-testid="tweet-text-show-more-link"]').length`);
  const expanded = await page.cdp.eval(P.EXPAND);
  await U.sleep(120);
  const afterExpand = await page.cdp.eval(`document.querySelectorAll('[data-testid="tweet-text-show-more-link"]').length`);
  ok(`长文「显示更多」：点击前 ${beforeExpand} 个，点击了 ${expanded} 个，点击后剩 ${afterExpand} 个`);
  if (!beforeExpand) fail('夹具里没有生成"显示更多"链接，这条没验证到');
  else if (afterExpand !== 0) fail('长文展开没有生效（点击没有真正触发页面处理）');

  await page.cdp.eval(`(() => {
    const d = document.createElement('div');
    d.setAttribute('data-testid', 'toast');
    d.textContent = 'Rate limit exceeded. Please try again later.';
    document.body.appendChild(d); return true;
  })()`);
  const realSig = await page.cdp.eval(P.CHECK_STOP);
  if (!realSig || !realSig.stop) fail('真实的限流提示没有被识别出来（漏报）');
  else ok(`真实限流提示能被识别：${realSig.reasons.join('；')}`);
  await page.cdp.eval(`(() => { const t = document.querySelector('[data-testid="toast"]'); if (t) t.remove(); return true; })()`);

  console.log('--- 4. 字段解析检查 ---');
  const all = (await page.cdp.eval(P.EXTRACT)) || [];
  const kinds = {};
  for (const t of all) kinds[t.kind] = (kinds[t.kind] || 0) + 1;
  const withMedia = all.filter((t) => (t.media || []).length > 0);
  const withQuote = all.filter((t) => t.quoted && t.quoted.text);
  const withReply = all.filter((t) => t.reply_to && t.reply_to.length);
  const withMetrics = all.filter((t) => t.metrics && t.metrics.likes != null && t.metrics.views != null);
  console.log('   当前 DOM 里类型分布：', JSON.stringify(kinds));
  ok(`带媒体 ${withMedia.length} 条｜带引用 ${withQuote.length} 条｜回复 ${withReply.length} 条｜含互动数据 ${withMetrics.length} 条`);
  if (!withMedia.length || !withQuote.length || !withReply.length) fail('媒体/引用/回复至少有一类没解析出来');
  if (withQuote.some((t) => !t.quoted.url)) fail('引用推文的链接没解析出来');

  if (firstSample) {
    console.log('   转推样本：', JSON.stringify(firstSample).slice(0, 400));
    if (!firstSample.retweeted_by) fail('转推的 retweeted_by 没解析出来');
    if (firstSample.kind !== 'retweet') fail('转推 kind 判定错误');
    if (!firstSample.time_iso) fail('转推时间没解析出来');
    if (!/^\d{19}$/.test(firstSample.id)) fail('推文 id 位数不对：' + firstSample.id);
  } else {
    fail('没有抓到任何转推样本');
  }
  const likeSample = all.find((t) => t.metrics && typeof t.metrics.likes === 'number');
  if (!likeSample) fail('点赞数没解析出来');
  else ok(`点赞数解析示例：${likeSample.metrics.likes}`);
  const viewSample = all.find((t) => t.metrics && typeof t.metrics.views === 'number');
  if (!viewSample) fail('浏览量没解析出来');
  else ok(`浏览量解析示例：${viewSample.metrics.views}`);
  const textSample = all.find((t) => (t.text || '').indexOf('multi line') >= 0);
  if (!textSample) fail('多行/特殊字符正文没解析出来');
  else ok('多行 + emoji + <angle> & ampersand 的正文解析正常');

  console.log('--- 4.5 用真实提取结果生成 HTML 报告（打通最后一段链路）---');
  const outDir = path.join(TEST_DIR, 'out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'tweets.jsonl'),
    all.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'state.json'),
    JSON.stringify({ handle: 'fakehandle', lastRunAt: U.nowIso(), total: all.length, images: 0, tabs: ['posts'] }),
    'utf8',
  );
  const { generateReport } = require('../app/report');
  const rep = generateReport(outDir, { title: '自测报告' });
  const html = fs.readFileSync(rep.outPath, 'utf8');
  ok(`报告已生成：${rep.outPath}（${rep.count} 条，${U.fmtBytes(Buffer.byteLength(html))}）`);
  if (rep.count !== all.length) fail(`报告条数不对：${rep.count} != ${all.length}`);
  if (Buffer.byteLength(html) < 5000) fail('生成的 HTML 太小，可能是空页面');
  if (html.indexOf('Tweet body #4') < 0) fail('报告里找不到推文正文');
  if (html.indexOf('quoted body') < 0) fail('报告里找不到引用推文内容');
  if (!/搜索|search/.test(html)) fail('报告里没有搜索框');
  if (html.indexOf('<script') < 0) fail('报告缺少脚本，交互功能不可用');
  const rawAngle = all.some((t) => (t.text || '').indexOf('<angle>') >= 0);
  if (rawAngle) ok('正文里的 <angle> 已进入报告，稍后由浏览器渲染时按纯文本处理');

  console.log('--- 5. 关闭测试浏览器 ---');
  await CH.closeShadowBrowser(PORT, (m) => console.log('   ' + m));
  await U.sleep(1500);
  const stillUp = await CH.portAlive(PORT);
  if (stillUp) fail('测试浏览器没有关掉'); else ok('测试浏览器已关闭');

  console.log('\n结果：' + (process.exitCode ? '有失败项，见上面的 ✗' : '全部通过'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
