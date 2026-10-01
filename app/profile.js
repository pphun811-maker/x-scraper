'use strict';
/**
 * 影子登录态：把日常 Chrome 里"登录了 X 的那个配置"复制成一个独立副本，
 * 之后所有自动化都在副本里跑 —— 你日常的 Chrome 配置一点都不会被改到。
 *
 * 复制 cookie 时优先用 SQLite 自己的一致性快照（VACUUM INTO），
 * 所以即使 Chrome 正在运行、库里有未落盘的日志，也能拿到完整一致的副本。
 * 关掉 Chrome 再复制当然更稳，但不是必须的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');
const { isChromeRunning, chromeVersion } = require('./chrome');

const SRC = U.SRC_USER_DATA;
const SRC_PROFILE = U.SRC_PROFILE;
const SHADOW = U.SHADOW_DIR;
const SESSION_MARKER = path.join(SHADOW, '.xscraper-session');

/**
 * 标记"副本自己已经有可用的登录态了"。
 * 为什么需要它：Chrome 127+ 的 App-Bound 加密让"复制配置目录复用登录态"不可行
 * （实测：3530 条 v20 cookie 被影子 Chrome 全部丢弃），所以副本的登录态来自
 * 用户在副本里手动登录那一次 —— 那就绝不能被后面的"准备登录态"覆盖掉。
 */
function markShadowSession(account) {
  U.ensureDir(SHADOW);
  fs.writeFileSync(SESSION_MARKER, JSON.stringify({ at: U.nowIso(), account: account || null }), 'utf8');
}
function shadowSession() {
  const j = U.readJsonSafe(SESSION_MARKER, null);
  return j && j.at ? j : null;
}

function srcProfile() {
  return path.join(SRC, SRC_PROFILE);
}

function copyFileMaybe(from, to) {
  if (!fs.existsSync(from)) return null;
  U.ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return { from, to, bytes: fs.statSync(to).size };
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch (_) { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function copyDirMaybe(from, to) {
  if (!fs.existsSync(from)) return null;
  U.ensureDir(path.dirname(to));
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
  const s = dirStats(to);
  return { from, to, bytes: s.bytes, files: s.files };
}

/** 同步小睡（用于同步函数里的重试间隔） */
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (_) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { /* busy wait */ }
  }
}

/**
 * 只读探测 cookie 库：优先用 SQLite 真读（拿到真实行数），失败则退化为字节扫描。
 * 只统计 host_key / name，绝不读取、绝不打印任何 cookie 的值。
 */
