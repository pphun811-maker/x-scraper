'use strict';
/**
 * 注入到 X 页面里执行的函数集合。
 * 这些函数不引用任何外部变量（会被 toString() 之后通过 CDP Runtime.evaluate 执行），
 * 所以可以整体拷贝到页面上下文里跑。选择器尽量只用 data-testid，避免受界面语言影响。
 */

/** 提取当前 DOM 里所有推文。返回数组。 */
function pageExtract() {
  const out = [];
  const arts = document.querySelectorAll('article[data-testid="tweet"]');

  function parseCount(input) {
    if (input == null) return null;
    const s = String(input).replace(/[\s,]/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)(万|亿|[KkMmBb])?/);
    if (!m) return null;
    let v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    const suf = (m[2] || '').toUpperCase();
    if (suf === 'K') v *= 1e3;
    else if (suf === 'M') v *= 1e6;
    else if (suf === 'B') v *= 1e9;
    else if (m[2] === '万') v *= 1e4;
    else if (m[2] === '亿') v *= 1e8;
    return Math.round(v);
  }

  function metricOf(art, testIds) {
    for (const tid of testIds) {
      const el = art.querySelector('[data-testid="' + tid + '"]');
      if (!el) continue;
      const label = el.getAttribute('aria-label') || '';
      const text = (el.innerText || el.textContent || '').trim();
      const v = parseCount(label) != null ? parseCount(label) : parseCount(text);
      if (v != null) return v;
    }
    return null;
  }

  /**
   * 找到"引用推文卡片"的外层容器。
   * 关键：X 里图片/视频外面也常包着 role=link，所以**不能**看到 role=link 就当引用 ——
   * 必须同时含 [data-testid="User-Name"] 和 <time> 才是真正的引用卡片。
   * （之前的版本就是在这里把所有图片都当成引用丢掉了。）
   */
  function quoteRootOf(node, art) {
    let el = node.parentElement;
    while (el && el !== art) {
      if (el.getAttribute && el.getAttribute('role') === 'link'
        && el.querySelector('[data-testid="User-Name"]') && el.querySelector('time')) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }
  function insideQuote(node, art) {
    return !!quoteRootOf(node, art);
  }

  for (const art of arts) {
    try {
      const timeEl = art.querySelector('time[datetime]');
      if (!timeEl) continue;
      const linkEl = timeEl.closest('a');
      const href = linkEl ? (linkEl.getAttribute('href') || '') : '';
      const idMatch = /\/status\/(\d+)/.exec(href);
      if (!idMatch) continue;
      const id = idMatch[1];

      const nameBlock = art.querySelector('[data-testid="User-Name"]');
      let authorName = null;
      let authorHandle = null;
      if (nameBlock) {
        const txt = (nameBlock.innerText || nameBlock.textContent || '').trim();
        const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
        authorName = lines.length ? lines[0] : null;
        const hm = txt.match(/@([A-Za-z0-9_]{1,20})/);
        authorHandle = hm ? hm[1] : null;
      }

      const avatarEl = art.querySelector('img[src*="profile_images"]');
      const verified = !!art.querySelector('[data-testid="icon-verified"]');
      const social = art.querySelector('[data-testid="socialContext"]');
      const retweetedBy = social ? (social.textContent || '').trim() : null;

      const textNodes = Array.prototype.slice.call(art.querySelectorAll('[data-testid="tweetText"]'));
      const mainNode = textNodes.filter((n) => !insideQuote(n, art))[0] || null;
      const quoteNodes = textNodes.filter((n) => insideQuote(n, art));
      const text = mainNode ? (mainNode.innerText || mainNode.textContent || '') : '';
      const lang = mainNode ? (mainNode.getAttribute('lang') || '') : '';

      let quoted = null;
      if (quoteNodes.length) {
        const qn = quoteNodes[0];
        const wrap = quoteRootOf(qn, art);
        let qUrl = null;
        let qName = null;
        let qHandle = null;
        if (wrap) {
          const a = wrap.querySelector('a[href*="/status/"]');
          if (a) qUrl = 'https://x.com' + a.getAttribute('href');
          const nm = wrap.querySelector('[data-testid="User-Name"]');
          if (nm) {
            const t = (nm.innerText || '').trim();
            const ls = t.split('\n').map((s) => s.trim()).filter(Boolean);
            qName = ls.length ? ls[0] : null;
            const hm = t.match(/@([A-Za-z0-9_]{1,20})/);
            qHandle = hm ? hm[1] : null;
          }
        }
        quoted = {
          url: qUrl,
          author_name: qName,
          author_handle: qHandle,
          text: qn.innerText || qn.textContent || '',
        };
      }

      let replyTo = null;
      const divs = art.querySelectorAll('div');
      for (const d of divs) {
        if (insideQuote(d, art)) continue;
        const t = (d.textContent || '').trim();
        if (!t || t.length > 240) continue;
        if (/^(Replying to|回复|回覆)/i.test(t)) {
          const hs = Array.prototype.slice.call(d.querySelectorAll('a'))
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => h.charAt(0) === '/' && h.indexOf('/status/') < 0);
          const names = hs.map((h) => '@' + h.slice(1).split('/')[0]).filter(Boolean);
          replyTo = names.length
            ? names
            : (t.replace(/^(Replying to|回复|回覆)\s*/i, '').match(/@[A-Za-z0-9_]+/g) || []);
          if (replyTo && replyTo.length) break;
          replyTo = null;
        }
      }
      if (!replyTo && /^@[A-Za-z0-9_]{1,20}\b/.test(text.trim())) {
        const m = text.trim().match(/^@[A-Za-z0-9_]+/);
        if (m) replyTo = [m[0]];
      }

      const media = [];
      const seenMedia = {};
      const photos = art.querySelectorAll('[data-testid="tweetPhoto"] img');
      for (const img of photos) {
        if (insideQuote(img, art)) continue;
        const src = img.getAttribute('src') || img.currentSrc || img.src || '';
        if (!src || src.indexOf('data:') === 0) continue;
        if (src.indexOf('pbs.twimg.com/media') < 0 && src.indexOf('pbs.twimg.com/amplify') < 0
          && src.indexOf('pbs.twimg.com/ext_tw_video_thumb') < 0 && src.indexOf('pbs.twimg.com/tweet_video_thumb') < 0) continue;
        if (seenMedia[src]) continue;
        seenMedia[src] = 1;
        media.push({ type: 'photo', url: src, poster: null, local: null, alt: img.getAttribute('alt') || null });
      }
      const videos = art.querySelectorAll('video');
      for (const v of videos) {
        if (insideQuote(v, art)) continue;
        const poster = v.getAttribute('poster') || null;
        const key = poster || ('video-' + media.length);
        if (seenMedia[key]) continue;
        seenMedia[key] = 1;
        media.push({ type: 'video', url: null, poster, local: null, alt: null });
      }

      let card = null;
      const cardEl = art.querySelector('[data-testid="card.wrapper"]');
      if (cardEl) {
        const a = cardEl.querySelector('a');
        const t = (cardEl.innerText || '').trim();
        const ls = t.split('\n').map((s) => s.trim()).filter(Boolean);
        card = {
          url: a ? a.href : null,
          title: ls.length ? ls[0] : null,
          domain: ls.length > 1 ? ls[ls.length - 1] : null,
        };
      }

      const viewsEl = art.querySelector('a[href*="/analytics"]');
      let views = null;
      if (viewsEl) {
        views = parseCount(viewsEl.getAttribute('aria-label') || '') ;
        if (views == null) views = parseCount((viewsEl.innerText || '').trim());
      }

      const truncated = !!art.querySelector('[data-testid="tweet-text-show-more-link"]');
      const kind = retweetedBy ? 'retweet' : (replyTo ? 'reply' : 'original');

      out.push({
        id,
        url: 'https://x.com' + href,
        author_name: authorName,
        author_handle: authorHandle,
        author_avatar: avatarEl ? (avatarEl.getAttribute('src') || null) : null,
        verified,
        text,
        lang,
        kind,
        retweeted_by: retweetedBy,
        reply_to: replyTo,
        quoted,
        media,
        card,
        metrics: {
          replies: metricOf(art, ['reply']),
          reposts: metricOf(art, ['retweet', 'unretweet']),
          likes: metricOf(art, ['like', 'unlike']),
          views,
        },
        time_iso: timeEl.getAttribute('datetime') || null,
        time_text: (timeEl.textContent || '').trim(),
        truncated,
      });
    } catch (err) {
      /* 单条解析失败不影响其它推文 */
    }
  }
  return out;
}

