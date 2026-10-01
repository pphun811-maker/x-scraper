'use strict';

/**
 * report.js —— 把某个数据目录里的 tweets.jsonl 渲染成一个可离线双击打开的 index.html
 *
 * 用法：
 *   const { generateReport } = require('./report.js');
 *   const { outPath, count } = generateReport('E:/x-scraper/data/georgerussell63');
 *
 * 说明：
 *   - 零第三方依赖，只用 node 内置模块。
 *   - 生成的 index.html 是单文件：CSS/JS 全内联，不引用任何 CDN / 外部字体，
 *     图片优先用 media[].local 的相对路径，本地文件缺失时自动回退到远程 URL。
 *   - 推文数据内联在 <script id="data" type="application/json"> 里，
 *     序列化时把 < > & 以及 U+2028/U+2029 全部转义成 \uXXXX，避免 </script> 注入。
 *   - 坏行会被跳过，不会因为一行脏数据让整次生成失败。
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 通用小工具（Node 侧）
 * ------------------------------------------------------------------ */

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function num(v) {
  // 注意：null / undefined / '' 必须保持“缺失”，不能变成 0（Number('') === 0 是个坑）
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v.trim().replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** HTML 文本转义（只用于报告页里由 Node 直接生成的静态片段） */
function escHtml(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 序列化成可以安全放进 <script> 里的 JSON 文本 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Date -> "2026-09-20 20:34"（本机时区） */
function fmtLocalDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 把 media[].local 变成相对 index.html 的 URL；绝对路径 / 不可移植的路径返回 '' */
function localRef(p) {
  let s = str(p).trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(s)) return ''; // E:/xxx —— 换台机器就失效，宁可用远程
  if (s.indexOf('//') === 0 || s.indexOf('file:') === 0) return '';
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  const segs = s.split('/').filter(Boolean);
  if (!segs.length) return '';
  return segs.map((x) => encodeURIComponent(x)).join('/');
}

/* ------------------------------------------------------------------ *
 * 读取输入
 * ------------------------------------------------------------------ */

/** 逐行解析 JSONL，坏行只计数不抛错 */
function readJsonlFile(file) {
  const out = { items: [], badLines: 0, totalLines: 0, exists: false, bytes: 0, error: null };
  let text;
  try {
    if (!fs.existsSync(file)) return out;
    const st = fs.statSync(file);
    if (!st.isFile()) return out;
    out.exists = true;
    out.bytes = st.size;
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    out.error = String((err && err.message) || err);
    return out;
  }
  // 去掉 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    out.totalLines++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      out.badLines++;
      continue;
    }
    out.items.push(obj);
  }
  return out;
}

function readStateFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 字段归一化（容错：字段可能缺失 / null / 类型不对）
 * ------------------------------------------------------------------ */

function normalizeMedia(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const m = rawList[i];
    if (!m || typeof m !== 'object') continue;
    const url = str(m.url);
    const poster = str(m.poster);
    const local = str(m.local);
    if (!url && !poster && !local) continue;
    let type = str(m.type).toLowerCase();
    if (type !== 'photo' && type !== 'video' && type !== 'gif') type = poster || url.indexOf('/amplify_video') >= 0 ? 'video' : 'photo';
    out.push({
      type: type,
      url: url,
      poster: poster,
      local: local,
      localRef: localRef(local),
      alt: str(m.alt),
    });
  }
  return out;
}

function normalizeQuoted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const q = {
    url: str(raw.url),
    author_name: str(raw.author_name),
    author_handle: str(raw.author_handle),
    text: typeof raw.text === 'string' ? raw.text : str(raw.text),
  };
  if (!q.url && !q.text && !q.author_name && !q.author_handle) return null;
  return q;
}

function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = { url: str(raw.url), title: str(raw.title), domain: str(raw.domain) };
  if (!c.url && !c.title && !c.domain) return null;
  return c;
}

function normalizeMetrics(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    replies: num(m.replies),
    reposts: num(m.reposts),
    likes: num(m.likes),
    views: num(m.views),
  };
}

