'use strict';
/**
 * 影子 Chrome 的启动、连接与登录态检查。
 *
 * 关键点：
 *  - 用独立的 --user-data-dir（副本），所以能和你日常的 Chrome 同时开，互不干扰；
 *    （另外 Chrome 136+ 也禁止在"默认配置目录"上开调试端口，所以必须用副本。）
 *  - 不加 --enable-automation、不用 headless，所以 navigator.webdriver 保持 false，
 *    且页面看到的是一颗正常的、有真实窗口的 Chrome。
 *  - 窗口默认挪到屏幕外，你看不见它，但它照常渲染滚动。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { CDP, version, listTargets, newPage, closeTarget } = require('./cdp');
const U = require('./util');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

function findChromeExe() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('找不到 chrome.exe，请确认已安装 Google Chrome。');
}

function chromeVersion() {
  try {
    const dir = path.dirname(findChromeExe());
    const vers = fs.readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
    vers.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
    return vers.pop() || '';
  } catch (_) {
    return '';
  }
}

function isChromeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    return /chrome\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

/** 找出正在跑的"副本" Chrome 进程号（用独立配置目录启动的那些） */
function listShadowChromePids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
      + "Where-Object { $_.CommandLine -match 'chrome-shadow' } | "
      + 'Select-Object -ExpandProperty ProcessId'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  } catch (_) {
    return [];
  }
}

async function portAlive(port) {
  try {
    // 2500 → 5000：直连下探测只要 1–8ms，2.5 秒绰绰有余；但一旦有环境代理把
    // 回环请求绕去代理（第三轮根因 2），2.5 秒会成为误判源 → 面板对健康实例
    // 间歇全盲。放宽到 5 秒只影响"确认端口死了"的速度，不影响正常路径。
    await version(port, 5000);
    return true;
  } catch (_) {
    return false;
  }
}

async function waitPort(port, timeoutMs, log) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portAlive(port)) return true;
    await U.sleep(600);
  }
  if (log) log('等待调试端口超时');
  return false;
}

/**
 * 副本配置目录还被某个 Chrome 实例占着吗？
 *
 * 为什么不只用 listShadowChromePids()：那个依赖 WMI/PowerShell，在受限环境里会拿不到而
 * 静默返回空数组。Chrome 在运行时会以独占方式打开配置目录里的 `lockfile`，所以
 * "能不能独占打开这个文件"是一个不依赖外部命令、又很准的探针。
 */