/**
 * 找出页面里真正在滚动的元素。
 * X 通常滚 document，但有时会把时间线放进内部滚动容器，所以这里自动识别并缓存。
 */
function findScroller() {
  const cached = window.__xScrollerEl;
  if (cached && cached.isConnected && cached.scrollHeight > cached.clientHeight + 200) return cached;

  const se = document.scrollingElement || document.documentElement;
  let found = null;
  if (se && se.scrollHeight > se.clientHeight + 200) {
    found = se;
  } else {
    const divs = document.querySelectorAll('div');
    let best = null;
    for (let i = 0; i < divs.length; i += 1) {
      const d = divs[i];
      let oy = '';
      try { oy = window.getComputedStyle(d).overflowY || ''; } catch (err) { oy = ''; }
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      if (d.scrollHeight <= d.clientHeight + 200) continue;
      if (!best || d.clientHeight > best.clientHeight) best = d;
    }
    found = best || se;
  }
  try { window.__xScrollerEl = found; } catch (err) { /* ignore */ }
  return found;
}

/** 页面滚动状态 + 是否到底 + 是否有加载指示 */
function pageScrollInfo() {
  const el = __xFindScroller();
  const st = el.scrollTop || 0;
  const sh = el.scrollHeight || 0;
  const ch = el.clientHeight || window.innerHeight || 0;
  return {
    scrollTop: st,
    scrollHeight: sh,
    clientHeight: ch,
    innerHeight: window.innerHeight || 0,
    articles: document.querySelectorAll('article[data-testid="tweet"]').length,
    atBottom: sh > 0 ? (st + ch >= sh - 40) : false,
    spinner: !!document.querySelector('[role="progressbar"]'),
    scrollerIsWindow: el === (document.scrollingElement || document.documentElement),
  };
}

