'use strict';
/** 用修复后的提取脚本，对正在抓取的真实页面做一次提取，看媒体是否回来了。 */
const U = require('../app/util');
const { CDP, listTargets } = require('../app/cdp');
const P = require('../app/extract');

const PORT = U.DEFAULT_DEBUG_PORT;

async function main() {
  const list = await listTargets(PORT, 8000);
  const target = list.find((t) => t.type === 'page' && t.url.includes('x.com'));
  if (!target) { console.log('没有 x.com 标签页'); return; }
  const cdp = new CDP(target.webSocketDebuggerUrl, 'probe');
  await cdp.connect(12000);
  await cdp.send('Runtime.enable', {}, 8000).catch(() => {});

  const batch = await cdp.eval(P.EXTRACT, { timeoutMs: 40000 });
  const arr = Array.isArray(batch) ? batch : [];
  const withMedia = arr.filter((t) => (t.media || []).length > 0);
  const photos = arr.reduce((a, t) => a + (t.media || []).filter((m) => m.type === 'photo').length, 0);
  const videos = arr.reduce((a, t) => a + (t.media || []).filter((m) => m.type === 'video').length, 0);

  console.log(`提取到 ${arr.length} 条；带媒体 ${withMedia.length} 条；图片 ${photos} 张；视频/动图 ${videos} 个`);
  for (const t of withMedia.slice(0, 5)) {
    console.log(`  - id=${t.id} kind=${t.kind} 媒体 ${t.media.length} 个 | 首个：${(t.media[0].url || t.media[0].poster || '').slice(0, 80)}`);
    console.log(`    正文：${(t.text || '').slice(0, 40).replace(/\n/g, ' ')}`);
  }
  const quoted = arr.filter((t) => t.quoted && t.quoted.text);
  console.log(`引用推文 ${quoted.length} 条`);
  if (!photos && !videos) { console.error('✗ 媒体仍然是 0，修复没生效'); process.exitCode = 1; }
  else console.log('✓ 媒体提取已恢复');
  cdp.close();
}

main().catch((err) => { console.error('异常：', err && err.stack ? err.stack : err); process.exitCode = 1; });
