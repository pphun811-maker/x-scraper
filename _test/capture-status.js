'use strict';
/**
 * 跑动期全程日志存档器：每 N 秒抓一次 /api/status 追加落盘。
 * 背景：面板 status 接口只保留最近 80 条日志（scraper.js 的 logger.recent.slice(-80)），
 * 任务结束后无法回放全程（2026-09-30 第八轮教训②），必须在跑动期间定期抓存。
 * 用法：node _test/capture-status.js [间隔秒=30]
 * 结束条件：看到 running=true 之后又变回 false（任务收尾）自动退出；Ctrl+C 随时可停。
 * 快照保留 status 全量（含 logs 窗口），分析时按日志行首时间戳去重即可。
 */
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.HTTP_PROXY; delete process.env.http_proxy;
delete process.env.HTTPS_PROXY; delete process.env.https_proxy;

const http = require('http');
const fs = require('fs');
const path = require('path');

const intervalSec = Math.max(5, Number(process.argv[2]) || 30);
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const outPath = path.join(__dirname, `status-capture-${stamp}.jsonl`);
const stream = fs.createWriteStream(outPath, { flags: 'a' });

let sawRunning = false;
let polls = 0;

function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8787, path: '/api/status', timeout: 10000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (err) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function tick() {
  polls += 1;
  const s = await fetchStatus();
  if (!s) {
    console.log(`[${now()}] 第 ${polls} 次：面板无响应（8787），继续重试`);
    return;
  }
  stream.write(JSON.stringify({ capturedAt: new Date().toISOString(), status: s }) + '\n');
  const logN = Array.isArray(s.logs) ? s.logs.length : 0;
  console.log(`[${now()}] 第 ${polls} 次：running=${s.running} phase=${s.phase} 滚=${s.scrolls}`
    + ` 新增=${s.newThisRun} 共=${s.tweets}（快照含 ${logN} 条日志）`);
  if (s.running) sawRunning = true;
  else if (sawRunning) {
    console.log(`[${now()}] 任务已从 running 收尾（stopReason=${s.stopReason}），采集结束 → ${outPath}`);
    stream.end(() => process.exit(0));
  }
}

(async () => {
  console.log(`采集开始：每 ${intervalSec}s 抓一次 /api/status → ${outPath}`);
  await tick();
  setInterval(() => { tick().catch((err) => console.log(`tick 失败：${err.message}`)); }, intervalSec * 1000);
})();
process.on('SIGINT', () => {
  console.log('\n收到 Ctrl+C，结束采集（已落盘内容保留）');
  stream.end(() => process.exit(0));
});
