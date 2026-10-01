'use strict';
/**
 * 报告页翻译模块的离线测试：假 DOM + 假 fetch，不开浏览器、不碰面板、不发真实请求。
 * 用法：node _test/test-report-translation.js
 * 覆盖：Google 引擎（译按钮/引用/收起/429 回退/缓存）、设置弹窗（预设/保存/引擎切换）、
 *       AI 引擎（OpenAI 兼容、F1 提示词、缓存分引擎）、AI 批量确认（取消/放行）。
 */

const fs = require('fs');
const path = require('path');

/* ---------------- 假 fetch（按 URL 分发真实响应结构） ---------------- */

const fetchCalls = [];
let lastAiBody = null;
function fakeFetch(url, opts) {
  fetchCalls.push(String(url));
  if (String(url).indexOf('/chat/completions') >= 0) {
    try { lastAiBody = JSON.parse(opts && opts.body); } catch (e) { lastAiBody = null; }
    const content = lastAiBody && lastAiBody.messages && lastAiBody.messages[lastAiBody.messages.length - 1]
      ? lastAiBody.messages[lastAiBody.messages.length - 1].content : '';
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'AI译文：' + content } }] }),
    });
  }
  const q = decodeURIComponent((/q=([^&]*)/.exec(url) || [, ''])[1]);
  if (url.indexOf('translate_a/single') >= 0) {
    // 备选端点：gtx dj=1 的响应结构
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ sentences: [{ trans: '备选端点译文：' + q, orig: q }], src: 'en' }),
    });
  }
  if (q.indexOf('FORCE429') >= 0) {
    // 首选端点对这条限流（模拟本机对 gtx 的 429 情况）
    return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
  }
  // 首选端点：dict-chrome-ex 的响应结构
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve([[q + '→中译', 'en']]),
  });
}

/* ---------------- 假 DOM ---------------- */

function matchSel(n, sel) {
  const parts = sel.match(/\.[\w-]+|\[[^\]]+\]|^[a-zA-Z]+/g) || [];
  for (const p of parts) {
    if (p[0] === '.') {
      if (!(n.classList && n.classList.contains(p.slice(1)))) return false;
    } else if (p[0] === '[') {
      const m = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(p);
      const got = n.getAttribute(m[1]);
      if (m[2] === undefined ? got === null : got !== m[2]) return false;
    } else if (n.tagName !== p) return false;
  }
  return true;
}

