'use strict';
/**
 * 测试：能不能直接用「用户日常那颗已登录的 Chrome」配合调试端口？
 *
 * Chrome 136+ 出于安全考虑，在"默认配置目录"上会忽略 --remote-debugging-port。
 * 这里实测两种绕法：
 *   A：把默认路径原样显式传给 --user-data-dir
 *   B：建一个目录联接（junction）指向真实配置目录，路径字符串就不是默认值了
 * 测完只报告事实，不修改用户配置。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const CH = require('../app/chrome');
const U = require('../app/util');

const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REAL = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const LINK = path.join(U.ROOT, 'chrome-live');
const PORT = 9222;
const PROFILE = process.argv[2] || 'Profile 1';

function launchArgs(userDataDir) {
  return [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate',
    '--window-size=1440,1000',
    '--window-position=-3200,-3200',
    '--new-window',
    'about:blank',
  ];
}

function chromeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', timeout: 20000 });
    return /chrome\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 }); } catch (_) { /* ignore */ }
}

async function attempt(tag, userDataDir) {
  console.log(`\n=== 变体 ${tag}：--user-data-dir=${userDataDir} ===`);
  const child = spawn(EXE, launchArgs(userDataDir), { detached: true, stdio: 'ignore' });
  child.unref();
  const ok = await CH.waitPort(PORT, 30000, () => {});
  console.log(`    调试端口 ${PORT} 是否开放：${ok ? '是 ✓' : '否 ✗'}`);
  if (!ok) {
    killTree(child.pid);
    await U.sleep(3000);
  }
  return { ok, pid: child.pid, userDataDir };
}

async function inspect(port, label) {
  const page = await CH.openPage(port, 'about:blank', () => {});
  await CH.navigate(page.cdp, 'https://x.com/home', () => {});
  await U.sleep(6000);
  const info = await page.cdp.eval(`(() => {
    const q = (s) => document.querySelector(s);
    const link = q('[data-testid="AppTabBar_Profile_Link"]');
    const nav = q('[data-testid="SideNav_AccountSwitcher_Button"]');
    return {
      href: location.href,
      title: document.title,
      loggedIn: !!(link || nav),
      handle: link ? (link.getAttribute('href') || '').replace(/^\\//, '') : null,
      hasLoginButton: !!q('[data-testid="loginButton"]'),
      bodyStart: (document.body ? document.body.innerText : '').slice(0, 160).replace(/\\s+/g, ' '),
    };
  })()`);
  const ck = await page.cdp.send('Network.getCookies', { urls: ['https://x.com/'] });
  const cookies = (ck && ck.cookies) || [];
  console.log(`    [${label}] 已登录=${info.loggedIn} 账号=${info.handle || '-'} 页面=${info.href}`);
  console.log(`    [${label}] x.com cookie 数量=${cookies.length} 含 auth_token=${cookies.some((c) => c.name === 'auth_token')}`);
  console.log(`    [${label}] 页面开头：${info.bodyStart}`);
  page.cdp.close();
  return { info, cookieCount: cookies.length };
}

async function main() {
  if (chromeRunning()) {
    console.log('检测到 Chrome 仍在运行，请先完全退出 Chrome（所有窗口、所有配置）。');
    process.exitCode = 2;
    return;
  }
  console.log(`目标配置：${PROFILE}`);

  // 清掉可能存在的旧联接
  if (fs.existsSync(LINK)) {
    try { fs.rmdirSync(LINK); } catch (err) { console.log(`清理旧联接失败：${err.message}`); }
  }
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', LINK, REAL], { encoding: 'utf8' });
    console.log(`已建立目录联接：${LINK}  ->  ${REAL}`);
  } catch (err) {
    console.log(`建立联接失败：${err.message}`);
  }

  const a = await attempt('A（默认路径显式传入）', REAL);
  if (a.ok) {
    await inspect(PORT, 'A');
    console.log('\n结论：变体 A 可行 —— 直接用真实配置目录就能接管，不需要副本。');
    await CH.closeShadowBrowser(PORT, (m) => console.log('    ' + m));
    return;
  }

  const b = await attempt('B（目录联接）', LINK);
  if (b.ok) {
    await inspect(PORT, 'B');
    console.log('\n结论：变体 B 可行 —— 用目录联接可以绕过限制，直接使用真实配置。');
    await CH.closeShadowBrowser(PORT, (m) => console.log('    ' + m));
    return;
  }

  console.log('\n结论：两种变体都被 Chrome 拒绝，无法直接接管日常配置。');
  try { fs.rmdirSync(LINK); } catch (_) { /* ignore */ }
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