/** 展开被折叠的长推文（X 自己的"显示更多"按钮，带 data-testid，不受界面语言影响） */
function pageExpandLongText() {
  const links = document.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
  let n = 0;
  for (const el of links) {
    try { el.click(); n += 1; } catch (err) { /* ignore */ }
  }
  return n;
}

/**
 * 危险信号检查：只看 X 自己的界面提示（toast / alert），并且把推文正文从 body 文本里剔除，
 * 避免某条推文里恰好写了"rate limit"之类的词造成误判。
 */
function pageCheckStop() {
  const hits = [];

  // 只取 X 自己的界面文字：优先看 toast/弹窗，其次遍历文本节点并跳过
  // 推文正文、脚本、样式 —— 否则某条推文里恰好写了"rate limit"就会被误判成限流。
  function pickChromeText() {
    const toast = Array.prototype.slice
      .call(document.querySelectorAll('[data-testid="toast"], [role="alert"], [role="dialog"]'))
      .map((e) => (e.innerText || e.textContent || '').trim())
      .join('\n');
    if (toast) return toast;

    const skip = (el) => !!(el && el.closest && el.closest(
      'article[data-testid="tweet"], [data-testid="tweetText"], script, style, noscript, template, textarea',
    ));
    const chunks = [];
    let total = 0;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        if (!skip(node.parentElement)) {
          const t = (node.nodeValue || '').trim();
          if (t) {
            chunks.push(t);
            total += t.length;
            if (total > 20000) break;
          }
        }
        node = walker.nextNode();
      }
    } catch (err) { /* 取不到就算了，宁可少判也不误判 */ }
    return chunks.join('\n');
  }

  const chromeText = pickChromeText();

  const rules = [
    { re: /rate limit exceeded|you are rate limited|已达到速率限制|速率限制/i, reason: 'X 提示达到速率限制' },
    { re: /something went wrong\.?\s*(try reloading|try again)?/i, reason: 'X 页面报错（Something went wrong）' },
    { re: /出错了|出现问题|发生错误/i, reason: 'X 页面报错' },
    { re: /account is suspended|账号已被冻结|账号被封禁/i, reason: 'X 提示账号被冻结' },
    { re: /verify (you are|it's you|your identity)|确认你是真人|人机验证|进行验证/i, reason: 'X 要求人机验证' },
    { re: /too many requests|请求过于频繁/i, reason: 'X 提示请求过于频繁' },
  ];
  for (const r of rules) {
    if (r.re.test(chromeText)) hits.push(r.reason);
  }

  const retryBtn = Array.prototype.slice.call(document.querySelectorAll('[role="button"], button'))
    .find((b) => /^(Retry|重试|重新加载)$/.test(((b.innerText || b.textContent || '').trim())));

  const loggedIn = !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
    || !!document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
  // 只有真的看到"登录入口"才算退出登录；看不到账号按钮不等于登出（可能是页面还在加载）
  const loginEntry = document.querySelector(
    '[data-testid="loginButton"], a[href="/login"], a[href^="/i/flow/login"]',
  );
  const loggedOut = !!loginEntry || /^\/(i\/flow\/)?login/.test(location.pathname || '');

  return {
    stop: hits.length > 0,
    reasons: hits,
    retryVisible: !!retryBtn,
    loggedIn,
    loggedOut,
    sample: chromeText.slice(0, 300),
  };
}

/** 点掉 X 的"重试"按钮（偶发的加载失败） */
function pageClickRetry() {
  const btn = Array.prototype.slice.call(document.querySelectorAll('[role="button"], button'))
    .find((b) => /^(Retry|重试|重新加载)$/.test(((b.innerText || b.textContent || '').trim())));
  if (btn) { try { btn.click(); return true; } catch (err) { return false; } }
  return false;
}

const PRELUDE = `const __xFindScroller = ${findScroller.toString()};`;
const wrap = (fn) => `(() => { ${PRELUDE} return (${fn.toString()})(); })()`;

module.exports = {
  EXTRACT: wrap(pageExtract),
  SCROLL_INFO: wrap(pageScrollInfo),
  EXPAND: wrap(pageExpandLongText),
  CHECK_STOP: wrap(pageCheckStop),
  CLICK_RETRY: wrap(pageClickRetry),
  /** 后备方案：滚轮事件没生效时，直接改滚动容器的 scrollTop */
  scrollByExpr: (delta) => `(() => { ${PRELUDE} const el = __xFindScroller(); el.scrollTop = el.scrollTop + (${Number(delta) || 0}); return el.scrollTop; })()`,
};
