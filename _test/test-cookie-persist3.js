'use strict';
/**
 * 精确验证：auth_token / ct0 这两个名字的 cookie 注入后能不能跨重启存活（不访问 x.com，
 * 以排除"X 服务器看到假 token 后把它清掉"这个干扰因素）。
 * 同时清掉上一轮留下的 probeA / probeB 探针 cookie。
 */
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

async function launch() {
  const config = U.loadConfig();
  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: () => {} });
  return CH.openPage(PORT, 'about:blank', () => {});
}
async function names(cdp) {
  const jar = await cdp.send('Network.getCookies', { urls: ['https://x.com/', 'https://api.x.com/'] });
  return ((jar && jar.cookies) || []).map((c) => c.name).sort();
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log('=== 1. 注入同名的假 auth_token / ct0（不访问 X）===');
  let page = await launch();
  for (const c of [
    { name: 'auth_token', value: 'FAKE-TOKEN-FOR-PERSISTENCE-TEST', httpOnly: true, sameSite: 'None' },
    { name: 'ct0', value: 'FAKE-CSRF-FOR-PERSISTENCE-TEST', httpOnly: false, sameSite: 'Lax' },
  ]) {
    const r = await page.cdp.send('Network.setCookie', {
      name: c.name, value: c.value, domain: '.x.com', path: '/', secure: true, httpOnly: c.httpOnly,
      expires: nowSec + 20 * 24 * 3600, sameSite: c.sameSite, url: 'https://x.com/',
    });
    if (!r || r.success !== true) fail(`注入 ${c.name} 返回失败`);
  }
  console.log('   写入后:', (await names(page.cdp)).join(', '));
  // 清掉上一轮的探针
  for (const n of ['probeA', 'probeB']) {
    try { await page.cdp.send('Network.deleteCookies', { name: n, domain: '.x.com', path: '/' }); } catch (_) { /* ignore */ }
  }
  await U.sleep(3000);
  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  await U.sleep(1500);

  console.log('=== 2. 重启后检查 ===');
  page = await launch();
  const list = await names(page.cdp);
  console.log('   重启后:', list.join(', '));
  if (list.includes('auth_token')) ok('auth_token 跨重启存活 → 登录态可以持久化');
  else fail('auth_token 没存活');
  if (list.includes('ct0')) ok('ct0 跨重启存活');
  else fail('ct0 没存活');
  if (list.includes('probeA') || list.includes('probeB')) fail('探针 cookie 没清干净');
  else ok('探针 cookie 已清理');

  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  console.log('\n结果：' + (process.exitCode ? '有失败项' : '全部通过'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