function shadowProfileLocked(profileDir = U.SHADOW_DIR) {
  const lock = path.join(profileDir, 'lockfile');
  if (!fs.existsSync(lock)) return false;      // 没有 lockfile 说明没有实例在跑
  let fd = null;
  try {
    fd = fs.openSync(lock, 'r+');
    return false;                              // 能打开 → 没被占用
  } catch (_) {
    return true;                               // 打不开 → 有实例占着
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/** 等配置目录被放开（上一个实例真的退干净）。返回 true = 已放开 */
async function waitProfileFree(profileDir = U.SHADOW_DIR, timeoutMs = 60000, log = null) {
  const t0 = Date.now();
  let warned = false;
  while (shadowProfileLocked(profileDir)) {
    if (Date.now() - t0 > timeoutMs) return false;
    if (!warned) {
      if (log) log('上一个副本浏览器还在退出（配置目录仍被占用），等它退干净再启动…');
      warned = true;
    }
    await U.sleep(1500);
  }
  return true;
}

function launchShadowChrome(opts = {}) {
  const {
    port = U.DEFAULT_DEBUG_PORT,
    url = 'about:blank',
    visible = false,
    profileDir = U.SHADOW_DIR,
    windowSize = '1440,1000',
    proxy = '',
  } = opts;

  const exe = findChromeExe();
  const pos = visible ? '120,80' : '-3200,-3200';
  const args = [
    `--user-data-dir=${profileDir}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate',
    `--window-size=${windowSize}`,
    `--window-position=${pos}`,
    '--new-window',
  ];
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push(url);

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

/**
 * 启动"你自己的 Chrome"（live 模式）。
 *
 * ⚠️ 这里**绝对不能**传 --user-data-dir：
 * 一旦路径字符串不是默认值，Chrome 的应用绑定加密就会判定密钥不匹配，
 * 进而把解不开的 cookie 全部删掉（已实测：3530 行 → 60 行，不可恢复）。
 * 而路径是默认值时 Chrome 136+ 会拒绝调试端口 —— 需要用官方策略
 * RemoteDebuggingAllowed 来放行（见 tools/policy-enable.ps1）。
 */
function launchLiveChrome(opts = {}) {
  const {
    port = U.DEFAULT_DEBUG_PORT,
    profile = U.SRC_PROFILE,
    visible = false,
    url = 'about:blank',
    windowSize = '1440,1000',
  } = opts;

  const exe = findChromeExe();
  const pos = visible ? '120,80' : '-3200,-3200';
  const args = [
    `--profile-directory=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate',
    `--window-size=${windowSize}`,
    `--window-position=${pos}`,
    '--new-window',
    url,
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** 按当前模式确保有一个带调试端口的 Chrome 在跑 */
async function ensureBrowser(opts = {}) {
  const {
    mode = 'live',
    config = U.loadConfig(),
    visible = false,
    url = 'about:blank',
    log = () => {},
  } = opts;
  const port = config.debugPort || U.DEFAULT_DEBUG_PORT;

  if (await portAlive(port)) {
    log(`复用已在运行的浏览器（调试端口 ${port}）`);
    return { reused: true, port, mode };
  }

  if (mode === 'live') {
    if (isChromeRunning()) {
      throw new Error('「直接使用我的 Chrome」模式需要由脚本来启动 Chrome。请先完全退出 Chrome（所有窗口），再点开始。');
    }
    log(`启动你自己的 Chrome（配置：${config.liveProfile}，窗口在屏幕外）…`);
    launchLiveChrome({ port, profile: config.liveProfile, visible, url });
  } else {
    // 副本模式下：如果已经有副本 Chrome 在跑（可能只是端口还没开出来），先耐心等它，
    // 别急着再启一个实例 —— 两个实例抢同一个配置目录会互相卡住。
    //
    // ★ 关键一步（2026-09-29 实测事故后加的）：先确认配置目录真的被放开了再启动。
    //   否则新实例是在"上一个实例还没退干净"的状态下起来的：实测表现为起端口要 135 秒，
    //   随后页面渲染进程反复 30 秒不响应，任务一路"（已忽略）"硬撑 13 分钟、0 新增。
    const free = await waitProfileFree(U.SHADOW_DIR, 60000, log);
    if (!free) {
      throw new Error('上一个副本浏览器还没退出（配置目录被占用超过 60 秒）。'
        + '请等十几秒再点开始；如果任务栏里还留着那个 Chrome 窗口（它在屏幕外），先手动关掉它。');
    }
    const existing = listShadowChromePids();
    if (existing.length) {
      log(`检测到已有副本 Chrome 在运行（${existing.length} 个进程），先等它开放调试端口…`);
      if (await waitPort(port, 150000, log)) {
        log(`复用已在运行的浏览器（调试端口 ${port}）`);
        return { reused: true, port, mode };
      }
      log('等了 150 秒仍没有调试端口，判定是卡死的旧实例：先把它们结束掉，再重新启动一个干净的。');
      for (const pid of existing) {
        try { process.kill(pid); } catch (_) { /* ignore */ }
      }
      await U.sleep(4000);
    }
    log(visible ? '启动影子 Chrome（窗口可见）…' : '启动影子 Chrome（窗口在屏幕外）…');
    launchShadowChrome({ port, visible, url });
  }

  const tStart = Date.now();
  const ok = await waitPort(port, 180000, log);
  const startMs = Date.now() - tStart;
  if (!ok) {
    if (mode === 'live') {
      throw new Error('Chrome 起来了，但没有开放调试端口。Chrome 136 之后默认禁止在默认配置目录上开调试端口，'
        + '请先点「授权并启用调试接口」（会弹一次 UAC），再重试。');
    }
    throw new Error('副本 Chrome 启动后 180 秒内没有开放调试端口。请检查是否有杀毒软件拦截，或手动看一眼屏幕。');
  }
  const T = U.loadTimeouts();
  if (startMs > (T.effective.launchWarnMs || 20000)) {
    log(`⚠ 副本浏览器启动花了 ${Math.round(startMs / 1000)} 秒（正常 4 秒以内）：这个实例可能不健康。`
      + '若随后日志里出现"页面无响应"，任务会自己重载页面 / 重启浏览器；也可以停止后重试一次。');
  }
  log(`浏览器已就绪（调试端口 ${port}，启动耗时 ${Math.round(startMs / 1000)} 秒）`);
  return { reused: false, port, mode };
}

/** 确保影子浏览器在跑（已有调试端口就直接复用） */
async function ensureShadowBrowser(opts = {}) {
  const { port = U.DEFAULT_DEBUG_PORT, visible = false, url = 'about:blank', log = () => {} } = opts;
  if (await portAlive(port)) {
    log(`复用已在运行的影子浏览器（调试端口 ${port}）`);
    return { reused: true, port };
  }
  log(visible ? '启动影子 Chrome（窗口可见）…' : '启动影子 Chrome（窗口在屏幕外）…');
  // 和 ensureBrowser 一样：先确保配置目录已经放开，别和正在退出的旧实例抢
  const free = await waitProfileFree(U.SHADOW_DIR, 60000, log);
  if (!free) {
    throw new Error('上一个副本浏览器还没退出（配置目录被占用超过 60 秒），请稍后再试，或手动关掉那个屏幕外的 Chrome 窗口。');
  }
  const pid = launchShadowChrome({ port, visible, url });
  const ok = await waitPort(port, 60000, log);
  if (!ok) {
    throw new Error('影子 Chrome 启动后 60 秒内没有开放调试端口。可能被杀毒软件拦截，或 Chrome 弹了对话框；请手动看一眼屏幕。');
  }
  log(`影子 Chrome 已就绪（PID ${pid}，调试端口 ${port}）`);
  return { reused: false, port, pid };
}

async function openPage(port, url, log = () => {}) {
  const target = await newPage(port, url || 'about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl, 'page');
  await cdp.connect(15000);
  await cdp.send('Page.enable', {}, 10000).catch(() => {});
  await cdp.send('Runtime.enable', {}, 10000).catch(() => {});
  await cdp.send('Network.enable', {}, 10000).catch(() => {});
  // 让后台/离屏窗口别被降频：告诉页面自己处于激活状态
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }, 5000).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000).catch(() => {});
  log(`已打开页面目标 ${target.id}`);
  return { target, cdp };
}

/** 带重试的页面求值：X 首屏很重，渲染期间求值会超时，重试几次就好 */
async function evalRetry(cdp, expression, opts = {}) {
  const T = U.loadTimeouts().effective;
  const { tries = T.evalTries, timeoutMs = T.evalMs, gapMs = 1500, label = '页面求值' } = opts;
  let lastErr = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await cdp.eval(expression, { timeoutMs });
    } catch (err) {
      lastErr = err;
      if (i < tries) await U.sleep(gapMs);
    }
  }
  throw new Error(`${label}失败（已重试 ${tries} 次）：${lastErr && lastErr.message}`);
}

