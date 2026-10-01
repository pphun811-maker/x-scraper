'use strict';
/**
 * 这个扩展只做一件事：
 *   用 Chrome 自己的 cookie 接口读出 x.com / twitter.com 的登录 cookie（包括 HttpOnly 的 auth_token，
 *   浏览器会在这里替我们解密），然后 POST 给本机 127.0.0.1 上的抓取工具。
 *
 * 不做任何别的：不注入页面、不改页面、不联网到任何外部服务器、不读其它网站的 cookie。
 */

const SERVER = 'http://127.0.0.1:8787';
const DOMAINS = ['x.com', 'twitter.com'];

async function collectCookies() {
  const seen = new Map();
  for (const domain of DOMAINS) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch (err) {
      list = [];
    }
    for (const c of list) {
      seen.set(`${c.name}|${c.domain}|${c.path}`, c);
    }
  }
  return Array.from(seen.values()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
    expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : null,
    sameSite: c.sameSite || null,
    hostOnly: !!c.hostOnly,
  }));
}

async function sync() {
  const cookies = await collectCookies();
  if (!cookies.length) {
    return { ok: false, error: '没有读到任何 x.com 的 cookie —— 请先在这个浏览器里登录 X。' };
  }
  const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value);
  if (!hasAuth) {
    return { ok: false, error: '读到了 cookie，但没有 auth_token —— 说明这个浏览器当前没有登录 X。' };
  }
  let res;
  try {
    res = await fetch(`${SERVER}/api/cookies/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'chrome-extension', at: new Date().toISOString(), cookies }),
    });
  } catch (err) {
    return { ok: false, error: '连不上本机工具（http://127.0.0.1:8787）。请先双击启动面板.cmd 把控制面板打开。' };
  }
  let data = {};
  try { data = await res.json(); } catch (err) { data = {}; }
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.message || `工具返回 HTTP ${res.status}` };
  }
  return { ok: true, count: cookies.length, message: data.message || '已同步。' };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg && msg.type === 'sync') {
    sync().then(respond).catch((err) => respond({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;      // 异步回应
  }
  return false;
});

// 装好扩展后自动同步一次，省得用户还要点按钮
chrome.runtime.onInstalled.addListener(() => {
  sync().then((r) => console.log('[X 登录态同步] 自动同步结果：', r))
    .catch((err) => console.log('[X 登录态同步] 自动同步失败：', err));
});
