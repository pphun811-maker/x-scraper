'use strict';
/** 连上正在抓取的标签页，看看 DOM 真实状态：推文数、媒体数、滚动位置、页面是否卡住。 */
const U = require('../app/util');
const CH = require('../app/chrome');
const P = require('../app/extract');

const PORT = U.DEFAULT_DEBUG_PORT;

async function main() {
  const list = await require('../app/cdp').listTargets(PORT, 8000);
  const pages = list.filter((t) => t.type === 'page');
  console.log('标签页：');
  pages.forEach((t) => console.log('  -', t.id, t.url.slice(0, 80)));
  const target = pages.find((t) => t.url.includes('georgerussell63'));
  if (!target) { console.log('没找到抓取标签页'); return; }

  const cdp = new (require('../app/cdp').CDP)(target.webSocketDebuggerUrl, 'probe');
  await cdp.connect(12000);
  await cdp.send('Runtime.enable', {}, 8000).catch(() => {});

  const t0 = Date.now();
  const info = await cdp.eval(P.SCROLL_INFO, { timeoutMs: 25000 });
  console.log(`SCROLL_INFO 耗时 ${Date.now() - t0}ms：`, JSON.stringify(info));

  const t1 = Date.now();
  const raw = await cdp.eval(`(() => {
    const arts = document.querySelectorAll('article[data-testid="tweet"]');
    const photos = document.querySelectorAll('[data-testid="tweetPhoto"] img');
    let realImg = 0, dataImg = 0;
    photos.forEach((i) => { const s = i.getAttribute('src') || ''; if (s.indexOf('data:') === 0) dataImg++; else if (s) realImg++; });
    return {
      href: location.href, title: document.title,
      articles: arts.length, photos: photos.length, realImg, dataImg,
      cells: document.querySelectorAll('[data-testid="cellInnerDiv"]').length,
      firstArticleText: arts.length ? (arts[0].innerText || '').slice(0, 60) : null,
      lastArticleText: arts.length ? (arts[arts.length - 1].innerText || '').slice(0, 60) : null,
    };
  })()`, { timeoutMs: 25000 });
  console.log(`DOM 概览 耗时 ${Date.now() - t1}ms：`, JSON.stringify(raw, null, 1));

  const t2 = Date.now();
  const batch = await cdp.eval(P.EXTRACT, { timeoutMs: 40000 });
  console.log(`EXTRACT 耗时 ${Date.now() - t2}ms，返回 ${Array.isArray(batch) ? batch.length : 'N/A'} 条`);
  if (Array.isArray(batch) && batch.length) {
    const withMedia = batch.filter((b) => (b.media || []).length > 0).length;
    console.log(`  其中带媒体 ${withMedia} 条；首条 id=${batch[0].id} kind=${batch[0].kind}`);
    console.log('  首条 media：', JSON.stringify((batch[0].media || []).slice(0, 2)));
  }

  const t3 = Date.now();
  const stop = await cdp.eval(P.CHECK_STOP, { timeoutMs: 30000 });
  console.log(`CHECK_STOP 耗时 ${Date.now() - t3}ms：`, JSON.stringify(stop));

  cdp.close();
}

main().catch((err) => { console.error('诊断异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