/** 等到页面真的能响应脚本为止（解决"刚启动/正在渲染时求值超时"） */
async function waitResponsive(cdp, log = () => {}, timeoutMs) {
  const budget = timeoutMs || U.loadTimeouts().effective.responsiveMs;
  const t0 = Date.now();
  let tries = 0;
  while (Date.now() - t0 < budget) {
    tries += 1;
    try {
      const v = await cdp.eval('1+1', { timeoutMs: 10000 });
      if (v === 2) {
        if (tries > 1) log(`页面在重试 ${tries} 次后恢复响应（等待了 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
        return true;
      }
    } catch (_) { /* 继续等 */ }
    await U.sleep(1200);
  }
  log('页面长时间没有响应，仍继续尝试');
  return false;
}

async function navigate(cdp, url, log = () => {}, timeoutMs) {
  const budget = timeoutMs || U.loadTimeouts().effective.navigateMs;
  log(`打开 ${url}`);
  const done = cdp.waitEvent('Page.loadEventFired', budget).catch(() => null);
  try {
    await cdp.send('Page.navigate', { url }, budget);
  } catch (err) {
    log(`导航指令返回较慢（${err.message}），继续等待页面就绪`);
  }
  await done;
  // loadEventFired 之后 X 还要几秒渲染，交给调用方 waitFor
  return true;
}

async function waitFor(cdp, expression, timeoutMs, intervalMs = 700, label = '条件') {
  const T = U.loadTimeouts().effective;
  const budget = timeoutMs || T.renderWaitMs;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < budget) {
    try {
      last = await cdp.eval(expression, { timeoutMs: T.evalMs });
      if (last) return last;
    } catch (_) { /* 页面还在导航时求值会失败，忽略 */ }
    await U.sleep(intervalMs);
  }
  throw new Error(`等待「${label}」超时（${Math.round(budget / 1000)} 秒）`);
}

const LOGIN_PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const nav = q('[data-testid="SideNav_AccountSwitcher_Button"]');
  const profileLink = q('[data-testid="AppTabBar_Profile_Link"]');
  const loginBtn = q('[data-testid="loginButton"]') || q('a[href="/login"]');
  const href = profileLink ? (profileLink.getAttribute('href') || '') : '';
  const body = document.body ? document.body.innerText.slice(0, 3000) : '';
  return {
    url: location.href,
    loggedIn: !!(nav || profileLink),
    handle: href ? href.replace(/^\\//, '').split('/')[0] : null,
    loginVisible: !!loginBtn,
    looksLikeLanding: /(Sign in to X|登录 X|Create account|创建账号|Happening now|正在发生)/i.test(body),
  };
})()`;

/** 打开 x.com/home 并判断登录态 */
async function checkLoginState(cdp, log = () => {}) {
  const T = U.loadTimeouts().effective;
  await waitResponsive(cdp, log);
  await navigate(cdp, 'https://x.com/home', log);
  try {
    await waitFor(
      cdp,
      `(() => !!document.querySelector('[data-testid="primaryColumn"], [data-testid="SideNav_AccountSwitcher_Button"], [data-testid="loginButton"], main'))()`,
      T.renderWaitMs,
      1200,
      'X 页面渲染',
    );
  } catch (err) {
    log(`登录态检查期间等待页面超时：${err.message}`);
  }
  await U.sleep(1500);
  let info;
  try {
    info = await evalRetry(cdp, LOGIN_PROBE, { tries: T.evalTries, timeoutMs: T.evalMs, label: '读取登录态' });
  } catch (err) {
    log(`${err.message}（如果反复出现，请检查代理是否稳定）`);
    info = { loggedIn: false, handle: null, url: null, probeFailed: true };
  }
  return info;
}

/** 关掉副本浏览器里多余的标签页，只留指定的那个（避免越攒越多拖慢响应） */
async function closeOtherPages(port, keepId, log = () => {}) {
  try {
    const list = await listTargets(port);
    let closed = 0;
    for (const t of list) {
      if (t.type !== 'page' || t.id === keepId) continue;
      await closeTarget(port, t.id);
      closed += 1;
    }
    if (closed) log(`顺手关掉了 ${closed} 个多余标签页`);
  } catch (_) { /* 关不掉也不影响 */ }
}

async function findPageByUrl(port, part) {
  try {
    const list = await listTargets(port);
    return list.find((t) => t.type === 'page' && String(t.url || '').includes(part)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 关掉副本浏览器，并且**确认它真的关掉了**。
 *
 * 以前只发一个 Browser.close 就完事：实测出现过"请求发出去了、浏览器没死"，
 * 结果那个僵尸实例一直占着配置目录，害得下一次任务撞车（页面反复无响应）。
 * 现在会轮询调试端口，没关掉就再试一次，最后给出可操作的提示。
 */
async function closeShadowBrowser(port, log = () => {}) {
  if (!(await portAlive(port))) return true;          // 本来就没开，不必喊

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const v = await version(port, 3000);
      const cdp = new CDP(v.webSocketDebuggerUrl, 'browser');
      await cdp.connect(6000);
      await cdp.send('Browser.close', {}, 5000).catch(() => {});
      cdp.close();
      log(attempt === 1 ? '已请求关闭影子浏览器' : '已再次请求关闭影子浏览器');
    } catch (err) {
      log(`请求关闭影子浏览器失败（第 ${attempt} 次）：${err.message}`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (!(await portAlive(port))) return true;
      await U.sleep(800);
    }
    if (attempt === 1) log('关闭请求发出 12 秒后调试端口仍在监听，重试一次…');
  }
  log('⚠ 副本浏览器没有关掉（调试端口仍在监听），它会一直占着配置目录，'
    + '导致下次任务启动异常缓慢甚至页面无响应。请在任务栏里手动关掉那个 Chrome 窗口（它在屏幕外），再重试。');
  return false;
}

module.exports = {
  findChromeExe, chromeVersion, isChromeRunning, listShadowChromePids, portAlive, waitPort,
  shadowProfileLocked, waitProfileFree,
  launchShadowChrome, launchLiveChrome, ensureBrowser, ensureShadowBrowser,
  openPage, navigate, waitFor, evalRetry, waitResponsive, closeOtherPages,
  checkLoginState, findPageByUrl, closeShadowBrowser, LOGIN_PROBE,
};