function fakeEl(tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, listeners: {}, hidden: false,
    parentNode: null, style: {}, _isFrag: tag === '#frag',
    value: '', checked: false, disabled: false,
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    appendChild(c) {
      if (c && c._isFrag) { const kids = c.children.slice(); c.children = []; kids.forEach((k) => el.appendChild(k)); return c; }
      c.parentNode = el; el.children.push(c); return c;
    },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = el.children.indexOf(ref);
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    fire(type) { (el.listeners[type] || []).forEach((fn) => fn({})); },
    click() { el.fire('click'); },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
      walk(el);
      return out;
    },
  };
  let clsSet = new Set();
  Object.defineProperty(el, 'className', {
    get() { return Array.from(clsSet).join(' '); },
    set(v) { clsSet = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  el.classList = {
    add(c) { clsSet.add(c); },
    remove(c) { clsSet.delete(c); },
    contains(c) { return clsSet.has(c); },
    toggle(c, force) {
      const on = force === undefined ? !clsSet.has(c) : !!force;
      if (on) clsSet.add(c); else clsSet.delete(c);
      return on;
    },
  };
  Object.defineProperty(el, 'nextElementSibling', {
    get() { if (!el.parentNode) return null; const s = el.parentNode.children; return s[s.indexOf(el) + 1] || null; },
  });
  Object.defineProperty(el, 'previousElementSibling', {
    get() { if (!el.parentNode) return null; const s = el.parentNode.children; return s[s.indexOf(el) - 1] || null; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return (el._text || '') + el.children.map((c) => c.textContent).join(''); },
    set(v) { el._text = String(v); el.children = []; },
  });
  return el;
}

const byId = {};
const IDS = ['feed', 'wall', 'hits', 'empty', 'more', 'sentinel', 'sort', 'q', 'kinds', 'reset',
  'onlyMedia', 'onlyCard', 'lightbox', 'lbImg', 'lbCap', 'lbCount', 'lbPrev', 'lbNext',
  'lbClose', 'topbar', 'foldBtn', 'expandBtn', 'trAll', 'trStat', 'trGear', 'trSet',
  'trsEngG', 'trsEngA', 'trsAi', 'trsPreset', 'trsBase', 'trsKey', 'trsModel',
  'trsTest', 'trsTestStat', 'trsSave', 'trsCancel'];

function buildDom() {
  IDS.forEach((id) => { byId[id] = fakeEl(id === 'feed' ? 'main' : 'div'); });
  byId.data = fakeEl('script');
  byId.data.textContent = JSON.stringify({ tweets: TWEETS, meta: { batchCards: 80, batchWall: 120 } });
  document.body = fakeEl('body');
}

const document = {
  getElementById: (id) => byId[id] || null,
  createElement: (tag) => fakeEl(tag),
  createDocumentFragment: () => fakeEl('#frag'),
  createTextNode: (s) => { const e = fakeEl('#text'); e._text = String(s); return e; },
  // 假实现：遍历所有根（body + 注册过的 byId 元素），支撑 refreshBoxesForText 的全局查找
  querySelectorAll: (sel) => {
    const out = [];
    const seen = new Set();
    const roots = [document.body].concat(Object.keys(byId).map((k) => byId[k]));
    const walk = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      if (matchSel(n, sel)) out.push(n);
      for (const c of n.children) walk(c);
    };
    roots.forEach(walk);
    return out;
  },
  addEventListener() {},
  body: fakeEl('body'),
};

const localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
const confirmState = { result: true, calls: [] };
const window = {
  localStorage,
  confirm(m) { confirmState.calls.push(String(m)); return confirmState.result; },
  alert() {},
};

/* ---------------- 数据与被测代码 ---------------- */

const TWEETS = [
  { id: '123', url: 'https://x.com/test/status/123', author_name: 'Test', handle: 'test',
    text: 'Hello world, this is an English tweet.', lang: 'en', kind: 'original',
    time_iso: '2026-09-30T10:00:00Z', media: [],
    quoted: { url: '', author_name: 'Q', author_handle: 'q', text: 'Quoted English text here.' } },
  { id: '456', url: 'https://x.com/test/status/456', author_name: '测试', handle: 'test',
    text: '这条本来就是中文，不需要翻译。', lang: 'zh', kind: 'original',
    time_iso: '2026-09-30T09:00:00Z', media: [], quoted: null },
  { id: '789', url: 'https://x.com/test/status/789', author_name: 'Test', handle: 'test',
    text: 'FORCE429 please fall back to the second endpoint.', lang: 'en', kind: 'original',
    time_iso: '2026-09-30T08:00:00Z', media: [], quoted: null },
  { id: '999', url: 'https://x.com/test/status/999', author_name: 'Test', handle: 'test',
    text: 'AI engine test tweet for the settings round.', lang: 'en', kind: 'original',
    time_iso: '2026-09-30T07:00:00Z', media: [], quoted: null },
];

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'report.js'), 'utf8');
const m = src.match(/function pageApp\(\) \{[\s\S]*?\n\}/);
if (!m) { console.log('FAIL：没从 report.js 里截到 pageApp'); process.exit(1); }
global.document = document;
global.window = window;
global.fetch = fakeFetch;
global.localStorage = localStorage;

