'use strict';
const btn = document.getElementById('go');
const out = document.getElementById('result');

function show(kind, text) {
  out.className = kind;
  out.textContent = text;
}

btn.addEventListener('click', () => {
  btn.disabled = true;
  btn.textContent = '同步中…';
  show('', '');
  chrome.runtime.sendMessage({ type: 'sync' }, (res) => {
    btn.disabled = false;
    btn.textContent = '立即同步';
    if (chrome.runtime.lastError) {
      show('bad', '出错：' + chrome.runtime.lastError.message);
      return;
    }
    if (!res) { show('bad', '没有收到回应，请重新打开这个弹窗再试。'); return; }
    if (res.ok) show('ok', `成功：同步了 ${res.count} 条 cookie。\n${res.message || ''}`);
    else show('bad', '失败：' + (res.error || '未知错误'));
  });
});

// 打开弹窗时自动试一次，省一次点击
document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ type: 'sync' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    if (res.ok) show('ok', `成功：同步了 ${res.count} 条 cookie。`);
    else show('bad', '失败：' + (res.error || '未知错误'));
  });
});
