'use strict';
/**
 * 自测：cookie 导入 → 注入副本 → 校验。
 * 用**合成 cookie**（假 auth_token）跑通整条管路，验证：
 *   1) 接口能收到并解析；2) 副本浏览器能被启动并注入；3) 注入后 cookie 真的出现在副本的 cookie jar 里；
 *   4) 假 token 情况下登录校验能正确报"未登录"（而不是误报成功）。
 * 全程不接触用户的真实配置目录。
 */
const http = require('http');

const PORT = 8787;

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(new Error('返回不是 JSON: ' + Buffer.concat(chunks).toString('utf8').slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(new Error('返回不是 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

async function main() {
  const fake = [
    { name: 'auth_token', value: 'SYNTHETIC-TEST-TOKEN-NOT-REAL', domain: '.x.com', path: '/', secure: true, httpOnly: true, session: false, expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30, sameSite: 'no_restriction', hostOnly: false },
    { name: 'ct0', value: 'SYNTHETIC-CSRF', domain: '.x.com', path: '/', secure: true, httpOnly: false, session: true, expirationDate: null, sameSite: 'lax', hostOnly: false },
    { name: 'twid', value: 'u%3D12345', domain: '.x.com', path: '/', secure: true, httpOnly: false, session: false, expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30, sameSite: null, hostOnly: false },
    { name: 'guest_id', value: 'v1%3A123', domain: '.x.com', path: '/', secure: true, httpOnly: false, session: false, expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30, sameSite: null, hostOnly: false },
  ];

  console.log('--- 1. 确认面板在跑 ---');
  const st0 = await get('/api/status');
  ok(`面板在线，模式 = ${st0.mode}，当前 session 元信息 = ${JSON.stringify(st0.session)}`);

  console.log('--- 2. 导入合成 cookie（假的 auth_token，只为验证管路）---');
  const res = await post('/api/cookies/import', { source: 'selftest', cookies: fake });
  console.log('   返回：', JSON.stringify(res));
  if (!res || res.ok === false) { fail('导入失败：' + (res && res.message)); return; }
  const hasAuth = res.session && res.session.hasAuthToken;
  if (!hasAuth) fail('注入后副本 cookie jar 里没有 auth_token');
  else ok('注入成功：副本 cookie jar 里能看到 auth_token');
  if (res.session.loggedIn) fail('假 token 竟然被判成已登录，说明校验逻辑有假阳性');
  else ok('假 token 被正确判为"未登录"（没有假成功）');
  if (res.session.cookieCount < 4) fail('注入条数偏少：' + res.session.cookieCount);
  else ok(`注入条数 = ${res.session.cookieCount}`);

  console.log('--- 3. 状态接口应反映同步信息 ---');
  const st1 = await get('/api/status');
  if (!st1.session || !st1.session.syncedAt) fail('状态里没有 syncedAt');
  else ok(`状态里的同步时间 = ${st1.session.syncedAt}，cookie ${st1.session.cookieCount} 条，loggedIn=${st1.session.loggedIn}`);

  console.log('\n结果：' + (process.exitCode ? '有失败项' : '全部通过（管路可用，等真实 cookie 注入）'));
}

main().catch((err) => {
  console.error('测试异常：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
