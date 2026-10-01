'use strict';
/**
 * 本地控制面板后端。只监听 127.0.0.1，不对外网开放。
 * 启动后会自动打开浏览器到面板地址。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const U = require('./util');
const PROFILE = require('./profile');
const CH = require('./chrome');
const SESSION = require('./session');
const { Runner } = require('./scraper');

const runner = new Runner();
const lastLogin = { state: 'unknown', account: null, at: null };
const PORT = Number(process.env.XSCRAPER_PORT || U.UI_PORT);

const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome';
const POLICY_NAME = 'RemoteDebuggingAllowed';
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * 读取 Chrome 官方策略当前值（读注册表不需要管理员权限）。
 * 结果缓存 60 秒：面板每 1.5 秒轮询一次状态，原来每次都起一个 reg.exe，
 * 既浪费又把"找不到注册表值"的中文报错喷满控制台。策略变动后要 force 重读。
 */
let policyCache = { at: 0, value: null };
function readPolicy(force) {
  const now = Date.now();
  if (!force && policyCache.at && now - policyCache.at < 60000) return policyCache.value;
  let value = null;
  try {
    const out = execFileSync('reg', ['query', POLICY_KEY, '/v', POLICY_NAME], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],   // 找不到值时的报错不要往控制台喷
    });
    const m = new RegExp(`${POLICY_NAME}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(out);
    value = m ? parseInt(m[1], 16) : null;
  } catch (_) {
    value = null;      // 不存在或读不到
  }
  policyCache = { at: now, value };
  return value;
}

/** 通过 UAC 提权写/删策略；返回是否成功（以注册表实际值为准） */
function setPolicyElevated(enable) {
  return new Promise((resolve) => {
    const script = path.join(U.TOOLS_DIR, enable ? 'policy-enable.ps1' : 'policy-disable.ps1');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, message: `找不到脚本 ${script}` });
      return;
    }
    const inner = `Start-Process -FilePath '${PS_EXE}' -Verb RunAs -Wait `
      + `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}'`;
    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-Command', inner], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, message: `无法发起提权：${err.message}` });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, message: `提权失败：${err.message}` }));
    child.on('exit', () => {
      const value = readPolicy(true);      // 刚改过策略，强制重读、别用缓存
      const want = enable ? 1 : null;
      const ok = enable ? value === 1 : (value === null || value === 0);
      resolve({
        ok,
        value,
        message: ok
          ? (enable ? '调试接口已授权启用（用完请点「停用并清理」）。' : '调试接口授权已清理。')
          : '授权似乎被取消或写入失败，策略当前值：' + String(value),
      });
    });
  });
}

/** live 模式下，用 cookie 库里是否存在 auth_token 判断"你的 Chrome 里 X 还登着没"（不解密任何 cookie） */
function liveCookieInfo() {
  const cfg = U.loadConfig();
  const file = path.join(U.SRC_USER_DATA, cfg.liveProfile || U.SRC_PROFILE, 'Network', 'Cookies');
  const info = PROFILE.inspectCookieDb(file);
  return { profile: cfg.liveProfile || U.SRC_PROFILE, file, ...info };
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到文件：' + file);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function countLines(file) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) === 10) n += 1;
    if (s.length && s.charCodeAt(s.length - 1) !== 10) n += 1;
    return n;
  } catch (_) {
    return 0;
  }
}

