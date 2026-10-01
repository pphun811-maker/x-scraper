'use strict';
/**
 * 通过系统代理直接下载文件。
 *
 * 为什么需要它：Node 的 fetch 默认**不读 Windows 的系统代理**，而 pbs.twimg.com 在很多网络下
 * 必须走代理才能访问，于是图片会全部下载失败。这里自己用 HTTP CONNECT 建隧道再发 HTTP/1.0
 * 请求（HTTP/1.0 不会被分块编码，连接关闭即结束，解析简单可靠），不依赖任何第三方库。
 */
const http = require('http');
const tls = require('tls');
const { execFileSync } = require('child_process');

let cachedProxy;
let cachedProxyAt = 0;

/** 读系统代理（Windows 注册表），结果缓存 60 秒 */
function systemProxy(force) {
  const now = Date.now();
  if (!force && cachedProxy !== undefined && now - cachedProxyAt < 60000) return cachedProxy;
  cachedProxyAt = now;
  cachedProxy = null;
  // 先读环境变量（启动面板.cmd 在检测到系统代理时会设置 HTTP(S)_PROXY），
  // 读不到再查注册表。reg.exe 可能被安全软件列入程序黑名单（实测：火绒对
  // agent 会话整棵进程树生效，放宽沙箱也绕不过），单靠它会有"检测不到系统
  // 代理 → 图片全败"的单点故障；环境变量路径不依赖任何外部进程。
  const envRaw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  const envProxy = envRaw && String(envRaw).trim();
  if (envProxy) {
    cachedProxy = envProxy.includes('://') ? envProxy : `http://${envProxy}`;
    return cachedProxy;
  }
  try {
    const out = execFileSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const m = /ProxyServer\s+REG_SZ\s+([^\s]+)/.exec(out);
    if (m && m[1]) cachedProxy = m[1].includes('://') ? m[1] : `http://${m[1]}`;
  } catch (_) {
    /* 没有系统代理 */
  }
  return cachedProxy;
}

function parseProxy(p) {
  const s = String(p || '').replace(/^[a-z]+:\/\//i, '');
  const i = s.lastIndexOf(':');
  if (i < 0) return { host: s, port: 8080 };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || 8080 };
}

function fetchViaProxy(rawUrl, opts = {}) {
  const { timeoutMs = 30000, proxy = systemProxy(), userAgent = 'Mozilla/5.0', referer = 'https://x.com/' } = opts;
  return new Promise((resolve, reject) => {
    if (!proxy) { reject(new Error('没有检测到系统代理')); return; }
    let u;
    try { u = new URL(rawUrl); } catch (err) { reject(new Error('URL 不合法')); return; }
    const { host: phost, port: pport } = parseProxy(proxy);

    const req = http.request({
      host: phost, port: pport, method: 'CONNECT', path: `${u.hostname}:443`, timeout: timeoutMs,
    });
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.on('error', (err) => reject(new Error(`代理连接失败：${err.message}`)));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: u.hostname }, () => {
        tlsSock.write([
          `GET ${u.pathname}${u.search} HTTP/1.0`,
          `Host: ${u.hostname}`,
          `User-Agent: ${userAgent}`,
          'Accept: image/avif,image/webp,image/*,*/*;q=0.8',
          'Accept-Encoding: identity',
          `Referer: ${referer}`,
          'Connection: close',
          '', '',
        ].join('\r\n'));
      });
      const chunks = [];
      tlsSock.setTimeout(timeoutMs, () => tlsSock.destroy(new Error('读取超时')));
      tlsSock.on('data', (d) => chunks.push(d));
      tlsSock.on('error', (err) => reject(new Error(`隧道出错：${err.message}`)));
      tlsSock.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const sep = buf.indexOf('\r\n\r\n');
          if (sep < 0) { reject(new Error('响应格式异常')); return; }
          const head = buf.slice(0, sep).toString('latin1');
          const status = Number((/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(head) || [])[1] || 0);
          const body = buf.slice(sep + 4);
          if (status !== 200) { reject(new Error(`HTTP ${status}`)); return; }
          if (!body.length) { reject(new Error('响应体为空')); return; }
          resolve(body);
        } catch (err) {
          reject(err);
        }
      });
      tlsSock.on('close', () => {
        if (!chunks.length) reject(new Error('连接被提前关闭'));
      });
    });
    req.end();
  });
}

module.exports = { fetchViaProxy, systemProxy, parseProxy };
