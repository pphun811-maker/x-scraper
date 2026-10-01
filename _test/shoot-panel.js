'use strict';
/**
 * 给控制面板截图（用来目视确认「超时档位」下拉等 UI 是否正常渲染）。
 * 用法：node _test/shoot-panel.js [port]   默认 http://127.0.0.1:8787
 * 产物：_test/shots/panel.png（整页）
 * 只会打开本机面板页面，不访问 x.com。
 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;
const PANEL = `http://127.0.0.1:${process.argv[2] || U.UI_PORT}/`;
const outDir = path.join(U.ROOT, '_test', 'shots');

async function main() {
  U.ensureDir(outDir);
  const config = U.loadConfig();
  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: (m) => console.log('   ' + m) });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  const cdp = page.cdp;

  await cdp.send('Page.navigate', { url: PANEL }, 30000);
  await U.sleep(3500);

  const info = await cdp.eval(`(() => {
    const sel = document.getElementById('timeoutPreset');
    return {
      title: document.title,
      hasSelect: !!sel,
      options: sel ? Array.from(sel.options).map((o) => o.value + ':' + o.textContent.trim()) : [],
      selected: sel ? sel.value : null,
      hint: (document.getElementById('timeoutHint') || {}).textContent || null,
      rescueHidden: (document.getElementById('rescueHint') || {}).hidden,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean),
    };
  })()`);
  console.log('   面板页信息：', JSON.stringify(info, null, 2));

  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 30000);
  const file = path.join(outDir, 'panel.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`   截图 -> ${file}（${U.fmtBytes(fs.statSync(file).size)}）`);

  if (!info.hasSelect) { console.error('✗ 找不到「超时档位」下拉框'); process.exitCode = 1; }
  else if (!/读页面/.test(info.hint || '')) { console.error('✗ 超时提示行没有渲染：' + info.hint); process.exitCode = 1; }
  else console.log('✓ 超时档位下拉与提示行都渲染正常');

  cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
  console.log('结果：' + (process.exitCode ? '有失败项' : '全部通过'));
}

main().catch((err) => { console.error('异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
