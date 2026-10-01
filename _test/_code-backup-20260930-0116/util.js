'use strict';
/**
 * 公共工具：路径、日志、随机延时、时间格式化、JSONL 读写。
 * 零第三方依赖，只用 Node 内置模块。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');                 // x-scraper 根目录
const APP_DIR = path.join(ROOT, 'app');
const TOOLS_DIR = path.join(ROOT, 'tools');
const DATA_ROOT = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const SHADOW_DIR = path.join(ROOT, 'chrome-shadow');        // 影子浏览器配置目录
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SRC_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SRC_PROFILE = 'Profile 1';                            // 登录了 X 的那个 Chrome 配置
const DEFAULT_DEBUG_PORT = 9222;
const UI_PORT = 8787;

/**
 * 两种运行模式：
 *   live   —— 直接用你日常那颗已登录的 Chrome。绝不传 --user-data-dir，
 *             保持默认路径，这样 Chrome 的应用绑定加密才正常（否则 cookie 会被删）。
 *             需要一次性授权 Chrome 官方策略 RemoteDebuggingAllowed。
 *   shadow —— 用一个独立副本目录 + 你在副本里自己登录一次；完全不影响日常 Chrome。
 */
const DEFAULT_CONFIG = {
  mode: 'shadow',
  liveProfile: SRC_PROFILE,
  debugPort: DEFAULT_DEBUG_PORT,
  timeoutPreset: 'standard',
};

/**
 * 超时/耐心档位。
 *
 * 为什么要有这个：真实 x.com 上偶尔会出现"页面渲染进程一段时间不响应"，
 * 原来的超时全是硬编码（读页面 30 秒、等渲染 90 秒），机器慢的时候一次卡顿
 * 会白等半分钟，而急性子又没法让它早点失败。现在面板上可以直接选档位。
 *
 *   evalMs        注入脚本（EXTRACT/SCROLL_INFO/CHECK_STOP）的单次超时
 *   wheelMs       派发一次滚轮事件的超时
 *   navigateMs    Page.navigate 的超时
 *   renderWaitMs  等 X 首屏渲染出标志元素的超时
 *   responsiveMs  等页面能响应脚本求值的超时
 *   evalTries     读取登录态之类的重试次数
 *   stuckAfter    连续多少轮页面无响应就判定"卡住"→ 自动重载页面
 *   maxRecoveries 一次任务里最多自救几次（重载 / 重启浏览器）
 *   launchWarnMs  副本浏览器启动超过这么久就告警（超过就说明这次实例可能不健康）
 */
const TIMEOUT_PRESETS = {
  quick: {
    label: '快速失败（超时短，卡住就赶紧报错）',
    values: {
      evalMs: 15000, wheelMs: 6000, navigateMs: 30000, renderWaitMs: 60000, responsiveMs: 60000,
      evalTries: 3, stuckAfter: 2, maxRecoveries: 2, launchWarnMs: 15000,
    },
  },
  standard: {
    label: '标准（推荐）',
    values: {
      evalMs: 30000, wheelMs: 8000, navigateMs: 45000, renderWaitMs: 90000, responsiveMs: 90000,
      evalTries: 4, stuckAfter: 3, maxRecoveries: 2, launchWarnMs: 20000,
    },
  },
  patient: {
    label: '宽松（网络/机器慢时用）',
    values: {
      evalMs: 45000, wheelMs: 12000, navigateMs: 60000, renderWaitMs: 150000, responsiveMs: 120000,
      evalTries: 5, stuckAfter: 4, maxRecoveries: 3, launchWarnMs: 30000,
    },
  },
  extreme: {
    label: '极宽松（很慢的机器，能等就等）',
    values: {
      evalMs: 60000, wheelMs: 15000, navigateMs: 90000, renderWaitMs: 180000, responsiveMs: 180000,
      evalTries: 6, stuckAfter: 5, maxRecoveries: 4, launchWarnMs: 45000,
    },
  },
};
const DEFAULT_TIMEOUT_PRESET = 'standard';
const TIMEOUT_KEYS = Object.keys(TIMEOUT_PRESETS.standard.values);