function inspectCookieDb(file) {
  const out = {
    exists: false, bytes: 0, hasXHost: false, hasAuthToken: false, xRows: 0, totalRows: 0, sqlite: false,
    unreadable: false,
  };
  if (!fs.existsSync(file)) return out;
  out.exists = true;
  out.bytes = fs.statSync(file).size;

  // Chrome 正在运行时这个文件可能被独占锁住，先复制一份再读；偶尔失败就重试几次
  const tmp = path.join(os.tmpdir(), `xscraper-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let copied = false;
  for (let i = 0; i < 4 && !copied; i += 1) {
    try {
      fs.copyFileSync(file, tmp);
      copied = true;
    } catch (err) {
      out.locked = true;
      out.lockError = err.code || err.message;
      sleepSync(250 * (i + 1));
    }
  }
  const byteScan = () => {
    try {
      const text = fs.readFileSync(file).toString('latin1');
      out.hasXHost = text.includes('x.com') || text.includes('twitter.com');
      out.hasAuthToken = text.includes('auth_token');
    } catch (_) { /* ignore */ }
  };

  if (!copied) {
    byteScan();          // 拷不动就退化为直接读字节（只判断"有没有出现这些字样"）
    out.locked = true;
    // T4.1 修复：连字节扫描都可能被文件锁挡住（Chrome 运行时实测 EBUSY），
    // 此时 hasAuthToken:false 不可信 —— 必须显式告诉调用方"打不开 ≠ 没登录"。
    out.unreadable = true;
    return out;
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmp, { readOnly: true });
    const xRow = db.prepare(
      "select count(*) as n from cookies where host_key like '%x.com%' or host_key like '%twitter.com%'",
    ).get();
    const allRow = db.prepare('select count(*) as n from cookies').get();
    const authRow = db.prepare("select count(*) as n from cookies where name = 'auth_token'").get();
    db.close();
    out.sqlite = true;
    out.locked = false;
    out.xRows = Number(xRow && xRow.n) || 0;
    out.totalRows = Number(allRow && allRow.n) || 0;
    out.hasXHost = out.xRows > 0;
    out.hasAuthToken = (Number(authRow && authRow.n) || 0) > 0;
    return out;
  } catch (err) {
    out.lockError = err.message;
    // T4.1 修复：快照拷到了但 SQLite 真读失败（库损坏/加密/锁残留）——
    // 此后的 byteScan 只是尽力而为，结果同样要打上"不可信"标记。
    out.unreadable = true;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }

  byteScan();
  return out;
}

/**
 * 一致性复制 cookie 库：
 * 先把库（连同 -journal/-wal/-shm）拷到临时目录，再让 SQLite 自己把它导出成一个干净的新库。
 * 这样拿到的是事务一致的快照，不会拷到"半个事务"。
 */
function copyCookiesConsistent(srcCookies, dstCookies) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xscraper-ck-'));
  const tmpDb = path.join(tmpDir, 'Cookies');
  try {
    fs.copyFileSync(srcCookies, tmpDb);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(srcCookies + suffix)) {
        try { fs.copyFileSync(srcCookies + suffix, tmpDb + suffix); } catch (_) { /* ignore */ }
      }
    }
    U.ensureDir(path.dirname(dstCookies));
    try { fs.rmSync(dstCookies, { force: true }); } catch (_) { /* ignore */ }
    const target = dstCookies.replace(/\\/g, '/').replace(/'/g, "''");
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmpDb);
    db.exec(`VACUUM INTO '${target}'`);
    db.close();
    return { mode: 'sqlite-snapshot', bytes: fs.statSync(dstCookies).size };
  } catch (err) {
    const r = copyFileMaybe(srcCookies, dstCookies);
    return { mode: 'plain-copy', bytes: r ? r.bytes : 0, note: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

function shadowStatus() {
  const pref = path.join(SHADOW, 'Default', 'Preferences');
  const cookies = path.join(SHADOW, 'Default', 'Network', 'Cookies');
  const localState = path.join(SHADOW, 'Local State');
  const info = inspectCookieDb(cookies);
  return {
    ready: fs.existsSync(SHADOW) && fs.existsSync(pref) && fs.existsSync(localState) && info.exists,
    shadowDir: SHADOW,
    hasPreferences: fs.existsSync(pref),
    hasLocalState: fs.existsSync(localState),
    cookies: info,
    updatedAt: (() => {
      try { return U.nowIso(fs.statSync(cookies).mtime); } catch (_) { return null; }
    })(),
  };
}

/** 执行复制（只在副本还没有自己的登录态时才应该调用）。 */
function prepareShadowProfile(options = {}) {
  const log = options.log || (() => {});
  const existing = shadowSession();
  const shadowCookies = path.join(SHADOW, 'Default', 'Network', 'Cookies');

  if (existing && !options.force) {
    log(`副本已有自己的登录态（${existing.at}${existing.account ? `，${existing.account}` : ''}），跳过复制。`);
    return {
      skipped: true,
      reason: 'shadow-session-exists',
      session: existing,
      shadowDir: SHADOW,
      cookies: inspectCookieDb(shadowCookies),
    };
  }

  if (!fs.existsSync(SRC)) throw new Error(`找不到 Chrome 配置目录：${SRC}`);
  if (!fs.existsSync(srcProfile())) {
    throw new Error(`找不到配置 "${SRC_PROFILE}"：${path.join(SRC, SRC_PROFILE)} 不存在。请确认登录 X 的是哪个 Chrome 配置。`);
  }

  const chromeRunning = isChromeRunning();
  const srcCookiesNew = path.join(srcProfile(), 'Network', 'Cookies');
  const srcCookiesOld = path.join(srcProfile(), 'Cookies');
  const srcCookies = fs.existsSync(srcCookiesNew) ? srcCookiesNew : srcCookiesOld;
  if (!fs.existsSync(srcCookies)) {
    throw new Error(`配置 "${SRC_PROFILE}" 里找不到 Cookies 文件，无法复制登录态。`);
  }

  const before = inspectCookieDb(srcCookies);
  log(`源配置 ${SRC_PROFILE}：cookie 共 ${before.totalRows} 行，其中 x.com/twitter.com ${before.xRows} 行，auth_token ${before.hasAuthToken ? '存在' : '不存在'}`);
  if (!before.hasXHost) {
    log(`注意：${SRC_PROFILE} 里没看到 x.com 的 cookie，可能登录 X 的是别的配置。`);
  }
  log(chromeRunning
    ? '检测到 Chrome 正在运行：用 SQLite 一致性快照复制 cookie（不需要关闭 Chrome）。'
    : 'Chrome 未运行：直接复制 cookie 文件。');

  if (existing && options.force) {
    const backup = path.join(SHADOW, `.backup-${Date.now()}`);
    try {
      U.ensureDir(path.join(backup, 'Default', 'Network'));
      fs.copyFileSync(path.join(SHADOW, 'Local State'), path.join(backup, 'Local State'));
      fs.copyFileSync(shadowCookies, path.join(backup, 'Default', 'Network', 'Cookies'));
      log(`已把副本现有登录态备份到 ${backup}`);
    } catch (err) {
      log(`备份副本登录态失败：${err.message}`);
    }
  }

  U.ensureDir(path.join(SHADOW, 'Default', 'Network'));
  const copied = [];
  const push = (r) => { if (r) copied.push(r); };

  push(copyFileMaybe(path.join(SRC, 'Local State'), path.join(SHADOW, 'Local State')));
  const ck = copyCookiesConsistent(srcCookies, path.join(SHADOW, 'Default', 'Network', 'Cookies'));
  copied.push({
    from: srcCookies,
    to: path.join(SHADOW, 'Default', 'Network', 'Cookies'),
    bytes: ck.bytes,
    mode: ck.mode,
  });
  log(`cookie 复制方式：${ck.mode}${ck.note ? `（回退原因：${ck.note}）` : ''}`);
  push(copyFileMaybe(path.join(srcProfile(), 'Preferences'), path.join(SHADOW, 'Default', 'Preferences')));
  push(copyFileMaybe(
    path.join(srcProfile(), 'Network', 'Network Persistent State'),
    path.join(SHADOW, 'Default', 'Network', 'Network Persistent State'),
  ));
  push(copyDirMaybe(path.join(srcProfile(), 'Local Storage'), path.join(SHADOW, 'Default', 'Local Storage')));
  push(copyDirMaybe(path.join(srcProfile(), 'Session Storage'), path.join(SHADOW, 'Default', 'Session Storage')));

  // 让 Chrome 认为上次是正常退出的，避免"恢复页面"气泡
  const prefPath = path.join(SHADOW, 'Default', 'Preferences');
  try {
    const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    pref.profile = pref.profile || {};
    pref.profile.exit_type = 'Normal';
    pref.profile.exited_cleanly = true;
    if (pref.extensions) delete pref.extensions;      // 副本里没有扩展文件，避免报"扩展缺失"
    fs.writeFileSync(prefPath, JSON.stringify(pref), 'utf8');
    log('已修正副本的退出标记');
  } catch (err) {
    log(`修正 Preferences 失败（可忽略）：${err.message}`);
  }

  try {
    fs.writeFileSync(path.join(SHADOW, 'Last Version'), chromeVersion(), 'utf8');
    fs.writeFileSync(path.join(SHADOW, 'First Run'), '', 'utf8');
  } catch (err) {
    log(`写入版本标记失败（可忽略）：${err.message}`);
  }

  const after = inspectCookieDb(path.join(SHADOW, 'Default', 'Network', 'Cookies'));
  const totalBytes = copied.reduce((a, c) => a + (c.bytes || 0), 0);
  log(`影子登录态已复制：${copied.length} 项，共 ${U.fmtBytes(totalBytes)}`);
  log(`副本校验：cookie ${after.totalRows} 行，x.com/twitter.com ${after.xRows} 行，auth_token ${after.hasAuthToken ? '存在' : '不存在'}`);

  return {
    copied, cookies: after, source: before, totalBytes, shadowDir: SHADOW, chromeRunning, cookieMode: ck.mode,
  };
}

module.exports = {
  prepareShadowProfile, shadowStatus, inspectCookieDb, copyCookiesConsistent,
  markShadowSession, shadowSession, SHADOW, SRC, SESSION_MARKER,
};
