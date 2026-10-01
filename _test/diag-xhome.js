'use strict';
/** 直接测 x.com/home：多久能打开、登录态如何。 */
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;

async function main() {
  const config = U.loadConfig();
  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: (m) => console.log('   ' + m) });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  const cdp = page.cdp;

  const t0 = Date.now();
  await cdp.send('Page.navigate', { url: 'https://x.com/home' }, 60000);
  console.log('   Page.navigate 返回耗时', Date.now() - t0, 'ms');

  let last = null;
  for (let i = 0; i < 90; i += 1) {
    await U.sleep(2000);
    last = await cdp.eval(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        href: location.href,
        rs: document.readyState,
        title: document.title,
        articles: document.querySelectorAll('article[data-testid="tweet"]').length,
        hasNav: !!q('[data-testid="SideNav_AccountSwitcher_Button"]'),
        handle: (q('[data-testid="AppTabBar_Profile_Link"]') || {}).getAttribute
          ? q('[data-testid="AppTabBar_Profile_Link"]').getAttribute('href') : null,
        hasLogin: !!q('[data-testid="loginButton"]'),
        cells: document.querySelectorAll('[data-testid="cellInnerDiv"]').length,
      };
    })()`, { timeoutMs: 10000 }).catch((e) => ({ error: e.message }));
    console.log(`   +${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(last));
    if (last && !last.error && (last.articles > 0 || last.hasNav || last.hasLogin)) break;
  }
  console.log('\n最终：', JSON.stringify(last));
  try { cdp.close(); } catch (_) { /* ignore */ }
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
