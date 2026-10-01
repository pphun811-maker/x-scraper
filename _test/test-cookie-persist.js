'use strict';
/**
 * 验证：注入到副本里的 cookie 能不能跨浏览器重启存活。
 * （之前自测注入了 4 条合成 cookie；这里重新启动副本浏览器，看它们还在不在。）
 * 不接触用户的真实配置目录。
 */
const U = require('../app/util');
const CH = require('../app/chrome');

const PORT = U.DEFAULT_DEBUG_PORT;

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

async function main() {
  const config = U.loadConfig();
  console.log(`模式=${config.mode} 端口=${PORT}`);

  await CH.ensureBrowser({ mode: 'shadow', config, visible: false, log: (m) => console.log('   ' + m) });
  const page = await CH.openPage(PORT, 'about:blank', () => {});
  const jar = await page.cdp.send('Network.getCookies', { urls: ['https://x.com/', 'https://api.x.com/'] });
  const cookies = (jar && jar.cookies) || [];
  const names = cookies.map((c) => c.name).sort();
  console.log('   副本当前 x.com cookie：', names.join(', ') || '(无)');

  const auth = cookies.find((c) => c.name === 'auth_token');
  if (!auth) fail('重启后 auth_token 不见了 —— 登录态无法持久化');
  else ok(`重启后 auth_token 仍在（值长度 ${String(auth.value).length}，符合预期：注入的合成 cookie 被副本自己的密钥加密存了下来）`);

  const ct0 = cookies.find((c) => c.name === 'ct0');
  if (!ct0) fail('重启后 ct0 不见了');
  else ok('ct0 也在');

  try { page.cdp.close(); } catch (_) { /* ignore */ }
  await CH.closeShadowBrowser(PORT, (m) => console.log('   ' + m));
  console.log('\n结果：' + (process.exitCode ? '有失败项' : '通过 —— 同步一次即可长期复用'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
