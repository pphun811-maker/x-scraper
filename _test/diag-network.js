'use strict';
/**
 * 诊断：副本浏览器能不能上网？能不能上 x.com？
 * 分别测 example.com（应该秒开）和 x.com（需要走代理），并报告耗时与失败原因。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;

async function tryNav(cdp, url, timeoutMs) {
  const t0 = Date.now();
  try {
    await cdp.send('Page.navigate', { url }, timeoutMs);
    // 等 readyState 变化
    for (let i = 0; i < Math.ceil(timeoutMs / 1000); i += 1) {
      await U.sleep(1000);
      let info = null;
      try {
        info = await cdp.eval('({href: location.href, rs: document.readyState, title: document.title})', { timeoutMs: 8000 });
      } catch (_) { /* 导航中可能报错 */ }
      if (info && info.rs === 'complete' && info.href && info.href !== 'about:blank') {
        return { ok: true, ms: Date.now() - t0, ...info };
      }
    }
    const last = await cdp.eval('({href: location.href, rs: document.readyState, title: document.title})', { timeoutMs: 8000 }).catch(() => null);
    return { ok: false, ms: Date.now() - t0, reason: '等待 readyState=complete 超时', last };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, reason: err.message };
  }
}

async function main() {
  const config = U.loadConfig();

  // 先看看副本配置里的代理设置
  const prefPath = path.join(U.SHADOW_DIR, 'Default', 'Preferences');
  if (fs.existsSync(prefPath)) {
    const j = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
    console.log('副本 Preferences 里的代理设置：', JSON.stringify(j.proxy || '(没有 proxy 键，走系统默认)'));
    const sys = j.proxy && j.proxy.mode;
    console.log('   proxy.mode =', sys || '(未设置 → Chrome 默认用系统代理)');
  }

  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: (m) => console.log('   ' + m) });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  const cdp = page.cdp;

  console.log('\n=== 1. 普通网站 example.com ===');
  const a = await tryNav(cdp, 'https://example.com/', 30000);
  console.log('   ', JSON.stringify(a));

  console.log('\n=== 2. x.com/robots.txt ===');
  const b = await tryNav(cdp, 'https://x.com/robots.txt', 40000);
  console.log('   ', JSON.stringify(b));

  console.log('\n=== 3. Google（对照，确认代理通路）===');
  const c = await tryNav(cdp, 'https://www.google.com/', 30000);
  console.log('   ', JSON.stringify(c));

  try { cdp.close(); } catch (_) { /* ignore */ }
  console.log('\n（诊断结束，浏览器保持运行）');
}

main().catch((err) => {
  console.error('诊断异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
