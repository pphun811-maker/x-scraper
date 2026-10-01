'use strict';
/**
 * 复现并验证两个失败场景已被修好：
 *   A) "检查登录态" 和 "开始抓取" 同时点 → 第二个必须被友好拒绝，且不能把浏览器关掉。
 *   B) 页面刚启动时的求值超时 → 现在会自动重试/等待，登录态检查应当成功。
 *
 * 用法（⚠️ 会真的启动一次抓取、访问 x.com，别随手跑）：
 *   node _test/test-race-and-retry.js          # 上限默认 100
 *   node _test/test-race-and-retry.js 120      # 覆盖上限（> 本地已有条数时才会真的滚动）
 *
 * ── B 段为什么可能被"跳过"（这是设计如此，不是 bug）────────────────────────────
 * /api/start 的 maxTweets ≤ 本地 data\<handle>\tweets.jsonl 已有条数时，runner 根本不滚动：
 * app/scraper.js 的 progress() 里 `if (maxTweets && this.records.size >= maxTweets)` 立刻成立，
 * 任务随即以 stopReason="已达到设定上限 N 条" 正常收尾（本地已有 100 条、上限 100 时约 20 秒结束，
 * scrolls 始终 0，只是顺带补一补缺图）。这种收尾里即使轮询能看到几次 running=true，也**没有任何
 * 滚动推进**，稳定性其实没被验证到。所以 B 段把"达上限 + 零推进"判为【跳过】并单独计数，
 * 不再像以前那样落到最后的 else 分支报一句"✓ 当前阶段 stopped"的空判。
 * 想真正验证长跑稳定性：把上限调到比已有条数大，例如 `node _test/test-race-and-retry.js 120`
 * —— 那会产生真实滚动访问，先确认账号风险。
 *
 * ── 异常日志筛选 ──────────────────────────────────────────────────────────
 * /api/status 的 logs 是服务端"最近 80 条"的滚动缓冲，天然包含本次运行之前的历史行。
 * 本脚本 (1) 只取 t 落在本次脚本运行窗口内的行，并把被滤掉的历史条数打印出来；
 * (2) 只认真异常：失败 N（N>0）/ 超时 / 中断 / 出错 / 已关闭 / 关闭失败 / 已忽略，
 * 明确排除"失败 0"这种成功句（例如"注入结果：成功 4 条，失败 0 条"）。
 */
const http = require('http');

const PORT = 8787;
const DEFAULT_MAX_TWEETS = 100;

// ------------------------------------------------------------------ 纯逻辑（可离线自测）

/** "HH:MM:SS" → 当天秒数；认不出返回 null */
function clockToSec(text) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

/** 允许的日志时间窗（秒）：脚本本身只跑一分钟左右，留足余量即可 */
const LOG_WINDOW_SEC = 900;

/**
 * 这条日志是否发生在 startSec（当天秒数）之后、且还在本次运行的窗口内。
 * 日志缓冲里只会是"过去"的行，所以时刻晚于起点很多的，只能是更早那一天的 —— 算历史。
 * 容差 2 秒：t 只精确到秒，而起点取自 Date.now()，同秒内的行不该被当成历史。
 * 跨零点：起点在 23:5x 而日志在 00:0x 时算本次运行。
 */
function isLogAfter(t, startSec, windowSec) {
  const sec = clockToSec(t);
  if (sec == null || !Number.isFinite(startSec)) return true; // 认不出时间就别丢信息
  const win = Number.isFinite(windowSec) && windowSec > 0 ? windowSec : LOG_WINDOW_SEC;
  if (sec >= startSec - 2 && sec <= startSec + win) return true;
  if (86400 - startSec <= 600 && sec <= 600) return true;     // 跨零点
  return false;
}

/** 真异常关键词：注意"失败"必须跟着正数或冒号，"关闭失败""已忽略"单独列 */
const REAL_ERROR_RE = /失败\s*[1-9]\d*|失败\s*[：:]|超时|中断|出错|错误|异常|已关闭|关闭失败|已忽略/;

