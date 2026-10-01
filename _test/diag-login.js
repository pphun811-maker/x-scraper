'use strict';
/**
 * 诊断：影子登录态为什么没生效？
 * 只输出 cookie 的"名字/域/长度/加密前缀"，绝不输出任何 cookie 值。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;
const out = {};

function dbInfo(tag, file) {
  const tmp = path.join(U.ROOT, '_test', `${tag}-cookies.db`);
  try {
    if (!fs.existsSync(file)) return { file, missing: true };
    fs.copyFileSync(file, tmp);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmp, { readOnly: true });
    const total = db.prepare('select count(*) as n from cookies').get();
    const prefixes = db.prepare(
      'select hex(substr(encrypted_value,1,3)) as prefix, count(*) as n from cookies group by 1 order by n desc',
    ).all();
    const key = db.prepare(
      "select name, host_key, length(encrypted_value) as len, hex(substr(encrypted_value,1,3)) as prefix "
      + "from cookies where host_key like '%x.com%' and name in ('auth_token','ct0','twid','kdt','auth_multi') order by name",
    ).all();
    const xCount = db.prepare(
      "select count(*) as n from cookies where host_key like '%x.com%' or host_key like '%twitter.com%'",
    ).get();
    db.close();
    return { file, total: total.n, xCount: xCount.n, prefixes, keyCookies: key };
  } catch (err) {
    return { file, error: err.message };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

async function main() {
  out.srcUserData = U.SRC_USER_DATA;
  out.shadowDir = U.SHADOW_DIR;
  out.db = {
    source: dbInfo('source', path.join(U.SRC_USER_DATA, U.SRC_PROFILE, 'Network', 'Cookies')),
    shadow: dbInfo('shadow', path.join(U.SHADOW_DIR, 'Default', 'Network', 'Cookies')),
  };

  const alive = await CH.portAlive(PORT);
  out.browserWasRunning = alive;
  if (!alive) {
    CH.launchShadowChrome({ port: PORT, url: 'about:blank', visible: false });
    await CH.waitPort(PORT, 60000, () => {});
  }

  const page = await CH.openPage(PORT, 'about:blank', () => {});
  await CH.navigate(page.cdp, 'https://x.com/home', () => {});
  await U.sleep(7000);

  out.page = await page.cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      href: location.href,
      title: document.title,
      hasAccountSwitcher: !!q('[data-testid="SideNav_AccountSwitcher_Button"]'),
      hasProfileLink: !!q('[data-testid="AppTabBar_Profile_Link"]'),
      hasLoginButton: !!q('[data-testid="loginButton"]'),
      hasPrimaryColumn: !!q('[data-testid="primaryColumn"]'),
      hasTimeline: !!q('[data-testid="cellInnerDiv"]'),
      bodyStart: (document.body ? document.body.innerText : '').slice(0, 300).replace(/\\s+/g, ' '),
    };
  })()`);

  const ck = await page.cdp.send('Network.getCookies', { urls: ['https://x.com/', 'https://api.x.com/'] });
  const cookies = (ck && ck.cookies) || [];
  out.browserCookieJar = {
    count: cookies.length,
    names: cookies.map((c) => `${c.name}@${c.domain}`).sort(),
    hasAuthToken: cookies.some((c) => c.name === 'auth_token'),
    hasCt0: cookies.some((c) => c.name === 'ct0'),
  };

  const ver = await CH.openPage(PORT, 'chrome://version', () => {});
  await U.sleep(2500);
  const text = await ver.cdp.eval('document.body.innerText');
  ver.cdp.close();
  const grab = (label) => {
    const m = String(text || '').match(new RegExp(`^${label}[^\\S\\n]*[:：]?\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  out.chromeVersionPage = {
    profilePath: grab('Profile Path') || grab('配置文件路径'),
    commandLine: (grab('Command Line') || grab('命令行') || '').slice(0, 400),
  };

  page.cdp.close();
  console.log(JSON.stringify(out, null, 2));

  await CH.closeShadowBrowser(PORT, (m) => console.log('# ' + m));
}

main().catch((err) => {
  console.error('诊断异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