let failed = 0;
function ok(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pageApp() { eval('(' + m[0] + ')')(); }
function reinit() { buildDom(); pageApp(); } // 全新 DOM + 全新闭包（localStorage 保留）

(async () => {
  buildDom();
  console.log('1) 初始渲染');
  pageApp();
  const feed = byId.feed;
  ok(feed.children.length === 4, '四张卡片都渲染出来（' + feed.children.length + '）');
  const en = feed.children[0], zh = feed.children[1], f429 = feed.children[2];
  ok(en.getAttribute('data-trid') === '123', '卡片带 data-trid');
  ok(!!en.querySelector('.tr-btn'), '英文卡有「译」按钮');
  ok(!zh.querySelector('.tr-btn'), '中文卡没有「译」按钮（自动跳过）');
  ok(!en.querySelector('[data-tr="1"]'), '初始无译文块');

  console.log('2) 点「译」：主文本+引用一起翻（首选端点）');
  en.querySelector('.tr-btn').click();
  await sleep(80);
  const boxes = en.querySelectorAll('[data-tr="1"]');
  ok(boxes.length === 2, '出现两个译文块（主+引用）（' + boxes.length + '）');
  const mainBox = en.querySelector('.tw-text').nextElementSibling;
  ok(/Hello world[\s\S]*→中译/.test(mainBox.textContent), '主文本译文内容正确（含 "→中译"）');
  ok(mainBox.textContent.indexOf('译 · en') >= 0, '译文块带源语言标记（译 · en）');
  ok(fetchCalls.length >= 2 && fetchCalls[0].indexOf('clients5.google.com') >= 0, '请求走的首选端点 dict-chrome-ex');
  ok(en.querySelector('.q-text').nextElementSibling.textContent.indexOf('Quoted English text here.→中译') >= 0, '引用译文正确');

  console.log('3) 再点「译」：收起 / 展开');
  en.querySelector('.tr-btn').click();
  ok(en.classList.contains('tr-collapsed'), '第二次点击进入收起');
  en.querySelector('.tr-btn').click();
  ok(!en.classList.contains('tr-collapsed'), '第三次点击恢复展开');

  console.log('4) 429 回退备选端点');
  f429.querySelector('.tr-btn').click();
  await sleep(900);
  const fBox = f429.querySelector('.tw-text').nextElementSibling;
  ok(fBox && fBox.textContent.indexOf('备选端点译文') >= 0, '限流后自动换 translate_a/single 成功');

  console.log('5) localStorage 持久化（防抖 800ms）');
  await sleep(900);
  const saved = localStorage.getItem('xscraper_translations_v1');
  ok(!!saved && saved.indexOf('Hello world, this is an English tweet.') >= 0, '译文缓存已写入 localStorage');

  console.log('6) 缓存命中：重新初始化（Google 引擎）自动显示');
  reinit();
  const en2 = byId.feed.children[0];
  ok(en2.querySelectorAll('[data-tr="1"]').length === 2, '重开后缓存的译文直接显示（主+引用）');
  const aiCard2 = byId.feed.children[3];
  ok(!aiCard2.querySelector('[data-tr="1"]'), 'AI 推文在 Google 引擎下无译文块');

  console.log('7) 设置弹窗：选 AI + 预设自动填充 + 保存');
  byId.trGear.click();
  ok(byId.trSet.hidden === false, '点齿轮打开设置弹窗');
  byId.trsEngA.checked = true;
  byId.trsEngA.fire('change');
  ok(byId.trsAi.hidden === false, '选 AI 后表单显示');
  byId.trsPreset.value = '0'; // DeepSeek（用户自有服务商不进预设，用「自定义」手填）
  byId.trsPreset.fire('change');
  ok(byId.trsBase.value === 'https://api.deepseek.com/v1' && byId.trsModel.value === 'deepseek-chat', 'DeepSeek 预设自动填地址和模型');
  byId.trsKey.value = 'sk-test-123';
  byId.trsSave.click();
  ok(byId.trSet.hidden === true, '保存后关闭弹窗');
  const cfg = JSON.parse(localStorage.getItem('xscraper_translator_settings_v1'));
  ok(cfg.engine === 'a' && cfg.ai.base === 'https://api.deepseek.com/v1' && cfg.ai.key === 'sk-test-123' && cfg.ai.model === 'deepseek-chat', '设置已写 localStorage');
  ok(byId.trStat.textContent.indexOf('AI') >= 0, '状态条提示引擎已切换（' + byId.trStat.textContent + '）');

  console.log('8) AI 引擎逐卡翻译（F1 提示词 + 缓存分引擎）');
  byId.feed.children[3].querySelector('.tr-btn').click();
  await sleep(120);
  const aiBox = byId.feed.children[3].querySelector('.tw-text').nextElementSibling;
  ok(aiBox && aiBox.textContent.indexOf('AI译文：AI engine test tweet') >= 0, 'AI 译文正确显示');
  ok(aiBox.textContent.indexOf('译 · AI') >= 0, '译文块标记「译 · AI」');
  ok(fetchCalls.some((u) => u.indexOf('/chat/completions') >= 0), '请求走 chat/completions');
  ok(!!lastAiBody && lastAiBody.model === 'deepseek-chat', '请求带模型名');
  ok(!!lastAiBody && lastAiBody.messages[0].role === 'system' && lastAiBody.messages[0].content.indexOf('pit stop=进站') >= 0, '系统提示词含 F1 术语表');
  ok(!!lastAiBody && lastAiBody.messages[0].content.indexOf('Russell=拉塞尔') >= 0, '系统提示词含车手中译');
  await sleep(900);
  const savedTr = localStorage.getItem('xscraper_translations_v1');
  ok(savedTr.indexOf('a\\u0000AI engine test tweet') >= 0, 'AI 缓存条目带 a\\u0000 前缀（与 Google 分开）');

  console.log('9) 引擎隔离：切回 Google 后不吃 AI 缓存');
  byId.trGear.click();
  byId.trsEngG.checked = true;
  byId.trsEngA.checked = false; // 假 DOM 没有单选互斥，手动模拟真实浏览器的行为
  byId.trsEngG.fire('change');
  byId.trsSave.click();
  ok(byId.trStat.textContent.indexOf('Google') >= 0, '状态条提示切回 Google');
  reinit();
  ok(byId.feed.children[0].querySelectorAll('[data-tr="1"]').length === 2, 'Google 缓存仍有效（卡片0）');
  ok(!byId.feed.children[3].querySelector('[data-tr="1"]'), 'AI 引擎的缓存不会喂给 Google 引擎');

  console.log('10) AI 批量确认：取消不放行，确认后执行');
  byId.trGear.click();
  byId.trsEngA.checked = true;
  byId.trsEngG.checked = false; // 同上，模拟单选互斥
  byId.trsEngA.fire('change');
  byId.trsSave.click();
  confirmState.result = false;
  confirmState.calls = [];
  const chatBefore = fetchCalls.filter((u) => u.indexOf('/chat/completions') >= 0).length;
  byId.trAll.click();
  ok(confirmState.calls.length === 1 && /AI 翻译 \d+ 段/.test(confirmState.calls[0]), '批量前弹确认框并报条数');
  ok(byId.trStat.textContent === '已取消', '取消后不执行');
  ok(fetchCalls.filter((u) => u.indexOf('/chat/completions') >= 0).length === chatBefore, '取消后零请求');
  confirmState.result = true;
  byId.trAll.click();
  await sleep(4500);
  ok(/完成：成功 \d+ 段/.test(byId.trStat.textContent), '确认后批量完成（' + byId.trStat.textContent + '）');
  const savedTr2 = localStorage.getItem('xscraper_translations_v1');
  ok(savedTr2.indexOf('a\\u0000Hello world') >= 0, '批量结果按引擎入缓存');

  console.log(failed ? ('FAIL：' + failed + ' 项未过') : '全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL：' + (e && e.stack || e)); process.exit(1); });