function listAccounts() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(U.DATA_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name);
  } catch (_) {
    return out;
  }
  for (const name of dirs) {
    const st = U.readJsonSafe(U.statePath(name), {}) || {};
    let images = 0;
    try { images = fs.readdirSync(U.imagesDir(name)).length; } catch (_) { images = 0; }
    out.push({
      handle: name,
      count: countLines(U.tweetsPath(name)),
      images,
      updatedAt: st.lastRunAt || null,
      hasReport: fs.existsSync(U.reportPath(name)),
    });
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

function statusPayload() {
  const st = runner.status();
  const cfg = U.loadConfig();
  const shadow = PROFILE.shadowStatus();
  const live = cfg.mode === 'live' ? liveCookieInfo() : null;
  const policy = readPolicy();
  // 注意：这里只在 runner.status() 的返回值上追加字段，不重建对象，
  // 所以 runner 以后新增的字段（pageStuck / recoveries / consecutiveFailures /
  // lastEvalOkAgoMs 等）都会原样透传给面板，不要写成白名单式的重建。
  st.mode = cfg.mode;
  st.config = cfg;
  st.timeouts = U.loadTimeouts(cfg);
  st.policy = { value: policy, enabled: policy === 1, name: POLICY_NAME };
  st.profile = {
    ready: shadow.ready,
    shadowDir: shadow.shadowDir,
    cookies: shadow.cookies,
    updatedAt: shadow.updatedAt,
    chromeRunning: CH.isChromeRunning(),
    chromeVersion: CH.chromeVersion(),
    loginState: lastLogin.state,
    loginAccount: lastLogin.account,
    loginCheckedAt: lastLogin.at,
    session: PROFILE.shadowSession(),
    live: live ? { profile: live.profile, hasAuthToken: live.hasAuthToken, unreadable: !!live.unreadable, lockError: live.lockError || null, xRows: live.xRows, totalRows: live.totalRows } : null,
  };
  st.accounts = listAccounts();
  st.session = SESSION.loadMeta();
  st.serverPort = PORT;
  return st;
}

function openLocalFile(file) {
  if (!fs.existsSync(file)) throw new Error('文件还不存在：' + file);
  spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * 面板操作互斥锁：防止"检查登录态"和"开始抓取"同时跑。
 * 之前就是因为两个动作并发，检查登录态结束时把抓取用的浏览器关掉了。
 */
let opName = null;
function beginOp(name) {
  if (opName) throw new Error(`正在执行「${opName}」，请等它结束再操作（两个动作同时跑会互相打断）。`);
  if (runner.busy) throw new Error('抓取任务正在运行，请先停止。');
  opName = name;
}
function endOp() { opName = null; }

/** 只有在没有抓取任务时才关浏览器 */
async function closeBrowserIfIdle(port, log) {
  if (runner.busy) {
    log('抓取任务仍在运行，保留浏览器不关闭');
    return;
  }
  await CH.closeShadowBrowser(port, log);
}

async function doPrepareProfile() {
  const cfg = U.loadConfig();
  beginOp('准备登录态');
  try {
    if (cfg.mode === 'live') {
      return {
        skipped: true,
        reason: 'live-mode',
        message: '当前是「直接使用我的 Chrome」模式，不需要复制登录态。',
      };
    }
    if (await CH.portAlive(cfg.debugPort || U.DEFAULT_DEBUG_PORT)) {
      await CH.closeShadowBrowser(cfg.debugPort || U.DEFAULT_DEBUG_PORT, (m) => runner.log(m));
      await U.sleep(2000);
    }
    const r = PROFILE.prepareShadowProfile({ log: (m) => runner.log(m) });
    lastLogin.state = 'unknown';
    lastLogin.account = null;
    return r;
  } finally {
    endOp();
  }
}

async function doLoginCheck() {
  const cfg = U.loadConfig();
  const mode = cfg.mode;
  const port = cfg.debugPort || U.DEFAULT_DEBUG_PORT;
  beginOp('检查登录态');
  try {
    return await doLoginCheckInner(cfg, mode, port);
  } finally {
    endOp();
  }
}

async function doLoginCheckInner(cfg, mode, port) {
  if (mode === 'live') {
    const info = liveCookieInfo();
    // T4.1 修复：cookie 库打不开（Chrome 运行时文件锁）≠ 没登录，不能判 logged_out
    if (info.unreadable) {
      return {
        ok: true,
        loginState: 'unknown',
        account: null,
        message: `配置「${info.profile}」的 cookie 库暂时读不出来（${info.lockError || '文件被占用'}）`
          + '——这不代表登录失效。请完全退出 Chrome 后再点一次；副本模式不受此影响，可直接开始抓取。',
      };
    }
    if (!info.hasAuthToken) {
      return {
        ok: true,
        loginState: 'logged_out',
        account: null,
        message: `配置「${info.profile}」里没有找到 X 的 auth_token（cookie 共 ${info.totalRows} 行，x/twitter ${info.xRows} 行）。`
          + '请先打开你自己的 Chrome，在这个配置里登录一次 X，然后再点「检查登录态」。',
      };
    }
    try {
      await CH.ensureBrowser({ mode, config: cfg, visible: false, log: (m) => runner.log(m) });
    } catch (err) {
      return {
        ok: false,
        loginState: 'unknown',
        account: null,
        message: `${err.message}（已确认 cookie 里存在 auth_token，说明登录态是好的，只差调试授权。）`,
      };
    }
    const page = await CH.openPage(port, 'about:blank', (m) => runner.log(m));
    let probed;
    try {
      probed = await CH.checkLoginState(page.cdp, (m) => runner.log(m));
    } finally {
      try { page.cdp.close(); } catch (_) { /* ignore */ }
    }
    lastLogin.state = probed.loggedIn ? 'logged_in' : 'logged_out';
    lastLogin.account = probed.handle ? '@' + probed.handle : null;
    lastLogin.at = U.nowIso();
    await U.sleep(2000);
    await CH.closeShadowBrowser(port, (m) => runner.log(m));
    return {
      ok: true,
      loginState: lastLogin.state,
      account: lastLogin.account,
      message: probed.loggedIn
        ? `登录态正常${lastLogin.account ? `（${lastLogin.account}）` : ''}，可以开始抓取了。`
        : 'Cookie 里有 auth_token，但页面仍显示未登录，可能 X 已让该会话失效。请在你自己的 Chrome 里重新登录一次 X。',
    };
  }

  const shadow = PROFILE.shadowStatus();
  if (!shadow.ready) throw new Error('副本目录不完整。请删掉 chrome-shadow 目录后，重新用扩展同步一次登录态。');
  const meta = SESSION.loadMeta();
  if (!meta || !meta.syncedAt) {
    return {
      ok: true,
      loginState: 'unknown',
      account: null,
      message: '还没有同步登录态。请先按第 1 步装好扩展并同步一次（扩展弹窗里看到"成功"），再点「检查登录态」。',
    };
  }
  await CH.ensureBrowser({ mode, config: cfg, visible: false, log: (m) => runner.log(m) });
  const page = await CH.openPage(port, 'about:blank', (m) => runner.log(m));
  await CH.closeOtherPages(port, page.target.id, (m) => runner.log(m));
  let info;
  try {
    info = await CH.checkLoginState(page.cdp, (m) => runner.log(m));
  } finally {
    try { page.cdp.close(); } catch (_) { /* ignore */ }
  }
  lastLogin.state = info.loggedIn ? 'logged_in' : 'logged_out';
  lastLogin.account = info.handle ? '@' + info.handle : null;
  lastLogin.at = U.nowIso();

  if (!info.loggedIn) {
    await closeBrowserIfIdle(port, (m) => runner.log(m));
    if (!info.probeFailed) {
      SESSION.saveMeta(Object.assign({}, meta, { loggedIn: false }));
    }
    return {
      ok: true,
      loginState: info.probeFailed ? 'unknown' : 'logged_out',
      account: null,
      message: info.probeFailed
        ? '页面暂时没有响应，没能读出登录状态（不是登录失效）。请稍等几秒再点一次；如果反复出现，检查代理是否稳定。'
        : '副本里的登录态已失效（X 显示未登录）。请在你自己的 Chrome 里确认还能正常刷 X，'
          + '然后点一次扩展图标重新同步，再回来检查。',
    };
  }
  SESSION.saveMeta(Object.assign({}, meta, { loggedIn: true, handle: info.handle || meta.handle || null, syncedAt: U.nowIso(), cookieCount: meta.cookieCount || 0 }));
  await closeBrowserIfIdle(port, (m) => runner.log(m));
  return {
    ok: true,
    loginState: 'logged_in',
    account: lastLogin.account,
    message: `登录态正常${lastLogin.account ? `（${lastLogin.account}）` : ''}，可以开始抓取了。`,
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/ui.html')) {
    sendFile(res, path.join(U.APP_DIR, 'ui.html'), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && p === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && p === '/api/status') {
    sendJson(res, 200, statusPayload());
    return;
  }
  if (req.method === 'GET' && p === '/api/accounts') {
    sendJson(res, 200, { ok: true, accounts: listAccounts() });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: '只支持 GET/POST' });
    return;
  }

  let body = {};
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, message: err.message });
    return;
  }

  try {
    if (p === '/api/profile/prepare') {
      const r = await doPrepareProfile();
      if (r.skipped) {
        sendJson(res, 200, {
          ok: true,
          skipped: true,
          message: `副本已经有自己的登录态了（${r.session.at}${r.session.account ? `，${r.session.account}` : ''}），`
            + '不需要再复制，直接点「检查登录态」即可。',
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        message: `登录态已复制到副本（${r.copied.length} 项，共 ${U.fmtBytes(r.totalBytes)}）。`
          + '注意：Chrome 154 的应用绑定加密不允许直接复用已加密的 cookie，'
          + '所以还需要点「检查登录态」，在弹出的窗口里登录一次 X —— 只需这一次，之后全自动。',
        copied: r.copied.map((c) => ({ from: c.from, to: c.to, bytes: c.bytes, mode: c.mode })),
        cookies: r.cookies,
      });
      return;
    }
    if (p === '/api/open-folder') {
      const which = body.which === 'shadow' ? 'shadow' : 'extension';
      const dir = which === 'extension' ? path.join(U.ROOT, 'extension') : U.SHADOW_DIR;
      if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
      spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      sendJson(res, 200, {
        ok: true,
        message: which === 'extension'
          ? `已打开扩展文件夹：${dir}\n在 Chrome 里打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选这个文件夹`
          : `已打开：${dir}`,
      });
      return;
    }
    if (p === '/api/cookies/import') {
      beginOp('同步登录态');
      try {
        const cookies = Array.isArray(body.cookies) ? body.cookies : [];
        if (!cookies.length) throw new Error('没有收到 cookie 数据');
        const meta = await SESSION.importCookies(cookies, {
          log: (m) => runner.log(m),
          source: body.source || 'chrome-extension',
          mode: 'shadow',
        });
        const line = meta.loggedIn
          ? `登录态已就绪${meta.handle ? `（@${meta.handle}）` : ''}，可以开始抓取了。`
          : 'cookie 已写入副本，但 X 仍显示未登录。请确认浏览器里登录的是哪个 X 账号，或稍后重试。';
        sendJson(res, 200, {
          ok: true,
          message: `已同步 ${meta.cookieCount} 条 cookie 到独立副本。${line}`,
          session: meta,
        });
      } finally {
        endOp();
      }
      return;
    }
    if (p === '/api/login/check') {
      const r = await doLoginCheck();
      sendJson(res, 200, r);
      return;
    }
    if (p === '/api/config') {
      const patch = {};
      if (body.mode === 'live' || body.mode === 'shadow') patch.mode = body.mode;
      if (typeof body.liveProfile === 'string' && body.liveProfile.trim()) patch.liveProfile = body.liveProfile.trim();

      // 先合并普通配置项：saveConfig 是「读现有 config.json + 合并 patch」，不会清掉 timeouts。
      let next = U.saveConfig(patch);
      const notes = [];
      if (patch.mode) {
        runner.log(`运行模式已切换为：${next.mode === 'live' ? '直接使用我的 Chrome' : '独立副本'}`);
        notes.push(next.mode === 'live'
          ? '已切到「直接使用我的 Chrome」：请先在自己 Chrome 里登录 X，再点「授权并启用调试接口」。'
          : '已切到「独立副本」：请先点「准备登录态」，再点「检查登录态」在副本窗口里登录一次。');
      }

      // 再处理超时档位：saveTimeoutPreset 内部自己会调一次 saveConfig，
      // 它写入的 timeoutPreset + timeouts 与上面的 patch 各自独立、互不覆盖，
      // 所以最终以它返回的 next 为准（里面同时包含 mode/liveProfile 和档位数值）。
      // 注意顺序：先 patch 后档位，保证档位那次的 loadConfig 已经带上 mode/liveProfile。
      const preset = body.timeoutPreset;
      if (preset !== undefined && preset !== null && preset !== '') {
        if (typeof preset === 'string' && U.TIMEOUT_PRESETS[preset]) {
          next = U.saveTimeoutPreset(preset);
          runner.log(`超时档位已切换为：${U.TIMEOUT_PRESETS[preset].label}`);
          notes.push(`超时档位已切换为「${U.TIMEOUT_PRESETS[preset].label}」，下个任务生效`
            + '（正在跑的任务不受影响，想立刻生效请先停止再重新开始）。');
        } else {
          // 非法档位名不当成错误：忽略它，并在回复里说明合法档位。
          const names = Object.keys(U.TIMEOUT_PRESETS)
            .map((k) => `${k}（${U.TIMEOUT_PRESETS[k].label}）`).join('、');
          runner.log(`超时档位「${String(preset)}」不合法，已忽略。可用档位：${names}`);
          notes.push(`超时档位「${String(preset)}」不是有效档位，已忽略本次修改，当前仍是`
            + `「${U.loadTimeouts(next).label}」。可用档位：${names}。`);
        }
      }

      sendJson(res, 200, {
        ok: true,
        config: next,
        timeouts: U.loadTimeouts(next),
        message: notes.length
          ? notes.join(' ')
          : '这次没有需要修改的配置项，当前设置保持不变（下个任务生效）。',
      });
      return;
    }
    if (p === '/api/policy') {
      if (runner.busy) throw new Error('抓取任务正在运行，请先停止。');
      const enable = body.enable !== false;
      runner.log(enable ? '正在请求 UAC 授权以启用 Chrome 调试策略…' : '正在清理 Chrome 调试策略…');
      const r = await setPolicyElevated(enable);
      runner.log(`策略操作结果：${r.message}`);
      sendJson(res, 200, r);
      return;
    }
    if (p === '/api/start') {
      if (opName) throw new Error(`正在执行「${opName}」，请等它结束再点开始抓取。`);
      const handle = U.safeHandle(body.handle);
      if (!handle) throw new Error('用户名不合法');
      const opts = {
        handle,
        maxTweets: Math.max(0, Number(body.maxTweets) || 0),
        speed: ['safe', 'normal', 'fast'].indexOf(body.speed) >= 0 ? body.speed : 'safe',
        images: ['none', 'medium', 'orig'].indexOf(body.images) >= 0 ? body.images : 'orig',
        tabs: body.tabs === 'posts' ? 'posts' : 'with_replies',
        // 完整重走：不走搜索页增量，用「帖子与回复」时间线从顶划到底补全（搜索索引有缺）
        forceTimeline: body.forceTimeline === true,
        // 自定义搜索查询（探测/补窗）：给了就不走续抓边界；无结果直接收尾，不回退主页
        searchQuery: typeof body.searchQuery === 'string' && body.searchQuery.trim() ? body.searchQuery : undefined,
        // 单次时长上限（分钟）：''/null/undefined = 跟速度档位走；0 = 不限时；正数 = 分钟数
        maxMinutes: (body.maxMinutes === '' || body.maxMinutes === null || body.maxMinutes === undefined)
          ? null
          : Math.max(0, Math.floor(Number(body.maxMinutes) || 0)),
      };
      await runner.start(opts);
      sendJson(res, 200, { ok: true, message: `已开始抓取 @${handle}` });
      return;
    }
    if (p === '/api/stop') {
      runner.stop('你手动点了停止');
      sendJson(res, 200, { ok: true, message: '已发送停止请求，当前这一步走完就会停下来。' });
      return;
    }
    if (p === '/api/open-report') {
      const handle = U.safeHandle(body.handle);
      if (!handle) throw new Error('用户名不合法');
      const file = U.reportPath(handle);
      openLocalFile(file);
      sendJson(res, 200, { ok: true, message: '已用默认浏览器打开报告：' + file });
      return;
    }
    sendJson(res, 404, { ok: false, message: '未知接口 ' + p });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    runner.log(`接口 ${p} 出错：${msg}`);
    sendJson(res, 200, { ok: false, message: msg });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    try { sendJson(res, 500, { ok: false, message: String(err && err.message) }); } catch (_) { /* ignore */ }
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    const urlText = `http://127.0.0.1:${PORT}`;
    // 双击 启动面板.cmd 时如果已经有面板在跑，这里是唯一会走到的地方：
    // 以前只打一行报错就退出，用户看到的是"窗口一闪、什么都没打开"。现在：
    //   ① 明确告诉他"面板已经在运行"；② 直接帮他打开那个正在运行的面板；③ 留 3 秒让他看清提示。
    console.error('');
    console.error(`端口 ${PORT} 已经被占用 —— 说明控制面板多半已经在运行了（找找有没有另一个黑窗口）。`);
    console.error(`已尝试帮你打开正在运行的面板：${urlText}`);
    console.error('如果那个面板打不开：先关掉旧的黑窗口再运行本脚本，或者设环境变量 XSCRAPER_PORT=8788 换端口');
    console.error('（注意：换端口后扩展 extension\\background.js 里的 SERVER 也要一起改）。');
    console.error('');
    try {
      runner.log(`控制面板启动失败：端口 ${PORT} 已被占用（多半已有一个面板在运行），已尝试打开 ${urlText}`);
    } catch (_) { /* ignore */ }
    if (!process.env.XSCRAPER_NO_OPEN) {
      try {
        spawn('cmd', ['/c', 'start', '', urlText], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (_) { /* ignore */ }
    }
    setTimeout(() => process.exit(1), 3000);
    return;
  }
  console.error('控制面板启动失败：', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const urlText = `http://127.0.0.1:${PORT}`;
  console.log('==============================================');
  console.log(' X 主页抓取器 —— 控制面板已启动');
  console.log(` 地址：${urlText}`);
  console.log(' 这个窗口不要关，关掉面板就停了。');
  console.log('==============================================');
  runner.log(`控制面板启动：${urlText}`);
  const cfg = U.loadConfig();
  if (cfg.mode === 'live') {
    const live = liveCookieInfo();
    runner.log(`运行模式：直接使用你的 Chrome（配置 ${live.profile}）`);
    runner.log(live.unreadable
      ? `注意：配置 ${live.profile} 的 cookie 库读不出来（${live.lockError || '文件被占用'}）——Chrome 正在运行时会这样，登录状态未知，不代表未登录`
      : live.hasAuthToken
        ? `你的 Chrome 里检测到 X 的登录 cookie（x/twitter ${live.xRows} 行），看起来是已登录状态`
        : `注意：配置 ${live.profile} 里暂时没检测到 X 的 auth_token，可能还没登录 X`);
  } else {
    const shadow = PROFILE.shadowStatus();
    runner.log('运行模式：独立副本');
    runner.log(shadow.ready ? '副本登录态：已准备' : '副本登录态：还没准备（请先点「准备登录态」）');
  }
  const pol = readPolicy();
  if (pol === 1) {
    runner.log('提示：Chrome 调试策略当前是启用状态，抓完请点「停用并清理」。');
  }
  if (!process.env.XSCRAPER_NO_OPEN) {
    spawn('cmd', ['/c', 'start', '', urlText], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

function shutdown() {
  runner.log('控制面板关闭中…');
  try { runner.stop('控制面板被关闭'); } catch (_) { /* ignore */ }
  if (readPolicy() === 1) {
    runner.log('提醒：Chrome 调试策略 RemoteDebuggingAllowed 仍是启用状态；'
      + '下次打开面板点「停用并清理」即可恢复（也可以手动删除该注册表值）。');
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
