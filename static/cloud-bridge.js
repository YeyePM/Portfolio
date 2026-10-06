/*!
 * 云服务桥接层 —— 叶烨作品集 / 大促分配推演台
 * ---------------------------------------------------------------------------
 * 职责：加载 WorkBuddy 云 SDK、初始化客户端、写入「访问记录」与「演示记录」、
 *       读取统计。四个页面（portfolio / audit-console / merchant-portal / index）
 *       共用这一份，页面侧只调 WBCX.*。
 *
 * 三条硬约定：
 *   1) 只用 publicConfig 里的 endpoint + publishableKey。这两个值本身就是公开的：
 *      publishableKey 只声明「属于哪个应用」，真正的门禁是服务端「Origin 精确匹配
 *      + 数据库 RLS」。任何长效密钥都不许进前端。
 *   2) 云服务不可用（断网 / 被墙 / 被拦截）时一律静默降级：页面照常可用，
 *      连一条报错都不往用户脸上弹，只在 console 留一行 warn。
 *   3) 访问记录 / 演示记录都是「游客可写」的表（不需要登录），因此绝不携带 owner_id，
 *      表侧由 WITH CHECK (true) 放行、长度 CHECK 兜底防刷。
 * ---------------------------------------------------------------------------
 * 暴露：window.WBCX
 *   WBCX.ready(fn)                     云就绪后回调 fn(client)；未就绪/失败则不回调
 *   WBCX.onStatus(fn)                  状态变化订阅：'loading'|'ready'|'unavailable'
 *   WBCX.status                        当前状态
 *   WBCX.visitorId()                   本机访客 ID（localStorage 持久化）
 *   WBCX.recordDemo(key, title, opt)   写入一条演示记录（opt: {action, detail}）
 *   WBCX.getStats()                    聚合统计 -> {total_visits, unique_visitors, ...}
 *   WBCX.getRecentDemos(n)             最近 n 条演示记录
 *   WBCX.getRecentVisits(n)            最近 n 条访问记录
 */
