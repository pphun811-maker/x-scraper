'use strict';
/**
 * 登录态同步：把 Chrome 扩展交给我们的 cookie 注入到"独立副本"浏览器里。
 *
 * 为什么这么绕：Chrome 127+ 的应用绑定加密让 cookie 无法被别的程序解密，也禁止把配置目录
 * 复制到别处复用；而 Chrome 136+ 又拒绝在默认配置目录上开调试端口。所以唯一干净的组合是：
 *   ① 由用户自己的 Chrome（扩展）把 cookie 明文交出来（浏览器自己解密的，合法且不复制配置目录）；
 *   ② 注入到我们自己的副本浏览器里跑抓取 —— 副本有自己的加密密钥，完全自洽。
 *
 * 明文 cookie 只在内存里过一遍，不落盘；磁盘上只记录"什么时候同步过、多少条"。
 */
const path = require('path');
const U = require('./util');
const CH = require('./chrome');

const META_PATH = path.join(U.DATA_ROOT, '_session', 'x-session.json');

function loadMeta() {
  return U.readJsonSafe(META_PATH, null);
}
function saveMeta(meta) {
  U.ensureDir(path.dirname(META_PATH));
  U.writeJsonSafe(META_PATH, meta);
}

function sameSiteToCdp(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return null;                       // unspecified → 不传
}

/** 把扩展导出的 cookie 写进副本浏览器，并验证登录态 */
async function importCookies(cookies, ctx = {}) {
  const log = ctx.log || (() => {});
  const config = U.loadConfig();
  const mode = ctx.mode || 'shadow';        // 统一注入到副本，绝不碰用户的真实配置
  const port = config.debugPort || U.DEFAULT_DEBUG_PORT;

  const wanted = cookies.filter((c) => c && c.name && typeof c.value === 'string'
    && /(^|\.)(x\.com|twitter\.com)$/i.test(String(c.domain || '').replace(/^\./, '')));
  if (!wanted.length) throw new Error('收到 0 条 x.com/twitter.com 的 cookie，请确认是在登录了 X 的浏览器里点的同步。');

  log(`收到 ${cookies.length} 条 cookie，其中 x.com/twitter.com 相关 ${wanted.length} 条，开始注入副本…`);
  await CH.ensureBrowser({ mode, config, visible: false, log });
  const page = await CH.openPage(port, 'about:blank', log);
  const cdp = page.cdp;

  const nowSec = Math.floor(Date.now() / 1000);
  let ok = 0;
  let fail = 0;
  const failures = [];

  for (const c of wanted) {
    const host = String(c.domain).replace(/^\./, '');
    const params = {
      name: String(c.name),
      value: String(c.value),
      path: c.path || '/',
      secure: true,                          // X 的 cookie 都是 HTTPS 专用
      httpOnly: !!c.httpOnly,
      // 会话级 cookie 给个 30 天的期限，这样副本站重启后登录态还在
      expires: c.expirationDate ? Math.floor(c.expirationDate) : nowSec + 30 * 24 * 3600,
      url: `https://${host}/`,
    };
    if (!c.hostOnly) params.domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    const ss = sameSiteToCdp(c.sameSite);
    if (ss) params.sameSite = ss;
    try {
      const r = await cdp.send('Network.setCookie', params, 10000);
      if (r && r.success) ok += 1;
      else { fail += 1; failures.push(`${c.name}@${c.domain}`); }
    } catch (err) {
      fail += 1;
      failures.push(`${c.name}@${c.domain}: ${err.message}`);
    }
  }
  log(`注入结果：成功 ${ok} 条，失败 ${fail} 条${fail ? `（例如 ${failures.slice(0, 3).join('；')}）` : ''}`);

  const jar = await cdp.send('Network.getCookies', { urls: ['https://x.com/', 'https://api.x.com/'] });
  const names = new Set(((jar && jar.cookies) || []).map((c) => c.name));
  const hasAuth = names.has('auth_token');
  const hasCt0 = names.has('ct0');
  log(`副本 cookie 检查：x.com 可见 cookie ${names.size} 个，auth_token ${hasAuth ? '在' : '不在'}，ct0 ${hasCt0 ? '在' : '不在'}`);

  let login = { loggedIn: false, handle: null };
  try {
    login = await CH.checkLoginState(cdp, log);
  } catch (err) {
    log(`登录态验证失败：${err.message}`);
  }

  const meta = {
    syncedAt: U.nowIso(),
    cookieCount: ok,
    failed: fail,
    hasAuthToken: hasAuth,
    loggedIn: !!login.loggedIn,
    handle: login.handle || null,
    source: ctx.source || 'chrome-extension',
  };
  saveMeta(meta);
  try { page.cdp.close(); } catch (_) { /* ignore */ }
  await CH.closeShadowBrowser(port, log);
  return meta;
}

module.exports = { importCookies, loadMeta, saveMeta, META_PATH };
