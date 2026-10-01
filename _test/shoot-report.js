'use strict';
/** 打开生成的报告并截图，用来目视确认渲染是否正常。 */
const fs = require('fs');
const path = require('path');
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;
const HANDLE = process.argv[2] || 'georgerussell63';
const report = U.reportPath(HANDLE);
const outDir = path.join(U.ROOT, '_test', 'shots');

async function shoot(cdp, file, label) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(file, buf);
  console.log(`  ${label} -> ${file}（${U.fmtBytes(buf.length)}）`);
}

async function main() {
  if (!fs.existsSync(report)) throw new Error('报告不存在：' + report);
  U.ensureDir(outDir);
  const config = U.loadConfig();
  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: (m) => console.log('   ' + m) });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  const cdp = page.cdp;

  const url = 'file:///' + report.replace(/\\/g, '/');
  await cdp.send('Page.navigate', { url }, 30000);
  await U.sleep(4000);
  const info = await cdp.eval(`(() => ({
    title: document.title,
    cards: document.querySelectorAll('#feed > *').length,
    imgs: document.querySelectorAll('#feed img').length,
    header: (document.body.innerText || '').slice(0, 160).replace(/\\n/g, ' | '),
  }))()`);
  console.log('  报告页信息：', JSON.stringify(info));
  await shoot(cdp, path.join(outDir, 'report-cards.png'), '卡片视图');

  // 切到图片墙再看一眼
  const clicked = await cdp.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('button,[data-mode]'));
    const b = btns.find((x) => (x.getAttribute('data-mode') || '') === 'wall'
      || /图片墙/.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  console.log('  切换图片墙：', clicked);
  await U.sleep(3500);
  await shoot(cdp, path.join(outDir, 'report-wall.png'), '图片墙视图');

  cdp.close();
  await CH.closeShadowBrowser(PORT, () => {});
}

main().catch((err) => { console.error('异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