/** 把用户手改的数值夹到安全区间，避免 0 或负数把流程搞死 */
function clampTimeouts(obj) {
  const out = {};
  const ranges = {
    evalMs: [3000, 600000], wheelMs: [2000, 120000], navigateMs: [5000, 600000],
    renderWaitMs: [10000, 900000], responsiveMs: [10000, 900000],
    evalTries: [1, 10], stuckAfter: [1, 20], maxRecoveries: [0, 5], launchWarnMs: [3000, 300000],
  };
  for (const k of TIMEOUT_KEYS) {
    const v = Number(obj && obj[k]);
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = ranges[k] || [1, 1e9];
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  return out;
}

/**
 * 取当前生效的超时值：档位预设 + config.json 里手改的 timeouts（手改优先）。
 * 面板上用 custom 判断"当前数值和任何档位都不一样"，从而显示成「自定义」。
 */
function loadTimeouts(config) {
  const cfg = config || loadConfig();
  const presetName = TIMEOUT_PRESETS[cfg.timeoutPreset] ? cfg.timeoutPreset : DEFAULT_TIMEOUT_PRESET;
  const preset = TIMEOUT_PRESETS[presetName];
  const override = clampTimeouts(cfg.timeouts || {});
  const effective = Object.assign({}, preset.values, override);
  const custom = TIMEOUT_KEYS.some((k) => effective[k] !== preset.values[k]);
  return { preset: presetName, label: preset.label, presets: TIMEOUT_PRESETS, effective, custom };
}

/** 切换档位：把该档位的数值一起写进 config.json（这样配置里能看到真正生效的数字） */
function saveTimeoutPreset(name) {
  const presetName = TIMEOUT_PRESETS[name] ? name : DEFAULT_TIMEOUT_PRESET;
  return saveConfig({ timeoutPreset: presetName, timeouts: Object.assign({}, TIMEOUT_PRESETS[presetName].values) });
}

function loadConfig() {
  const raw = readJsonSafe(CONFIG_PATH, null);
  return Object.assign({}, DEFAULT_CONFIG, raw && typeof raw === 'object' ? raw : {});
}
function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  writeJsonSafe(CONFIG_PATH, next);
  return next;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 把各种输入（@名字、完整链接、带 ?s=20 的链接）统一成干净的 handle */
function safeHandle(input) {
  let h = String(input == null ? '' : input).trim();
  h = h.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '');
  h = h.replace(/^@/, '');
  h = h.split(/[/?#]/)[0];
  return h.replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
}

function dataDir(handle) {
  return path.join(DATA_ROOT, safeHandle(handle));
}
function tweetsPath(handle) {
  return path.join(dataDir(handle), 'tweets.jsonl');
}
function imagesDir(handle) {
  return path.join(dataDir(handle), 'images');
}
function statePath(handle) {
  return path.join(dataDir(handle), 'state.json');
}
function reportPath(handle) {
  return path.join(dataDir(handle), 'index.html');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}
/** 从区间数组里随机取一个整数延时 */
function pick(range) {
  return randInt(range[0], range[1]);
}

const pad = (n) => String(n).padStart(2, '0');

function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}
function clockText(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function ymd(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

/**
 * 速度档位：滚动距离、滚动间隔、偶尔的"走神"停顿、时间上限、判定到底的空转轮数。
 * 数值刻意偏"慢且随机"，目的是让节奏接近真人。
 */
const SPEED = {
  safe: {
    label: '稳健',
    scrollDelta: [320, 680],
    gapMs: [2200, 5200],
    longPauseEvery: [7, 13],
    longPauseMs: [6000, 15000],
    maxMinutes: 60,
    emptyRounds: 6,
  },
  normal: {
    label: '标准',
    scrollDelta: [420, 900],
    gapMs: [1500, 3600],
    longPauseEvery: [9, 17],
    longPauseMs: [4000, 10000],
    maxMinutes: 45,
    emptyRounds: 5,
  },
  fast: {
    label: '快速',
    scrollDelta: [550, 1150],
    gapMs: [900, 2100],
    longPauseEvery: [12, 22],
    longPauseMs: [3000, 7000],
    maxMinutes: 30,
    emptyRounds: 5,
  },
};

/** 图片尺寸档位：把 pbs.twimg.com 的 name 参数换成对应变体 */
const IMAGE_VARIANT = {
  none: null,
  medium: 'large',
  orig: 'orig',
};

class Logger {
  constructor(onLine) {
    this.onLine = onLine || null;
    this.file = path.join(ensureDir(LOG_DIR), `app-${ymd()}.log`);
    this.recent = [];
  }
  line(msg) {
    const t = clockText();
    const text = String(msg == null ? '' : msg);
    console.log(`[${t}] ${text}`);
    try {
      fs.appendFileSync(this.file, `${nowIso()} ${text}\r\n`, 'utf8');
    } catch (_) { /* 日志写不进去也不该影响主流程 */ }
    this.recent.push({ t, msg: text });
    if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
    if (this.onLine) {
      try { this.onLine({ t, msg: text }); } catch (_) { /* ignore */ }
    }
  }
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}
function writeJsonSafe(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 逐行读 JSONL，坏行跳过 */
function readJsonl(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
  }
  return out;
}
function appendJsonl(file, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

module.exports = {
  ROOT, APP_DIR, TOOLS_DIR, DATA_ROOT, LOG_DIR, SHADOW_DIR, CONFIG_PATH,
  SRC_USER_DATA, SRC_PROFILE, DEFAULT_DEBUG_PORT, UI_PORT, DEFAULT_CONFIG,
  TIMEOUT_PRESETS, DEFAULT_TIMEOUT_PRESET, TIMEOUT_KEYS,
  loadConfig, saveConfig, loadTimeouts, saveTimeoutPreset, clampTimeouts,
  ensureDir, safeHandle, dataDir, tweetsPath, imagesDir, statePath, reportPath,
  sleep, randInt, randFloat, pick, pad, nowIso, clockText, ymd, fmtBytes, fmtDuration,
  SPEED, IMAGE_VARIANT, Logger, readJsonSafe, writeJsonSafe, readJsonl, appendJsonl,
};