function normalizeTweet(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = {
    id: str(raw.id),
    url: str(raw.url),
    handle: str(raw.handle),
    author_name: str(raw.author_name),
    author_handle: str(raw.author_handle),
    author_avatar: str(raw.author_avatar),
    verified: raw.verified === true,
    text: typeof raw.text === 'string' ? raw.text : str(raw.text),
    retweeted_by: str(raw.retweeted_by),
    reply_to: Array.isArray(raw.reply_to)
      ? raw.reply_to.map(str).filter(Boolean)
      : str(raw.reply_to)
        ? [str(raw.reply_to)]
        : [],
    quoted: normalizeQuoted(raw.quoted),
    media: normalizeMedia(raw.media),
    card: normalizeCard(raw.card),
    metrics: normalizeMetrics(raw.metrics),
    time_iso: str(raw.time_iso),
    lang: str(raw.lang),
    truncated: raw.truncated === true,
    source_tab: str(raw.source_tab),
    scraped_at: str(raw.scraped_at),
  };
  let kind = str(raw.kind).toLowerCase();
  if (kind !== 'original' && kind !== 'retweet' && kind !== 'reply') {
    kind = t.retweeted_by ? 'retweet' : t.reply_to.length ? 'reply' : 'original';
  }
  t.kind = kind;
  if (!t.id && !t.url && !t.text) return null; // 完全空对象当脏数据丢掉
  if (!t.url && t.id && (t.author_handle || t.handle)) {
    t.url = 'https://x.com/' + (t.author_handle || t.handle) + '/status/' + t.id;
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * 概览信息
 * ------------------------------------------------------------------ */

function buildMeta(tweets, state, readInfo, dir, options) {
  const times = [];
  const tabs = [];
  let images = 0;
  let authorName = '';
  let handle = '';

  for (let i = 0; i < tweets.length; i++) {
    const t = tweets[i];
    const ms = Date.parse(t.time_iso);
    if (!Number.isNaN(ms)) times.push(ms);
    images += t.media.length;
    if (t.source_tab && tabs.indexOf(t.source_tab) < 0) tabs.push(t.source_tab);
    if (!handle && (t.author_handle || t.handle)) handle = t.author_handle || t.handle;
    if (!authorName && t.author_name) authorName = t.author_name;
  }

  const stateHandle = str(state && state.handle);
  if (!handle) handle = stateHandle;
  if (!authorName && stateHandle && handle === stateHandle) authorName = '';

  const minMs = times.length ? Math.min.apply(null, times) : null;
  const maxMs = times.length ? Math.max.apply(null, times) : null;
  const rangeStart = minMs === null ? '' : fmtLocalDate(new Date(minMs));
  const rangeEnd = maxMs === null ? '' : fmtLocalDate(new Date(maxMs));

  const stateImages = num(state && state.images);
  const stateTabs = state && Array.isArray(state.tabs) ? state.tabs.map(str).filter(Boolean) : [];

  const title =
    str(options.title).trim() ||
    (handle ? '@' + handle + ' 的推文存档' : '推文存档（离线）');

  return {
    title: title,
    handle: handle,
    authorName: authorName,
    count: tweets.length,
    imageCount: images,
    stateImageCount: stateImages,
    rangeStart: rangeStart,
    rangeEnd: rangeEnd,
    generatedAt: fmtLocalDate(new Date()),
    dataFile: path.join(dir, 'tweets.jsonl'),
    dataFileName: 'tweets.jsonl',
    fileSize: humanSize(readInfo.bytes),
    fileBytes: readInfo.bytes,
    fileExists: readInfo.exists,
    dataError: readInfo.error || '',
    badLines: readInfo.badLines,
    totalLines: readInfo.totalLines,
    stateUsed: !!state,
    stateTotal: num(state && state.total),
    lastRunAt: str(state && state.lastRunAt),
    tabs: stateTabs.length ? stateTabs : tabs,
    tabsText: (stateTabs.length ? stateTabs : tabs)
      .map((x) => (x === 'posts' ? '仅主贴' : x === 'with_replies' ? '含回复' : x === 'search' ? '搜索续抓' : x))
      .join(' / '),
    batchCards: 80,
    batchWall: 120,
  };
}

/* ------------------------------------------------------------------ *
 * 页面样式
 * ------------------------------------------------------------------ */

function pageCss() {
  return `
:root{
  --bg:#0e1116; --panel:#151a22; --panel-2:#1a2029; --panel-3:#101620;
  --line:#252d3a; --line-2:#2f3947;
  --fg:#e7ebf2; --muted:#95a1b4; --dim:#6b7688;
  --accent:#4f8cff; --accent-bg:#1b2b4a; --accent-line:#2c4a80;
  --ok:#3fb950; --ok-bg:#152a1c; --warn:#d7a33a; --warn-bg:#2c2413; --bad:#ef7d72;
  --radius:12px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--fg);
  font-family:"Segoe UI","Microsoft YaHei",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  font-size:14px; line-height:1.62; -webkit-font-smoothing:antialiased;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px; margin:0 auto; padding:0 16px}
.topbar{position:sticky; top:0; z-index:30; background:rgba(14,17,22,.94); border-bottom:1px solid var(--line); backdrop-filter:blur(8px)}
.topbar .fold-btn{flex:none; font-size:12.5px; color:var(--muted); background:transparent; border:1px solid var(--line-2); border-radius:8px; padding:5px 12px; cursor:pointer; font-family:inherit}
.topbar .fold-btn:hover{color:var(--fg); border-color:var(--muted)}
.topbar .mini{display:none; align-items:center; gap:10px; padding-top:12px; padding-bottom:12px; min-width:0}
.topbar .mini b{color:var(--fg); font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.topbar .mini .mini-info{color:var(--dim); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.topbar .mini .mini-expand{margin-left:auto; flex:none; font-size:12.5px; color:var(--muted); background:transparent; border:1px solid var(--line-2); border-radius:8px; padding:4px 12px; cursor:pointer; font-family:inherit}
.topbar .mini .mini-expand:hover{color:var(--fg); border-color:var(--muted)}
.topbar.collapsed .ov-head,.topbar.collapsed .ov-meta,.topbar.collapsed .toolbar{display:none}
.topbar.collapsed .mini{display:flex}
.topbar.collapsed .wrap{padding-top:0; padding-bottom:0}
.topbar .wrap{padding-top:12px; padding-bottom:10px; position:relative}
.ov-head{display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap}
.ov-id h1{margin:0 0 2px; font-size:18px; font-weight:650; letter-spacing:.2px}
.ov-sub{color:var(--muted); font-size:13px}
.ov-sub .name{color:var(--fg)}
.ov-sub .handle{color:var(--muted); margin-left:6px}
.vfy{display:inline-block; margin-left:6px; width:15px; height:15px; line-height:15px; text-align:center;
  border-radius:50%; background:var(--accent); color:#fff; font-size:10px; vertical-align:1px}
.ov-stats{display:flex; gap:18px}
.ov-stats .stat{text-align:right; min-width:64px}
.ov-stats .stat b{display:block; font-size:17px; font-weight:650}
.ov-stats .stat span{color:var(--dim); font-size:12px}
.ov-meta{color:var(--dim); font-size:12px; margin-top:8px}
.toolbar{display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px}
#q{flex:1 1 240px; min-width:200px; padding:8px 11px; border-radius:9px; border:1px solid var(--line-2);
  background:var(--panel-3); color:var(--fg); font-size:13px; font-family:inherit; outline:none}
#q:focus{border-color:var(--accent-line); box-shadow:0 0 0 3px rgba(79,140,255,.13)}
#q:disabled{opacity:.5}
.kinds,.views{display:flex; gap:4px; background:var(--panel-3); padding:3px; border-radius:9px; border:1px solid var(--line)}
.kbtn,.vbtn{cursor:pointer; border:0; background:transparent; color:var(--muted); font-family:inherit; font-size:12.5px;
  padding:5px 10px; border-radius:6px; white-space:nowrap}
.kbtn i,.vbtn i{font-style:normal; color:var(--dim); margin-left:4px; font-size:11.5px}
.kbtn:hover,.vbtn:hover{color:var(--fg); background:#1e2531}
.kbtn.on,.vbtn.on{background:var(--accent-bg); color:#cfe0ff; box-shadow:inset 0 0 0 1px var(--accent-line)}
.kbtn.on i,.vbtn.on i{color:#9dbcff}
.kbtn:disabled,.vbtn:disabled{opacity:.45; cursor:default}
.chk{display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:12.5px; cursor:pointer; user-select:none}
.chk input{accent-color:var(--accent); width:14px; height:14px}
#sort{padding:6px 8px; border-radius:9px; border:1px solid var(--line); background:var(--panel-3); color:var(--muted);
  font-family:inherit; font-size:12.5px; outline:none}
.ghost{cursor:pointer; border:1px solid var(--line); background:var(--panel-3); color:var(--muted);
  font-family:inherit; font-size:12.5px; padding:6px 10px; border-radius:9px}
.ghost:hover{color:var(--fg); border-color:var(--line-2)}
.hits{color:var(--dim); font-size:12px; margin-left:auto; white-space:nowrap}
main{display:block; padding-bottom:8px}
.card{background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:13px 15px; margin:12px 0}
.card.kind-retweet{border-left:3px solid #3d4a5f}
.card.kind-reply{border-left:3px solid #3a4a3f}
.rt-line{color:var(--muted); font-size:12.5px; margin-bottom:8px; display:flex; gap:6px; align-items:center}
.rt-line .rt-ico{background:var(--panel-2); border:1px solid var(--line); border-radius:5px; padding:0 5px; font-size:11px; color:var(--dim)}
.rt-line.reply .rt-ico{color:#9ec5a8}
.rt-line .rt-who{color:var(--fg)}
.c-head{display:flex; gap:10px; align-items:flex-start}
.avatar{width:38px; height:38px; border-radius:50%; overflow:hidden; flex:none; background:var(--panel-2);
  display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:15px; font-weight:600}
.avatar img{width:100%; height:100%; object-fit:cover; display:block}
.c-who{flex:1 1 auto; min-width:0}
.c-line1{display:flex; align-items:center; gap:6px; flex-wrap:wrap}
.c-name{font-weight:620}
.c-handle{color:var(--muted); font-size:12.5px}
.badge{font-size:11px; padding:1px 7px; border-radius:20px; border:1px solid var(--line-2); color:var(--muted); background:var(--panel-2)}
.badge.b-original{color:#9ec5a8; border-color:#2f4a38; background:#16221a}
.badge.b-retweet{color:#a9bedd; border-color:#2f3f57; background:#161e2b}
.badge.b-reply{color:#d3bc95; border-color:#4a3f2a; background:#221d13}
.c-time{color:var(--dim); font-size:12.5px}
.c-open{margin-left:auto; font-size:12.5px; color:var(--muted); white-space:nowrap}
.c-open:hover{color:var(--accent)}
.tw-text{white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; margin:9px 0 0}
.tw-text a{color:var(--accent)}
.note{color:var(--dim); font-size:12px; margin-top:6px}
.mgrid{display:grid; gap:4px; margin-top:10px; border-radius:10px; overflow:hidden}
.mgrid.n1{grid-template-columns:1fr}
.mgrid.n2{grid-template-columns:1fr 1fr}
.mgrid.n3,.mgrid.n4{grid-template-columns:1fr 1fr}
.mgrid .cell{position:relative; background:#0b0e13; overflow:hidden; min-height:90px}
.mgrid.n1 .cell{max-height:560px}
.mgrid img{width:100%; height:100%; object-fit:cover; display:block; cursor:zoom-in; background:#0b0e13}
.mgrid.n1 img{max-height:560px; object-fit:contain}
.mgrid .vtag{position:absolute; left:8px; bottom:8px; background:rgba(8,10,14,.82); border:1px solid var(--line-2);
  color:#dbe3f0; font-size:11.5px; padding:2px 8px; border-radius:20px; pointer-events:none}
.m-ph{display:flex; align-items:center; justify-content:center; height:100%; min-height:90px; color:var(--dim);
  font-size:12px; border:1px dashed var(--line-2); border-radius:8px; background:var(--panel-3)}
.quote{border:1px solid var(--line-2); border-radius:10px; padding:10px 12px; margin-top:10px; background:var(--panel-2)}
.quote .q-head{display:flex; gap:6px; align-items:center; font-size:12.5px; flex-wrap:wrap}
.quote .q-name{font-weight:600}
.quote .q-handle{color:var(--muted)}
.quote .q-text{white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; margin-top:6px; color:#dfe5ef}
.linkcard{display:block; border:1px solid var(--line-2); border-radius:10px; padding:9px 12px; margin-top:10px;
  background:var(--panel-2); color:var(--fg)}
.linkcard:hover{text-decoration:none; border-color:var(--accent-line)}
.linkcard .lc-dom{color:var(--dim); font-size:12px}
.linkcard .lc-title{margin-top:2px}
.linkcard .lc-url{color:var(--muted); font-size:12px; word-break:break-all}
.metrics{display:flex; gap:16px; flex-wrap:wrap; margin-top:11px; padding-top:9px; border-top:1px solid var(--line); color:var(--muted); font-size:12.5px}
.metrics .metric{display:inline-flex; gap:5px; align-items:baseline}
.metrics .metric b{font-weight:600; color:#cfd7e4}
.metrics .metric i{font-style:normal; color:var(--dim)}
.wall{display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:6px; margin-top:12px}
.wall .wcell{position:relative; aspect-ratio:1/1; border-radius:9px; overflow:hidden; background:#0b0e13; cursor:zoom-in}
.wall .wcell img{width:100%; height:100%; object-fit:cover; display:block}
.wall .wcell .vtag{position:absolute; left:6px; bottom:6px; background:rgba(8,10,14,.82); border-radius:20px;
  font-size:11px; padding:1px 7px; color:#dbe3f0}
.more-wrap{text-align:center; margin:16px 0 4px}
.more{cursor:pointer; font-family:inherit; font-size:13px; padding:9px 20px; border-radius:9px;
  border:1px solid var(--accent-line); background:var(--accent-bg); color:#cfe0ff}
.more:hover{background:#22345a}
.empty{border:1px dashed var(--line-2); border-radius:var(--radius); padding:38px 20px; text-align:center;
  color:var(--muted); margin:18px 0; background:var(--panel-3)}
.empty b{display:block; color:var(--fg); margin-bottom:6px; font-size:15px}
.empty code{background:var(--panel-2); padding:1px 6px; border-radius:5px; font-size:12.5px; color:#cbd5e6}
.foot{color:var(--dim); font-size:12px; text-align:center; padding:26px 0 40px; border-top:1px solid var(--line); margin-top:26px}
.lb{position:fixed; inset:0; background:rgba(6,8,12,.93); z-index:60; display:flex; align-items:center; justify-content:center}
.lb[hidden]{display:none}
.lb-inner{max-width:94vw; max-height:92vh; display:flex; flex-direction:column; align-items:center; gap:10px}
.lb img{max-width:92vw; max-height:74vh; object-fit:contain; border-radius:10px; background:#0b0e13}
.lb-cap{color:var(--muted); font-size:12.5px; text-align:center; max-width:760px}
.lb-cap .lb-text{color:#cfd7e4; margin-top:4px; white-space:pre-wrap; word-break:break-word}
.lb-btn{position:fixed; background:rgba(20,25,33,.9); border:1px solid var(--line-2); color:var(--fg);
  width:40px; height:40px; border-radius:50%; cursor:pointer; font-size:17px; line-height:1}
.lb-btn:hover{background:#232c3a}
#lbPrev{left:14px; top:50%; transform:translateY(-50%)}
#lbNext{right:14px; top:50%; transform:translateY(-50%)}
#lbClose{right:14px; top:14px}
.lb-count{position:fixed; left:14px; top:16px; color:var(--muted); font-size:12.5px}
/* ---- 翻译（Google 免费接口；点按钮才联网请求） ---- */
.tr-btn{cursor:pointer; border:1px solid var(--line-2); background:var(--panel-2); color:var(--muted); font-family:inherit; font-size:12px; padding:2px 10px; border-radius:20px; margin-left:8px; flex:none; white-space:nowrap}
.tr-btn:hover{color:var(--fg); border-color:var(--muted)}
.tr-btn.on{color:#cfe0ff; border-color:var(--accent-line); background:var(--accent-bg)}
.tw-trans,.q-trans{margin-top:7px; padding:7px 11px; background:var(--panel-3); border:1px solid var(--line); border-radius:9px; color:#cfd9ea; font-size:13.5px; line-height:1.7; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere}
.q-trans{font-size:13px; padding:6px 9px}
article.tr-collapsed [data-tr]{display:none}
.tr-tag{display:inline-block; color:var(--dim); font-size:11px; border:1px solid var(--line-2); border-radius:4px; padding:0 5px; margin-right:7px; vertical-align:1px}
.tr-err .tr-body,.tr-busy .tr-body{color:var(--dim)}
.tw-trans.tr-err{cursor:pointer}
.tr-stat{color:var(--dim); font-size:12px; white-space:nowrap}
@media (max-width:640px){
  .ov-stats{gap:12px}
  .ov-stats .stat{min-width:52px; text-align:left}
  .wall{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}
  .hits{margin-left:0; width:100%}
}
`;
}

/* ------------------------------------------------------------------ *
 * 页面脚本（在浏览器里跑；这里用真函数体，最后 toString() 内联进 HTML，
 * 这样不需要拼接字符串，语法错误在 require 阶段就会暴露）
 * ------------------------------------------------------------------ */

function pageApp() {
  'use strict';

  var dataEl = document.getElementById('data');
  var payload = { tweets: [], meta: {} };
  if (dataEl) {
    try {
      payload = JSON.parse(dataEl.textContent || '{}') || payload;
    } catch (e) {
      payload = { tweets: [], meta: {}, parseError: String((e && e.message) || e) };
    }
  }
  var META = payload.meta || {};
  var TWEETS = Array.isArray(payload.tweets) ? payload.tweets : [];
  var BATCH_CARDS = Number(META.batchCards) > 0 ? Number(META.batchCards) : 80;
  var BATCH_WALL = Number(META.batchWall) > 0 ? Number(META.batchWall) : 120;

  var view = { q: '', kind: 'all', onlyMedia: false, onlyCard: false, sort: 'desc', mode: 'cards' };
  var filtered = [];
  var wallItems = [];
  var shown = 0;
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var wall = $('wall');
  var hitsEl = $('hits');
  var emptyEl = $('empty');
  var moreBtn = $('more');
  var sentinel = $('sentinel');
  var sortSel = $('sort');
  var qInput = $('q');
  var kindsEl = $('kinds');
  var resetBtn = $('reset');
  var onlyMediaEl = $('onlyMedia');
  var onlyCardEl = $('onlyCard');
  var lb = $('lightbox');
  var lbImg = $('lbImg');
  var lbCap = $('lbCap');
  var lbCount = $('lbCount');
  var lbState = { list: [], idx: 0 };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function kindOf(t) {
    var k = String((t && t.kind) || '').toLowerCase();
    if (k === 'retweet' || k === 'reply') return k;
    return 'original';
  }

  function kindLabel(k) {
    return k === 'retweet' ? '转推' : k === 'reply' ? '回复' : '原创';
  }

  function displayName(t) {
    return (t && (t.author_name || t.author_handle || t.handle)) || '';
  }

  function handleOf(t) {
    return (t && (t.author_handle || t.handle)) || '';
  }

  function hasMedia(t) { return !!(t && t.media && t.media.length); }
  function hasCard(t) { return !!(t && t.card && (t.card.url || t.card.title)); }

  function tsOf(t) {
    var v = Date.parse((t && t.time_iso) || '');
    return isNaN(v) ? null : v;
  }

  function hayOf(t) {
    if (t.__hay !== undefined) return t.__hay;
    var parts = [t.text, t.author_name, t.author_handle, t.handle, t.retweeted_by, t.lang];
    if (t.reply_to && t.reply_to.length) parts.push(t.reply_to.join(' '));
    if (t.quoted) parts.push(t.quoted.text, t.quoted.author_name, t.quoted.author_handle);
    if (t.card) parts.push(t.card.title, t.card.domain, t.card.url);
    if (t.media) {
      for (var i = 0; i < t.media.length; i++) if (t.media[i] && t.media[i].alt) parts.push(t.media[i].alt);
    }
    var s = parts.filter(Boolean).join('\n').toLowerCase();
    try {
      Object.defineProperty(t, '__hay', { value: s, enumerable: false, configurable: true, writable: true });
    } catch (e) {
      t.__hay = s;
    }
    return s;
  }

  function termsOf() {
    var q = String(view.q || '').trim().toLowerCase();
    return q ? q.split(/\s+/).filter(Boolean) : [];
  }

  function matchTerms(t, terms) {
    var h = hayOf(t);
    for (var i = 0; i < terms.length; i++) if (h.indexOf(terms[i]) < 0) return false;
    return true;
  }

  function fmtNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }

  function absTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '时间未知';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function relTime(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 0) return '刚刚';
    if (s < 60) return Math.max(1, Math.floor(s)) + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + ' 个月前';
    return Math.floor(s / (86400 * 365)) + ' 年前';
  }

  function setEmpty(msg) {
    if (!emptyEl) return;
    if (msg) {
      emptyEl.textContent = '';
      var b = el('b', null, msg.title);
      emptyEl.appendChild(b);
      if (msg.body) emptyEl.appendChild(el('div', null, msg.body));
      if (msg.hint) {
        var h = el('div', null);
        h.style.marginTop = '8px';
        h.appendChild(el('code', null, msg.hint));
        emptyEl.appendChild(h);
      }
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      emptyEl.textContent = '';
    }
  }

  /** 正文渲染：保留换行（CSS pre-wrap），链接可点且新窗口打开 */
  function renderText(box, text) {
    var s = text === null || text === undefined ? '' : String(text);
    if (!s) return;
    var parts = s.split(/(https?:\/\/[^\s<>"']+)/g);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (/^https?:\/\//i.test(p)) {
        var a = el('a', null, p);
        a.href = p;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        box.appendChild(a);
      } else {
        box.appendChild(document.createTextNode(p));
      }
    }
  }

  /** 判断一个 URL 是否可以直接当图片加载（视频/GIF 的 url 常常是 mp4，不能塞给 img） */
  function isImageUrl(u) {
    var s = String(u || '');
    if (!s) return false;
    if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(s)) return true;
    if (/[?&]format=(jpe?g|png|webp|gif|avif)\b/i.test(s)) return true;
    return false;
  }

  function mediaItem(m, t) {
    var local = m && m.localRef ? m.localRef : '';
    var type = (m && m.type) || 'photo';
    var url = (m && m.url) || '';
    var poster = (m && m.poster) || '';
    var remote;
    if (type === 'video' || type === 'gif') {
      remote = poster || (isImageUrl(url) ? url : ''); // 视频只能拿封面当缩略图
    } else {
      remote = isImageUrl(url) ? url : url || poster;
    }
    return {
      src: local,
      remote: remote,
      videoUrl: type === 'photo' ? '' : url,
      alt: (m && m.alt) || '',
      type: type,
      tweet: t,
    };
  }

  function typeTag(type) {
    if (type === 'video') return '视频 · 需回原推观看';
    if (type === 'gif') return '动图 · 需回原推观看';
    return '';
  }

  /** 图片节点：本地相对路径优先，失败回退远程，再失败显示占位 */
  function imgNode(src, remote, alt, cls) {
    function fallback(msg) { return el('div', 'm-ph', msg || '图片不可用'); }
    if (!src && !remote) return fallback();
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = alt || '';
    img.referrerPolicy = 'no-referrer';
    if (cls) img.className = cls;
    var triedRemote = false;
    img.addEventListener('error', function () {
      if (!triedRemote && remote && remote !== src) {
        triedRemote = true;
        img.src = remote;
        return;
      }
      if (img.parentNode) img.parentNode.replaceChild(fallback(), img);
    });
    img.src = src || remote;
    return img;
  }

  function openLink(url, cls, text) {
    var a = el('a', cls, text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    return a;
  }

  function metric(label, value) {
    var n = fmtNum(value);
    if (n === null) return null;
    var s = el('span', 'metric');
    s.appendChild(el('b', null, n));
    s.appendChild(el('i', null, label));
    return s;
  }

  function mediaGrid(t, list) {
    var grid = el('div', 'mgrid n' + Math.min(4, t.media.length));
    for (var i = 0; i < t.media.length; i++) {
      var m = t.media[i];
      var item = mediaItem(m, t);
      var ci = list.length;
      list.push(item);
      var cell = el('div', 'cell');
      var tag = typeTag(item.type);
      if (item.type === 'photo' || item.type === 'gif' || item.poster || item.remote || item.src) {
        cell.appendChild(imgNode(item.src, item.remote, item.alt, ''));
      }
      if (tag) cell.appendChild(el('div', 'vtag', tag));
      cell.setAttribute('data-idx', String(ci));
      cell.addEventListener('click', function (ev) {
        var idx = Number((ev.currentTarget && ev.currentTarget.getAttribute('data-idx')) || 0);
        lbOpen(list, idx);
      });
      grid.appendChild(cell);
    }
    return grid;
  }

  function cardNode(t) {
    var card = el('article', 'card kind-' + kindOf(t));
    card.setAttribute('data-trid', trIdOf(t));

    if (t.retweeted_by) {
      var rt = el('div', 'rt-line');
      rt.appendChild(el('span', 'rt-ico', '转推'));
      rt.appendChild(el('span', 'rt-who', t.retweeted_by + ' 转推了这条'));
      card.appendChild(rt);
    }
    if (kindOf(t) === 'reply' && t.reply_to && t.reply_to.length) {
      var rl = el('div', 'rt-line reply');
      rl.appendChild(el('span', 'rt-ico', '回复'));
      rl.appendChild(el('span', 'rt-who', t.reply_to.join(' ')));
      card.appendChild(rl);
    }

    var head = el('div', 'c-head');
    var av = el('div', 'avatar');
    var initial = (displayName(t) || '?').slice(0, 1).toUpperCase();
    av.textContent = initial;
    if (t.author_avatar) {
      var avImg = document.createElement('img');
      avImg.loading = 'lazy';
      avImg.alt = '';
      avImg.referrerPolicy = 'no-referrer';
      avImg.addEventListener('error', function () { if (avImg.parentNode) avImg.parentNode.removeChild(avImg); });
      avImg.src = t.author_avatar;
      av.appendChild(avImg);
    }
    head.appendChild(av);

    var who = el('div', 'c-who');
    var line1 = el('div', 'c-line1');
    line1.appendChild(el('span', 'c-name', displayName(t) || '未知作者'));
    if (handleOf(t)) line1.appendChild(el('span', 'c-handle', '@' + handleOf(t)));
    if (t.verified) {
      var v = el('span', 'vfy', '✓');
      v.title = '认证账号';
      line1.appendChild(v);
    }
    line1.appendChild(el('span', 'badge b-' + kindOf(t), kindLabel(kindOf(t))));
    who.appendChild(line1);
    var line2 = el('div', 'c-line1');
    var tm = el('time', 'c-time', absTime(t.time_iso));
    tm.dateTime = t.time_iso || '';
    tm.title = relTime(t.time_iso);
    line2.appendChild(tm);
    if (t.source_tab) {
      line2.appendChild(el('span', 'c-handle',
        t.source_tab === 'with_replies' ? '· 含回复'
          : t.source_tab === 'search' ? '· 搜索续抓'
            : '· 仅主贴'));
    }
    who.appendChild(line2);
    head.appendChild(who);

    if (t.url) head.appendChild(openLink(t.url, 'c-open', '在原推打开 ↗'));
    if ((t.text && needsTr(t.text)) || (t.quoted && t.quoted.text && needsTr(t.quoted.text))) {
      var trB = el('button', 'tr-btn', '译');
      trB.type = 'button';
      trB.title = '翻译成中文（Google 免费接口，点按钮才联网）';
      trB.addEventListener('click', function () { onCardTrBtn(card, t); });
      head.appendChild(trB);
    }
    card.appendChild(head);

    var textBox = el('div', 'tw-text');
    if (t.text) renderText(textBox, t.text);
    else textBox.appendChild(el('span', 'c-time', '（这条没有文字内容）'));
    card.appendChild(textBox);

    if (t.truncated) card.appendChild(el('div', 'note', '提示：正文可能被平台截断，完整内容请点右上角在原推查看。'));

    var list = [];
    if (hasMedia(t)) card.appendChild(mediaGrid(t, list));

    if (t.quoted) {
      var q = el('div', 'quote');
      var qh = el('div', 'q-head');
      if (t.quoted.author_name) qh.appendChild(el('span', 'q-name', t.quoted.author_name));
      if (t.quoted.author_handle) qh.appendChild(el('span', 'q-handle', '@' + t.quoted.author_handle));
      if (t.quoted.url) qh.appendChild(openLink(t.quoted.url, 'q-handle', '引用原推 ↗'));
      q.appendChild(qh);
      if (t.quoted.text) {
        var qt = el('div', 'q-text');
        renderText(qt, t.quoted.text);
        q.appendChild(qt);
      }
      card.appendChild(q);
    }

    if (hasCard(t)) {
      var c = t.card;
      var lc = openLink(c.url || '#', 'linkcard');
      if (c.domain) lc.appendChild(el('div', 'lc-dom', c.domain));
      if (c.title) lc.appendChild(el('div', 'lc-title', c.title));
      if (c.url) lc.appendChild(el('div', 'lc-url', c.url));
      card.appendChild(lc);
    }

    var mt = el('div', 'metrics');
    var mArr = [
      metric('回复', t.metrics && t.metrics.replies),
      metric('转推', t.metrics && t.metrics.reposts),
      metric('点赞', t.metrics && t.metrics.likes),
      metric('浏览', t.metrics && t.metrics.views),
    ];
    var anyM = false;
    for (var i = 0; i < mArr.length; i++) {
      if (mArr[i]) { mt.appendChild(mArr[i]); anyM = true; }
    }
    if (anyM) card.appendChild(mt);

    if (!list.length && !t.quoted && !hasCard(t) && !anyM) {
      card.appendChild(el('div', 'note', '这条记录的字段不完整，只保留了已有内容。'));
    }
    fillTransBoxes(card, t); // 已有译文缓存/出错的，重新渲染时直接画出来
    return card;
  }

  function renderKindCounts(counts) {
    if (!kindsEl) return;
    var btns = kindsEl.querySelectorAll('.kbtn');
    for (var i = 0; i < btns.length; i++) {
      var k = btns[i].getAttribute('data-kind');
      var c = btns[i].querySelector('i');
      if (c) c.textContent = String(counts[k] === undefined ? 0 : counts[k]);
      if (k === view.kind) btns[i].classList.add('on');
      else btns[i].classList.remove('on');
    }
  }

  function baseSet() {
    var terms = termsOf();
    var out = [];
    for (var i = 0; i < TWEETS.length; i++) {
      var t = TWEETS[i];
      if (view.onlyMedia && !hasMedia(t)) continue;
      if (view.onlyCard && !hasCard(t)) continue;
      if (terms.length && !matchTerms(t, terms)) continue;
      out.push(t);
    }
    return out;
  }

  function cmpTweet(a, b) {
    var ta = tsOf(a);
    var tb = tsOf(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return view.sort === 'desc' ? tb - ta : ta - tb;
  }

  function apply() {
    var base = baseSet();
    var counts = { all: base.length, original: 0, retweet: 0, reply: 0 };
    for (var i = 0; i < base.length; i++) counts[kindOf(base[i])]++;
    renderKindCounts(counts);

    filtered = [];
    for (var j = 0; j < base.length; j++) {
      if (view.kind === 'all' || kindOf(base[j]) === view.kind) filtered.push(base[j]);
    }
    filtered.sort(cmpTweet);

    wallItems = [];
    for (var k = 0; k < filtered.length; k++) {
      var ms = filtered[k].media || [];
      for (var m = 0; m < ms.length; m++) wallItems.push(mediaItem(ms[m], filtered[k]));
    }

    if (hitsEl) hitsEl.textContent = '命中 ' + filtered.length + ' / 共 ' + TWEETS.length + ' 条';
    if (feed) feed.textContent = '';
    if (wall) wall.textContent = '';
    shown = 0;

    if (!TWEETS.length) {
      setEmpty({
        title: '还没有可显示的推文',
        body: META.parseError
          ? '数据文件解析失败：' + META.parseError
          : '没有找到 tweets.jsonl，或文件里没有任何有效记录。请先到控制面板完成一次抓取，再重新生成报告。',
        hint: META.dataFile || '',
      });
    } else if (!filtered.length) {
      setEmpty({ title: '没有符合当前筛选条件的推文', body: '换个关键词，或者点右边的「清空筛选」恢复全部。' });
    } else {
      setEmpty(null);
    }

    renderMore();
  }

  function updateMore(total) {
    var left = total - shown;
    if (moreBtn) {
      if (left > 0) {
        moreBtn.hidden = false;
        moreBtn.textContent = '加载更多（还有 ' + left + ' 条）';
      } else {
        moreBtn.hidden = true;
      }
    }
  }

  function renderMore() {
    if (busy) return;
    busy = true;
    try {
      if (view.mode === 'wall') {
        var wEnd = Math.min(wallItems.length, shown + BATCH_WALL);
        var wf = document.createDocumentFragment();
        for (var i = shown; i < wEnd; i++) wf.appendChild(wallCell(wallItems[i], i));
        if (wall) wall.appendChild(wf);
        shown = wEnd;
        updateMore(wallItems.length);
      } else {
        var cEnd = Math.min(filtered.length, shown + BATCH_CARDS);
        var cf = document.createDocumentFragment();
        for (var j = shown; j < cEnd; j++) cf.appendChild(cardNode(filtered[j]));
        if (feed) feed.appendChild(cf);
        shown = cEnd;
        updateMore(filtered.length);
      }
    } finally {
      busy = false;
    }
  }

  function wallCell(item, index) {
    var cell = el('div', 'wcell');
    if (item.type === 'video' && !item.src && !item.remote) {
      cell.appendChild(el('div', 'm-ph', '视频'));
    } else {
      cell.appendChild(imgNode(item.src, item.remote, item.alt, ''));
    }
    var tag = typeTag(item.type);
    if (tag) cell.appendChild(el('div', 'vtag', tag));
    cell.title = (item.alt || '') + (item.alt ? ' · ' : '') + absTime(item.tweet && item.tweet.time_iso);
    cell.addEventListener('click', function () { lbOpen(wallItems, index); });
    return cell;
  }

  function setMode(mode) {
    view.mode = mode === 'wall' ? 'wall' : 'cards';
    var btns = document.querySelectorAll('.vbtn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-mode') === view.mode) btns[i].classList.add('on');
      else btns[i].classList.remove('on');
    }
    if (feed) feed.hidden = view.mode !== 'cards';
    if (wall) wall.hidden = view.mode !== 'wall';
    if (feed) feed.textContent = '';
    if (wall) wall.textContent = '';
    shown = 0;
    renderMore();
  }

  /* ---------------- lightbox ---------------- */

  function lbRender() {
    var item = lbState.list[lbState.idx];
    if (!item) return;
    if (lbImg) {
      lbImg.textContent = '';
      var node = imgNode(item.src, item.remote, item.alt, '');
      node.style.maxWidth = '92vw';
      node.style.maxHeight = '74vh';
      lbImg.appendChild(node);
    }
    if (lbCount) lbCount.textContent = lbState.idx + 1 + ' / ' + lbState.list.length;
    if (lbCap) {
      lbCap.textContent = '';
      var t = item.tweet || {};
      var head = el('div');
      var who = (t.author_name || '') + (handleOf(t) ? ' @' + handleOf(t) : '');
      head.appendChild(el('span', null, (who || '未知作者') + ' · ' + absTime(t.time_iso)));
      if (t.url) {
        head.appendChild(document.createTextNode(' · '));
        head.appendChild(openLink(t.url, null, '在原推打开 ↗'));
      }
      lbCap.appendChild(head);
      var tag = typeTag(item.type);
      if (tag) lbCap.appendChild(el('div', null, tag));
      if (item.alt) lbCap.appendChild(el('div', 'lb-text', '图片描述：' + item.alt));
      if (t.text) {
        var short = String(t.text).replace(/\s+/g, ' ').slice(0, 140);
        lbCap.appendChild(el('div', 'lb-text', short + (String(t.text).length > 140 ? '…' : '')));
      }
    }
    var single = lbState.list.length <= 1;
    var p = $('lbPrev');
    var n = $('lbNext');
    if (p) p.hidden = single;
    if (n) n.hidden = single;
  }

  function lbOpen(list, idx) {
    if (!list || !list.length || !lb) return;
    lbState.list = list;
    lbState.idx = Math.max(0, Math.min(list.length - 1, idx || 0));
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
    lbRender();
  }

  function lbStep(d) {
    if (!lbState.list.length) return;
    var n = lbState.list.length;
    lbState.idx = (lbState.idx + d + n) % n;
    lbRender();
  }

  function lbClose() {
    if (!lb) return;
    lb.hidden = true;
    lbState.list = [];
    document.body.style.overflow = '';
    if (lbImg) lbImg.textContent = '';
  }

  /* ---------------- 事件 ---------------- */

  var qTimer = null;
  if (qInput) {
    qInput.addEventListener('input', function () {
      view.q = qInput.value;
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(apply, 120);
    });
  }
  if (kindsEl) {
    kindsEl.addEventListener('click', function (ev) {
      var target = ev.target;
      while (target && target !== kindsEl && !target.getAttribute('data-kind')) target = target.parentNode;
      if (!target || target === kindsEl) return;
      view.kind = target.getAttribute('data-kind');
      apply();
    });
  }
  if (onlyMediaEl) onlyMediaEl.addEventListener('change', function () { view.onlyMedia = onlyMediaEl.checked; apply(); });
  if (onlyCardEl) onlyCardEl.addEventListener('change', function () { view.onlyCard = onlyCardEl.checked; apply(); });
  if (sortSel) sortSel.addEventListener('change', function () { view.sort = sortSel.value === 'asc' ? 'asc' : 'desc'; apply(); });
  var modeBtns = document.querySelectorAll('.vbtn');
  for (var bi = 0; bi < modeBtns.length; bi++) {
    modeBtns[bi].addEventListener('click', function (ev) {
      setMode(ev.currentTarget.getAttribute('data-mode'));
    });
  }
  if (moreBtn) moreBtn.addEventListener('click', renderMore);
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      view.q = '';
      view.kind = 'all';
      view.onlyMedia = false;
      view.onlyCard = false;
      view.sort = 'desc';
      if (qInput) qInput.value = '';
      if (onlyMediaEl) onlyMediaEl.checked = false;
      if (onlyCardEl) onlyCardEl.checked = false;
      if (sortSel) sortSel.value = 'desc';
      apply();
    });
  }
  if (lb) {
    lb.addEventListener('click', function (ev) {
      if (ev.target === lb) lbClose();
    });
    var pc = $('lbPrev');
    var nc = $('lbNext');
    var cc = $('lbClose');
    if (pc) pc.addEventListener('click', function () { lbStep(-1); });
    if (nc) nc.addEventListener('click', function () { lbStep(1); });
    if (cc) cc.addEventListener('click', lbClose);
  }
  /* ---------------- 顶栏收起 ---------------- */

  var topbar = $('topbar');
  var foldBtn = $('foldBtn');
  var expandBtn = $('expandBtn');
  var FOLD_KEY = 'xscraper_report_topbar_folded';
  function setFold(folded, save) {
    if (!topbar) return;
    topbar.classList[folded ? 'add' : 'remove']('collapsed');
    if (foldBtn) {
      foldBtn.textContent = folded ? '展开 ▼' : '收起 ▲';
      foldBtn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    }
    if (save) {
      try { window.localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch (e) { /* localStorage 不可用就当没记住 */ }
    }
  }
  if (foldBtn) {
    foldBtn.addEventListener('click', function () {
      setFold(!(topbar && topbar.classList.contains('collapsed')), true);
    });
  }
  if (expandBtn) expandBtn.addEventListener('click', function () { setFold(false, true); });
  try {
    if (window.localStorage.getItem(FOLD_KEY) === '1') setFold(true, false);
  } catch (e) { /* ignore */ }

  document.addEventListener('keydown', function (ev) {
    if (!lb || lb.hidden) return;
    if (ev.key === 'Escape') { lbClose(); return; }
    if (ev.key === 'ArrowLeft') { lbStep(-1); return; }
    if (ev.key === 'ArrowRight') { lbStep(1); }
  });

  if (sentinel && 'IntersectionObserver' in window) {
    try {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { renderMore(); break; }
        }
      }, { rootMargin: '700px 0px' });
      io.observe(sentinel);
    } catch (e) { /* 没有就算了，还有「加载更多」按钮 */ }
  }

  /* ---------------- 翻译（Google 免费接口；只有点击才联网） ---------------- */

  var TR_TL = 'zh-CN';
  var TR_LS_KEY = 'xscraper_translations_v1';
  var trMem = {};       // 源文本 -> { t: 译文, s: 源语言 }
  var trInflight = {};  // 源文本 -> Promise（去重并发请求）
  var trErr = {};       // 源文本 -> 最近一次失败的文案
  var trSaveBroken = false;
  var trSaveTimer = null;
  var trBatchRun = false;
  var trBatchStop = false;

  // 端点 1 是 Chrome 自带翻译用的接口（本机实测通，带 Access-Control-Allow-Origin:*，
  // file:// 打开的报告页也能直接 fetch）；端点 2 是经典 gtx（部分网络/出口 IP 会 429，留作备选）。
  // 响应结构：1 → [[译文, 源语言], ...]；2 → { sentences: [{trans,...}], src }
  var TR_ENDPOINTS = [
    {
      url: function (text) {
        return 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' + TR_TL + '&q=' + encodeURIComponent(text);
      },
      parse: function (data) {
        var out = '';
        var src = '';
        if (Array.isArray(data)) {
          for (var i = 0; i < data.length; i++) {
            var seg = data[i];
            if (Array.isArray(seg) && typeof seg[0] === 'string') {
              out += seg[0];
              if (seg[1]) src = seg[1];
            }
          }
        }
        return out ? { t: out, s: src } : null;
      },
    },
    {
      url: function (text) {
        return 'https://translate.googleapis.com/translate_a/single?client=gtx&dj=1&sl=auto&tl=' + TR_TL + '&dt=t&q=' + encodeURIComponent(text);
      },
      parse: function (data) {
        var out = '';
        var src = '';
        if (data && Array.isArray(data.sentences)) {
          for (var j = 0; j < data.sentences.length; j++) {
            if (data.sentences[j] && data.sentences[j].trans) out += data.sentences[j].trans;
          }
        }
        if (data && data.src) src = data.src;
        return out ? { t: out, s: src } : null;
      },
    },
  ];

  function trLoad() {
    try {
      var raw = window.localStorage.getItem(TR_LS_KEY);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && obj.m && typeof obj.m === 'object') trMem = obj.m;
    } catch (e) { /* 缓存坏了就当没有 */ }
  }

  function trSave() {
    if (trSaveBroken) return;
    if (trSaveTimer) clearTimeout(trSaveTimer);
    trSaveTimer = setTimeout(function () {
      try {
        var s = JSON.stringify({ v: 1, m: trMem });
        if (s.length > 3000000) return; // 超限就只在本次会话里记，不写 localStorage
        window.localStorage.setItem(TR_LS_KEY, s);
      } catch (e) { trSaveBroken = true; } // 存不进去（满/被禁）就只留内存
    }, 800);
  }

  function trCacheGet(text) {
    return Object.prototype.hasOwnProperty.call(trMem, text) ? trMem[text] : null;
  }

  function cjkRatio(s) {
    var m = String(s || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
    return m ? m.length / String(s).length : 0;
  }

  /** 已经基本是中文的（或空的）不用翻 */
  function needsTr(text) {
    var s = String(text || '').trim();
    if (!s) return false;
    return cjkRatio(s) <= 0.3;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function trErrMsg(err) {
    var m = String((err && err.message) || err || '');
    if (m.indexOf('429') >= 0) return '被 Google 限流了（HTTP 429），过几分钟再试';
    if (m.indexOf('Failed to fetch') >= 0 || m.indexOf('NetworkError') >= 0) return '网络请求失败（没联网或代理没通）';
    return m || '未知错误';
  }

  function trOnce(text, ep) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      function done(fn, arg) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(arg);
      }
      var opts = { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' };
      if (typeof AbortController === 'function') {
        var ctl = new AbortController();
        opts.signal = ctl.signal;
        timer = setTimeout(function () { ctl.abort(); }, 20000);
      }
      fetch(ep.url(text), opts).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        var r = ep.parse(data);
        if (!r) throw new Error('返回内容为空');
        done(resolve, r);
      }).catch(function (err) {
        done(reject, err && err.name === 'AbortError' ? new Error('请求超时（20 秒）') : err);
      });
    });
  }

  function gtxFetch(text) {
    return trOnce(text, TR_ENDPOINTS[0]).catch(function (err1) {
      // 首选端点失败（限流/断网/超时都算）→ 换备选端点再试一次，再失败就报错
      return sleep(600).then(function () { return trOnce(text, TR_ENDPOINTS[1]); }).catch(function () { throw err1; });
    });
  }

  /** 确保一段文本有译文：有缓存直接用，在请求中就复用，否则发起请求（结果进缓存） */
  function ensureTr(text) {
    if (!needsTr(text)) return Promise.resolve(null);
    var hit = trCacheGet(text);
    if (hit) return Promise.resolve(hit);
    if (trInflight[text]) return trInflight[text];
    var p = gtxFetch(text).then(function (r) {
      delete trInflight[text];
      trMem[text] = r;
      delete trErr[text];
      trSave();
      return r;
    }).catch(function (err) {
      delete trInflight[text];
      trErr[text] = trErrMsg(err);
      throw err;
    });
    trInflight[text] = p;
    return p;
  }

  function trIdOf(t) {
    return String((t && (t.id || t.url)) || '');
  }

  /** 在 anchor（.tw-text / .q-text）后面生成或刷新译文块；三种状态（缓存/出错/请求中）都从这里画 */
  function transBoxFor(anchor, text, cls) {
    var box = anchor.nextElementSibling;
    if (box && box.getAttribute && box.getAttribute('data-tr') === '1') {
      box.className = cls;
    } else {
      box = el('div', cls);
      box.setAttribute('data-tr', '1');
      anchor.parentNode.insertBefore(box, anchor.nextElementSibling);
    }
    box.setAttribute('data-trtext', text);
    box.onclick = null;
    box.classList.remove('tr-err', 'tr-busy');
    box.textContent = '';
    var hit = trCacheGet(text);
    if (hit) {
      box.appendChild(el('span', 'tr-tag', hit.s && hit.s.indexOf('zh') !== 0 ? '译 · ' + hit.s : '译'));
      var body = el('span', 'tr-body');
      renderText(body, hit.t);
      box.appendChild(body);
    } else if (trErr[text]) {
      box.classList.add('tr-err');
      box.appendChild(el('span', 'tr-tag', '译'));
      box.appendChild(el('span', 'tr-body', trErr[text] + ' · 点这里重试'));
      box.onclick = function () {
        delete trErr[text];
        startTr(anchor, text, cls);
      };
    } else {
      box.classList.add('tr-busy');
      box.appendChild(el('span', 'tr-tag', '译'));
      box.appendChild(el('span', 'tr-body', '翻译中…'));
      if (!trInflight[text]) {
        ensureTr(text).then(function () { refreshBoxesForText(text); }).catch(function () { refreshBoxesForText(text); });
      }
    }
    return box;
  }

  /** 译文落定后，把页面上所有同源文本的译文块刷新（同一条被转推/引用时会有多处） */
  function refreshBoxesForText(text) {
    var nodes = document.querySelectorAll('[data-tr="1"]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-trtext') !== text) continue;
      var anchor = n.previousElementSibling;
      if (anchor) transBoxFor(anchor, text, n.className || 'tw-trans');
      else if (n.parentNode) n.parentNode.removeChild(n);
    }
  }

  function startTr(anchor, text, cls) {
    var p = ensureTr(text);          // 先把请求发起来（inflight 去重）
    transBoxFor(anchor, text, cls);  // 再画（此刻多半是“翻译中…”）
    p.then(function () { refreshBoxesForText(text); })
      .catch(function () { refreshBoxesForText(text); });
  }

  /** 把一张卡片的译文块按当前状态画/刷（缓存命中、出错、请求中才画；没翻过的不画） */
  function fillTransBoxes(card, t) {
    if (!card || !card.querySelector) return;
    if (t.text && needsTr(t.text) && (trCacheGet(t.text) || trErr[t.text] || trInflight[t.text])) {
      var a = card.querySelector('.tw-text');
      if (a) transBoxFor(a, t.text, 'tw-trans');
    }
    if (t.quoted && t.quoted.text && needsTr(t.quoted.text) && (trCacheGet(t.quoted.text) || trErr[t.quoted.text] || trInflight[t.quoted.text])) {
      var qa = card.querySelector('.q-text');
      if (qa) transBoxFor(qa, t.quoted.text, 'q-trans');
    }
    var btn = card.querySelector('.tr-btn');
    if (btn) {
      var any = card.querySelector('[data-tr="1"]');
      btn.classList[any && !card.classList.contains('tr-collapsed') ? 'add' : 'remove']('on');
    }
  }

  /** 批量翻译时按推文对象刷新它已渲染的卡片（feed 里的 article 是直接子节点） */
  function trRefreshCard(t) {
    var key = trIdOf(t);
    if (!key || !feed) return;
    for (var i = 0; i < feed.children.length; i++) {
      var c = feed.children[i];
      if (c.getAttribute && c.getAttribute('data-trid') === key) fillTransBoxes(c, t);
    }
  }

  /** 卡片上的「译」按钮：没翻过 → 翻这条；翻过 → 收起/展开译文 */
  function onCardTrBtn(card, t) {
    var btn = card.querySelector('.tr-btn');
    if (card.querySelector('[data-tr="1"]')) {
      var collapse = !card.classList.contains('tr-collapsed');
      card.classList[collapse ? 'add' : 'remove']('tr-collapsed');
      if (btn) btn.classList[collapse ? 'remove' : 'add']('on');
      return;
    }
    if (btn) btn.classList.add('on');
    var started = 0;
    if (t.text && needsTr(t.text)) {
      var a = card.querySelector('.tw-text');
      if (a) { startTr(a, t.text, 'tw-trans'); started++; }
    }
    if (t.quoted && t.quoted.text && needsTr(t.quoted.text)) {
      var qa = card.querySelector('.q-text');
      if (qa) { startTr(qa, t.quoted.text, 'q-trans'); started++; }
    }
    if (!started && btn) btn.classList.remove('on');
  }

  var trAllBtn = $('trAll');
  var trStatEl = $('trStat');
  function trStat(msg) { if (trStatEl) trStatEl.textContent = msg || ''; }

  if (trAllBtn) {
    trAllBtn.addEventListener('click', function () {
      if (trBatchRun) { trBatchStop = true; trStat('正在停止，等当前这一条走完…'); return; }
      var jobs = [];
      for (var i = 0; i < filtered.length; i++) {
        var t = filtered[i];
        if (t.text && needsTr(t.text) && !trCacheGet(t.text)) jobs.push({ t: t, txt: t.text });
        if (t.quoted && t.quoted.text && needsTr(t.quoted.text) && !trCacheGet(t.quoted.text)) jobs.push({ t: t, txt: t.quoted.text });
      }
      if (!jobs.length) { trStat('当前筛选的内容都已有译文'); return; }
      trBatchRun = true;
      trBatchStop = false;
      trAllBtn.textContent = '停止翻译';
      trStat('待翻译 ' + jobs.length + ' 段，逐条进行…');
      var okN = 0, errN = 0, consecErr = 0;
      function finishBatch() {
        trBatchRun = false;
        trAllBtn.textContent = '翻译本页';
        trStat('完成：成功 ' + okN + ' 段' + (errN ? '，失败 ' + errN + ' 段（多半是限流，稍后重试即可）' : ''));
      }
      function step(k) {
        if (trBatchStop || k >= jobs.length || consecErr >= 3) {
          finishBatch();
          return;
        }
        var j = jobs[k];
        trAllBtn.textContent = '停止翻译（' + (k + 1) + '/' + jobs.length + '）';
        var p = ensureTr(j.txt);
        trRefreshCard(j.t); // inflight 已在，会把已渲染的卡片画成“翻译中…”
        p.then(function () { okN++; consecErr = 0; }, function () { errN++; consecErr++; }).then(function () {
          trRefreshCard(j.t);
          var delay = consecErr ? 3000 : 350 + Math.floor(Math.random() * 400);
          setTimeout(function () { step(k + 1); }, delay);
        });
      }
      step(0);
    });
  }

  trLoad();
  try {
    var trCached = Object.keys(trMem).length;
    if (trCached) trStat('已有 ' + trCached + ' 段译文缓存');
  } catch (e) { /* ignore */ }

  apply();
}