/** 只命中真异常，明确排除"失败 0"这类成功句 */
function isRealAnomaly(msg) {
  const s = String(msg == null ? '' : msg);
  if (/失败\s*0(?![1-9])/.test(s)) {
    // "失败 0 条/张" 是成功句；但同一行还写着别的异常时仍算异常
    return REAL_ERROR_RE.test(s.replace(/失败\s*0(?![1-9])/g, ''));
  }
  return REAL_ERROR_RE.test(s);
}

/** 从 logs 里挑出"本次运行内"的异常行；history = 被判为历史（本轮之前）的条数 */
function pickAnomalyLogs(logs, startSec, limit) {
  const all = Array.isArray(logs) ? logs : [];
  const fresh = all.filter((l) => l && isLogAfter(l.t, startSec));
  const hits = fresh.filter((l) => isRealAnomaly(l.msg));
  const max = limit > 0 ? limit : 4;
  return { hits: hits.slice(-max), freshCount: fresh.length, history: all.length - fresh.length };
}

/** 正常收尾的理由（都不是"异常中断"） */
const BENIGN_STOP_RE = /已达到设定上限|已达到单次时长上限|已经划到底|已请求停止|没有新内容/;
/** 异常收尾的理由：这些出现了 B 段就必须判失败 */
const BAD_STOP_RE = /中断|失败|错误|异常|已关闭|关闭失败|退出登录|调试连接|卡住/;
/** "上限 ≤ 已有条数"这一种收尾 */
const CAP_STOP_RE = /已达到设定上限/;

/**
 * B 段判定（纯函数，喂假 status 序列即可自测）。
 * samples: [{ running, phase, tweets, newThisRun, scrolls, error, stopReason }, ...]
 * 返回 { verdict: 'pass'|'fail'|'skip', reason, detail }
 */
function judgeStability(samples, opts) {
  const list = Array.isArray(samples) ? samples.filter(Boolean) : [];
  const minAlive = (opts && opts.minAlive) || 3;
  if (!list.length) return { verdict: 'fail', reason: 'B 段：一个 status 样本都没拿到（面板没起来？）', detail: null };

  const alive = list.filter((s) => s.running === true).length;
  const phases = [];
  list.forEach((s) => {
    const p = s.phase || 'unknown';
    if (phases.indexOf(p) < 0) phases.push(p);
  });
  const first = list[0];
  const last = list[list.length - 1];
  const firstScrolls = Number(first.scrolls) || 0;
  const lastScrolls = Number(last.scrolls) || 0;
  const firstTweets = Number(first.tweets) || 0;
  const lastTweets = Number(last.tweets) || 0;
  const progressed = lastScrolls > firstScrolls || lastTweets > firstTweets;
  const stopReason = String(last.stopReason == null ? '' : last.stopReason);
  const observed = `running=true ${alive}/${list.length} 次；phase 序列 ${phases.join(' → ')}；`
    + `scrolls ${firstScrolls}→${lastScrolls}；tweets ${firstTweets}→${lastTweets}；stopReason=${stopReason || 'null'}`;

  const withError = list.filter((s) => s.error);
  if (withError.length) {
    return { verdict: 'fail', reason: 'B 段：观测到任务报错 → ' + withError[0].error, detail: observed };
  }
  const errored = list.filter((s) => s.phase === 'error');
  if (errored.length) {
    return { verdict: 'fail', reason: 'B 段：观测到 phase=error，任务异常中断', detail: observed };
  }
  if (BAD_STOP_RE.test(stopReason)) {
    return { verdict: 'fail', reason: 'B 段：任务异常结束 → ' + stopReason, detail: observed };
  }

  // 设计如此：上限 ≤ 已有条数 → 不滚动、零推进、正常收尾；这段没验证到稳定性
  if (CAP_STOP_RE.test(stopReason) && !progressed) {
    return {
      verdict: 'skip',
      reason: 'B 段跳过：上限 ≤ 已有条数，任务按设计立即结束，本段无法验证稳定性',
      detail: observed,
    };
  }
  if (alive === 0) {
    if (BENIGN_STOP_RE.test(stopReason)) {
      return {
        verdict: 'skip',
        reason: `B 段跳过：任务在窗口内以正常理由结束且从未观察到 running=true（${stopReason}），本段无法验证稳定性`,
        detail: observed,
      };
    }
    return { verdict: 'fail', reason: 'B 段：45 秒窗口内从未观察到 running=true，任务没跑起来', detail: observed };
  }
  if (alive < minAlive) {
    return {
      verdict: 'fail',
      reason: `B 段：只在 ${alive} 次轮询里观察到 running=true（要求 ≥ ${minAlive}），任务过早结束，稳定性未验证`,
      detail: observed,
    };
  }
  return {
    verdict: 'pass',
    reason: `B 段：抓取稳定推进中（${alive}/${list.length} 次轮询 running=true；phase ${phases.join(' → ')}；`
      + `scrolls ${firstScrolls}→${lastScrolls}；tweets ${firstTweets}→${lastTweets}`
      + `${last.running ? '；窗口结束时仍在跑' : '；窗口内正常结束：' + (stopReason || '无 stopReason')}）`,
    detail: null,
  };
}