(function (global) {
  'use strict';

  /* ── 1. 公开配置（来自云服务开通结果 publicConfig，非猜测值）────────────── */
  var CONFIG = {
    endpoint: 'https://e4c0fdd067fd4093a62990e14e8ea091.app.workbuddy.host',
    publishableKey: 'wbpk_061NsT1nQ894uQUnF32t3E_Gl82oLslH1VRVEjZ6vpEKe3OdrnuqFbn'
  };

  /* 本文件自己的 <script> 标签 —— 用来把 SDK 副本定位到「与本文件同级的 vendor/」。
     这样同一份 cloud-bridge.js 既能跑在 FastAPI 的 /static/ 下，也能直接扔在
     GitHub Pages 的 <repo>/static/ 下，不必为不同站点维护两版。
     ⚠️ 必须在同步执行期取（currentScript 只在初始求值时可靠），所以放在最外层。

     顺带支持一个通用开关：给本标签加 data-no-visit="1" 的页面不写访问记录
     （数据看板这类自用页，自己刷新不该污染访客数据）。 */
  function findSelfTag() {
    try {
      var cur = global.document.currentScript;
      if (cur && cur.src && /cloud-bridge\.js(\?|#|$)/.test(cur.src)) return cur;
      var tags = global.document.getElementsByTagName('script');
      for (var i = tags.length - 1; i >= 0; i--) {
        if (tags[i].src && /cloud-bridge\.js(\?|#|$)/.test(tags[i].src)) return tags[i];
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  var SELF_TAG = findSelfTag();
  var SELF_SRC = (SELF_TAG && SELF_TAG.src) || '';
  var NO_VISIT = !!(SELF_TAG && SELF_TAG.getAttribute && SELF_TAG.getAttribute('data-no-visit'));

  /* SDK 本地副本优先：国内直连 jsdelivr 不稳，断网时至少还能加载本地这一份。
     本地副本被删 / 加载失败时，再回退到官方 CDN（@dev 通道，不锁版本）。 */
  var LOCAL_SDK = SELF_SRC
    ? SELF_SRC.replace(/cloud-bridge\.js[^/]*$/, 'vendor/workbuddy-cloud.global.js')
    : '/static/vendor/workbuddy-cloud.global.js';
  var CDN_SDK = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

  var VISITOR_KEY = 'wbx.visitor_id';
  var VISIT_TTL_MS = 20 * 60 * 1000;   // 同一页面 20 分钟内只记一次，防刷新刷量

  /* ── 2. 小工具 ─────────────────────────────────────────────────────────── */
  function trunc(v, n) {
    if (v === null || v === undefined) return null;
    var s = String(v);
    return s.length > n ? s.slice(0, n) : s;
  }

  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* 隐私模式：忽略 */ } }
  function ssGet(k) { try { return global.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }

  function warn(msg, err) {
    if (global.console && console.warn) console.warn('[WBCX] ' + msg, err || '');
  }

  /* ── 3. SDK 加载 + 客户端初始化 ────────────────────────────────────────── */
  var status = 'loading';       // loading | ready | unavailable
  var client = null;
  var waiters = [];             // ready 前的回调队列
  var statusFns = [];           // 状态订阅者
  var visitPromise = Promise.resolve(false);   // 「本次访问是否已落库」

  function setStatus(s) {
    if (status === s) return;
    status = s;
    for (var i = 0; i < statusFns.length; i++) {
      try { statusFns[i](s); } catch (e) { /* 订阅者自己的锅自己背 */ }
    }
  }

  function injectScript(src, ok, fail) {
    var done = false;
    var s = global.document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = function () { if (!done) { done = true; ok(); } };
    s.onerror = function () { if (!done) { done = true; fail(); } };
    global.document.head.appendChild(s);
  }

  function loadSdk(ok, fail) {
    if (global.WorkBuddyCloud && global.WorkBuddyCloud.createWorkBuddyCloud) return ok();
    // 本地副本 → 官方 CDN，两级兜底
    injectScript(LOCAL_SDK, ok, function () {
      warn('本地 SDK 副本加载失败，回退官方 CDN');
      injectScript(CDN_SDK, ok, fail);
    });
  }

  function boot() {
    if (!global.WorkBuddyCloud || !global.WorkBuddyCloud.createWorkBuddyCloud) {
      setStatus('unavailable');
      warn('云 SDK 未加载（本地与 CDN 均失败），云功能已静默关闭');
      return;
    }
    try {
      client = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CONFIG.endpoint,
        publishableKey: CONFIG.publishableKey
      });
    } catch (e) {
      setStatus('unavailable');
      warn('云客户端初始化失败', e);
      return;
    }
    // 顺序要紧：先把「这次访问已落库」的 Promise 挂上，再放行 ready 回调。
    // 否则页面读统计会跑在写访问前面，首批数字永远比实际少一条。
    try { visitPromise = logVisit(); } catch (e) { visitPromise = Promise.resolve(false); }
    setStatus('ready');
    var fns = waiters; waiters = [];
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](client); } catch (e) { warn('ready 回调异常', e); }
    }
  }

  /* ── 4. 访客标识 ───────────────────────────────────────────────────────── */
  var _vid = null;
  function visitorId() {
    if (_vid) return _vid;
    var v = lsGet(VISITOR_KEY);
    if (!v || typeof v !== 'string' || v.length < 6 || v.length > 64) {
      v = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      lsSet(VISITOR_KEY, v);
    }
    _vid = v;
    return v;
  }

  function screenSize() {
    try {
      if (global.screen && global.screen.width) return screen.width + 'x' + screen.height;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /* ── 5. 访问记录 ───────────────────────────────────────────────────────── */
  function logVisit() {
    // 自带 data-no-visit="1" 的页面（数据看板这类自用页）不记访问
    if (NO_VISIT) return Promise.resolve(false);

    // 页脚那个预热 iframe（隐藏、0 尺寸）会去加载推演台，如果不排除，
    // 每次有人看作品集都会顺带多记一条 `/` 的访问 —— 那是机器流量，不是访客。
    try { if (global.top !== global.self) return Promise.resolve(false); } catch (e) { /* 读不到就按顶层算 */ }

    var path = null;
    try { path = global.location.pathname || '/'; } catch (e) { path = null; }
    // 同页面 20 分钟内只记一次
    var stampKey = 'wbx.last_visit:' + path;
    var last = parseInt(ssGet(stampKey) || '0', 10);
    if (last && (Date.now() - last) < VISIT_TTL_MS) return Promise.resolve(false);
    ssSet(stampKey, String(Date.now()));

    var row = {
      visitor_id: visitorId(),
      page: trunc(path, 300),
      referrer: trunc(global.document.referrer || '', 600),
      user_agent: trunc(global.navigator.userAgent || '', 600),
      screen: trunc(screenSize(), 40),
      lang: trunc(global.navigator.language || '', 40)
    };
    return send(function () {
      return client.database.from('portfolio_visits').insert(row).select();
    }, '写入访问记录');
  }

  /* 统一写入口：吞掉一切异常，任何失败都不影响页面。
     永远返回 Promise（resolve 布尔值：是否真的写成功），绝不 reject。 */
  function send(run, what) {
    if (!client) return Promise.resolve(false);
    var p;
    try { p = run(); } catch (e) { warn(what + '调用异常', e); return Promise.resolve(false); }
    if (!p || typeof p.then !== 'function') return Promise.resolve(false);
    return p.then(function (res) {
      if (res && res.error) {
        warn(what + '失败：' + (res.error.message || res.error.code || ''));
        return false;
      }
      return true;
    }, function (e) {
      warn(what + '失败', e);
      return false;
    });
  }

  /* ── 6. 演示记录 ───────────────────────────────────────────────────────── */
  function recordDemo(key, title, opt) {
    opt = opt || {};
    var row = {
      visitor_id: visitorId(),
      demo_key: trunc(key, 64) || 'unknown',
      demo_title: trunc(title, 200),
      action: trunc(opt.action || 'open', 32),
      detail: trunc(opt.detail, 500)
    };
    send(function () {
      return client.database.from('portfolio_demo_records').insert(row).select();
    }, '写入演示记录');
  }

  /* ── 7. 读统计 ─────────────────────────────────────────────────────────── */
  function getStats() {
    if (!client) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return client.database.rpc('portfolio_stats'); })
      .then(function (res) {
        if (res && res.error) { warn('读取统计失败：' + (res.error.message || '')); return null; }
        return res ? res.data : null;
      })
      .catch(function (e) { warn('读取统计失败', e); return null; });
  }

  function getRecentDemos(n) {
    if (!client) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () {
        return client.database.from('portfolio_demo_records')
          .select('demo_key, demo_title, action, detail, created_at, visitor_id')
          .order('created_at', { ascending: false })
          .limit(n || 8);
      })
      .then(function (res) { return (res && !res.error && res.data) ? res.data : []; })
      .catch(function () { return []; });
  }

  function getRecentVisits(n) {
    if (!client) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () {
        return client.database.from('portfolio_visits')
          /* 带上 user_agent：数据看板要用它解析出「设备 / 系统 / 浏览器」。
             作品集那块面板不用它，多带一列无副作用。 */
          .select('page, referrer, screen, lang, user_agent, created_at, visitor_id')
          .order('created_at', { ascending: false })
          .limit(n || 8);
      })
      .then(function (res) { return (res && !res.error && res.data) ? res.data : []; })
      .catch(function () { return []; });
  }

  /* ── 8. 对外接口 ───────────────────────────────────────────────────────── */
  global.WBCX = {
    status: status,
    CONFIG: CONFIG,
    visitorId: visitorId,
    recordDemo: recordDemo,
    getStats: getStats,
    getRecentDemos: getRecentDemos,
    getRecentVisits: getRecentVisits,

    /* 本次访问是否已落库（Promise，resolve 布尔值，永不 reject）。
       读统计前先等它，避免「写访问」和「读统计」并发导致首批数字少一条。 */
    whenVisitLogged: function () { return visitPromise; },

    ready: function (fn) {
      if (typeof fn !== 'function') return;
      if (status === 'ready') { try { fn(client); } catch (e) { warn('ready 回调异常', e); } return; }
      if (status === 'unavailable') return;      // 不可用：不回调，页面走降级分支
      waiters.push(fn);
    },

    onStatus: function (fn) {
      if (typeof fn !== 'function') return;
      statusFns.push(fn);
      if (status !== 'loading') { try { fn(status); } catch (e) { /* 忽略 */ } }
    },

    /* 状态是异步确定的，所以每次读都同步一份到属性上 */
    isReady: function () { return status === 'ready'; }
  };

  // 让 WBCX.status 始终反映真实状态
  statusFns.push(function (s) { global.WBCX.status = s; });

  /* ── 9. 启动 ─────────────────────────────────────────────────────────────
     必须放在最后、且用 setTimeout 推迟一拍：若页面已经用 <script> 直接引过
     SDK 副本，loadSdk 会同步回调，boot() 就会赶在 WBCX / waiters 注册之前跑完，
     首访记录会整个丢掉。异步化 + 后置，两种情况行为一致。 */
  loadSdk(function () {
    setTimeout(boot, 0);
  }, function () {
    setTimeout(function () {
      setStatus('unavailable');
      warn('云 SDK 加载失败，云功能已静默关闭');
    }, 0);
  });
})(window);
