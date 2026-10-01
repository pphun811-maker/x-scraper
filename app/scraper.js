'use strict';
/**
 * 抓取主循环。
 *
 * 节奏：滚一小段 -> 等随机时间 -> 提取当前 DOM 里的推文 -> 去重落盘，
 * 直到「连续多次滚动都没有新内容」判定到底，或触达条数/时长上限，或遇到异常信号立即停止。
 * 全程只读：不点赞、不转发、不关注、不发帖。
 */
const fs = require('fs');
const path = require('path');
const U = require('./util');
const P = require('./extract');
const CH = require('./chrome');
const PROFILE = require('./profile');
const PF = require('./proxyfetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

function extFromUrl(url) {
  const m = /[?&]format=([a-z0-9]+)/i.exec(url || '');
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const m2 = /\.([a-z0-9]{3,4})(?:$|[?#])/i.exec(url || '');
  return m2 ? m2[1].toLowerCase() : 'jpg';
}

/** 把图片 URL 换成指定尺寸变体（原图用 name=orig） */
function variantUrl(url, mode) {
  if (!url || mode === 'none') return url;
  const name = mode === 'orig' ? 'orig' : 'large';
  if (/[?&]name=/.test(url)) return url.replace(/([?&])name=[^&]*/i, `$1name=${name}`);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'name=' + name;
}

/**
 * 每一轮滚动之后判断：是"真的到底了"，还是"只是还没滚到触发加载的位置"。
 *
 * 这是整个工具最容易误判的地方 —— X 是滚到接近底部才加载下一批，
 * 如果只按"这几轮没有新推文"就收工，会在半路提前停止。
 * 所以做成纯函数：产品代码和自测跑的是同一份判定逻辑。
 */
function evaluateProgress(input) {
  const {
    gained = 0,
    heightGrew = false,
    atBottom = false,
    spinner = false,
    scrolled = true,
    endRounds = 0,
    stuckRounds = 0,
    cfg,
  } = input;

  let end = endRounds;
  let stuck = stuckRounds;
  const progressed = gained > 0 || heightGrew;

  if (progressed) {
    end = 0;
    stuck = 0;
  } else {
    stuck = scrolled ? 0 : stuck + 1;
    // 只有"已经在底部（或根本滚不动）、没有加载动画、也没有新内容"才算真的到底
    if ((atBottom || !scrolled) && !spinner) end += 1;
    else end = 0;
  }

  let stop = false;
  let reason = null;
  if (end >= cfg.emptyRounds) {
    stop = true;
    reason = '已经划到底（连续多次滚动都没有加载出新内容）';
  } else if (stuck >= 20) {
    stop = true;
    reason = '页面卡住了（滚动位置长时间没有变化），已停止';
  }
  return { endRounds: end, stuckRounds: stuck, stop, reason, progressed };
}

/**
 * 看门狗判定（纯函数，方便单测）：页面连续读不到内容时该怎么办。
 *
 * 背景：真实 x.com 上曾出现过副本浏览器实例不健康，`Runtime.evaluate` 连续 30 秒超时，
 * 老版本只会一路 "页面操作失败（已忽略）" 硬撑 13 分钟 —— 用户看到的是"一条都没抓到"。
 * 现在改成：连续失败到阈值 → 先重载页面 → 再不行就重启浏览器 → 还是不行就明确报错停下。
 */
function decideRecovery(input) {
  const {
    consecutiveFailures = 0,
    recoveries = 0,
    stuckAfter = 3,
    maxRecoveries = 2,
  } = input || {};
  if (consecutiveFailures < stuckAfter) return { action: 'continue' };
  if (recoveries >= maxRecoveries) {
    return {
      action: 'abort',
      reason: `页面连续 ${consecutiveFailures} 次无响应，已自救 ${recoveries} 次仍不恢复`,
    };
  }
  // 第 1 次自救重载页面，第 2 次重启浏览器，依次交替
  return { action: recoveries % 2 === 0 ? 'reload' : 'restart' };
}

/**
 * 断点续抓「补更早」用的搜索页 URL（纯函数，方便自测）。
 *
 * 背景：X 时间线是虚拟列表，普通主页续抓必须先把已抓过的区域重滚一遍
 * （140 条要 ~100 滚、3000 条要 ~2000 滚）。改走搜索页可以直接从没抓过的区域开始：
 *   from:<handle> until:<最老已抓记录的本地日期 + 1 天>，f=live（「最新」标签）
 * 「最新」按新→旧排列，结果第一屏正好落在边界日期附近；边界日里已抓过的
 * 少数几条由去重消化 —— 热身基本归零。
 *
 * until 是"早于该日"（不含当日），所以 +1 天才能把最老记录那一天整个盖住。
 * 另注意：搜索可能不索引转推（include:nativeretweets 待真实验证），
 * 续抓窗口内转推可能缺失 —— 首次真实验证时要专门看一眼。
 * 返回 null 表示本地没有带时间戳的记录，调用方回退普通主页续抓。
 */
function buildResumeSearchUrl(records, handle, opts) {
  let oldestMs = null;
  for (const rec of (records instanceof Map ? records.values() : [])) {
    const ms = Date.parse(rec && rec.time_iso);
    if (Number.isFinite(ms) && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
  }
  if (oldestMs === null || !handle) return null;
  const d = new Date(oldestMs);
  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const untilStr = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;
  const parts = [`from:${handle}`, `until:${untilStr}`];
  if (opts && opts.excludeReplies) parts.push('-filter:replies');
  return `https://x.com/search?q=${encodeURIComponent(parts.join(' '))}&f=live`;
}

/**
 * 断点续抓「补最新」用的搜索页 URL（纯函数，方便自测）。
 *
 * 背景：until 版续抓只往过去翻 —— 上次抓取之后新发的帖子永远不在结果里，
 * 对已抓完整的账号（本地最老记录已到账号初创），续抓会变成"搜一段全已知的
 * 老内容 → 0 新增收尾"的静默空跑。补最新与补更早是两个不相交的时间窗
 * （比最新记录新 / 比最老记录旧），一条查询装不下，所以各用一个搜索页：
 *   from:<handle> since:<最新已抓记录的本地日期>，f=live（「最新」标签）
 * since 是"该日以来"（含当日），故意不加 1 天：若最新记录当天还有没抓到的
 * 更晚推文（比如上次中途停了），也能一并收进来；重叠部分由去重消化。
 * 这里取 **UTC 日期** 而不是本地日期：since 是下界，往早取只会多盖不会漏 ——
 * 若用本地日期（北京比 UTC 快 8 小时），一条 UTC 16:00 后发的推文本地日期已
 * 是次日，X 按 UTC 解释 since 时会留下最多 4 小时的永久缺口；反过来
 * buildResumeSearchUrl 的 until 是上界，用本地日期 +1 天只会多盖不会漏。
 * 没有新帖时这个搜索页只有几屏已知内容，几滚就到底，代价极小。
 * 返回 null 表示本地没有带时间戳的记录，调用方回退普通主页续抓。
 */
function buildNewPostsSearchUrl(records, handle, opts) {
  let newestMs = null;
  for (const rec of (records instanceof Map ? records.values() : [])) {
    const ms = Date.parse(rec && rec.time_iso);
    if (Number.isFinite(ms) && (newestMs === null || ms > newestMs)) newestMs = ms;
  }
  if (newestMs === null || !handle) return null;
  const d = new Date(newestMs);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const sinceStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const parts = [`from:${handle}`, `since:${sinceStr}`];
  if (opts && opts.excludeReplies) parts.push('-filter:replies');
  return `https://x.com/search?q=${encodeURIComponent(parts.join(' '))}&f=live`;
}

class Runner {
  constructor() {
    this.logger = new U.Logger();
    this.resetState();
  }

  resetState() {
    this.busy = false;
    this.stopRequested = false;
    this.stopReasonText = null;
    this.errorText = null;
    this.phase = 'idle';
    this.handle = null;
    this.tab = null;
    this.searchUrl = null;            // 续抓搜索页 URL（tab='search' 时 urlFor 用它）
    this.tweetCount = 0;
    this.scrollCount = 0;
    this.startedAt = 0;
    this.imageOk = 0;
    this.imageFail = 0;
    this.cdp = null;
    this.port = U.DEFAULT_DEBUG_PORT;
    this.T = null;                    // 本次任务生效的超时配置（U.loadTimeouts()）
    this.consecutiveFailures = 0;     // 连续多少轮读不到页面（看门狗用）
    this.recoveries = 0;              // 本任务自救次数（重载页面 / 重启浏览器）
    this.lastEvalOkAt = 0;            // 上次成功读到页面的时间
    this.records = new Map();
    this.imageQueue = [];
    this.queueClosed = false;
    this.needsManualLogin = false;
    this.totals = { newThisRun: 0 };
  }

  log(msg) {
    this.logger.line(msg);
  }

  status() {
    return {
      running: this.busy,
      phase: this.phase,
      handle: this.handle,
      tab: this.tab,
      tweets: this.tweetCount,
      newThisRun: this.totals.newThisRun,
      scrolls: this.scrollCount,
      elapsedSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      stopReason: this.stopReasonText,
      error: this.errorText,
      images: { ok: this.imageOk, failed: this.imageFail, pending: this.imageQueue.length },
      needsManualLogin: this.needsManualLogin,
      pageStuck: !!(this.T && this.consecutiveFailures >= this.T.effective.stuckAfter),
      consecutiveFailures: this.consecutiveFailures,
      recoveries: this.recoveries,
      lastEvalOkAgoMs: this.lastEvalOkAt ? (Date.now() - this.lastEvalOkAt) : null,
      timeouts: this.T ? this.T.effective : null,
      timeoutPreset: this.T ? this.T.preset : null,
      logs: this.logger.recent.slice(-80),
    };
  }

  stop(reason) {
    this.stopRequested = true;
    this.stopReasonText = reason || this.stopReasonText || '已请求停止';
    this.log(`收到停止请求：${this.stopReasonText}`);
  }

  async safeEval(expr, opts) {
    const T = this.T ? this.T.effective : { evalMs: 30000 };
    try {
      const v = await this.cdp.eval(expr, Object.assign({}, opts, { timeoutMs: (opts && opts.timeoutMs) || T.evalMs }));
      this.lastEvalOkAt = Date.now();
      this.consecutiveFailures = 0;
      return v;
    } catch (err) {
      this.notePageFailure(err);
      return null;
    }
  }

  /**
   * 页面读不到就记账。连续失败到阈值就交给看门狗自救 —— 不要再像以前那样
   * 一路 "（已忽略）" 硬撑十几分钟，日志里只留下"新增 0 条"。
   */
  notePageFailure(err) {
    this.consecutiveFailures += 1;
    const stuckAfter = this.T ? this.T.effective.stuckAfter : 3;
    const msg = err && err.message ? err.message : String(err);
    if (this.consecutiveFailures >= stuckAfter) {
      this.log(`页面已连续 ${this.consecutiveFailures} 次没有响应（最近一次：${msg}）→ 准备自救`);
    } else {
      this.log(`页面操作失败（已忽略）：${msg}`);
    }
  }

  /** 自救：重载页面 或 重启副本浏览器；彻底不行就带清晰原因报错停下 */
  async recover(decision, ctx) {
    const T = this.T.effective;
    if (decision.action === 'abort') {
      throw new Error('页面长时间没有响应，已自救 ' + this.recoveries + ' 次仍不恢复。'
        + '已抓到的数据都已落盘，不会丢。建议稍后重试；如果反复出现，请在面板上把「超时档位」换一档再试。');
    }
    this.recoveries += 1;
    if (decision.action === 'reload') {
      this.log(`页面无响应，自救第 ${this.recoveries} 次：重载页面…`);
      await CH.navigate(this.cdp, this.urlFor(ctx), (m) => this.log(m), T.navigateMs).catch(() => {});
    } else {
      this.log(`页面无响应，自救第 ${this.recoveries} 次：重启副本浏览器…`);
      await this.restartBrowser(ctx);
    }
    this.consecutiveFailures = 0;
    await CH.waitResponsive(this.cdp, (m) => this.log(m), T.responsiveMs);
    await CH.waitFor(
      this.cdp,
      `document.querySelectorAll('article[data-testid="tweet"]').length > 0`,
      T.renderWaitMs, 1200, '推文出现',
    ).catch(() => this.log('自救后等待推文出现超时，继续尝试'));
    this.log('自救完成：已回到页面顶部重新开始滚（已抓过的内容会去重，不会重复保存）');
    return true;
  }

  /** 关掉副本浏览器再重新起一个（自救的最后手段） */
  async restartBrowser(ctx) {
    const old = this.cdp;
    this.cdp = null;
    if (old) { try { old.close(); } catch (_) { /* ignore */ } }
    await CH.closeShadowBrowser(this.port, (m) => this.log(m)).catch(() => {});
    await U.sleep(3000);
    await CH.ensureBrowser({ mode: this.mode, config: this.config, visible: false, log: (m) => this.log(m) });
    const page = await CH.openPage(this.port, 'about:blank', (m) => this.log(m));
    this.cdp = page.cdp;
    await CH.closeOtherPages(this.port, page.target.id, (m) => this.log(m));
    await CH.navigate(this.cdp, this.urlFor(ctx), (m) => this.log(m), this.T.effective.navigateMs);
  }

  /** 当前标签页对应的 URL */
  urlFor(ctx) {
    const handle = (ctx && ctx.handle) || this.handle;
    const tab = (ctx && ctx.tab) || this.tab;
    if (tab === 'search' && this.searchUrl) return this.searchUrl;
    return tab === 'with_replies' ? `https://x.com/${handle}/with_replies` : `https://x.com/${handle}`;
  }

  /** 页面级调试连接必须显式关闭，否则 Chrome 会认为还有 DevTools 挂着而不肯退出
   *  （旧版本漏了这一步 → 旧实例迟迟不退 → 下一个任务撞车 → 页面反复无响应） */
  closePageCdp() {
    const cdp = this.cdp;
    this.cdp = null;
    if (!cdp) return;
    try { cdp.close(); this.log('已关闭页面调试连接'); } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 生命周期

  async start(opts) {
    if (this.busy) throw new Error('已经有一个任务在运行');
    const handle = U.safeHandle(opts.handle);
    if (!handle) throw new Error('用户名不合法，请输入类似 georgerussell63 或 https://x.com/xxx 这样的内容');
    const config = U.loadConfig();
    const mode = opts.mode === 'shadow' || opts.mode === 'live' ? opts.mode : config.mode;
    if (mode === 'shadow') {
      const st = PROFILE.shadowStatus();
      if (!st.ready) {
        throw new Error('「独立副本」模式还没有准备好登录态。请先点「准备登录态」，再点「检查登录态」在副本窗口里登录一次 X。');
      }
    }
    this.resetState();
    this.mode = mode;
    this.config = config;
    this.T = U.loadTimeouts(config);
    this.port = config.debugPort || U.DEFAULT_DEBUG_PORT;
    this.log(`超时档位：${this.T.label}${this.T.custom ? '（config.json 里有手改数值）' : ''}`
      + `｜读页面 ${Math.round(this.T.effective.evalMs / 1000)}s`
      + `｜等渲染 ${Math.round(this.T.effective.renderWaitMs / 1000)}s`
      + `｜连续 ${this.T.effective.stuckAfter} 次无响应就自救`);
    this.handle = handle;
    this.busy = true;
    this.startedAt = Date.now();
    this.phase = 'preparing';

    this._run(opts, handle)
      .catch((err) => {
        this.errorText = err && err.message ? err.message : String(err);
        this.phase = 'error';
        this.log(`任务中断：${this.errorText}`);
      })
      .finally(() => {
        this.busy = false;
        if (this.phase !== 'error') this.phase = 'stopped';
        this.closePageCdp();     // 兜底：任何退出路径都要把页面调试连接关掉
        this.log(`任务结束。本次新增 ${this.totals.newThisRun} 条，本地共 ${this.tweetCount} 条。`);
      });
  }

  async _run(opts, handle) {
    const cfg = Object.assign({}, U.SPEED[opts.speed] || U.SPEED.normal);
    // 完整重走耐心档：快速连滚会触发 X 虚拟列表的「压缩跳过」（渲染跟不上就丢块、滚动位置
    // 前跳 —— 2026-09-30 04:46 那轮 361 滚就"快进"到了 2018 年，抽样而非遍历）。
    // 慢速小步 + 到底判定提到 15 轮（≈45–60 秒真停滞才算到底），才能逐条走完不被误判。
    if (opts.forceTimeline) {
      cfg.scrollDelta = [320, 560];
      cfg.gapMs = [1500, 3200];
      cfg.burst = [2, 3];
      cfg.burstGapMs = [500, 1100];
      cfg.longPauseEvery = [10, 16];
      cfg.longPauseMs = [4000, 9000];
      cfg.emptyRounds = 15;
      cfg.label += '·完整重走';
    }
    // 单次时长上限（分钟）：任务参数 > config.json 的 maxMinutes > 速度档位默认。0 = 不限时。
    const cfgOnDisk = U.loadConfig();
    const diskMax = Number(cfgOnDisk.maxMinutes);
    if (Number.isFinite(diskMax) && diskMax >= 0) cfg.maxMinutes = Math.floor(diskMax);
    const optMax = Number(opts.maxMinutes);
    if (Number.isFinite(optMax) && optMax >= 0 && opts.maxMinutes !== '' && opts.maxMinutes !== null && opts.maxMinutes !== undefined) {
      cfg.maxMinutes = Math.floor(optMax);
    }
    const maxTweets = Math.max(0, Number(opts.maxTweets) || 0);
    const imageMode = U.IMAGE_VARIANT[opts.images] ? opts.images : 'orig';
    const tabs = opts.tabs === 'posts' ? ['posts'] : ['posts', 'with_replies'];
    const twPath = U.tweetsPath(handle);
    const dataDir = U.dataDir(handle);

    U.ensureDir(U.imagesDir(handle));

    // 1) 读取已有数据 —— 支持断点续抓
    for (const t of U.readJsonl(twPath)) {
      if (t && t.id) this.records.set(String(t.id), t);
    }
    this.tweetCount = this.records.size;

    // 续抓时，把"上次没下载成功的图片"重新排队（否则第二次跑就永远不会补图）
    let backfill = 0;
    for (const rec of this.records.values()) {
      if (!rec || !Array.isArray(rec.media)) continue;
      for (const m of rec.media) {
        if (!m || !m.local) continue;
        const file = path.join(dataDir, m.local.split('/').join(path.sep));
        if (!fs.existsSync(file) || fs.statSync(file).size < 200) {
          const url = m.type === 'photo' ? m.url : (m.poster || null);
          if (url) { this.imageQueue.push({ url, target: file }); backfill += 1; }
        }
      }
    }
    if (backfill) this.log(`续抓：把之前缺的 ${backfill} 张图片重新排进下载队列`);
    this.log(`目标 @${handle}｜模式：${this.mode === 'live' ? '直接用你的 Chrome' : '独立副本'}｜本地已有 ${this.records.size} 条记录｜速度档位：${cfg.label}｜单次最长：${cfg.maxMinutes > 0 ? cfg.maxMinutes + ' 分钟' : '不限（到底/上限/手动停才停）'}｜图片：${opts.images}｜标签页：${tabs.join(' + ')}`);

    // 2) 启动浏览器（live = 你自己的 Chrome；shadow = 独立副本）
    this.phase = 'launching';
    await CH.ensureBrowser({
      mode: this.mode, config: this.config, visible: false, log: (m) => this.log(m),
    });
    const page = await CH.openPage(this.port, 'about:blank', (m) => this.log(m));
    this.cdp = page.cdp;
    await CH.closeOtherPages(this.port, page.target.id, (m) => this.log(m));
    await CH.waitResponsive(this.cdp, (m) => this.log(m));

    // 3) 登录态
    this.phase = 'navigating';
    const login = await CH.checkLoginState(this.cdp, (m) => this.log(m));
    if (!login.loggedIn) {
      this.needsManualLogin = true;
      this.log('当前浏览器没有登录 X。');
      await CH.closeShadowBrowser(this.port, (m) => this.log(m)).catch(() => {});
      throw new Error(this.mode === 'live'
        ? '你自己的 Chrome 里当前没有登录 X。请先登录，然后重新点「开始抓取」。'
        : '副本里的登录态无效。请在你自己的 Chrome 里确认能正常刷 X，然后点一次扩展图标重新同步登录态，再开始抓取。');
    }
    this.log(`登录态正常${login.handle ? `（@${login.handle}）` : ''}，开始抓取`);

    // 4) 图片下载后台工人
    this.queueClosed = false;
    this.startImageWorkers(2);

    // 5) 逐个页面滚动。断点续抓（本地已有记录）走两个搜索页增量，不从头滚时间线：
    //    ① 先补最新（since:<最新记录日期>）—— 上次抓取之后新发的帖子在这里出现；
    //       没有新帖时该页只有几屏已知内容，几滚就到底，代价极小；
    //    ② 再补更早（until:<最老记录日期+1天>）—— 把下边界继续往过去推。
    //    两个搜索页逐页预检：有结果才滚，全都没结果（如超出搜索索引深度）就回退
    //    普通主页，行为与旧版一致。
    //    forceTimeline=true（完整重走）时跳过搜索页：X 搜索不返回全部推文（索引缺失），
    //    要补全只能靠 with_replies（帖子与回复）时间线本身 —— 它包含原创+回复+转推，
    //    从顶划到底配合去重就是全量。
    let resumeVia = opts.forceTimeline ? 'full-rescan' : null;
    let searchPages = null;   // null = 不走搜索页（首次抓取/完整重走）；数组 = 待预检的搜索页
    if (this.records.size > 0 && !opts.forceTimeline) {
      // searchQuery：自定义搜索查询（探测/补窗模式），给了就不走续抓边界，直接搜这个词
      const probeQuery = typeof opts.searchQuery === 'string' ? opts.searchQuery.trim().slice(0, 400) : '';
      const excludeReplies = tabs.length === 1 && tabs[0] === 'posts';
      if (probeQuery) {
        searchPages = [{
          tab: 'search', label: '搜索（自定义查询）', probe: true,
          url: `https://x.com/search?q=${encodeURIComponent(probeQuery)}&f=live`,
        }];
      } else {
        searchPages = [];
        const newestUrl = buildNewPostsSearchUrl(this.records, handle, { excludeReplies });
        if (newestUrl) searchPages.push({ tab: 'search', label: '搜索（补最新）', url: newestUrl });
        const oldestUrl = buildResumeSearchUrl(this.records, handle, { excludeReplies });
        if (oldestUrl) searchPages.push({ tab: 'search', label: '搜索（补更早）', url: oldestUrl });
      }
    }

    const homePages = tabs.map((t) => ({ tab: t, label: t === 'posts' ? '主贴' : '含回复' }));
    const pages = opts.forceTimeline
      ? [{ tab: 'with_replies', label: '帖子与回复（完整重走）' }]
      : (searchPages && searchPages.length ? searchPages : homePages);
    let searchHadContent = false;   // 本次任务里有没有任何一个搜索页真的给出了内容

    try {
      // 跑一页：导航（搜索页用各自的 URL，自救 reload 也不会滚回主页）→ 滚到底
      const runPage = async (pg) => {
        this.tab = pg.tab;
        this.phase = 'navigating';
        if (pg.tab === 'search' && pg.url) {
          this.searchUrl = pg.url;
          await CH.navigate(this.cdp, pg.url, (m) => this.log(m));
          const hasResult = await CH.waitFor(
            this.cdp,
            `document.querySelectorAll('article[data-testid="tweet"]').length > 0`,
            120000, 1200, '搜索结果出现',
          ).then(() => true).catch(() => false);
          if (!hasResult) {
            if (pg.probe) {
              this.stopReasonText = '自定义搜索查询没有返回结果，任务结束';
              this.log(this.stopReasonText);
              this.stopRequested = true;   // 探测模式不回退主页，直接收尾（finally 负责写 state/报告/关浏览器）
              return;
            }
            this.log(`${pg.label}页没有返回结果，跳过`);
            return;
          }
          searchHadContent = true;
          if (resumeVia !== 'search') {
            resumeVia = 'search';
            this.log(pg.probe
              ? `续抓：使用自定义搜索查询「${opts.searchQuery}」`
              : '续抓：走搜索页增量（先补上次之后的新帖，再往更早补边界），不从头滚时间线');
          }
        } else {
          const url = this.urlFor({ tab: pg.tab, handle });
          await CH.navigate(this.cdp, url, (m) => this.log(m));
          await CH.waitFor(
            this.cdp,
            `document.querySelectorAll('article[data-testid="tweet"]').length > 0`,
            120000, 1200, '推文出现',
          ).catch(() => this.log('等待推文出现超时，继续尝试'));
        }

        this.phase = 'scrolling';
        this.log(`开始滚动 ${pg.label}${resumeVia === 'search' ? ' 页面' : ' 标签页'}`);
        await this.scrollTab(cfg, { maxTweets, imageMode, tab: this.tab, twPath, handle });
      };

      for (let i = 0; i < pages.length; i += 1) {
        if (this.stopRequested) break;
        await runPage(pages[i]);
        if (this.stopRequested) break;
      }

      // 搜索页全都没内容（可能超出搜索索引深度）→ 回退普通主页，行为与旧版一致
      if (resumeVia === 'search' && !searchHadContent && !this.stopRequested) {
        this.log('搜索页都没有返回结果（可能超出搜索索引深度），本次回退到普通主页续抓');
        resumeVia = null;
        this.searchUrl = null;
        for (let i = 0; i < homePages.length; i += 1) {
          if (this.stopRequested) break;
          await runPage(homePages[i]);
          if (this.stopRequested) break;
        }
      }
    } finally {
      // 6) 等图片下载完
      this.phase = 'downloading';
      this.queueClosed = true;
      await this.waitImages(180000);
      // 7) 收尾：先把"补充过的记录"重写回文件，再写 state.json + 生成报告
      if (this.pendingRewrite) {
        try {
          const all = Array.from(this.records.values());
          const tmp = `${twPath}.tmp`;
          fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
          fs.renameSync(tmp, twPath);
          this.log(`已把 ${all.length} 条记录重写回文件（补全了媒体/正文等字段）`);
          this.pendingRewrite = false;
        } catch (err) {
          this.log(`重写 tweets.jsonl 失败：${err.message}`);
        }
      }
      this.phase = 'reporting';
      this.writeState(dataDir, handle, tabs, resumeVia);
      await this.generateReport(dataDir, handle);
      await CH.closeShadowBrowser(this.port, (m) => this.log(m)).catch(() => {});
      this.closePageCdp();       // ★ 关键：页面级调试连接不关，Chrome 会一直不肯退出
    }
  }

  // ---------------------------------------------------------------- 滚动主循环

  async scrollTab(cfg, ctx) {
    const { maxTweets } = ctx;
    let endRounds = 0;
    let stuckRounds = 0;
    let lastHeight = 0;
    let roundNo = 0;
    let retries = 0;
    let nextPauseAt = U.pick(cfg.longPauseEvery);
    let burstLeft = 0; // 连滚节奏：还剩几次「短间隔连滚」；<=0 表示下一个 burst 该开始了

    // 先抓一次当前可见的
    await this.extractOnce(ctx);

    for (;;) {
      if (this.stopRequested) break;
      if (maxTweets && this.records.size >= maxTweets) {
        this.stopReasonText = `已达到设定上限 ${maxTweets} 条`;
        break;
      }
      const mins = (Date.now() - this.startedAt) / 60000;
      if (cfg.maxMinutes > 0 && mins > cfg.maxMinutes) {
        this.stopReasonText = `已达到单次时长上限 ${cfg.maxMinutes} 分钟`;
        break;
      }

      // 看门狗：页面连续读不到内容时自救（重载页面 → 重启浏览器 → 报错停下）
      const decision = decideRecovery({
        consecutiveFailures: this.consecutiveFailures,
        recoveries: this.recoveries,
        stuckAfter: this.T.effective.stuckAfter,
        maxRecoveries: this.T.effective.maxRecoveries,
      });
      if (decision.action !== 'continue') {
        await this.recover(decision, ctx);   // abort 会在里面抛错，任务带着清晰原因停下
        endRounds = 0;
        stuckRounds = 0;
        lastHeight = 0;
        continue;
      }

      const before = (await this.safeEval(P.SCROLL_INFO)) || {};
      const delta = U.randInt(cfg.scrollDelta[0], cfg.scrollDelta[1]);
      await this.wheel(delta);
      this.scrollCount += 1;
      // 连滚节奏（像真人刷时间线：快速连滚几下 → 停一下 → 再连滚）：
      // burst 内用 burstGapMs 短间隔，burst 之间用 gapMs 停顿；长停（读帖）另有独立节拍。
      if (burstLeft > 0) {
        burstLeft -= 1;
        await U.sleep(U.randInt(cfg.burstGapMs[0], cfg.burstGapMs[1]));
      } else {
        burstLeft = U.randInt(cfg.burst[0], cfg.burst[1]);
        await U.sleep(U.randInt(cfg.gapMs[0], cfg.gapMs[1]));
      }

      let after = (await this.safeEval(P.SCROLL_INFO)) || {};
      let scrolledNow = (after.scrollTop || 0) > (before.scrollTop || 0);
      if (!scrolledNow) {
        this.log('滚轮事件没有让页面滚动，改用后备方式');
        await this.safeEval(P.scrollByExpr(delta));
        await U.sleep(700);
        after = (await this.safeEval(P.SCROLL_INFO)) || after;
        scrolledNow = (after.scrollTop || 0) > (before.scrollTop || 0);
      }

      const gained = await this.extractOnce(ctx);

      const heightGrew = (after.scrollHeight || 0) > (lastHeight || 0) + 24;
      if (after.scrollHeight) lastHeight = after.scrollHeight;

      const verdict = evaluateProgress({
        gained,
        heightGrew,
        atBottom: !!after.atBottom,
        spinner: !!after.spinner,
        scrolled: scrolledNow,
        endRounds,
        stuckRounds,
        cfg,
      });
      endRounds = verdict.endRounds;
      stuckRounds = verdict.stuckRounds;
      if (verdict.stop) {
        this.stopReasonText = verdict.reason;
        break;
      }

      if (roundNo % 5 === 0) {
        const sig = (await this.safeEval(P.CHECK_STOP)) || {};
        if (sig.stop) {
          this.stopReasonText = `X 出现异常提示，已立即停止：${(sig.reasons || []).join('；')}`;
          break;
        }
        if (sig.loggedOut) {
          this.stopReasonText = '检测到账号已退出登录，为安全起见已停止';
          break;
        }
        if (!sig.loggedIn && roundNo > 20) {
          this.log('提示：暂时看不到账号切换按钮，但也没有登录入口，继续观察');
        }
        if (sig.retryVisible) {
          retries += 1;
          if (retries <= 3) {
            await this.safeEval(P.CLICK_RETRY);
            this.log(`X 显示「重试」，已点掉（第 ${retries} 次）`);
            await U.sleep(4000);
          } else {
            this.stopReasonText = 'X 反复加载失败（重试超过 3 次），为降低风险已停止';
            break;
          }
        }
      }

      roundNo += 1;
      if (roundNo >= nextPauseAt) {
        const ms = U.pick(cfg.longPauseMs);
        this.log(`停顿 ${Math.round(ms / 1000)} 秒（模拟人离开一下）`);
        await U.sleep(ms);
        nextPauseAt = roundNo + U.pick(cfg.longPauseEvery);
      }
      if (roundNo % 10 === 0) {
        this.log(`已滚动 ${this.scrollCount} 次｜本次新增 ${this.totals.newThisRun} 条｜本地共 ${this.records.size} 条`);
      }
      // 深度探针（每 50 滚）：虚拟列表下"新增 0"无法说明走到哪，把当前渲染区的最老时间
      // 和滚动位置写进日志 —— 这是事后判断"每次停在哪个深度带"的唯一实测依据。
      if (roundNo % 50 === 0) {
        const probe = (await this.safeEval(P.DEPTH_PROBE)) || {};
        const pos = `${after.scrollTop || 0}/${after.scrollHeight || 0}`;
        this.log(probe.oldest
          ? `深度探针｜滚 ${this.scrollCount}｜位置 ${pos}｜可见最老 ${String(probe.oldest).slice(0, 10)}（可见 ${probe.count} 条，最新 ${String(probe.newest).slice(0, 10)}）`
          : `深度探针｜滚 ${this.scrollCount}｜位置 ${pos}｜可见区没有时间元素`);
      }
    }
    this.tab = null;
  }

  async wheel(delta) {
    const T = this.T ? this.T.effective : { wheelMs: 8000 };
    const x = U.randInt(260, 900);
    const y = U.randInt(220, 620);
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none', clickCount: 0,
      }, T.wheelMs);
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta, button: 'none', clickCount: 0, modifiers: 0,
      }, T.wheelMs);
    } catch (err) {
      // 滚轮事件要等渲染进程回执，它超时同样说明"页面不响应"，所以也记进看门狗的账
      this.consecutiveFailures += 1;
      const stuckAfter = this.T ? this.T.effective.stuckAfter : 3;
      this.log(this.consecutiveFailures >= stuckAfter
        ? `派发滚轮事件失败（连续 ${this.consecutiveFailures} 次无响应）：${err.message} → 准备自救`
        : `派发滚轮事件失败：${err.message}`);
    }
  }

  // ---------------------------------------------------------------- 提取与落盘

  async extractOnce(ctx) {
    const { imageMode, tab, twPath, handle } = ctx;
    await this.safeEval(P.EXPAND);           // 展开"显示更多"的长推文
    await U.sleep(250);
    const batch = (await this.safeEval(P.EXTRACT)) || [];
    if (!Array.isArray(batch) || !batch.length) return 0;

    const fresh = [];
    for (const raw of batch) {
      if (!raw || !raw.id) continue;
      const rec = this.normalize(raw, handle, tab, imageMode);
      const old = this.records.get(rec.id);
      if (!old) {
        this.records.set(rec.id, rec);
        fresh.push(rec);
      } else {
        const better = (rec.text || '').length > (old.text || '').length
          || (rec.media || []).length > (old.media || []).length;
        if (better) {
          rec.scraped_at = old.scraped_at;
          rec.source_tab = old.source_tab;
          this.records.set(rec.id, rec);
          this.pendingRewrite = true;
          this.enqueueImages(rec);      // 补全出来的媒体也要下载，否则只会写进数据、没图
        }
      }
    }

    if (fresh.length) {
      U.appendJsonl(twPath, fresh);
      this.tweetCount = this.records.size;
      this.totals.newThisRun += fresh.length;
      for (const rec of fresh) this.enqueueImages(rec);
    }
    return fresh.length;
  }

  normalize(raw, handle, tab, imageMode) {
    const rec = {
      id: String(raw.id),
      url: raw.url || `https://x.com/${handle}/status/${raw.id}`,
      handle,
      author_name: raw.author_name || null,
      author_handle: raw.author_handle ? String(raw.author_handle).toLowerCase() : null,
      author_avatar: raw.author_avatar || null,
      verified: !!raw.verified,
      text: raw.text || '',
      lang: raw.lang || null,
      kind: raw.kind || 'original',
      retweeted_by: raw.retweeted_by || null,
      reply_to: Array.isArray(raw.reply_to) ? raw.reply_to : null,
      quoted: raw.quoted || null,
      card: raw.card || null,
      media: [],
      metrics: raw.metrics || {},
      time_iso: raw.time_iso || null,
      time_text: raw.time_text || null,
      truncated: !!raw.truncated,
      source_tab: tab,
      scraped_at: U.nowIso(),
    };
    const list = Array.isArray(raw.media) ? raw.media : [];
    list.forEach((m, i) => {
      const type = m.type === 'video' || m.type === 'gif' ? 'video' : 'photo';
      const src = type === 'photo' ? (m.url || '') : (m.poster || '');
      let local = null;
      if (src && imageMode !== 'none') {
        local = `images/${rec.id}_${i + 1}.${extFromUrl(src)}`;
      }
      rec.media.push({
        type,
        url: m.url ? variantUrl(m.url, imageMode) : null,
        poster: m.poster ? variantUrl(m.poster, imageMode) : null,
        local,
        alt: m.alt || null,
      });
    });
    return rec;
  }

  // ---------------------------------------------------------------- 图片下载

  enqueueImages(rec) {
    for (const m of rec.media) {
      if (!m.local) continue;
      const url = m.type === 'photo' ? m.url : (m.poster || null);
      if (!url) { m.local = null; continue; }
      const target = path.join(U.dataDir(this.handle), m.local.split('/').join(path.sep));
      if (fs.existsSync(target) && fs.statSync(target).size > 200) continue;
      this.imageQueue.push({ url, target });
    }
  }

  startImageWorkers(n) {
    this.imageWorkers = [];
    for (let i = 0; i < n; i += 1) {
      this.imageWorkers.push((async () => {
        for (;;) {
          if (!this.imageQueue.length) {
            if (this.queueClosed) return;
            await U.sleep(500);
            continue;
          }
          const job = this.imageQueue.shift();
          try {
            const bytes = await this.downloadImage(job.url, job.target);
            this.imageOk += 1;
            if (this.imageOk % 25 === 0) this.log(`图片已下载 ${this.imageOk} 张（失败 ${this.imageFail} 张）`);
            if (bytes < 200) this.imageFail += 1;
          } catch (err) {
            this.imageFail += 1;
            if (this.imageFail <= 5) this.log(`图片下载失败：${err.message}`);
          }
          await U.sleep(U.randInt(200, 800));
        }
      })());
    }
  }

  async waitImages(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await U.sleep(1000);
      if (!this.imageQueue.length) break;
    }
    await Promise.allSettled(this.imageWorkers || []);
    this.log(`图片下载完成：成功 ${this.imageOk} 张，失败 ${this.imageFail} 张`);
  }

  /** 下载图片：代理直取（走系统代理，与正常看图一致）→ Node 直连兜底。
   * （T4.3 修复：原"浏览器取图"分支依赖 Network.loadNetworkResource + frameId，
   *  在真实抓取中每张图必撞 "Parameter frameId must be provided"，两轮 0 成功，
   *  真实下载 100% 由代理通道完成 —— 2026-09-30 删除该死分支，只留代理 + Node 兜底。） */
  async downloadImage(url, target) {
    U.ensureDir(path.dirname(target));
    let buf = null;
    try {
      buf = await PF.fetchViaProxy(url, { userAgent: UA });
    } catch (err) {
      this.log(`代理直取失败，再用 Node 直连兜底：${err.message}`);
    }
    if (!buf || buf.length < 200) {
      buf = await this.fetchViaNode(url);
    }
    fs.writeFileSync(target, buf);
    return buf.length;
  }

  async fetchViaNode(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://x.com/' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  // ---------------------------------------------------------------- 收尾

  writeState(dataDir, handle, tabs, resumeVia) {
    try {
      U.ensureDir(dataDir);
      let images = 0;
      try {
        images = fs.readdirSync(U.imagesDir(handle)).length;
      } catch (_) { images = 0; }
      U.writeJsonSafe(U.statePath(handle), {
        handle,
        lastRunAt: U.nowIso(),
        total: this.records.size,
        images,
        tabs,
        resumeVia: resumeVia || undefined,   // 'search' = 本次续抓走了搜索页增量
        stopReason: this.stopReasonText,
      });
    } catch (err) {
      this.log(`写 state.json 失败：${err.message}`);
    }
  }

  async generateReport(dataDir, handle) {
    try {
      const { generateReport } = require('./report');
      const r = generateReport(dataDir, { title: `@${handle} 的 X 主页存档` });
      this.log(`报告已生成：${r.outPath}（${r.count} 条）`);
      this.reportPath = r.outPath;
    } catch (err) {
      this.log(`生成 HTML 报告失败：${err.message}`);
    }
  }
}

module.exports = { Runner, extFromUrl, variantUrl, evaluateProgress, decideRecovery, buildResumeSearchUrl, buildNewPostsSearchUrl, UA };
