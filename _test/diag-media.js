'use strict';
/** 定位"DOM 里有图片但提取不到媒体"的原因。 */
const U = require('../app/util');
const { CDP, listTargets } = require('../app/cdp');

const PORT = U.DEFAULT_DEBUG_PORT;

async function main() {
  const list = await listTargets(PORT, 8000);
  const target = list.find((t) => t.type === 'page' && t.url.includes('x.com'));
  if (!target) { console.log('没有 x.com 标签页'); return; }
  const cdp = new CDP(target.webSocketDebuggerUrl, 'probe');
  await cdp.connect(12000);
  await cdp.send('Runtime.enable', {}, 8000).catch(() => {});

  const out = await cdp.eval(`(() => {
    const arts = document.querySelectorAll('article[data-testid="tweet"]');
    const res = [];
    for (const art of arts) {
      const photos = Array.from(art.querySelectorAll('[data-testid="tweetPhoto"] img'));
      if (!photos.length) continue;
      res.push({
        textHead: (art.innerText || '').slice(0, 30).replace(/\\n/g, ' '),
        photoCount: photos.length,
        details: photos.slice(0, 3).map((img) => {
          let el = img.parentElement;
          let hops = 0;
          let linkHop = 0;
          let linkHasUserName = null;
          while (el && el !== art) {
            hops += 1;
            if (el.getAttribute && el.getAttribute('role') === 'link') {
              if (!linkHop) {
                linkHop = hops;
                linkHasUserName = !!(el.querySelector('[data-testid="User-Name"]') && el.querySelector('time'));
              }
            }
            el = el.parentElement;
          }
          const src = img.getAttribute('src') || '';
          return {
            srcHead: src.slice(0, 70),
            isData: src.indexOf('data:') === 0,
            passesUrlFilter: /pbs\\.twimg\\.com\\/(media|amplify|ext_tw_video_thumb|tweet_video_thumb)/.test(src),
            roleLinkHops: linkHop,
            linkLooksLikeQuoteCard: linkHasUserName,
            insideQuoteByCurrentCode: !!linkHop,   // 当前代码的判定
          };
        }),
      });
    }
    return { articleCount: arts.length, withPhotos: res.length, res: res.slice(0, 4) };
  })()`, { timeoutMs: 30000 });

  console.log(JSON.stringify(out, null, 1));
  cdp.close();
}

main().catch((err) => { console.error('异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