/* ------------------------------------------------------------------ *
 * 页面骨架
 * ------------------------------------------------------------------ */

function renderHtml(payload) {
  const meta = payload.meta;
  const dataJson = jsonForScript(payload);
  const app = pageApp.toString();

  const hasData = meta.count > 0;
  const subBits = [];
  if (meta.authorName) subBits.push('<span class="name">' + escHtml(meta.authorName) + '</span>');
  if (meta.handle) subBits.push('<span class="handle">@' + escHtml(meta.handle) + '</span>');
  if (meta.tabsText) subBits.push('<span class="handle">· ' + escHtml(meta.tabsText) + '</span>');
  const subLine = subBits.length ? subBits.join(' ') : '<span class="handle">（未读到作者信息）</span>';

  const rangeText =
    meta.rangeStart && meta.rangeEnd
      ? meta.rangeStart + ' ~ ' + meta.rangeEnd
      : meta.rangeStart || meta.rangeEnd || '暂无数据';

  const metaLine = [
    '时间范围（本地时区）：' + escHtml(rangeText),
    '生成时间：' + escHtml(meta.generatedAt),
    '数据文件：' + escHtml(meta.dataFileName) + '（' + escHtml(meta.fileSize) + '）',
    meta.badLines > 0 ? '已跳过 ' + meta.badLines + ' 行无法解析的数据' : '',
    meta.lastRunAt ? '上次抓取：' + escHtml(meta.lastRunAt) : '',
  ]
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');

  const kinds = [
    ['all', '全部'],
    ['original', '原创'],
    ['retweet', '转推'],
    ['reply', '回复'],
  ]
    .map(function (pair) {
      const on = pair[0] === 'all' ? ' on' : '';
      return (
        '<button type="button" class="kbtn' +
        on +
        '" data-kind="' +
        pair[0] +
        '"' +
        (hasData ? '' : ' disabled') +
        '>' +
        pair[1] +
        ' <i>0</i></button>'
      );
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escHtml(meta.title)}</title>
<style>${pageCss()}</style>
</head>
<body>
<div class="topbar" id="topbar">
  <div class="wrap">
    <div class="ov-head">
      <div class="ov-id">
        <h1>${escHtml(meta.title)}</h1>
        <div class="ov-sub">${subLine}</div>
      </div>
      <div class="ov-stats">
        <div class="stat"><b>${escHtml(String(meta.count))}</b><span>推文</span></div>
        <div class="stat"><b>${escHtml(String(meta.imageCount))}</b><span>媒体</span></div>
        <div class="stat"><b>${escHtml(meta.fileSize)}</b><span>数据大小</span></div>
      </div>
    </div>
    <div class="ov-meta">${metaLine}</div>
    <div class="toolbar">
      <input id="q" type="search" placeholder="搜索正文 / 作者 / @用户名 / 引用内容…" autocomplete="off"${hasData ? '' : ' disabled'}>
      <div class="kinds" id="kinds">${kinds}</div>
      <label class="chk"><input type="checkbox" id="onlyMedia"${hasData ? '' : ' disabled'}> 仅有媒体</label>
      <label class="chk"><input type="checkbox" id="onlyCard"${hasData ? '' : ' disabled'}> 仅有链接卡片</label>
      <select id="sort" title="排序"${hasData ? '' : ' disabled'}>
        <option value="desc">最新在前</option>
        <option value="asc">最早在前</option>
      </select>
      <div class="views">
        <button type="button" class="vbtn on" data-mode="cards"${hasData ? '' : ' disabled'}>卡片流</button>
        <button type="button" class="vbtn" data-mode="wall"${hasData ? '' : ' disabled'}>图片墙</button>
      </div>
      <button type="button" class="ghost" id="reset"${hasData ? '' : ' disabled'}>清空筛选</button>
      <button type="button" class="ghost" id="trAll" title="把当前筛选命中的推文（含引用）逐条翻译成中文。Google 免费接口，逐条请求、可随时再点它停止；只有点按钮才联网发文本。" ${hasData ? '' : ' disabled'}>翻译本页</button>
      <div class="hits" id="hits">命中 ${escHtml(String(meta.count))} / 共 ${escHtml(String(meta.count))} 条</div>
      <span class="tr-stat" id="trStat"></span>
      <button type="button" class="fold-btn" id="foldBtn" aria-expanded="true" title="收起顶栏（标题、统计和筛选栏会一并收起），腾出阅读空间">收起 ▲</button>
    </div>
    <div class="mini">
      <b>${escHtml(meta.title)}</b>
      <span class="mini-info">${escHtml(String(meta.count))} 条 · ${escHtml(rangeText)}</span>
      <button type="button" class="mini-expand" id="expandBtn" title="展开顶栏，找回搜索和筛选">展开 ▼</button>
    </div>
  </div>
</div>
<div class="wrap">
  <div id="empty" class="empty" hidden></div>
  <main id="feed"></main>
  <div id="wall" class="wall" hidden></div>
  <div class="more-wrap"><button type="button" class="more" id="more" hidden>加载更多</button></div>
  <div id="sentinel" style="height:1px"></div>
  <footer class="foot">数据仅供个人离线查看，请勿公开转载。</footer>
</div>
<div id="lightbox" class="lb" hidden>
  <div class="lb-count" id="lbCount"></div>
  <div class="lb-inner">
    <div id="lbImg"></div>
    <div class="lb-cap" id="lbCap"></div>
  </div>
  <button type="button" class="lb-btn" id="lbPrev" title="上一张（←）" hidden>‹</button>
  <button type="button" class="lb-btn" id="lbNext" title="下一张（→）" hidden>›</button>
  <button type="button" class="lb-btn" id="lbClose" title="关闭（Esc）">×</button>
</div>
<script id="data" type="application/json">${dataJson}</script>
<script>(${app})();</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * @param {string} dataDir 数据目录（含 tweets.jsonl / images / state.json）
 * @param {{title?: string}} [options]
 * @returns {{outPath: string, count: number}}
 */
function generateReport(dataDir, options) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new TypeError('generateReport(dataDir, options?) 需要一个数据目录路径');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const dir = path.resolve(dataDir);
  const jsonlPath = path.join(dir, 'tweets.jsonl');
  const statePath = path.join(dir, 'state.json');
  const outPath = path.join(dir, 'index.html');

  const readInfo = readJsonlFile(jsonlPath);
  const tweets = [];
  for (let i = 0; i < readInfo.items.length; i++) {
    const t = normalizeTweet(readInfo.items[i]);
    if (t) tweets.push(t);
    else readInfo.badLines++;
  }
  const state = readStateFile(statePath);
  const meta = buildMeta(tweets, state, readInfo, dir, opts);

  const html = renderHtml({ meta: meta, tweets: tweets });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  return { outPath: outPath, count: tweets.length };
}

module.exports = { generateReport };

/* 允许直接命令行使用：node report.js <dataDir> */
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('用法：node report.js <dataDir>\n');
    process.exitCode = 1;
  } else {
    try {
      const r = generateReport(dir);
      process.stdout.write('已生成：' + r.outPath + '（' + r.count + ' 条）\n');
    } catch (err) {
      process.stderr.write('生成失败：' + String((err && err.message) || err) + '\n');
      process.exitCode = 1;
    }
  }
}
