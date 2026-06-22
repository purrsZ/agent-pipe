/* ══════════════════════════════════════════════════════════════
   需求批阅台 v2 · 共享脚本
   职责（走查结论主题一/七）：
   1) 统一 open-wait 队列 —— 唯一真相源 + 计数函数；看板徽标 / 工作台 / 顶栏铃铛共用，永远一致。
   2) go(page) 跨页导航 + 面包屑（记来路，返回回到正确位置）。
   3) asyncAction 异步三态（R06：已收到处理中 / 成功 / 失败重试）。
   4) undoBar 撤销浮条（B2：打回 10s 可撤销 / 通用操作回执）。
   5) toast 轻提示。
   纯静态原型：无后端，队列在内存 + localStorage，模拟"唯一源"的一致性。
   ══════════════════════════════════════════════════════════════ */
((global) => {
  /* ────────────────────────────────────────────────
     一、统一 open-wait 队列（唯一计数源）
     —— 一条「等你」= 一个 wait 项。两类严重度：
        gate = 关卡级（不处理则整件停，朱印红）
        soft = 取舍级（不急·其余照跑，琥珀）
     —— 所有计数（看板需求卡徽标 / 工作台焦点队列 / 顶栏铃铛）
        都派生自这一个数组，绝不各算各的。
     ──────────────────────────────────────────────── */

  // 演示用种子数据：跨需求的全部「等你」项。
  // reqId 关联到具体需求；sev 决定分级；href 决定点击直达哪个页面。
  var SEED_WAITS = [
    {
      id: 'w-fav-light2',
      reqId: 'fav',
      reqTitle: '商品收藏',
      sev: 'gate', // 关卡级：灯②审设计，不批则整件停
      kind: '灯②·审详细设计',
      title: '审「商品收藏」详细设计',
      summary: '快拍定方向 + 钉接口合同，不处理则整件停在审设计',
      href: 'review.html?id=fav',
      cta: '去批阅',
    },
    {
      id: 'w-coupon-unit',
      reqId: 'coupon',
      reqTitle: '优惠券改版',
      sev: 'soft', // 取舍级：传分还是元，其余照跑
      kind: '中途取舍',
      title: '券面额传「分」还是「元」',
      summary: '并行中冒出的跨端口径取舍，不急·其余端照常跑',
      href: 'workitem.html?id=coupon#wait-unit',
      cta: '去定夺',
    },
    {
      id: 'w-coupon-ui',
      reqId: 'coupon',
      reqTitle: '优惠券改版',
      sev: 'soft', // 取舍级：UI 待你调，原 v1 藏在工人面板漏掉，现进队列
      kind: '中途取舍',
      title: 'Web 优惠券列表页 UI 待你调',
      summary: '工人搭好骨架等你给视觉口径，不急·不挡其它端',
      href: 'workitem.html?id=coupon#wait-ui',
      cta: '去看看',
    },
  ];

  var STORE_KEY = 'reqdesk.waits.v2';

  function loadWaits() {
    try {
      var raw = global.localStorage && localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* localStorage 不可用时退化为内存 */
    }
    return SEED_WAITS.slice();
  }
  function saveWaits(list) {
    try {
      if (global.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (e) {
      /* 忽略 */
    }
  }

  var WaitQueue = {
    _list: loadWaits(),

    /** 全部「等你」项（可选按 reqId 过滤） */
    all: function (reqId) {
      return reqId ? this._list.filter((w) => w.reqId === reqId) : this._list.slice();
    },
    /** 唯一计数函数：count() 跨需求总数；count(reqId) 单需求；count(reqId,'gate') 单需求某级 */
    count: function (reqId, sev) {
      return this._list.filter((w) => (!reqId || w.reqId === reqId) && (!sev || w.sev === sev))
        .length;
    },
    /** 关卡级数量（跨需求或单需求）—— 用于"几件不处理则停" */
    gateCount: function (reqId) {
      return this.count(reqId, 'gate');
    },
    softCount: function (reqId) {
      return this.count(reqId, 'soft');
    },
    /** 涉及几个不同需求有等你项 */
    reqCount: function () {
      var s = {};
      this._list.forEach((w) => {
        s[w.reqId] = 1;
      });
      return Object.keys(s).length;
    },
    /** 消解一项（拍板后从唯一源移除，三处计数同步刷新） */
    resolve: function (id) {
      this._list = this._list.filter((w) => w.id !== id);
      saveWaits(this._list);
      WaitQueue._emit();
      return this;
    },
    /** 新增一项（如临时冒出大改卡）*/
    add: function (w) {
      if (!this._list.some((x) => x.id === w.id)) {
        this._list.push(w);
        saveWaits(this._list);
        this._emit();
      }
      return this;
    },
    /** 重置为种子（演示用，URL 带 ?reset 时调用） */
    reset: function () {
      this._list = SEED_WAITS.slice();
      saveWaits(this._list);
      this._emit();
      return this;
    },
    /** 排序：关卡级在前，再按原顺序（急缓） */
    sorted: function (reqId) {
      return this.all(reqId).sort((a, b) => {
        if (a.sev === b.sev) return 0;
        return a.sev === 'gate' ? -1 : 1;
      });
    },
    // ── 订阅：任一处变更，三处计数 UI 自动同步 ──
    _subs: [],
    onChange: function (fn) {
      this._subs.push(fn);
      return this;
    },
    _emit: function () {
      this._subs.forEach((fn) => {
        try {
          fn();
        } catch (e) {}
      });
    },
  };

  /**
   * 把铃铛徽标 / 任意 [data-wait-count] 元素刷成与唯一源一致。
   * data-wait-count 可选 data-wait-req（限某需求）、data-wait-sev（限某级）。
   */
  function syncCounts() {
    // 顶栏铃铛
    var bell = document.querySelector('[data-bell]');
    if (bell) {
      var n = WaitQueue.count();
      var bdg = bell.querySelector('.bdg');
      if (bdg) {
        bdg.textContent = n;
        bdg.classList.toggle('zero', n === 0);
      }
      bell.classList.toggle('has', n > 0);
    }
    // 任意计数挂载点
    document.querySelectorAll('[data-wait-count]').forEach((el) => {
      var req = el.getAttribute('data-wait-req') || null;
      var sev = el.getAttribute('data-wait-sev') || null;
      el.textContent = WaitQueue.count(req, sev);
    });
    // 渲染铃铛下拉列表（若存在）
    renderBellPop();
  }

  /** 渲染顶栏铃铛下拉的跨需求等你清单 */
  function renderBellPop() {
    var pop = document.querySelector('[data-bell-pop]');
    if (!pop) return;
    var body = pop.querySelector('.bp-body');
    var ct = pop.querySelector('.bp-head .ct');
    var list = WaitQueue.sorted();
    if (ct) ct.textContent = list.length + ' 件';
    if (!body) return;
    if (!list.length) {
      body.innerHTML = '<div class="bp-empty">没有等你的事，安心。</div>';
      return;
    }
    body.innerHTML = list
      .map(
        (w) =>
          '<div class="bp-item" onclick="ReqDesk.go(\'' +
          w.href +
          '\')">' +
          '<span class="sev ' +
          w.sev +
          '"></span>' +
          '<div class="bp-c">' +
          '<div class="bp-t">' +
          escapeHtml(w.title) +
          '</div>' +
          '<div class="bp-s">' +
          escapeHtml(w.summary) +
          '</div>' +
          '<div class="bp-req">' +
          escapeHtml(w.reqTitle) +
          ' · ' +
          escapeHtml(w.kind) +
          '</div>' +
          '</div></div>',
      )
      .join('');
  }

  function toggleBellPop() {
    var pop = document.querySelector('[data-bell-pop]');
    if (pop) pop.classList.toggle('show');
  }
  // 点击空白关闭铃铛下拉
  document.addEventListener('click', (e) => {
    var pop = document.querySelector('[data-bell-pop]');
    if (!pop || !pop.classList.contains('show')) return;
    if (!e.target.closest('[data-bell]') && !e.target.closest('[data-bell-pop]')) {
      pop.classList.remove('show');
    }
  });

  /* ────────────────────────────────────────────────
     二、跨页导航 + 面包屑（记来路）
     —— go(href) 跳页前把当前页压入来路栈；
        backOne() 弹栈返回，回到正确位置（修 B6 返回回错地方）。
     ──────────────────────────────────────────────── */
  var TRAIL_KEY = 'reqdesk.trail.v2';
  function getTrail() {
    try {
      return JSON.parse(sessionStorage.getItem(TRAIL_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function setTrail(t) {
    try {
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(t));
    } catch (e) {}
  }

  /** 跳转到某页，记下来路 */
  function go(href) {
    var trail = getTrail();
    var here = location.pathname.split('/').pop() + location.search;
    // 避免连续重复入栈
    if (trail[trail.length - 1] !== here) trail.push(here);
    if (trail.length > 12) trail = trail.slice(-12);
    setTrail(trail);
    location.href = href;
  }

  /** 返回上一来路（无来路则回看板 index.html） */
  function backOne() {
    var trail = getTrail();
    var prev = trail.pop();
    setTrail(trail);
    location.href = prev || 'index.html';
  }

  /**
   * 渲染面包屑到 [data-crumbs] 容器。
   * 用法：ReqDesk.crumbs([{label:'看板',href:'index.html'},{label:'商品收藏',href:'workitem.html?id=fav'},{label:'对接合同'}])
   * 最后一项无 href = 当前页（不可点）。
   */
  function crumbs(items) {
    var host = document.querySelector('[data-crumbs]');
    if (!host) return;
    host.innerHTML = items
      .map((it, i) => {
        var last = i === items.length - 1;
        var sep = i > 0 ? '<span class="sep">/</span>' : '';
        if (last || !it.href) {
          return sep + '<span class="cur">' + escapeHtml(it.label) + '</span>';
        }
        return (
          sep +
          '<button onclick="ReqDesk.go(\'' +
          it.href +
          '\')">' +
          escapeHtml(it.label) +
          '</button>'
        );
      })
      .join(' ');
  }

  /** 读取 URL 上的需求 id（review/workitem 参数化用） */
  function reqId() {
    var m = location.search.match(/[?&]id=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* ────────────────────────────────────────────────
     三、异步三态（R06）—— 已收到处理中 / 成功 / 失败重试
     不再瞬时假完成（防重复点击两端打架）。
     用法：ReqDesk.asyncAction(btn, {
       pending:'已收到·处理中', ok:'已拍板', fail:'未成功',
       run:function(done){ ... done(true|false) },  // done(true)=成功
       onOk:function(){...}                           // 成功后回调（如消解 wait）
     });
     fail 态可点重试（再次跑 run）。
     ──────────────────────────────────────────────── */
  function asyncAction(triggerEl, opts) {
    opts = opts || {};
    var host = triggerEl.closest('.async-host') || triggerEl.parentElement;
    // 复用或新建状态条
    var stateEl = host.querySelector('.async-state');
    if (!stateEl) {
      stateEl = document.createElement('span');
      stateEl.className = 'async-state';
      host.appendChild(stateEl);
    }

    function showPending() {
      triggerEl.style.display = 'none';
      stateEl.className = 'async-state pending show';
      stateEl.innerHTML = '<span class="as-spin"></span>' + (opts.pending || '已收到·处理中…');
      stateEl.onclick = null;
      // 模拟异步：默认 1.1s，opts.delay 可覆盖；opts.fail=true 演示失败
      var ms = opts.delay != null ? opts.delay : 1100;
      var runner =
        opts.run ||
        ((done) => {
          setTimeout(() => {
            done(!opts.fail);
          }, ms);
        });
      runner((success) => {
        if (success) showOk();
        else showFail();
      });
    }
    function showOk() {
      stateEl.className = 'async-state ok show';
      stateEl.innerHTML = '✓ ' + (opts.ok || '已完成');
      stateEl.onclick = null;
      if (opts.onOk) opts.onOk();
      if (opts.okFade !== false) {
        setTimeout(
          () => {
            stateEl.classList.remove('show');
          },
          opts.okHold != null ? opts.okHold : 2200,
        );
      }
    }
    function showFail() {
      stateEl.className = 'async-state fail show';
      stateEl.innerHTML =
        (opts.fail_ || opts.failText || '未成功') + ' · <span class="retry">点此重试</span>';
      stateEl.onclick = () => {
        showPending();
      }; // 重试
      if (opts.onFail) opts.onFail();
    }

    showPending();
  }

  /* ────────────────────────────────────────────────
     四、撤销浮条（B2：打回 10s 可撤销 / 通用操作回执）
     用法：ReqDesk.undoBar({
       msg:'已打回「商品收藏」设计',
       seconds:10,
       onUndo:function(){...},      // 点撤销
       onExpire:function(){...}     // 倒计时走完真正落地
     });
     ──────────────────────────────────────────────── */
  var _undoTimer = null;
  function undoBar(opts) {
    opts = opts || {};
    var secs = opts.seconds || 10;
    var bar = document.querySelector('[data-undobar]');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'undobar';
      bar.setAttribute('data-undobar', '');
      document.body.appendChild(bar);
    }
    clearTimeout(_undoTimer);
    bar.innerHTML =
      '<div class="ub-msg">' +
      (opts.msg || '已操作') +
      '</div>' +
      '<button class="ub-undo">撤销（' +
      secs +
      's）</button>' +
      '<span class="ub-timer" style="animation-duration:' +
      secs +
      's"></span>';

    var undone = false;
    function finish(viaUndo) {
      clearTimeout(_undoTimer);
      bar.classList.remove('show');
      if (viaUndo) {
        if (opts.onUndo) opts.onUndo();
      } else {
        if (opts.onExpire) opts.onExpire();
      }
    }
    bar.querySelector('.ub-undo').onclick = () => {
      if (undone) return;
      undone = true;
      finish(true);
    };
    // 强制重排让动画重启
    void bar.offsetWidth;
    bar.classList.add('show');
    _undoTimer = setTimeout(() => {
      if (!undone) finish(false);
    }, secs * 1000);
    return bar;
  }

  /* ────────────────────────────────────────────────
     五、toast（v1 原样保留）
     ──────────────────────────────────────────────── */
  var _toastTimer = null;
  function toast(msg) {
    var t = document.querySelector('[data-toast]');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      t.setAttribute('data-toast', '');
      document.body.appendChild(t);
    }
    t.innerHTML = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      t.classList.remove('show');
    }, 2600);
  }

  /* ────────────────────────────────────────────────
     六、朱印盖章（v1 approve 动画，复用到各灯通过）
     ──────────────────────────────────────────────── */
  function stamp(glyph, after) {
    var ov = document.querySelector('[data-seal]');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'seal-overlay';
      ov.setAttribute('data-seal', '');
      ov.innerHTML = '<div class="big-seal"></div>';
      document.body.appendChild(ov);
    }
    var s = ov.querySelector('.big-seal');
    s.textContent = glyph || '准';
    s.style.animation = 'none';
    void s.offsetWidth;
    s.style.animation = '';
    ov.classList.add('show');
    setTimeout(() => {
      ov.classList.remove('show');
      if (after) after();
    }, 1150);
  }

  /* ──────────────── 工具 ──────────────── */
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  /* ──────────────── 初始化 ──────────────── */
  function init() {
    // URL 带 ?reset 清演示数据（方便走查从头看）
    if (/[?&]reset/.test(location.search)) WaitQueue.reset();
    // 队列变更 → 三处计数自动同步（唯一源驱动）
    WaitQueue.onChange(syncCounts);
    syncCounts();
    // 顶栏铃铛点击
    var bell = document.querySelector('[data-bell]');
    if (bell)
      bell.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBellPop();
      });
    // 品牌区点回看板
    var brand = document.querySelector('[data-home]');
    if (brand)
      brand.addEventListener('click', () => {
        go('index.html');
      });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ──────────────── 对外暴露 ──────────────── */
  global.ReqDesk = {
    waits: WaitQueue,
    syncCounts: syncCounts,
    renderBellPop: renderBellPop,
    toggleBellPop: toggleBellPop,
    go: go,
    backOne: backOne,
    crumbs: crumbs,
    reqId: reqId,
    asyncAction: asyncAction,
    undoBar: undoBar,
    toast: toast,
    stamp: stamp,
  };
  // 常用快捷别名（页面内联调用更短）
  global.go = go;
  global.toast = toast;
})(window);