/** 命令行上限：`node _test/test-race-and-retry.js [maxTweets]`，默认 100 */
function parseMaxTweets(argv) {
  const raw = argv && argv[2];
  if (raw == null || raw === '') return { value: DEFAULT_MAX_TWEETS, note: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) {
    return { value: DEFAULT_MAX_TWEETS, note: `参数 "${raw}" 不是正整数，回退到默认 ${DEFAULT_MAX_TWEETS}` };
  }
  if (n === DEFAULT_MAX_TWEETS) return { value: n, note: null };
  return { value: n, note: `按命令行参数使用 maxTweets=${n}（大于本地已有条数时会真实滚动访问 x.com）` };
}

// ------------------------------------------------------------------ 运行时

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(new Error('非 JSON 返回')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end(data);
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(new Error('非 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

const tally = { pass: 0, fail: 0, skip: 0 };
const fail = (m) => { tally.fail += 1; console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => { tally.pass += 1; console.log('✓ ' + m); };
const skip = (m) => { tally.skip += 1; console.log('○ ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

async function main() {
  const cap = parseMaxTweets(process.argv);
  if (cap.note) console.log('注意：' + cap.note);
  console.log(`本轮 maxTweets=${cap.value}`);

  // 本次脚本的运行起点：日志只认这个时刻之后（含同秒容差）的行，历史故障一律不打印
  const logStartSec = (() => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); })();

  console.log('--- A. 并发保护：同时发"检查登录态"和"开始抓取" ---');
  const p1 = post('/api/login/check');
  await sleep(400);                                   // 让检查先进入执行中
  const p2 = post('/api/start', { handle: 'georgerussell63', maxTweets: cap.value, speed: 'normal', images: 'orig', tabs: 'posts' });
  const [r1, r2] = await Promise.all([p1, p2]);

  console.log('   检查登录态：', JSON.stringify(r1));
  console.log('   开始抓取：  ', JSON.stringify(r2));

  if (r1 && r1.loginState === 'logged_in') ok('并发下的登录态检查仍然成功（说明重试/等待生效）');
  else fail('登录态检查没有成功：' + JSON.stringify(r1));

  if (r2 && r2.ok === false && /正在执行/.test(r2.message || '')) ok('第二个动作被友好拒绝（互斥锁生效）');
  else if (r2 && r2.ok === true) {
    // 也可能先到先得：那就必须保证两边都活着
    console.log('   注意：抓取先拿到锁，检查被拒绝或被排队');
    const st = await get('/api/status');
    if (st.running) ok('抓取正常在跑');
    else fail('抓取没跑起来');
  } else fail('并发保护没有生效：' + JSON.stringify(r2));

  console.log('\n--- B. 抓取启动后的稳定性（45 秒窗口，每 3 秒轮询一次 /api/status）---');
  const POLL_MS = 3000;
  const WINDOW_MS = 45000;

  const st0 = await get('/api/status');
  if (st0 && st0.running) {
    console.log('   已有任务在跑，直接观察它推进…');
  } else {
    const r3 = await post('/api/start', { handle: 'georgerussell63', maxTweets: cap.value, speed: 'normal', images: 'orig', tabs: 'posts' });
    console.log('   启动：', JSON.stringify(r3));
    if (r3 && r3.ok === false) console.log('   注意：启动被拒绝，B 段只能观察现有任务或空转');
  }

  // 观测窗口：每 3 秒一次、共 45 秒，记录 running 次数 / phase 集合 / scrolls、tweets 变化
  const samples = [];
  let lastLogs = [];
  const deadline = Date.now() + WINDOW_MS;
  let round = 0;
  while (true) {
    if (round > 0 && Date.now() >= deadline) break;
    round += 1;
    let st = null;
    try {
      st = await get('/api/status');
    } catch (err) {
      console.log(`   [${pad2(round)}] 轮询失败：${err && err.message ? err.message : err}`);
    }
    if (st) {
      lastLogs = st.logs || [];
      samples.push({
        running: !!st.running, phase: st.phase, tweets: st.tweets, newThisRun: st.newThisRun,
        scrolls: st.scrolls, error: st.error, stopReason: st.stopReason,
      });
      console.log(`   [${pad2(round)}] phase=${st.phase} running=${st.running} scrolls=${st.scrolls} `
        + `tweets=${st.tweets} 新增=${st.newThisRun} stopReason=${st.stopReason || 'null'}`);
    }
    await sleep(POLL_MS);
  }

  // 收尾再读一次，拿最新的日志与终点状态（GET 不会启动 Chrome，安全）
  let finalSt = null;
  try { finalSt = await get('/api/status'); } catch (err) { console.log('   收尾状态读取失败：' + (err && err.message ? err.message : err)); }
  if (finalSt && Array.isArray(finalSt.logs)) lastLogs = finalSt.logs;
  const tail = finalSt || samples[samples.length - 1] || {};
  console.log(`   终点：phase=${tail.phase} running=${tail.running} tweets=${tail.tweets} scrolls=${tail.scrolls} error=${tail.error}`);

  const picked = pickAnomalyLogs(lastLogs, logStartSec, 4);
  if (picked.hits.length) {
    console.log('   本次运行内的异常日志：');
    picked.hits.forEach((l) => console.log(`     [${l.t}] ${l.msg}`));
  } else {
    console.log('   本次运行内的异常日志：（无）');
  }
  console.log(`   （已忽略 ${picked.history} 条本轮开始前的历史日志；本轮日志 ${picked.freshCount} 条，避免把旧故障当成本次故障）`);

  const verdict = judgeStability(samples, { minAlive: 3 });
  if (verdict.verdict === 'pass') ok(verdict.reason);
  else if (verdict.verdict === 'skip') { skip(verdict.reason); if (verdict.detail) console.log('   ' + verdict.detail); }
  else fail(verdict.reason + (verdict.detail ? '（' + verdict.detail + '）' : ''));

  console.log(`\n统计：通过 ${tally.pass} 项，失败 ${tally.fail} 项，跳过 ${tally.skip} 项`);
  console.log('结果：' + (tally.fail > 0 ? '有失败项' : (tally.skip > 0 ? '有跳过项（见上）' : '全部通过')));
}

module.exports = {
  clockToSec, isLogAfter, isRealAnomaly, pickAnomalyLogs,
  judgeStability, parseMaxTweets,
};

if (require.main === module) {
  main().catch((err) => { console.error('测试异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
}
