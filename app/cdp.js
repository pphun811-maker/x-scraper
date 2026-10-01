'use strict';
/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 * 只用 Node 内置能力：http 拿调试端点、全局 WebSocket（Node 22+）收发协议帧。
 * 不依赖 selenium / playwright / ws —— 也就不带 navigator.webdriver 之类的自动化指纹。
 */
const http = require('http');

function httpRequest(port, method, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`HTTP ${method} ${urlPath} 超时`)));
    req.on('error', reject);
    req.end();
  });
}

async function version(port, timeoutMs = 4000) {
  const r = await httpRequest(port, 'GET', '/json/version', timeoutMs);
  if (r.status >= 400) throw new Error(`/json/version HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function listTargets(port, timeoutMs = 5000) {
  const r = await httpRequest(port, 'GET', '/json/list', timeoutMs);
  if (r.status >= 400) throw new Error(`/json/list HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function newPage(port, url = 'about:blank', timeoutMs = 20000) {
  const p = '/json/new?' + encodeURIComponent(url);
  let r;
  try {
    r = await httpRequest(port, 'PUT', p, timeoutMs);
  } catch (_) {
    r = await httpRequest(port, 'POST', p, timeoutMs);   // 老版本 Chrome 用 GET/POST
  }
  if (r.status >= 400) throw new Error(`新建标签页失败 HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

async function closeTarget(port, targetId) {
  try { await httpRequest(port, 'GET', '/json/close/' + targetId, 4000); } catch (_) { /* ignore */ }
}

class CDP {
  constructor(wsUrl, name = 'cdp') {
    this.wsUrl = wsUrl;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ws = null;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(new Error(`无法创建 WebSocket：${err.message}（需要 Node 22 以上）`));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) { /* ignore */ }
        reject(new Error('连接调试端口超时'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error(`调试连接出错：${(ev && ev.message) || '未知错误'}`));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('调试连接已关闭'));
        this.pending.clear();
        this.emit('__closed', {});
      });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (_) {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params || {});
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }
  emit(event, params) {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const fn of list.slice()) {
      try { fn(params); } catch (_) { /* 单个监听器异常不影响协议层 */ }
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('调试连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  waitEvent(event, timeoutMs = 15000, predicate = null) {
    return new Promise((resolve, reject) => {
      const off = () => {
        const list = this.handlers.get(event) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
      const timer = setTimeout(() => { off(); reject(new Error(`等待 ${event} 事件超时`)); }, timeoutMs);
      const fn = (params) => {
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      };
      this.on(event, fn);
    });
  }

  /** 在页面里执行一段表达式并取回 JSON 结果 */
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: !!opts.awaitPromise,
      userGesture: true,
    }, opts.timeoutMs || 30000);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知错误';
      throw new Error(`页面脚本出错：${String(desc).split('\n')[0]}`);
    }
    return r && r.result ? r.result.value : undefined;
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { CDP, version, listTargets, newPage, closeTarget, httpRequest };
