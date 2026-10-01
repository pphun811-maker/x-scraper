'use strict';
/**
 * 验证两种注入方式的**持久化**差异：
 *   A) 在 about:blank 标签页上用 Network.setCookie（当前实现）
 *   B) 先导航到 https://x.com/ ，再用浏览器级 Storage.setCookies
 * 判定标准：关掉浏览器再打开，cookie 还在不在。
 * 全程只操作副本目录，不接触用户真实配置。
 */
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

const nowSec = Math.floor(Date.now() / 1000);

function toStorageCookie(c) {
  const host = String(c.domain).replace(/^\./, '');
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires || (nowSec + 30 * 24 * 3600),
    httpOnly: !!c.httpOnly,
    secure: true,
    session: false,
    sameSite: c.sameSite || 'None',
    sourceScheme: 'Secure',
    sourcePort: 443,
    hostOnly: false,
    partitionKey: undefined,
    priority: 'Medium',
  };
}

async function listNames(cdp) {
  const jar = await cdp.send('Network.getCookies', { urls: ['https://x.com/', 'https://api.x.com/'] });
  return ((jar && jar.cookies) || []).map((c) => c.name).sort();
}
async function listNamesStorage(cdp) {
  const r = await cdp.send('Storage.getCookies', {});
  return ((r && r.cookies) || []).filter((c) => /x\.com$/.test(String(c.domain).replace(/^\./, '')))
    .map((c) => c.name).sort();
}

async function launch() {
  const config = U.loadConfig();
  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: () => {} });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  return page;
}

async function main() {
  // ---------- A：about:blank + Network.setCookie ----------
  console.log('=== A. about:blank + Network.setCookie ===');
  let page = await launch();
  await page.cdp.send('Network.setCookie', {
    name: 'probeA', value: 'A-VALUE', domain: '.x.com', path: '/', secure: true, httpOnly: false,
    expires: nowSec + 7 * 24 * 3600, sameSite: 'None', url: 'https://x.com/',
  });
  console.log('   写入后（内存视图）:', (await listNames(page.cdp)).join(', '));
  await U.sleep(3000);
  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  await U.sleep(1500);

  page = await launch();
  let names = await listNames(page.cdp);
  console.log('   重启后:', names.join(', '));
  if (names.includes('probeA')) ok('A 方式可持久化');
  else fail('A 方式不能持久化（与刚才的现象一致）');
  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  await U.sleep(1500);

  // ---------- B：真实 x.com 页面 + Storage.setCookies ----------
  console.log('\n=== B. 真实 x.com 页面 + Storage.setCookies ===');
  page = await launch();
  await CH.navigate(page.cdp, 'https://x.com/', () => {});
  await U.sleep(2500);
  const cookie = toStorageCookie({
    name: 'probeB', value: 'B-VALUE', domain: '.x.com', path: '/', httpOnly: false, sameSite: 'None',
  });
  try {
    await page.cdp.send('Storage.setCookies', { cookies: [cookie] }, 15000);
    console.log('   Storage.setCookies 已调用');
  } catch (err) {
    fail('Storage.setCookies 调用失败：' + err.message);
  }
  console.log('   Storage.getCookies:', (await listNamesStorage(page.cdp)).join(', '));
  console.log('   Network.getCookies:', (await listNames(page.cdp)).join(', '));
  await U.sleep(3000);
  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  await U.sleep(1500);

  page = await launch();
  names = await listNames(page.cdp);
  console.log('   重启后:', names.join(', '));
  if (names.includes('probeB')) ok('B 方式可持久化 → 应该改用这种方式');
  else fail('B 方式也不能持久化，需要另找办法');
  page.cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});

  console.log('\n结果：' + (process.exitCode ? '有失败项' : '全部通过'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
