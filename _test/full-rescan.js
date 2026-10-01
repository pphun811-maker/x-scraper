'use strict';
/**
 * 完整重走驱动 —— 补全用。
 *
 * 背景：X 搜索不返回全部推文（老推文/低互动推文索引缺失），搜索页续抓会有系统性缺口；
 * 唯一完整的数据源是「帖子与回复」（with_replies）时间线本身（含原创+回复+转推）。
 * 本脚本让面板走 forceTimeline 模式：跳过搜索页增量，从顶划到底，去重消化已抓的、补上缺的。
 *
 * 用法：node _test/full-rescan.js [handle]     （默认 georgerussell63）
 * 结束条件：划到底 / 手动停止 / 异常信号。跑完打印终态摘要。
 */
const http = require('http');

const handle = process.argv[2] || 'georgerussell63';
const PORT = 8787;

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ raw: b.slice(0, 200) }); } });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    if (data) req.write(data);
    req.end();
  });
}

const get = (p) => request('GET', p);
const post = (p, body) => request('POST', p, body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

(async () => {
  console.log(`[full-rescan ${ts()}] 目标 @${handle}：完整重走（不走搜索页增量），从顶划到底补全缺口`);

  // 等面板空闲
  for (let i = 0; ; i += 1) {
    const st = await get('/api/status');
    if (!st.running) break;
    if (i === 0) console.log('面板上有任务在跑，等它结束…');
    await sleep(5000);
  }

  const r = await post('/api/start', {
    handle,
    maxTweets: 0,        // 0 = 全部（无条数上限）
    speed: 'normal',
    images: 'orig',
    tabs: 'with_replies',
    forceTimeline: true, // 关键：跳过搜索页增量
    maxMinutes: 0,       // 0 = 不限时（划到底才停）
  });
  console.log(`[full-rescan ${ts()}] 启动：`, JSON.stringify(r));
  if (!r.ok) process.exit(1);

  let lastPhase = '';
  let lastProgressLine = Date.now();
  for (;;) {
    await sleep(15000);
    let s;
    try {
      s = await get('/api/status');
    } catch (err) {
      console.log(`[${ts()}] 轮询失败（${err.message}），继续等`);
      continue;
    }
    if (s.phase !== lastPhase) {
      console.log(`[${ts()}] phase → ${s.phase}｜本地 ${s.tweets} 条｜已滚 ${s.scrolls} 次`);
      lastPhase = s.phase;
    }
    if (!s.running) {
      console.log(`[full-rescan ${ts()}] 任务结束：`, JSON.stringify({
        tweets: s.tweets,
        newThisRun: s.newThisRun,
        scrolls: s.scrolls,
        stopReason: s.stopReason,
        images: s.images,
        error: s.error,
        elapsedSec: s.elapsedSec,
      }));
      break;
    }
    if (Date.now() - lastProgressLine > 300000) {
      console.log(`[${ts()}] …进行中`, JSON.stringify({
        phase: s.phase, tweets: s.tweets, new: s.newThisRun, scrolls: s.scrolls, images: s.images,
      }));
      lastProgressLine = Date.now();
    }
  }
})().catch((err) => {
  console.error('[full-rescan] 异常：', err && err.message ? err.message : err);
  process.exit(1);
});
