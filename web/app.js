/* =============================================================================
 * 麦麦同席 · 前端主程序（原生 JS，无构建、无依赖）
 *
 * 分区：
 *   0. 工具函数      escapeHtml / 金额格式化 / 时间 / DOM
 *   1. API 层        只走 /api/*，不直连 MCP
 *   2. 状态          单一 state 对象 + 状态机辅助
 *   3. 渲染器        门店 / 成员 / 餐桌 / 方案 / 分账 / 菜单 / 票根
 *   4. 步骤控制器     五步流程、复算、确认、票根
 *   5. 启动          健康检查、恢复上次聚餐、全局事件
 *
 * 约定：金额在接口里一律是「分」，只在展示层除以 100。
 * ========================================================================== */
'use strict';

(function () {

  /* ========================================================================
   * 0. 工具函数
   * ===================================================================== */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** 转义所有插入 innerHTML 的动态文本（昵称、事由、餐品名、接口文案） */
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }
  var esc = escapeHtml;

  /** 分 → ¥xx.xx */
  function money(cents) {
    var n = Number(cents);
    if (!isFinite(n)) return '¥—';
    return '¥' + (n / 100).toFixed(2);
  }

  /** 元 → ¥xx.xx（共同预算、个人预算用元） */
  function moneyYuan(yuan) {
    var n = Number(yuan);
    if (!isFinite(n)) return '¥—';
    return '¥' + n.toFixed(2);
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function fmtTime(raw) {
    if (!raw) return '—';
    var s = String(raw).replace('T', ' ');
    // 只保留到分钟
    var m = s.match(/^(\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2})/);
    return m ? m[1] : s;
  }

  function isTyping() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function icon(name, cls) {
    return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  var MEMBER_PALETTE = ['#DA291C', '#2F6B46', '#B5761E', '#6D4A9B', '#1F6F8B', '#A8432B', '#6F6A1F', '#8C3B5E'];

  function memberColor(index) {
    return MEMBER_PALETTE[index % MEMBER_PALETTE.length];
  }

  function initialOf(name) {
    var s = String(name || '?').trim();
    return s ? s.slice(0, 1) : '?';
  }

  function colorForMember(memberId) {
    var list = state.members && state.members.length ? state.members : (state.party && state.party.members) || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === memberId) idx = i;
    if (idx < 0) return 'var(--ink-3)';
    return memberColor(idx);
  }

  /** 统一的错误文案提取 */
  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  /* ========================================================================
   * 1. API 层
   * ===================================================================== */

  var REQUEST_TIMEOUT = 45000;

  function request(method, path, body, extraHeaders) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT);
    var opts = { method: method, headers: extraHeaders || {}, signal: ctrl.signal };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch (e) { throw new Error('接口返回的不是 JSON（HTTP ' + res.status + '）'); }
        }
        if (!res.ok) {
          var msg = (data && data.error && data.error.message) || ('请求失败 HTTP ' + res.status);
          throw new Error(msg);
        }
        if (data && data.ok === false) {
          throw new Error((data.error && data.error.message) || '接口返回失败');
        }
        return data || {};
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时（' + (REQUEST_TIMEOUT / 1000) + ' 秒），后端可能未启动');
      throw err;
    }).then(function (data) {
      clearTimeout(timer);
      return data;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  var API = {
    health: function () { return request('GET', '/api/health'); },
    stores: function (city, keyword, beType) {
      return request('POST', '/api/stores', { city: city, keyword: keyword, beType: beType });
    },
    menu: function (storeCode, beType) {
      return request('GET', '/api/menu?storeCode=' + encodeURIComponent(storeCode) + '&beType=' + encodeURIComponent(beType));
    },
    createParty: function (payload) { return request('POST', '/api/party', payload); },
    getParty: function (id) { return request('GET', '/api/party/' + encodeURIComponent(id)); },
    updateParty: function (id, payload) { return request('PUT', '/api/party/' + encodeURIComponent(id), payload); },
    plans: function (id) { return request('POST', '/api/party/' + encodeURIComponent(id) + '/plans', {}); },
    recalc: function (id, payload) { return request('POST', '/api/party/' + encodeURIComponent(id) + '/recalc', payload); },
    confirm: function (id, planId) { return request('POST', '/api/party/' + encodeURIComponent(id) + '/confirm', { planId: planId }); },
    complete: function (id, completed) { return request('POST', '/api/party/' + encodeURIComponent(id) + '/complete', { completed: !!completed }); },
    getTicket: function (id) { return request('GET', '/api/party/' + encodeURIComponent(id) + '/ticket'); },
    makeTicket: function (id, options) { return request('POST', '/api/party/' + encodeURIComponent(id) + '/ticket', options); },
    parties: function () { return request('GET', '/api/parties'); },
    /* --- P1：口味偏好（逐人授权） --- */
    savePreferences: function (id, members) {
      return request('POST', '/api/party/' + encodeURIComponent(id) + '/preferences', { members: members });
    },
    preferenceGroups: function () { return request('GET', '/api/preferences'); },
    revisit: function (groupId, payload) {
      return request('POST', '/api/preferences/' + encodeURIComponent(groupId) + '/revisit', payload);
    },
    deletePreference: function (groupId) {
      return request('DELETE', '/api/preferences/' + encodeURIComponent(groupId));
    },
    /* --- P1：真实订单只读关联 --- */
    orders: function () { return request('GET', '/api/orders'); },
    linkOrder: function (id, orderId) {
      return request('POST', '/api/party/' + encodeURIComponent(id) + '/link-order', { orderId: orderId });
    },
    // 破坏性接口要求自定义头：跨站页面无法在不触发预检的情况下带上它，
    // 从而挡住「任意网页偷偷调 localhost 清空数据」（后端会校验 X-Mmtx-Confirm）
    cleanup: function (scope) {
      return request('POST', '/api/cleanup', { scope: scope || 'all' }, { 'X-Mmtx-Confirm': '1' });
    }
  };

  /* ========================================================================
   * 2. 状态
   * ===================================================================== */

  var MAX_CHIPS = 3;
  var TICKET_FIELDS = ['title', 'date', 'members', 'items', 'wishes', 'themeLine', 'photo', 'notes', 'nextMeet', 'status'];
  var FIELD_LABELS = {
    title: '聚餐事由',
    date: '日期',
    members: '成员昵称',
    items: '代表餐品',
    wishes: '小心愿',
    themeLine: '一句主题',
    photo: '合照',
    notes: '每人的话',
    nextMeet: '下次约定',
    status: '状态'
  };

  /** 票根版式：导出像素由版式决定，界面上的小字必须与之一致 */
  var TICKET_LAYOUTS = {
    portrait: { label: '竖版', size: '宽 1080 · 高度随内容', hint: '竖版：宽 1080，高度随内容自适应。' },
    square: { label: '方图', size: '1080 × 1080', hint: '方图：1080 × 1080，适合九宫格。' },
    story: { label: '竖屏', size: '1080 × 1920', hint: '竖屏：1080 × 1920，适合动态/故事。' }
  };
  var DEFAULT_LAYOUT = 'portrait';
  var MAX_PREF_CARDS = 3;
  var PHOTO_MAX_LEN = 600 * 1024;
  var PHOTO_MAX_EDGE = 1200;
  var NOTE_MAX = 24;
  var NEXT_MEET_MAX = 40;


  var DEMO = {
    title: '周五项目庆功',
    memberCount: 4,
    city: '上海',
    keyword: '人民广场',
    beType: 1,
    budget: 200,
    reservation: '',
    members: [
      { nickname: '小北', budget: 45, must: ['麦辣鸡腿堡'], nice: ['薯条'], never: [] },
      { nickname: '阿岚', budget: 40, must: ['鸡块'], nice: ['玉米杯'], never: ['辣'] },
      { nickname: '大可', budget: 60, must: ['巨无霸'], nice: ['可乐'], never: [] },
      { nickname: '糖糖', budget: 35, must: ['麦旋风'], nice: [], never: ['牛肉'] }
    ]
  };

  var state = {
    step: 1,
    party: null,
    stores: [],
    selectedStore: null,
    storeQuery: { city: '', keyword: '', beType: 1 },
    plans: [],
    meta: null,
    workingPlan: null,
    editPlanId: null,

    recalcPending: false,
    recalcBusy: false,
    recalcQueued: false,
    recalcError: null,
    recalcTimer: null,

    menu: { items: [], loaded: false, loading: false, error: null },
    menuQuery: '',

    members: [],
    memberIndex: 0,
    showAllMembers: false,
    prefillMembers: null,

    ticket: null,
    ticketOptions: {
      nicknames: {}, visibleFields: TICKET_FIELDS.slice(), themeLine: '',
      notes: {}, nextMeet: '', photo: '', layout: DEFAULT_LAYOUT
    },
    photoSent: '',
    ticketBusy: false,
    ticketTimer: null,

    prefGroups: [],
    prefLoaded: false,
    prefLoading: false,
    prefShowAll: false,
    prefSaving: false,

    orders: { items: [], loaded: false, loading: false, error: null },
    linkedOrder: null,
    linkDiag: null,
    linkConfirmed: false,
    linkingId: null,

    confirmedHere: false,
    health: null,
    restoring: false
  };

  /* ========================================================================
   * 3. 通用 UI：toast / 弹层 / 抽屉 / 行内状态
   * ===================================================================== */

  var toastRoot = $('#toastRoot');

  function toast(message, kind, ms) {
    if (!toastRoot) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var iconName = kind === 'error' ? 'alert' : kind === 'ok' ? 'check-circle' : kind === 'warn' ? 'alert' : 'info';
    el.innerHTML = icon(iconName) + '<span></span>';
    el.lastChild.textContent = String(message);
    toastRoot.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }, ms || (kind === 'error' ? 5200 : 3400));
  }

  function setInline(el, kind, html) {
    if (!el) return;
    el.className = 'inline-status' + (kind ? ' is-' + kind : '');
    el.innerHTML = html || '';
  }

  function loadingHtml(text) {
    return '<span class="inline-loading"><span class="spinner"></span>' + esc(text) + '</span>';
  }

  var modalScrim = $('#modalScrim');
  var modalTitle = $('#modalTitle');
  var modalBody = $('#modalBody');
  var modalOk = $('#modalOk');
  var modalCancel = $('#modalCancel');
  var modalResolve = null;
  var modalReturnFocus = null;
  var drawerReturnFocus = null;

  function focusableIn(container) {
    if (!container) return [];
    return $$('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter(function (el) { return !el.hidden && el.getAttribute('aria-hidden') !== 'true'; });
  }

  function trapFocus(e, container) {
    if (e.key !== 'Tab') return;
    var items = focusableIn(container);
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function syncPageLock() {
    var orderSheet = document.getElementById('orderSheet');
    var locked = (drawer && !drawer.hidden) || (modalScrim && !modalScrim.hidden) ||
      (orderSheet && !orderSheet.hidden);
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  function restoreFocus(el) {
    if (el && el.isConnected && typeof el.focus === 'function') el.focus();
  }

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      modalResolve = resolve;
      modalReturnFocus = document.activeElement;
      modalTitle.textContent = opts.title || '请确认';
      modalBody.innerHTML = opts.html || '';
      modalOk.textContent = opts.okText || '确认';
      modalOk.className = 'btn ' + (opts.danger === false ? 'btn--primary' : 'btn--danger');
      modalCancel.textContent = opts.cancelText || '取消';
      modalScrim.hidden = false;
      syncPageLock();
      modalCancel.focus();
    });
  }

  function closeModal(result) {
    modalScrim.hidden = true;
    syncPageLock();
    var returnTo = modalReturnFocus;
    modalReturnFocus = null;
    var fn = modalResolve;
    modalResolve = null;
    restoreFocus(returnTo);
    if (fn) fn(result);
  }

  if (modalOk) modalOk.addEventListener('click', function () { closeModal(true); });
  if (modalCancel) modalCancel.addEventListener('click', function () { closeModal(false); });
  if (modalScrim) modalScrim.addEventListener('click', function (e) { if (e.target === modalScrim) closeModal(false); });

  var drawer = $('#drawer');
  var drawerScrim = $('#drawerScrim');

  function setDrawerExpanded(expanded) {
    ['openDrawer', 'footOpenDrawer'].forEach(function (id) {
      var trigger = document.getElementById(id);
      if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  function openDrawer() {
    if (!drawer) return;
    drawerReturnFocus = document.activeElement;
    renderDrawerKv();
    renderPrefGroupList('');
    if (!state.prefLoaded) loadPreferenceGroups();
    drawer.hidden = false;
    drawerScrim.hidden = false;
    setDrawerExpanded(true);
    syncPageLock();
    var closeBtn = $('#closeDrawer');
    if (closeBtn) closeBtn.focus();
  }

  function closeDrawer() {
    var wasOpen = drawer && !drawer.hidden;
    if (drawer) drawer.hidden = true;
    if (drawerScrim) drawerScrim.hidden = true;
    setDrawerExpanded(false);
    syncPageLock();
    if (wasOpen) restoreFocus(drawerReturnFocus);
    drawerReturnFocus = null;
  }

  function renderDrawerKv() {
    var box = $('#drawerKv');
    if (!box) return;
    var h = state.health || {};
    var mcp = h.mcp || (h.latencyMs !== undefined ? h : null);
    var rows = [
      ['后端连接', state.health ? '正常' : '未连接'],
      ['MCP 状态', mcp ? (mcp.ok === false ? '不可用' : '可用（' + (mcp.latencyMs || 0) + ' ms）') : '—'],
      ['数据时点', fmtTime(h.dataTime || currentDataTime())],
      ['数据来源', dataSourceLabel(currentDataSource())],
      ['当前聚餐', state.party ? (state.party.title + '（' + state.party.memberCount + ' 人 · ' + statusLabel(state.party.status) + '）') : '尚未创建'],
      ['候选方案', state.plans.length ? state.plans.length + ' 套' : '—'],
      ['票根状态', state.ticket ? (state.ticket.statusLabel || statusLabel(state.ticket.status)) : '—']
    ];
    box.innerHTML = rows.map(function (r) {
      return '<div class="kv-row"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('');
  }

  function statusLabel(status) {
    var map = { draft: '草稿', planned: '待确认', confirmed: '已确认方案', completed: '已完成' };
    return map[status] || (status || '—');
  }

  function dataSourceLabel(src) {
    if (src === 'live') return '实时';
    if (src === 'replay') return '离线回放（非实时）';
    if (src === 'unavailable') return '不可用';
    return '—';
  }

  /* ---------------- 全局数据时点 / 离线横幅 ---------------- */

  function setDataTime(value) {
    var txt = $('#dataTimeText');
    if (!txt) return;
    txt.textContent = '数据时点 ' + (value ? fmtTime(value) : '—');
  }

  function currentDataTime() {
    if (state.meta && state.meta.dataTime) return state.meta.dataTime;
    if (state.workingPlan && state.workingPlan.pricing && state.workingPlan.pricing.quotedAt) return state.workingPlan.pricing.quotedAt;
    if (state.party && state.party.dataTime) return state.party.dataTime;
    return '';
  }

  function currentDataSource() {
    if (state.meta && state.meta.dataSource) return state.meta.dataSource;
    if (state.party && state.party.dataSource) return state.party.dataSource;
    return '';
  }

  function applyDataSource(src) {
    var banner = $('#replayBanner');
    if (banner) banner.hidden = src !== 'replay';
    var chip = $('#dataTimeChip');
    if (chip) {
      chip.className = 'chip ' + (src === 'replay' ? 'chip--replay' : src === 'live' ? 'chip--live' : 'chip--ghost');
    }
    setDataTime(currentDataTime());
    renderDrawerKv();
  }

  /* ========================================================================
   * 3.1 渲染器：门店
   * ===================================================================== */

  function renderStores(stores) {
    var list = $('#storeList');
    if (!list) return;
    if (!stores || !stores.length) {
      list.innerHTML = '';
      setInline($('#storeStatus'), 'error', '没有找到门店。换个商圈关键词或城市再试一次。');
      return;
    }
    state.stores = stores;
    list.innerHTML = stores.map(function (s, i) {
      var selected = state.selectedStore && state.selectedStore.storeCode === s.storeCode;
      var meta = [];
      if (s.distance !== null && s.distance !== undefined && s.distance !== '') {
        meta.push('<span class="pill">' + icon('store') + esc(typeof s.distance === 'number' ? s.distance + ' m' : s.distance) + '</span>');
      }
      if (s.reservation === true) {
        meta.push('<span class="pill" style="background:var(--green-soft);border-color:rgba(47,107,70,.3);color:var(--green)">' + icon('check') + '支持预约</span>');
      } else if (s.reservation === false) {
        meta.push('<span class="pill">不支持预约</span>');
      }
      if (s.beCode) meta.push('<span class="pill">得来速可用</span>');
      return '<li>' +
        '<button type="button" class="store-item' + (selected ? ' is-selected' : '') + '" data-store-idx="' + i + '" aria-pressed="' + (selected ? 'true' : 'false') + '">' +
          '<span class="store-item__top">' +
            '<span class="store-item__check">' + icon('check') + '</span>' +
            '<span style="min-width:0">' +
              '<span class="store-item__name">' + esc(s.storeName || '未命名门店') + '</span>' +
              '<span class="store-item__addr">' + esc(s.address || '地址未提供') + '</span>' +
            '</span>' +
          '</span>' +
          '<span class="store-item__meta">' + meta.join('') + '</span>' +
        '</button>' +
      '</li>';
    }).join('');
  }

  function selectStore(idx) {
    var s = state.stores[idx];
    if (!s) return;
    state.selectedStore = s;
    renderStores(state.stores);
    updateFormTip();
  }

  function updateFormTip() {
    var tip = $('#formTip');
    if (!tip) return;
    if (!state.selectedStore) {
      tip.className = 'form-foot__tip';
      tip.textContent = '选好门店后即可进入下一步。';
    } else {
      tip.className = 'form-foot__tip';
      tip.textContent = '已选：' + state.selectedStore.storeName + '。下一步收集成员心愿。';
    }
  }

  /* ========================================================================
   * 3.2 渲染器：成员心愿
   * ===================================================================== */

  function normalizeMembers(list, count) {
    var src = Array.isArray(list) ? list : [];
    var out = [];
    for (var i = 0; i < count; i++) {
      var m = src[i] || {};
      out.push({
        id: m.id || ('m' + (i + 1)),
        nickname: typeof m.nickname === 'string' ? m.nickname : '',
        budget: (typeof m.budget === 'number' && isFinite(m.budget)) ? m.budget : null,
        must: Array.isArray(m.must) ? m.must.slice(0, MAX_CHIPS) : [],
        nice: Array.isArray(m.nice) ? m.nice.slice(0, MAX_CHIPS) : [],
        never: Array.isArray(m.never) ? m.never.slice(0, MAX_CHIPS) : []
      });
    }
    return out;
  }

  function cloneMembers(list) {
    return (list || []).map(function (m) {
      return {
        id: m.id, nickname: m.nickname, budget: m.budget,
        must: (m.must || []).slice(), nice: (m.nice || []).slice(), never: (m.never || []).slice()
      };
    });
  }

  function findMember(id) {
    for (var i = 0; i < state.members.length; i++) if (state.members[i].id === id) return state.members[i];
    return null;
  }

  var GROUP_META = {
    must: { title: '必须要', hint: '尽量满足，做不到会说明原因', cls: 'must', icon: 'star', ph: '如：麦辣鸡腿堡' },
    nice: { title: '最好有', hint: '用于排序，不承诺全部满足', cls: 'nice', icon: 'sparkle', ph: '如：薯条' },
    never: { title: '不要', hint: '硬约束，不会为低价突破', cls: 'never', icon: 'x-circle', ph: '如：辣、牛肉' }
  };

  function chipHtml(word, key, memberId) {
    return '<span class="tag-input-chip tag-input-chip--' + key + '">' + esc(word) +
      '<button type="button" class="tag-input-chip__x" data-chip-remove="' + esc(memberId) + '" data-key="' + key +
      '" data-word="' + esc(word) + '" aria-label="移除 ' + esc(word) + '">' + icon('x') + '</button></span>';
  }

  function chipsBoxInner(member, key) {
    var words = member[key] || [];
    var meta = GROUP_META[key];
    var input = '<input type="text" data-chip-field="' + key + '" placeholder="' +
      esc(words.length >= MAX_CHIPS ? '已达上限 ' + MAX_CHIPS + ' 条' : meta.ph) + '"' +
      (words.length >= MAX_CHIPS ? ' disabled' : '') +
      ' maxlength="12" aria-label="' + meta.title + '，回车或逗号添加" />';
    return words.map(function (w) { return chipHtml(w, key, member.id); }).join('') + input;
  }

  function wishGroupHtml(member, key) {
    var meta = GROUP_META[key];
    return '<div class="wish-group wish-group--' + meta.cls + '">' +
      '<div class="wish-group__head">' +
        '<span class="wish-group__title">' + icon(meta.icon) + meta.title + '</span>' +
        '<span class="wish-group__hint">' + meta.hint + '</span>' +
      '</div>' +
      '<div class="chip-input" data-chip-input="' + esc(member.id) + '" data-key="' + key + '" data-ph="' + esc(meta.ph) + '">' +
        chipsBoxInner(member, key) +
      '</div>' +
    '</div>';
  }

  function memberExample(member, index) {
    var lines = [
      '示例：昵称写「小北」，必须要「麦辣鸡腿堡」，最好有「薯条」，不要「辣」。',
      '示例：昵称写「阿岚」，个人预算 40，不要「辣」——硬约束会优先于低价。',
      '示例：昵称写「大可」，必须「巨无霸」，最好有「可乐」。',
      '示例：昵称写「糖糖」，必须「麦旋风」，不要「牛肉」。'
    ];
    var hint = lines[index % lines.length];
    if (member.must && member.must.length) {
      hint += ' 当前只写「' + member.must[0] + '」也可以，系统会按关键词匹配餐品。';
    }
    return '<p class="member-card__example"><b>怎么填：</b>' + esc(hint) + '</p>';
  }

  function memberCardHtml(member, index, total, solo) {
    var color = memberColor(index);
    var filled = !!(member.nickname && member.nickname.trim());
    var nav = '';
    if (solo) {
      nav = '<div style="display:flex;gap:8px;align-items:center">' +
        (index > 0 ? '<button type="button" class="btn btn--sm btn--ghost js-member-prev">上一位</button>' : '') +
        '<button type="button" class="btn btn--sm btn--primary js-member-next">' +
          (index < total - 1 ? '保存，下一位' : '保存这一位') + '</button>' +
      '</div>';
    }
    return '<article class="member-card' + (solo ? ' member-card--solo' : '') + '" data-mid="' + esc(member.id) + '">' +
      '<div class="member-card__head">' +
        '<div class="member-card__who">' +
          '<span class="avatar" style="background:' + color + '">' + esc(initialOf(member.nickname || String(index + 1))) + '</span>' +
          '<span>' +
            '<span class="member-card__idx">第 ' + (index + 1) + ' / ' + total + ' 位</span>' +
            '<span class="member-card__name" data-name-echo>' + esc(filled ? member.nickname : '待填写昵称') + '</span>' +
          '</span>' +
        '</div>' +
        '<span class="pill">' + (member.budget !== null ? '个人预算 ' + moneyYuan(member.budget) : '未设个人预算') + '</span>' +
      '</div>' +
      '<div class="grid grid--2">' +
        '<label class="field">' +
          '<span class="field__label">昵称</span>' +
          '<input type="text" data-nick="' + esc(member.id) + '" maxlength="12" value="' + esc(member.nickname) + '" placeholder="如 小北" autocomplete="off" />' +
          '<span class="field__hint">1—12 字，票根上会用到。</span>' +
        '</label>' +
        '<label class="field field--budget">' +
          '<span class="field__label">个人预算（元）<span class="opt">可选</span></span>' +
          '<input type="number" min="0" step="1" data-budget="' + esc(member.id) + '" value="' +
            (member.budget === null ? '' : member.budget) + '" placeholder="不填则不限" inputmode="decimal" />' +
          '<span class="field__hint">超过时会在分账表标记（文字+图标）。</span>' +
        '</label>' +
      '</div>' +
      wishGroupHtml(member, 'must') +
      wishGroupHtml(member, 'nice') +
      wishGroupHtml(member, 'never') +
      memberExample(member, index) +
      '<div class="member-card__foot">' +
        '<span class="member-card__err" data-err></span>' +
        nav +
      '</div>' +
    '</article>';
  }

  function renderMemberStage() {
    var stage = $('#memberStage');
    if (!stage) return;
    var echo = $('#partyTitleEcho');
    if (echo) echo.textContent = (state.party && state.party.title) || '未命名聚餐';
    var total = state.members.length;
    if (!total) { stage.innerHTML = ''; return; }

    if (state.showAllMembers) {
      stage.className = 'member-stage member-stage--all';
      stage.innerHTML = state.members.map(function (m, i) { return memberCardHtml(m, i, total, false); }).join('');
    } else {
      stage.className = 'member-stage';
      var i = clamp(state.memberIndex, 0, total - 1);
      stage.innerHTML = memberCardHtml(state.members[i], i, total, true);
    }
    renderMemberProgress();
    renderMemberFootNote();
  }

  function renderMemberProgress() {
    var box = $('#memberProgress');
    if (!box) return;
    var total = state.members.length;
    var idx = state.showAllMembers ? -1 : state.memberIndex;
    var text = state.showAllMembers
      ? '全部 ' + total + ' 位成员，逐个核对'
      : '第 <b>' + (idx + 1) + '</b> / ' + total + ' 位';
    var pips = state.members.map(function (m, i) {
      var filled = !!(m.nickname && m.nickname.trim());
      var cls = 'pip' + (i === idx ? ' is-current' : '') + (filled ? ' is-filled' : '');
      return '<button type="button" class="' + cls + '" data-pip="' + i + '" title="' +
        esc((m.nickname || '待填写') + (filled ? '（已填写）' : '（未填写）')) + '" aria-label="第 ' + (i + 1) + ' 位 ' + esc(m.nickname || '待填写') + '"' +
        (i === idx ? ' aria-current="true"' : '') + '>' +
        '<span class="pip__n">' + (i + 1) + '</span>' +
        (filled ? '<span class="pip__dot" aria-hidden="true"></span>' : '') +
      '</button>';
    }).join('');
    box.innerHTML = '<span class="member-progress__text">' + text + '</span><span class="pips">' + pips + '</span>' +
      (state.party ? '<span class="chip chip--ghost">' + esc(state.party.title) + '</span>' : '');
  }

  function renderMemberFootNote() {
    var note = $('#memberFootNote');
    if (!note) return;
    var unfilled = state.members.filter(function (m) { return !m.nickname || !m.nickname.trim(); }).length;
    note.textContent = unfilled ? '还有 ' + unfilled + ' 位没写昵称' : '昵称都齐了，可以生成方案';
    note.style.color = unfilled ? 'var(--ink-3)' : 'var(--green)';
  }

  function rerenderChipsBox(memberId, key, leftover) {
    var box = $('.chip-input[data-chip-input="' + memberId + '"][data-key="' + key + '"]');
    if (!box) return;
    var member = findMember(memberId);
    if (!member) return;
    var ph = box.getAttribute('data-ph') || '';
    var words = member[key] || [];
    var input = '<input type="text" data-chip-field="' + key + '" placeholder="' +
      esc(words.length >= MAX_CHIPS ? '已达上限 ' + MAX_CHIPS + ' 条' : ph) + '"' +
      (words.length >= MAX_CHIPS ? ' disabled' : '') + ' maxlength="12" />';
    box.innerHTML = words.map(function (w) { return chipHtml(w, key, memberId); }).join('') + input;
    var next = $('input[data-chip-field="' + key + '"]', box);
    if (next) {
      if (leftover) next.value = leftover;
      if (!next.disabled) next.focus();
    }
  }

  function commitChip(input) {
    var box = input.closest('.chip-input');
    if (!box) return;
    var memberId = box.getAttribute('data-chip-input');
    var key = box.getAttribute('data-key');
    var member = findMember(memberId);
    if (!member) return;
    var raw = input.value;
    var parts = raw.split(/[,，、;；]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) { input.value = ''; return; }

    var list = member[key];
    var leftover = '';
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i].slice(0, 12);
      if (list.indexOf(w) > -1) continue;
      if (list.length >= MAX_CHIPS) { leftover = parts.slice(i).join('，'); break; }
      list.push(w);
    }
    if (leftover) toast('「' + GROUP_META[key].title + '」最多 ' + MAX_CHIPS + ' 条，多出的先留着了。', 'warn');
    rerenderChipsBox(memberId, key, leftover);
    renderMemberFootNote();
    renderMemberProgress();
  }

  function firstMemberError() {
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      var nick = (m.nickname || '').trim();
      if (!nick) return '第 ' + (i + 1) + ' 位成员还没写昵称';
      if (nick.length > 12) return '第 ' + (i + 1) + ' 位成员昵称超过 12 字';
    }
    return '';
  }

  /* ========================================================================
   * 3.3 渲染器：俯视餐桌
   * ===================================================================== */

  function seatsOf(plan) {
    var members = (state.party && state.party.members) || state.members || [];
    var groups = {};
    (plan.items || []).forEach(function (it) {
      if (!it.quantity) return;
      var key = it.shared || !it.assigneeId ? '__shared' : it.assigneeId;
      (groups[key] || (groups[key] = [])).push(it);
    });
    return { members: members, groups: groups };
  }

  function plateHtml(item, memberId) {
    var color = memberId ? colorForMember(memberId) : 'var(--ink-3)';
    return '<span class="plate' + (memberId ? '' : ' plate--shared') + '" style="--pc:' + color + '"' +
      (memberId ? ' data-plate-member="' + esc(memberId) + '"' : '') + '>' +
      '<span class="plate__disc"></span>' +
      '<span class="plate__name">' + esc(item.name || item.productCode) + '</span>' +
      '<span class="plate__qty">×' + (item.quantity || 1) + '</span>' +
    '</span>';
  }

  function tableSceneHtml(plan, opts) {
    opts = opts || {};
    var info = seatsOf(plan);
    var members = info.members;
    var groups = info.groups;
    var colors = members.map(function (m, i) { return memberColor(i); });

    var plates = [];
    var totalQty = 0;
    var sharedQty = 0;
    Object.keys(groups).forEach(function (key) {
      groups[key].forEach(function (it) {
        totalQty += it.quantity || 1;
        if (key === '__shared') sharedQty += it.quantity || 1;
        plates.push(plateHtml(it, key === '__shared' ? null : key));
      });
    });

    var caption = members.length + ' 人桌 · ' + totalQty + ' 份餐品' +
      (sharedQty ? ' · ' + sharedQty + ' 份共享' : '');

    var seatHtml = members.map(function (m, i) {
      var own = groups[m.id] || [];
      var qty = own.reduce(function (s, it) { return s + (it.quantity || 1); }, 0);
      var cents = own.reduce(function (s, it) { return s + (it.quantity || 1) * (it.unitPriceCents || 0); }, 0);
      var wr = (plan.wishResults || {})[m.id] || {};
      var flags = '';
      var mustUnmet = (wr.must || []).filter(function (x) { return x.status === 'unmet'; }).length;
      var neverViolated = (wr.never || []).filter(function (x) { return x.status === 'violated'; }).length;
      if (neverViolated) {
        flags += '<span class="seat__flag">' + icon('alert') + '硬约束冲突</span>';
      } else if (mustUnmet) {
        flags += '<span class="seat__flag seat__flag--warn">' + icon('alert') + '未满足 ' + mustUnmet + '</span>';
      } else if ((wr.must || []).length) {
        flags += '<span class="seat__flag seat__flag--ok">' + icon('check') + '心愿已满足</span>';
      }
      return '<div class="seat" data-seat="' + esc(m.id) + '" style="--c:' + colors[i] + '">' +
        '<div class="seat__top">' +
          '<span class="seat__dot">' + esc(initialOf(m.nickname)) + '</span>' +
          '<span class="seat__name">' + esc(m.nickname || '待填写') + '</span>' +
        '</div>' +
        '<div class="seat__items">' + (qty ? qty + ' 份' : '共享/无归属') + (opts.showPrice && qty ? ' · ' + money(cents) : '') + '</div>' +
        (flags ? '<div class="seat__wish">' + flags + '</div>' : '') +
      '</div>';
    }).join('');

    return '<div class="table-scene' + (members.length > 6 ? ' table-scene--tall' : '') + '" data-scene>' +
      '<svg class="table-links" aria-hidden="true"></svg>' +
      '<div class="table-top">' +
        '<div class="table-top__caption"><b>' + esc(caption) + '</b></div>' +
        '<div class="plate-grid' + (plates.length ? '' : ' plate-grid--empty') + '">' +
          (plates.length ? plates.join('') : '<span class="muted" style="font-size:11px">还没有餐品</span>') +
        '</div>' +
      '</div>' +
      seatHtml +
    '</div>';
  }

  function layoutScene(scene) {
    if (!scene) return;
    var w = scene.clientWidth;
    var h = scene.clientHeight;
    if (!w || !h) return;
    var seats = $$('.seat', scene);
    var narrow = window.matchMedia('(max-width: 700px)').matches;
    if (narrow) { seats.forEach(function (s) { s.style.left = ''; s.style.top = ''; }); }
    else {
      var n = seats.length;
      seats.forEach(function (s, i) {
        var sw = s.offsetWidth || 100;
        var sh = s.offsetHeight || 60;
        var rx = Math.max(0, (w - sw) / 2 - 6);
        var ry = Math.max(0, (h - sh) / 2 - 6);
        var ang = (-90 + i * (360 / Math.max(1, n))) * Math.PI / 180;
        s.style.left = (w / 2 + rx * Math.cos(ang)).toFixed(1) + 'px';
        s.style.top = (h / 2 + ry * Math.sin(ang)).toFixed(1) + 'px';
      });
    }
    drawLinks(scene);
  }

  function drawLinks(scene) {
    var svg = $('.table-links', scene);
    if (!svg) return;
    var box = scene.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute('viewBox', '0 0 ' + box.width.toFixed(1) + ' ' + box.height.toFixed(1));
    if (window.matchMedia('(max-width: 700px)').matches) { svg.innerHTML = ''; return; }

    var groups = {};
    $$('[data-plate-member]', scene).forEach(function (el) {
      var id = el.getAttribute('data-plate-member');
      var r = el.getBoundingClientRect();
      (groups[id] || (groups[id] = [])).push({
        x: r.left - box.left + r.width / 2,
        y: r.top - box.top + r.height / 2
      });
    });

    var lines = [];
    Object.keys(groups).forEach(function (id) {
      var seat = $('.seat[data-seat="' + id + '"]', scene);
      if (!seat) return;
      var sr = seat.getBoundingClientRect();
      var sx = sr.left - box.left + sr.width / 2;
      var sy = sr.top - box.top + sr.height / 2;
      var pts = groups[id];
      var px = pts.reduce(function (s, p) { return s + p.x; }, 0) / pts.length;
      var py = pts.reduce(function (s, p) { return s + p.y; }, 0) / pts.length;
      var color = (seat.style.getPropertyValue('--c') || '#DA291C').trim();
      lines.push('<line x1="' + sx.toFixed(1) + '" y1="' + sy.toFixed(1) + '" x2="' + px.toFixed(1) +
        '" y2="' + py.toFixed(1) + '" stroke="' + esc(color) + '"></line>');
    });
    svg.innerHTML = lines.join('');
  }

  function layoutAllScenes() {
    $$('#stage .table-scene').forEach(layoutScene);
  }

  var onResize = debounce(function () { layoutAllScenes(); }, 140);
  window.addEventListener('resize', onResize);

  /* ========================================================================
   * 3.4 渲染器：方案卡
   * ===================================================================== */

  function wishStatusTag(kind, status) {
    var map = {
      must: {
        satisfied: ['ok', 'check', '心愿已满足'],
        unmet: ['bad', 'x-circle', '未满足'],
        adjusted: ['warn', 'alert', '已调整']
      },
      nice: {
        satisfied: ['ok', 'check', '已兼顾'],
        unmet: ['muted', 'minus', '未满足']
      },
      never: {
        respected: ['ok', 'check', '硬约束已避开'],
        violated: ['bad', 'alert', '硬约束冲突']
      }
    };
    var conf = (map[kind] || {})[status] || ['muted', 'info', String(status || '未处理')];
    return '<span class="status-tag status-tag--' + conf[0] + '">' + icon(conf[1]) + esc(conf[2]) + '</span>';
  }

  function wishRowsHtml(plan, member) {
    var wr = (plan.wishResults || {})[member.id] || {};
    var rows = [];
    var kinds = [
      ['must', '必须要'],
      ['nice', '最好有'],
      ['never', '不要']
    ];
    kinds.forEach(function (pair) {
      var kind = pair[0], label = pair[1];
      var list = wr[kind] || [];
      if (!list.length) {
        rows.push('<div class="wish-line"><span class="wish-line__k">' + label +
          '</span><span class="wish-line__v muted">未填写</span></div>');
        return;
      }
      list.forEach(function (item) {
        var by = item.byProduct ? '<span class="wish-line__by"> · 由「' + esc(item.byProduct) + '」</span>' : '';
        var reason = item.reason ? '<span class="wish-line__by"> · ' + esc(item.reason) + '</span>' : '';
        rows.push('<div class="wish-line">' +
          '<span class="wish-line__k">' + label + '</span>' +
          '<span class="wish-line__v">' + esc(item.wish) + by + reason + '</span>' +
          wishStatusTag(kind, item.status) +
        '</div>');
      });
    });
    return rows.join('');
  }

  function strategyLabel(strategy) {
    var map = { balanced: '人人有期待', value: '整单更划算', explore: '一起尝点新' };
    return map[strategy] || '';
  }

  function planCardHtml(plan, index) {
    var pricing = plan.pricing || {};
    var dead = pricing.ok !== true;
    var members = (state.party && state.party.members) || [];
    var memberCount = Math.max(1, members.length || state.party && state.party.memberCount || 1);
    var name = plan.name || strategyLabel(plan.strategy) || ('方案 ' + (plan.planId || index + 1));
    var subtitle = plan.subtitle || '';
    var tagText = '方案 ' + (plan.planId || '') +
      (strategyLabel(plan.strategy) && strategyLabel(plan.strategy) !== name ? ' · ' + strategyLabel(plan.strategy) : '');

    var head = '<div class="plan-card__head">' +
      '<span class="plan-card__tag">' + icon('flag') + esc(tagText) + '</span>' +
      '<h3 class="plan-card__name">' + esc(name) + '</h3>' +
      '<p class="plan-card__sub">' + esc(subtitle) + '</p>' +
    '</div>';

    var priceBlock = '';
    if (dead) {
      var errInfo = pricing.error || {};
      priceBlock = '<div class="plan-dead">' +
        '<p class="plan-dead__title">' + icon('x-circle') + '核价失败 · 不可用</p>' +
        '<p class="plan-dead__msg">' + esc(errInfo.message || '官方核价未返回有效结果') +
          (errInfo.code ? '（错误码 ' + esc(errInfo.code) + '）' : '') + '</p>' +
        '<p class="plan-dead__msg" style="margin-top:6px">此方案不显示任何估算价格，也无法被确认。</p>' +
      '</div>';
    } else {
      var discount = Math.abs(Number(pricing.discountCents) || 0);
      var per = Math.round((Number(pricing.totalCents) || 0) / memberCount);
      priceBlock =
        '<div class="plan-card__price">' +
          '<span class="price-main">' +
            '<span class="price-main__num">' + money(pricing.totalCents) + '</span>' +
            '<span class="price-main__label">官方核价 · 整单</span>' +
          '</span>' +
          '<span class="price-side">' +
            (discount > 0 ? '原价 <s>' + money(pricing.originalTotalCents) + '</s><br />' : '') +
            '人均 <b>' + money(per) + '</b><br />' +
            '核价 ' + esc(fmtTime(pricing.quotedAt)) +
          '</span>' +
        '</div>';

      var coupon = pricing.coupon;
      if (coupon && coupon.title) {
        priceBlock += '<div class="plan-card__coupon plan-card__coupon--ok">' + icon('check') +
          '<span>优惠已计入：' + esc(coupon.title) + (discount ? '（-' + money(discount) + '）' : '') + '</span></div>';
      } else if (discount > 0) {
        priceBlock += '<div class="plan-card__coupon plan-card__coupon--ok">' + icon('check') +
          '<span>已享受优惠 -' + money(discount) + '（未返回券名）</span></div>';
      } else {
        priceBlock += '<div class="plan-card__coupon plan-card__coupon--none">' + icon('info') +
          '<span>当前无可用优惠</span></div>';
      }
    }

    var converge = '';
    if (plan.convergedWith) {
      var reasons = (plan.tradeoffs || []).filter(function (t) { return t.type === 'converged'; })
        .map(function (t) { return t.text; }).join('；');
      converge = '<div class="converge-note">' + icon('info') +
        '<span><strong>与 ' + esc(plan.convergedWith) + ' 方案策略收敛</strong>' +
        esc(reasons || '在当前菜单与预算下，两种策略落到了同一组餐品。') + '</span></div>';
    }

    var sceneSection = '<div class="plan-card__section">' +
      '<p class="plan-card__section-title">' + icon('users') + '这一桌</p>' +
      tableSceneHtml(plan, {}) +
    '</div>';

    var wishSection = '<div class="plan-card__section">' +
      '<p class="plan-card__section-title">' + icon('star') + '心愿处理结果</p>' +
      '<div class="wish-table">' +
        members.map(function (m, i) {
          return '<div class="wish-member">' +
            '<div class="wish-member__name">' +
              '<span class="wish-member__dot" style="background:' + memberColor(i) + '"></span>' + esc(m.nickname || '成员 ' + (i + 1)) +
            '</div>' + wishRowsHtml(plan, m) +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>';

    var tradeSection = '';
    if (plan.tradeoffs && plan.tradeoffs.length) {
      tradeSection = '<div class="plan-card__section">' +
        '<p class="plan-card__section-title">' + icon('info') + '取舍说明</p>' +
        '<ul class="tradeoff-list">' +
          plan.tradeoffs.map(function (t) {
            var cls = t.type === 'constraint' ? 'is-bad' : (t.type === 'wish' || t.type === 'budget') ? 'is-warn' : '';
            return '<li class="' + cls + '">' + esc(t.text) + '</li>';
          }).join('') +
        '</ul>' +
      '</div>';
    }

    var warnSection = '';
    if (plan.warnings && plan.warnings.length) {
      warnSection = '<div class="plan-card__warns">' + icon('alert') +
        '<span>' + esc(plan.warnings.join('；')) + '</span></div>';
    }

    var foot = '<div class="plan-card__foot">' +
      warnSection +
      (dead
        ? '<button type="button" class="btn btn--block" disabled>核价失败，不可选</button>'
        : '<button type="button" class="btn btn--primary btn--block" data-pick="' + esc(plan.planId) + '">选这套，去调整' +
            icon('chevron') + '</button>') +
    '</div>';

    return '<article class="plan-card plan-card--' + esc(plan.strategy || 'balanced') + (dead ? ' plan-card--dead' : '') + '" data-plan="' + esc(plan.planId) + '">' +
      head + priceBlock + converge + sceneSection + wishSection + tradeSection + foot +
    '</article>';
  }

  function skeletonCards(n) {
    var one = '<div class="plan-card" aria-hidden="true"><div style="padding:18px">' +
      '<div class="skeleton" style="height:14px;width:38%;margin-bottom:10px"></div>' +
      '<div class="skeleton" style="height:26px;width:64%;margin-bottom:14px"></div>' +
      '<div class="skeleton" style="height:52px;width:100%;margin-bottom:12px"></div>' +
      '<div class="skeleton" style="height:300px;width:100%;margin-bottom:10px"></div>' +
      '<div class="skeleton" style="height:64px;width:100%"></div>' +
      '</div></div>';
    var out = '';
    for (var i = 0; i < n; i++) out += one;
    return out;
  }

  function renderPlans() {
    var grid = $('#planGrid');
    if (!grid) return;
    if (!state.plans.length) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = state.plans.map(planCardHtml).join('');

    var stamp = $('#planTimeStamp');
    if (stamp) {
      var t = (state.meta && state.meta.dataTime) || (state.plans[0].pricing && state.plans[0].pricing.quotedAt);
      stamp.innerHTML = icon('clock') + '数据时点 ' + esc(fmtTime(t)) + '（官方核价）';
    }
    setDataTime(currentDataTime());
    applyDataSource(currentDataSource());

    requestAnimationFrame(function () { layoutAllScenes(); });
  }

  /* ========================================================================
   * 3.5 渲染器：分账 / 清单 / 菜单
   * ===================================================================== */

  function renderBill() {
    var plan = state.workingPlan;
    var summary = $('#billSummary');
    var body = $('#billBody');
    var foot = $('#billFoot');
    var checkLine = $('#billSumCheck');
    if (!plan || !summary) return;

    var pending = state.recalcPending;
    var failed = !!state.recalcError;
    var pricing = plan.pricing || {};
    var valid = !pending && !failed && pricing.ok === true;
    var members = (state.party && state.party.members) || [];
    var memberCount = Math.max(1, members.length);

    var budget = state.party ? Number(state.party.budgetTotal) : 0;
    var totalCents = valid ? Number(pricing.totalCents) || 0 : null;
    var diffCents = valid ? totalCents - Math.round(budget * 100) : null;

    function cell(label, value, cls) {
      return '<div class="bill-summary__cell"><div class="bill-summary__k">' + esc(label) + '</div>' +
        '<div class="bill-summary__v ' + (cls || '') + '">' + value + '</div></div>';
    }
    var totalVal = pending ? '<span class="bill-summary__v--pending">核价中…</span>'
      : failed ? '<span class="bill-summary__v--pending">无有效价格</span>'
      : valid ? money(totalCents) : '<span class="bill-summary__v--pending">—</span>';

    var perVal = valid ? money(Math.round(totalCents / memberCount)) : '<span class="bill-summary__v--pending">—</span>';
    var disc = valid ? Math.abs(Number(pricing.discountCents) || 0) : 0;
    var discVal = pending || failed ? '<span class="bill-summary__v--pending">—</span>' : (disc ? '-' + money(disc) : '无优惠');
    var budgetVal = valid
      ? (diffCents > 0 ? '<span class="bill-summary__v--bad">超 ' + money(diffCents) + '</span>' : '<span class="bill-summary__v--ok">在预算内</span>')
      : '<span class="bill-summary__v--pending">—</span>';

    summary.innerHTML = cell('整单应付', totalVal) + cell('人均', perVal) + cell('优惠', discVal) +
      cell('共同预算 ' + moneyYuan(budget), budgetVal);

    var alloc = (plan.allocation || []).slice();
    if (pending) {
      body.innerHTML = members.map(function (m, i) {
        return '<tr><td><span class="bill__who"><span class="bill__dot" style="background:' + memberColor(i) + '"></span>' +
          '<span class="bill__name">' + esc(m.nickname || '成员 ' + (i + 1)) + '</span></span></td>' +
          ['', '', '', ''].map(function () { return '<td class="num"><span class="skeleton" style="display:inline-block;height:10px;width:44px"></span></td>'; }).join('') +
          '</tr>';
      }).join('') || '<tr><td colspan="5" class="muted">—</td></tr>';
      if (foot) foot.innerHTML = '<tr><td>合计</td><td class="num">核价中…</td><td class="num">—</td><td class="num">—</td><td class="num">核价中…</td></tr>';
      if (checkLine) { checkLine.className = 'bill__sum-check'; checkLine.innerHTML = icon('clock') + '正在重新核价，旧金额已失效。'; }
      return;
    }

    if (failed) {
      body.innerHTML = '<tr><td colspan="5" class="muted">核价失败，暂无可展示的分账。</td></tr>';
      if (foot) foot.innerHTML = '';
      if (checkLine) { checkLine.className = 'bill__sum-check is-bad'; checkLine.innerHTML = icon('x-circle') + '核价失败，金额不可用。'; }
      return;
    }

    if (!alloc.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted">本方案没有分账数据。</td></tr>';
      if (foot) foot.innerHTML = '';
      if (checkLine) checkLine.innerHTML = '';
      return;
    }

    var colorMap = {};
    members.forEach(function (m, i) { colorMap[m.id] = memberColor(i); });

    body.innerHTML = alloc.map(function (a) {
      var budgetLine = (a.personalBudget === null || a.personalBudget === undefined)
        ? ''
        : '<span class="bill__budget">个人预算 ' + moneyYuan(a.personalBudget) + '</span>';
      var mark = a.overBudget
        ? '<span class="bill__over">' + icon('alert') + '超个人预算</span>'
        : (a.personalBudget !== null && a.personalBudget !== undefined
          ? '<span class="bill__ok">' + icon('check') + '预算内</span>' : '');
      var discShare = Number(a.discountShareCents) || 0;
      return '<tr>' +
        '<td><span class="bill__who">' +
          '<span class="bill__dot" style="background:' + (colorMap[a.memberId] || 'var(--ink-3)') + '"></span>' +
          '<span><span class="bill__name">' + esc(a.nickname || '—') + '</span>' + budgetLine + '</span>' +
          '<span style="display:inline-flex;flex-direction:column">' + mark + '</span>' +
        '</span></td>' +
        '<td class="num">' + money(a.itemsSubtotalCents) + '</td>' +
        '<td class="num">' + (a.sharedShareCents ? money(a.sharedShareCents) : '—') + '</td>' +
        '<td class="num">' + (discShare ? '-' + money(Math.abs(discShare)) : '—') + '</td>' +
        '<td class="num"><b>' + money(a.shareCents) + '</b></td>' +
      '</tr>';
    }).join('');

    var sumShare = alloc.reduce(function (s, a) { return s + (Number(a.shareCents) || 0); }, 0);
    var sumSub = alloc.reduce(function (s, a) { return s + (Number(a.itemsSubtotalCents) || 0); }, 0);
    var sumShared = alloc.reduce(function (s, a) { return s + (Number(a.sharedShareCents) || 0); }, 0);
    var sumDisc = alloc.reduce(function (s, a) { return s + (Number(a.discountShareCents) || 0); }, 0);

    if (foot) {
      foot.innerHTML = '<tr><td>合计</td>' +
        '<td class="num">' + money(sumSub) + '</td>' +
        '<td class="num">' + money(sumShared) + '</td>' +
        '<td class="num">' + (sumDisc ? '-' + money(Math.abs(sumDisc)) : '—') + '</td>' +
        '<td class="num">' + money(sumShare) + '</td></tr>';
    }

    if (checkLine) {
      var okSum = sumShare === totalCents;
      checkLine.className = 'bill__sum-check' + (okSum ? '' : ' is-bad');
      checkLine.innerHTML = okSum
        ? icon('check-circle') + '分账合计 ' + money(sumShare) + ' = 整单 ' + money(totalCents) + '，一致。'
        : icon('alert') + '分账合计 ' + money(sumShare) + ' 与整单 ' + money(totalCents) + ' 不一致，请重新核价。';
    }
  }

  function renderItemEditor() {
    var box = $('#itemEditor');
    var countPill = $('#itemCount');
    if (!box) return;
    var plan = state.workingPlan;
    if (!plan || !plan.items || !plan.items.length) {
      box.innerHTML = '<p class="ie-empty">这一桌还没有餐品，从右侧菜单添加，或换一个方案。</p>';
      if (countPill) countPill.textContent = '0 项';
      return;
    }
    var members = (state.party && state.party.members) || [];
    var totalQty = 0;
    box.innerHTML = plan.items.map(function (it, idx) {
      totalQty += it.quantity || 0;
      var assignee = it.shared || !it.assigneeId ? '' : it.assigneeId;
      var options = '<option value=""' + (assignee === '' ? ' selected' : '') + '>共享（均摊）</option>' +
        members.map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (assignee === m.id ? ' selected' : '') + '>' + esc(m.nickname || m.id) + '</option>';
        }).join('');
      return '<div class="ie-row" data-item-idx="' + idx + '">' +
        '<div class="ie-main">' +
          '<div class="ie-name">' + esc(it.name || it.productCode) + '</div>' +
          '<div class="ie-meta">' +
            '<span>' + money(it.unitPriceCents) + ' / 份</span>' +
            (it.novelty ? '<span class="pill">上新</span>' : '') +
            (it.components && it.components.length ? '<span>含 ' + esc(it.components.join('、')) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<select class="ie-assignee" data-role="assignee" aria-label="归属成员">' + options + '</select>' +
        '<span class="ie-qty">' +
          '<button type="button" class="ie-qty__btn" data-role="minus" aria-label="减少一份">' + icon('minus') + '</button>' +
          '<span class="ie-qty__n">' + (it.quantity || 1) + '</span>' +
          '<button type="button" class="ie-qty__btn" data-role="plus" aria-label="增加一份">' + icon('plus') + '</button>' +
        '</span>' +
        '<button type="button" class="ie-del" data-role="del" aria-label="移除">' + icon('trash') + '</button>' +
      '</div>';
    }).join('');
    if (countPill) countPill.textContent = plan.items.length + ' 项 · ' + totalQty + ' 份';
  }

  function renderMenu() {
    var box = $('#menuList');
    var countPill = $('#menuCount');
    if (!box) return;
    var m = state.menu;
    if (countPill) countPill.textContent = m.loaded ? m.items.length + ' 项在售' : '—';

    if (m.loading) {
      setInline($('#menuStatus'), '', loadingHtml('正在读取本店菜单…'));
      box.innerHTML = '<div style="padding:8px 0">' +
        '<div class="skeleton" style="height:34px;margin-bottom:8px"></div>'.repeat(6) + '</div>';
      return;
    }
    if (m.error) {
      setInline($('#menuStatus'), 'error', '菜单读取失败：' + esc(m.error) + '。可点「重新生成」重试。');
      box.innerHTML = '';
      return;
    }
    setInline($('#menuStatus'), '', '');

    var q = state.menuQuery.trim().toLowerCase();
    var items = m.items.filter(function (it) {
      if (!q) return true;
      var hay = [it.name, it.category, (it.tags || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) > -1;
    });

    if (!items.length) {
      box.innerHTML = '<p class="menu-empty">没有匹配「' + esc(state.menuQuery) + '」的餐品。</p>';
      return;
    }

    var groups = [];
    var index = {};
    items.slice(0, 240).forEach(function (it) {
      var cat = it.category || '其他';
      if (!index[cat]) { index[cat] = { name: cat, items: [] }; groups.push(index[cat]); }
      index[cat].items.push(it);
    });

    box.innerHTML = groups.map(function (g) {
      return '<div class="menu-group">' +
        '<div class="menu-group__title">' + esc(g.name) + ' · ' + g.items.length + '</div>' +
        g.items.map(function (it) {
          return '<div class="menu-item" data-add="' + esc(it.productCode) + '" role="button" tabindex="0">' +
            '<div class="menu-item__main">' +
              '<div class="menu-item__name">' + esc(it.name) + '</div>' +
              '<div class="menu-item__meta">' +
                (it.novelty ? '<span class="pill">上新</span>' : '') +
                (it.combo ? '<span class="pill">套餐</span>' : '') +
                '<span>' + esc(it.productCode) + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="text-align:right">' +
              '<div class="menu-item__price">' + money(it.priceCents) + '</div>' +
              (it.originalPriceCents > it.priceCents ? '<div class="menu-item__orig">' + money(it.originalPriceCents) + '</div>' : '') +
            '</div>' +
            '<button type="button" class="menu-item__add" data-add="' + esc(it.productCode) + '" aria-label="添加 ' + esc(it.name) + '">' + icon('plus') + '</button>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
  }

  function renderConfirmBox() {
    var box = $('#confirmBox');
    if (!box || !state.workingPlan) return;
    var plan = state.workingPlan;
    var pricing = plan.pricing || {};
    var pending = state.recalcPending;
    var failed = !!state.recalcError;
    var valid = !pending && !failed && pricing.ok === true;

    if (state.confirmedHere && state.party && state.party.status === 'confirmed') {
      box.innerHTML = '<div class="confirmed-card">' +
        '<h3>' + icon('check-circle') + ' 已保存为聚餐方案</h3>' +
        '<p>仅保存为聚餐方案，<b>未下单、未支付</b>。门店：' + esc((state.party.store && state.party.store.storeName) || '—') + '</p>' +
        '<button type="button" class="btn btn--primary btn--block" id="btnGoTicket">生成同桌票根' + icon('chevron') + '</button>' +
      '</div>';
      var goBtn = $('#btnGoTicket');
      if (goBtn) goBtn.addEventListener('click', enterTicket);
      return;
    }

    var budget = state.party ? Number(state.party.budgetTotal) : 0;
    var totalCents = valid ? Number(pricing.totalCents) || 0 : 0;
    var over = valid && totalCents > Math.round(budget * 100);
    var alloc = plan.allocation || [];
    var overMembers = alloc.filter(function (a) { return a.overBudget; }).length;
    var violated = 0;
    Object.keys(plan.wishResults || {}).forEach(function (mid) {
      var wr = plan.wishResults[mid] || {};
      violated += (wr.never || []).filter(function (x) { return x.status === 'violated'; }).length;
    });

    var checks = [];
    if (valid) {
      checks.push('<li>' + icon(over ? 'alert' : 'check', over ? 'bad' : 'ok') +
        (over ? '超出共同预算 ' + money(totalCents - Math.round(budget * 100)) : '在共同预算 ' + moneyYuan(budget) + ' 之内') + '</li>');
      checks.push('<li>' + icon(violated ? 'alert' : 'check', violated ? 'bad' : 'ok') +
        (violated ? violated + ' 条「不要」约束未被满足' : '所有「不要」硬约束均已避开') + '</li>');
      if (overMembers) {
        checks.push('<li>' + icon('alert', 'bad') + overMembers + ' 位成员超出个人预算（分账表已标记）</li>');
      } else {
        checks.push('<li>' + icon('check', 'ok') + '个人预算均在范围内</li>');
      }
    }

    var totalHtml = pending ? '核价中…' : failed ? '无有效价格' : valid ? money(totalCents) : '—';

    box.innerHTML =
      '<div class="confirm-box">' +
      '<div class="confirm-box__label">整单应付（官方核价）</div>' +
      '<div class="confirm-box__total">' + esc(totalHtml) + '</div>' +
      '<div class="confirm-box__sub">' + esc(pricing.ok ? ('核价时点 ' + fmtTime(pricing.quotedAt)) : '未取得官方核价') + '</div>' +
      '<ul class="confirm-box__list">' + checks.join('') + '</ul>' +
      '<div class="confirm-box__actions">' +
        '<button type="button" class="btn btn--primary btn--lg btn--block" id="btnConfirm"' +
          (valid ? '' : ' disabled') + '>' +
          (pending ? '核价中，请稍候…' : failed ? '核价失败，暂不可确认' : '确认这套方案') + '</button>' +
        '<button type="button" class="btn btn--ghost btn--block" id="btnBackPlans">换一个方案</button>' +
      '</div>' +
      '<p class="confirm-box__note">确认只会保存为聚餐方案，不会下单、不会领券、不会支付。价格以官方核价时点为准。</p>' +
      '</div>';

    var confirmBtn = $('#btnConfirm');
    if (confirmBtn) confirmBtn.addEventListener('click', doConfirm);
    var backBtn = $('#btnBackPlans');
    if (backBtn) backBtn.addEventListener('click', function () { goStep(3); });
  }

  function renderEdit() {
    var plan = state.workingPlan;
    if (!plan) return;
    var nameEcho = $('#editPlanName');
    if (nameEcho) nameEcho.textContent = (plan.name || strategyLabel(plan.strategy) || '方案') + ' · 方案 ' + (plan.planId || '');
    var stamp = $('#editQuoteStamp');
    if (stamp) {
      stamp.innerHTML = icon('clock') + (state.recalcPending ? '核价中…' : '核价时点 ' + esc(fmtTime((plan.pricing || {}).quotedAt)));
    }

    var sceneMount = $('#tableSceneMount');
    if (sceneMount) {
      // 核价中/失败时不展示任何金额，避免旧价被当成有效结果
      var showMoney = !state.recalcPending && !state.recalcError;
      sceneMount.innerHTML = tableSceneHtml(plan, { showPrice: showMoney });
    }
    renderItemEditor();
    renderBill();
    renderConfirmBox();
    var strip = $('#recalcStrip');
    if (strip) strip.hidden = !state.recalcPending;
    var errBox = $('#recalcError');
    if (errBox) errBox.hidden = !state.recalcError;
    var errTextEl = $('#recalcErrorText');
    if (errTextEl) errTextEl.textContent = state.recalcError ? '（' + state.recalcError + '）' : '';

    requestAnimationFrame(function () { layoutAllScenes(); });
  }

  /* ========================================================================
   * 3.6 渲染器：票根
   * ===================================================================== */

  function hasTicketRenderer() {
    return !!(window.TicketRenderer && typeof window.TicketRenderer.render === 'function');
  }

  function defaultVisibleFields() {
    var out = {};
    TICKET_FIELDS.forEach(function (f) { out[f] = true; });
    return out;
  }

  function renderTicketPreview() {
    var box = $('#ticketPreview');
    if (!box) return;
    var ticket = state.ticket;
    if (!ticket) {
      box.innerHTML = '<p class="muted">还没有票根数据。</p>';
      return;
    }

    if (!hasTicketRenderer()) {
      box.innerHTML = ticketFallbackHtml(ticket);
      var btn = $('#btnDownload');
      if (btn) {
        btn.disabled = true;
        btn.title = '票根渲染器（ticket.js）未加载，暂时无法导出图片';
      }
      var pv0 = $('#btnPreviewExport');
      if (pv0) { pv0.disabled = true; pv0.title = '票根渲染器未加载'; }
      return;
    }

    box.innerHTML = '';
    var layout = state.ticketOptions.layout || DEFAULT_LAYOUT;
    try {
      // 预览始终走 DOM 渲染（ticket.js 1.1.0 起按 layout 重排双栏）：
      // 预览按屏宽等比缩放、不裁切内容，真正的 1080×… 像素只在导出时成立。
      window.TicketRenderer.render(box, ticket, { preview: true, layout: layout });
      var dl = $('#btnDownload');
      if (dl) { dl.disabled = false; dl.title = ''; }
      var pv = $('#btnPreviewExport');
      if (pv) { pv.disabled = false; pv.textContent = '查看导出效果'; }
    } catch (e) {
      box.innerHTML = ticketFallbackHtml(ticket) +
        '<p class="muted" style="font-size:12px;text-align:center;margin-top:10px">票根渲染出错：' + esc(errText(e)) + '</p>';
      var b2 = $('#btnDownload');
      if (b2) { b2.disabled = true; b2.title = '票根渲染出错，暂时无法导出'; }
      var pv2 = $('#btnPreviewExport');
      if (pv2) { pv2.disabled = true; }
    }
  }

  function ticketFallbackHtml(t) {
    var vis = t.fieldsVisible || defaultVisibleFields();
    var rows = [];
    if (vis.date) rows.push(['日期', t.date || '—']);
    if (vis.members) rows.push(['成员', (t.members || []).join('、') || '—']);
    if (vis.items && t.items && t.items.length) {
      rows.push(['餐品', t.items.map(function (it) {
        return it.name + ' ×' + it.quantity + (it.assignee ? '（' + it.assignee + '）' : '');
      }).join('；')]);
    }
    if (vis.wishes && t.wishes && t.wishes.length) {
      rows.push(['小心愿', t.wishes.map(function (w) {
        return w.member + '：' + w.wish + (w.byProduct ? ' → ' + w.byProduct : '');
      }).join('；')]);
    }
    var dl = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');
    return '<div class="ticket-fallback">' +
      '<p class="eyebrow" style="justify-content:center">麦麦同席 · 同桌票根</p>' +
      (vis.title ? '<h3>' + esc(t.title || '') + '</h3>' : '') +
      '<p>' + esc(t.statusLabel || '计划中') + ' · ' + esc(t.ticketId || '') + '</p>' +
      (vis.themeLine ? '<p style="font-family:var(--font-serif);font-size:15px;margin-top:10px">「' + esc(t.themeLine || '') + '」</p>' : '') +
      (dl ? '<dl>' + dl + '</dl>' : '') +
      '<p class="muted" style="margin-top:14px;font-size:11.5px">票根渲染器未加载（ticket.js），以下为文字版预览。数据仍来自服务端票根模型。</p>' +
    '</div>';
  }

  function renderTicketControls() {
    var fieldBox = $('#fieldToggles');
    var nickBox = $('#nickEditor');
    if (!fieldBox || !nickBox) return;
    var ticket = state.ticket || {};
    var vis = ticket.fieldsVisible || defaultVisibleFields();
    var opts = state.ticketOptions;

    fieldBox.innerHTML = TICKET_FIELDS.map(function (f) {
      var checked = Object.prototype.hasOwnProperty.call(vis, f) ? vis[f] : true;
      return '<label class="check"><input type="checkbox" data-field="' + f + '"' + (checked ? ' checked' : '') + ' />' +
        '<span>' + esc(FIELD_LABELS[f] || f) + '</span></label>';
    }).join('');

    var members = (state.party && state.party.members) || [];
    nickBox.innerHTML = members.map(function (m) {
      return '<div class="nick-row">' +
        '<span class="nick-row__from" title="' + esc(m.nickname) + '">' + esc(m.nickname) + '</span>' +
        '<input type="text" maxlength="12" data-nickname="' + esc(m.id) + '" value="' +
          esc(opts.nicknames[m.id] || '') + '" placeholder="' + esc(m.nickname) + '" autocomplete="off" />' +
      '</div>';
    }).join('');

    var themeInput = $('#themeLine');
    if (themeInput) themeInput.value = opts.themeLine || '';

    var radios = $$('input[name="ticketStatus"]');
    radios.forEach(function (r) { r.checked = (r.value === (ticket.status || 'planning')); });

    var hiddenList = $('#hiddenFieldsList');
    if (hiddenList && ticket.hiddenFields && ticket.hiddenFields.length) {
      hiddenList.innerHTML = ticket.hiddenFields.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('');
    }

    renderNoteEditor();
    renderPhotoBlock();
    renderLayoutControls();
    renderPrefConsent();
    renderLinkResult();
  }

  /* ========================================================================
   * 3.7 P1：票根增强（合照 / 每人一句话 / 下次约定 / 版式）
   * ===================================================================== */

  /** 版式分段控件 + 导出像素小字：版式决定导出尺寸，文字必须跟着变 */
  function renderLayoutControls() {
    var layout = state.ticketOptions.layout || DEFAULT_LAYOUT;
    $$('input[name="ticketLayout"]').forEach(function (r) {
      r.checked = (r.value === layout);
    });
    var conf = TICKET_LAYOUTS[layout] || TICKET_LAYOUTS[DEFAULT_LAYOUT];
    var hint = $('#layoutHint');
    if (hint) hint.textContent = conf.hint;
    var sizeHint = $('#exportSizeHint');
    if (sizeHint) sizeHint.textContent = conf.label + ' · ' + conf.size;
    var note = $('.ticket-preview-note');
    if (note && layout === 'portrait') {
      note.textContent = '预览按屏幕宽度等比缩放；导出 ' + conf.size + '（2 倍像素）。';
    }
  }

  function renderNoteEditor() {
    var box = $('#noteEditor');
    if (!box) return;
    var members = (state.party && state.party.members) || [];
    var notes = state.ticketOptions.notes || {};
    if (!members.length) {
      box.innerHTML = '<p class="muted" style="font-size:12.5px">还没有成员。</p>';
      return;
    }
    box.innerHTML = members.map(function (m) {
      return '<div class="note-row">' +
        '<span class="note-row__who">' +
          '<span class="note-row__dot" style="background:' + colorForMember(m.id) + '"></span>' +
          '<span class="note-row__name" title="' + esc(m.nickname) + '">' + esc(m.nickname) + '</span>' +
        '</span>' +
        '<input type="text" maxlength="' + NOTE_MAX + '" data-note="' + esc(m.id) + '" value="' +
          esc(notes[m.id] || '') + '" placeholder="如：今晚很尽兴" autocomplete="off" />' +
      '</div>';
    }).join('');
  }

  /** dataURL 的长度（base64 字符数）；票根的 600KB 限制按 dataURL 长度算 */
  function outputLen(s) { return String(s || '').length; }

  function renderPhotoBlock() {
    var wrap = $('#photoPreview');
    var img = $('#photoPreviewImg');
    var rm = $('#btnRemovePhoto');
    var has = !!state.ticketOptions.photo;
    if (wrap && img) {
      wrap.hidden = !has;
      if (has) img.src = state.ticketOptions.photo;
      else img.removeAttribute('src');
    }
    if (rm) rm.hidden = !has;
  }

  function setPhotoStatus(kind, text) {
    var el = $('#photoStatus');
    if (el) setInline(el, kind, text ? esc(text) : '');
  }

  /**
   * 前端压图：长边 ≤1200、jpeg 0.82；超 600KB 依次降到 (900,0.7)、(720,0.62)。
   * 全部失败就明确报错——不把超限图片发给后端，避免被静默丢弃后出现「照片没了但提示已保存」。
   */
  function compressPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('没有读到文件')); return; }
      if (file.type && file.type.indexOf('image/') !== 0) {
        reject(new Error('请选择图片文件（jpg / png / webp）')); return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读取图片失败，换一张试试')); };
      reader.onload = function () {
        var dataUrl = String(reader.result || '');
        var image = new Image();
        image.onerror = function () { reject(new Error('这张图片无法解码，换一张试试')); };
        image.onload = function () {
          var attempts = [
            { edge: PHOTO_MAX_EDGE, quality: 0.82 },
            { edge: 900, quality: 0.7 },
            { edge: 720, quality: 0.62 }
          ];
          var out = '';
          for (var i = 0; i < attempts.length; i++) {
            try {
              out = drawScaledJpeg(image, attempts[i].edge, attempts[i].quality);
            } catch (e) {
              reject(new Error('当前浏览器无法压缩图片（' + errText(e) + '）'));
              return;
            }
            if (out && out.length <= PHOTO_MAX_LEN) { resolve(out); return; }
          }
          reject(new Error('照片压缩后仍有 ' + Math.round(outputLen(out) / 1024) +
            'KB，超过 600KB 上限。请换一张更小的图片。'));
        };
        image.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function drawScaledJpeg(image, maxEdge, quality) {
    var w = image.naturalWidth || image.width;
    var h = image.naturalHeight || image.height;
    if (!w || !h) throw new Error('图片尺寸为空');
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx || typeof canvas.toDataURL !== 'function') throw new Error('缺少 canvas 支持');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(image, 0, 0, cw, ch);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function handlePhotoPick(file) {
    if (!file) return;
    setPhotoStatus('', '正在压缩照片…');
    compressPhoto(file).then(function (dataUrl) {
      state.ticketOptions.photo = dataUrl;
      setPhotoStatus('ok', '照片已就绪（' + Math.round(outputLen(dataUrl) / 1024) + 'KB），保存后刷新也不会丢。');
      renderPhotoBlock();
      submitTicketDebounced();
    }).catch(function (err) {
      setPhotoStatus('error', '照片处理失败：' + errText(err));
      toast('照片处理失败：' + errText(err), 'error', 6000);
    });
  }

  function removePhoto() {
    if (!state.ticketOptions.photo) return;
    state.ticketOptions.photo = '';
    setPhotoStatus('', '照片已移除，正在更新票根…');
    renderPhotoBlock();
    submitTicketDebounced();
  }


  /* ========================================================================
   * 3.8 P1：原班人马，再吃一次（第 1 步）
   * ===================================================================== */

  var flashTimer = null;

  function flash(el) {
    if (!el) return;
    el.classList.add('is-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.classList.remove('is-flash'); }, 1400);
  }

  function highlightStoreArea() {
    var list = $('#storeList');
    var fieldset = list ? list.closest('fieldset') : null;
    var target = fieldset || list;
    if (target && target.scrollIntoView) {
      try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* 老浏览器忽略参数 */ }
    }
    flash(target);
    var kw = $('#fKeyword');
    if (kw) kw.focus();
  }

  function highlightBudget() {
    var input = $('#fBudget');
    if (!input) return;
    var field = input.closest('.field');
    flash(field || input);
    input.focus();
  }

  function freshTicketOptions() {
    return {
      nicknames: {}, visibleFields: TICKET_FIELDS.slice(), themeLine: '',
      notes: {}, nextMeet: '', photo: '', layout: DEFAULT_LAYOUT
    };
  }

  function loadPreferenceGroups() {
    if (state.prefLoading) return Promise.resolve(state.prefGroups);
    state.prefLoading = true;
    return API.preferenceGroups().then(function (res) {
      state.prefLoading = false;
      state.prefLoaded = true;
      state.prefGroups = (res.groups || []).filter(function (g) { return g && g.groupId; });
      renderRevisitBox();
      renderPrefGroupList('');
      return state.prefGroups;
    }).catch(function (err) {
      state.prefLoading = false;
      state.prefGroups = [];
      renderRevisitBox();
      renderPrefGroupList(errText(err));
      return [];
    });
  }

  function renderRevisitBox() {
    var box = $('#revisitBox');
    var list = $('#revisitList');
    var more = $('#revisitMore');
    if (!box || !list) return;
    var groups = state.prefGroups || [];
    if (!groups.length) {
      box.hidden = true;
      list.innerHTML = '';
      if (more) more.hidden = true;
      return;
    }
    box.hidden = false;
    var expanded = state.prefShowAll || groups.length <= MAX_PREF_CARDS;
    var shown = expanded ? groups : groups.slice(0, MAX_PREF_CARDS);
    list.innerHTML = shown.map(function (g) {
      var names = (g.nicknames || []).filter(function (n) { return !!n; });
      var count = g.memberCount || names.length;
      return '<article class="revisit-card">' +
        '<div class="revisit-card__top">' +
          '<span class="revisit-card__title" title="' + esc(g.title || '上次这群人') + '">' + esc(g.title || '上次这群人') + '</span>' +
          '<span class="pill">' + esc(count + ' 人') + '</span>' +
        '</div>' +
        '<p class="revisit-card__who">' + esc(names.join('、') || '（无昵称）') + '</p>' +
        '<p class="revisit-card__meta">' + esc((g.wishCount || 0) + ' 条心愿 · ' + fmtTime(g.createdAt)) + '</p>' +
        '<button type="button" class="btn btn--primary btn--sm btn--block" data-revisit="' + esc(g.groupId) + '">带入这次聚餐</button>' +
      '</article>';
    }).join('');
    if (more) {
      more.hidden = groups.length <= MAX_PREF_CARDS;
      more.textContent = state.prefShowAll ? '收起' : '查看全部（' + groups.length + '）';
    }
  }

  /** 再聚时提交的门店对象：与第 1 步创建聚餐时同构，保证后续菜单/核价口径一致 */
  function currentStorePayload() {
    var s = state.selectedStore;
    if (!s) return null;
    var beType = readBeType();
    return {
      storeCode: s.storeCode,
      storeName: s.storeName,
      address: s.address || null,
      reservation: s.reservation === undefined ? null : s.reservation,
      city: ($('#fCity') ? $('#fCity').value.trim() : '') || null,
      beType: beType,
      orderType: 1,
      beCode: beType === 5 ? (s.beCode || null) : null,
      reservationDate: ($('#fReservation') ? $('#fReservation').value.trim() : '') || null
    };
  }

  function showRevisitBanner(text) {
    var banner = $('#revisitBanner');
    var label = $('#revisitBannerText');
    if (!banner || !label) return;
    label.textContent = text || '已带入上次心愿；价格不会沿用，需重新生成方案核价。';
    banner.hidden = false;
  }

  function handleRevisit(groupId) {
    var gid = String(groupId || '');
    if (!gid) return;
    var tip = $('#formTip');
    if (!state.selectedStore) {
      toast('先选门店：再聚也要按当前门店查菜单、重新核价。', 'warn', 5200);
      setInline($('#storeStatus'), 'error', '先在下面选一家门店，再带入上次的心愿。');
      if (tip) { tip.className = 'form-foot__tip is-error'; tip.textContent = '请先选门店，再带入上次的聚餐。'; }
      highlightStoreArea();
      return;
    }
    var budget = Number($('#fBudget').value);
    if (!isFinite(budget) || budget <= 0) {
      toast('先填这次聚餐的共同预算。', 'warn', 4200);
      if (tip) { tip.className = 'form-foot__tip is-error'; tip.textContent = '共同预算需要大于 0，才能带入上次的心愿。'; }
      highlightBudget();
      return;
    }

    var btn = $('[data-revisit="' + gid + '"]');
    var original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 带入中…'; }
    if (tip) { tip.className = 'form-foot__tip'; tip.textContent = '正在带入上次的心愿…'; }

    API.revisit(gid, {
      store: currentStorePayload(),
      budgetTotal: budget,
      title: $('#fTitle').value.trim() || undefined
    }).then(function (res) {
      if (!res || !res.party) throw new Error('接口没有返回新的聚餐');
      applyRevisitParty(res.party, budget);
      renderRevisitBox();
      showRevisitBanner(res.notice);
      if (tip) { tip.className = 'form-foot__tip'; tip.textContent = '已带入上次的心愿：' + res.party.title + '。'; }
      toast('已带入上次的心愿，接着核对成员心愿。价格需要重新生成方案后核价。', 'ok', 5600);
      goStep(2);
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
      if (tip) { tip.className = 'form-foot__tip is-error'; tip.textContent = '带入失败：' + errText(err); }
      toast('带入上次心愿失败：' + errText(err), 'error', 6000);
    });
  }

  function applyRevisitParty(party, budget) {
    state.party = party;
    state.members = normalizeMembers(party.members || [], party.memberCount || 3);
    state.memberIndex = 0;
    state.showAllMembers = false;
    state.prefillMembers = null;
    state.plans = [];
    state.meta = null;
    state.workingPlan = null;
    state.editPlanId = null;
    state.menu = { items: [], loaded: false, loading: false, error: null };
    state.menuQuery = '';
    state.confirmedHere = false;
    state.ticket = null;
    state.ticketOptions = freshTicketOptions();
    state.photoSent = '';
    state.linkedOrder = null;
    state.linkDiag = null;
    state.linkConfirmed = false;
    state.linkingId = null;

    var grid = $('#planGrid');
    if (grid) grid.innerHTML = '';
    setInline($('#planStatus'), '', '');
    var toggle = $('#toggleAllMembers');
    if (toggle) { toggle.classList.remove('is-on'); toggle.textContent = '全部展开编辑'; }

    $('#fTitle').value = party.title || $('#fTitle').value;
    $('#fMemberCount').value = String(party.memberCount || state.members.length || 3);
    $('#fBudget').value = String(budget);
    if (party.store && party.store.city) $('#fCity').value = party.store.city;
    updateFormTip();
  }

  /* ========================================================================
   * 3.9 P1：关联真实订单（只读）
   * ===================================================================== */

  function tail4(orderId) {
    var s = String(orderId || '');
    return s.length > 4 ? s.slice(-4) : s;
  }

  function orderSummary(items) {
    var list = Array.isArray(items) ? items : [];
    if (!list.length) return '餐品未返回';
    var text = list.slice(0, 2).map(function (it) {
      return (it.name || it.productCode || '餐品') + '×' + (it.quantity || 1);
    }).join('、');
    if (list.length > 2) text += ' 等 ' + list.length + ' 件';
    return text;
  }

  function openOrderSheet() {
    var sheet = $('#orderSheet');
    var scrim = $('#orderSheetScrim');
    if (!sheet || !scrim) return;
    sheet.hidden = false;
    scrim.hidden = false;
    syncPageLock();
    var closeBtn = $('#closeOrderSheet');
    if (closeBtn) closeBtn.focus();
    if (!state.orders.loaded || state.orders.error) loadOrders();
    else renderOrders();
    renderLinkResult();
  }

  function closeOrderSheet() {
    var sheet = $('#orderSheet');
    var scrim = $('#orderSheetScrim');
    if (sheet) sheet.hidden = true;
    if (scrim) scrim.hidden = true;
    syncPageLock();
  }

  function loadOrders() {
    var box = $('#orderList');
    if (!box) return;
    if (state.orders.loading) return;
    state.orders.loading = true;
    state.orders.error = null;
    box.innerHTML = '';
    setInline($('#orderStatus'), '', loadingHtml('正在读取你的麦当劳订单（只读，不会下单）…'));
    API.orders().then(function (res) {
      state.orders.loading = false;
      state.orders.loaded = true;
      state.orders.items = res.orders || [];
      renderOrders();
    }).catch(function (err) {
      state.orders.loading = false;
      state.orders.error = errText(err);
      if (box) box.innerHTML = '<button type="button" class="btn btn--ghost btn--block" id="btnReloadOrders">重新读取订单</button>';
      setInline($('#orderStatus'), 'error', '订单读取失败：' + esc(errText(err)));
      toast('订单读取失败：' + errText(err), 'error');
    });
  }

  function renderOrders() {
    var box = $('#orderList');
    if (!box) return;
    var list = state.orders.items || [];
    if (state.orders.loading) return;
    if (!list.length) {
      box.innerHTML = '<p class="order-empty">没有查到订单。订单需要你自己在麦当劳 App / 小程序里完成后，才会出现在这里。</p>';
      setInline($('#orderStatus'), '', '没有可关联的订单。');
      return;
    }
    setInline($('#orderStatus'), '', '共 ' + list.length + ' 条可核对订单；订单号只显示后 4 位，金额仅供你自己核对。');
    box.innerHTML = list.map(function (o) {
      var active = state.linkingId === o.orderId;
      var amount = (o.amountCents === null || o.amountCents === undefined) ? '金额未返回' : money(o.amountCents);
      return '<button type="button" class="order-card' + (active ? ' is-active' : '') + '" data-order="' + esc(o.orderId) + '">' +
        '<span class="order-card__top">' +
          '<span class="order-card__store">' + esc(o.storeName || '门店未返回') + '</span>' +
          '<span class="order-card__status">' + esc(o.status || '状态未知') + '</span>' +
        '</span>' +
        '<span class="order-card__meta">' + esc(fmtTime(o.createTime)) + ' · 订单 …' + esc(tail4(o.orderId)) + '</span>' +
        '<span class="order-card__items">' + esc(orderSummary(o.items)) + '</span>' +
        '<span class="order-card__amount">' + esc(amount) + (active ? ' · <span class="order-card__doing">核对中…</span>' : '') + '</span>' +
      '</button>';
    }).join('');
  }

  function linkOrder(orderId) {
    if (!state.party || !state.party.id) { toast('还没有可关联的聚餐。', 'warn'); return; }
    if (!orderId || state.linkingId) return;
    state.linkingId = orderId;
    renderOrders();
    setInline($('#orderStatus'), '', loadingHtml('正在核对这条订单与本次聚餐是否一致…'));
    var warnBox = $('#linkWarnBox');
    if (warnBox) { warnBox.hidden = true; warnBox.innerHTML = ''; }
    API.linkOrder(state.party.id, orderId).then(function (res) {
      state.linkingId = null;
      state.linkedOrder = res.linkedOrder || null;
      state.linkDiag = res.diagnostics || null;
      var warnings = (res.diagnostics && res.diagnostics.warnings) || [];
      // 有警告时先不算「关联成功」：必须用户自己勾选确认后才放出后续操作
      state.linkConfirmed = !warnings.length;
      renderOrders();
      setInline($('#orderStatus'), warnings.length ? 'warn' : 'ok', esc(res.notice || '订单已关联。'));
      renderLinkWarnings(warnings);
      renderLinkResult();
      if (!warnings.length) toast('订单已关联，核对没有发现不一致。', 'ok', 5200);
      else toast('订单已记录，但有 ' + warnings.length + ' 条不一致，需要你确认。', 'warn', 6500);
    }).catch(function (err) {
      state.linkingId = null;
      renderOrders();
      setInline($('#orderStatus'), 'error', '关联失败：' + esc(errText(err)));
      toast('关联订单失败：' + errText(err), 'error');
    });
  }

  function renderLinkWarnings(warnings) {
    var box = $('#linkWarnBox');
    if (!box) return;
    if (!warnings || !warnings.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<div class="link-warn__head">' + icon('alert') + '<strong>这几点对不上，请自己确认</strong></div>' +
      '<ul class="link-warn__list">' +
        warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') +
      '</ul>' +
      '<label class="check check--confirm">' +
        '<input type="checkbox" id="linkConfirm"' + (state.linkConfirmed ? ' checked' : '') + ' />' +
        '<span>我确认这就是这次聚餐的订单</span>' +
      '</label>' +
      '<p class="link-warn__hint" id="linkWarnHint">' + (state.linkConfirmed
        ? '已确认：可以回到票根继续标记「已完成」。'
        : '勾选之后才会显示后续操作；不勾选就当作还没关联成功。') + '</p>';
  }

  function renderLinkResult() {
    var box = $('#linkResult');
    if (!box) return;
    var lo = state.linkedOrder;
    if (!lo) {
      box.innerHTML = '<p class="inline-status">还没有关联订单。关联只做事实核对，不会改动订单。</p>';
      return;
    }
    var diag = state.linkDiag || lo;
    var statusCompleted = !!(diag.statusCompleted || lo.statusCompleted);
    var html = '<div class="linked-order">' +
      '<p class="linked-order__title">' + icon('check-circle') + '已关联订单 …' + esc(tail4(lo.orderId)) + '</p>' +
      '<p class="linked-order__meta">' + esc(lo.storeName || '门店未返回') + ' · ' +
        esc(fmtTime(lo.createTime)) + ' · ' + esc(lo.status || '状态未知') + '</p>' +
    '</div>';
    // 刷新后只剩 linkedOrder 上的布尔结论：据实复述，不改写、不重新判定
    var flags = [];
    if (diag.storeMatch === false) flags.push('门店与本次聚餐不一致');
    if (diag.timeOk === false) flags.push('下单时间早于聚餐创建时间');
    if (state.linkDiag && diag.itemOverlap === 0) flags.push('餐品与已确认方案没有重合');
    if (flags.length && state.linkConfirmed) {
      html += '<p class="inline-status is-warn">关联记录里的不一致：' + esc(flags.join('；')) + '（已按你的确认保留）</p>';
    }
    if (!state.linkConfirmed) {
      html += '<p class="inline-status is-warn">关联结果有未消项：请在订单弹层里勾选「我确认这就是这次聚餐的订单」。</p>';
    } else if (statusCompleted) {
      var done = state.party && state.party.status === 'completed';
      html += '<button type="button" class="btn btn--primary btn--block" id="btnMarkCompleted"' + (done ? ' disabled' : '') + '>' +
        (done ? '这顿已标记为已完成' : '把这顿标记为已完成') + '</button>';
    } else {
      html += '<p class="inline-status">该订单状态还不是「已完成」。等订单完成后再关联一次即可。</p>';
    }
    box.innerHTML = html;
    var btn = $('#btnMarkCompleted');
    if (btn) btn.addEventListener('click', markCompletedFromOrder);
  }

  function markCompletedFromOrder() {
    confirmDialog({
      title: '把这顿标记为已完成？',
      html: '<p>已关联你在麦当劳的订单，但只有你亲自确认这顿真的发生了，才会标记「已完成」。</p>' +
        '<p class="muted">标记后票根会显示「已完成」，并写进本地聚餐记录。</p>',
      okText: '确认已完成',
      danger: false
    }).then(function (ok) { if (ok) setPartyCompleted(true); });
  }

  /* ========================================================================
   * 3.10 P1：保存这群人的口味（逐人授权）
   * ===================================================================== */

  function renderPrefConsent() {
    var box = $('#prefConsentList');
    if (!box) return;
    var members = (state.party && state.party.members) || [];
    if (!members.length) {
      box.innerHTML = '<p class="muted" style="font-size:12.5px">还没有成员，无法保存偏好。</p>';
      updatePrefSaveButton();
      return;
    }
    var keep = {};
    $$('[data-consent]', box).forEach(function (cb) { keep[cb.getAttribute('data-consent')] = cb.checked; });
    box.innerHTML = members.map(function (m) {
      return '<label class="check check--consent">' +
        '<input type="checkbox" data-consent="' + esc(m.id) + '"' + (keep[m.id] ? ' checked' : '') + ' />' +
        '<span><b>' + esc(m.nickname || '成员') + '</b> 同意保存我的口味偏好（不含个人预算）</span>' +
      '</label>';
    }).join('');
    updatePrefSaveButton();
  }

  function consentIds() {
    return $$('#prefConsentList [data-consent]').filter(function (cb) { return cb.checked; })
      .map(function (cb) { return cb.getAttribute('data-consent'); });
  }

  function updatePrefSaveButton() {
    var ids = consentIds();
    var btn = $('#btnSavePrefs');
    if (btn && !state.prefSaving) btn.disabled = !ids.length;
    var hint = $('#prefSaveHint');
    if (!hint) return;
    if (ids.length) setInline(hint, '', '已勾选 ' + ids.length + ' 位成员；只保存他们的昵称与三档心愿。');
    else setInline(hint, '', '至少勾选 1 位成员才能保存。');
  }

  function savePreferences() {
    if (!state.party || !state.party.id) { toast('还没有可保存的聚餐。', 'warn'); return; }
    var ids = consentIds();
    if (!ids.length) {
      setInline($('#prefSaveStatus'), 'error', '先至少勾选 1 位成员（默认不勾选，必须本人同意）。');
      toast('至少勾选 1 位成员才能保存偏好。', 'warn');
      return;
    }
    state.prefSaving = true;
    var btn = $('#btnSavePrefs');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 保存中…'; }
    setInline($('#prefSaveStatus'), '', loadingHtml('正在保存已授权成员的心愿…'));

    API.savePreferences(state.party.id, ids.map(function (mid) {
      return { memberId: mid, consent: true };
    })).then(function (res) {
      state.prefSaving = false;
      if (btn) btn.innerHTML = '保存偏好';
      var extra = (res.skipped && res.skipped.length)
        ? ' 未授权的 ' + res.skipped.join('、') + ' 没有任何数据被保存。'
        : '';
      setInline($('#prefSaveStatus'), 'ok', esc((res.notice || '已保存') + extra));
      toast('口味偏好已保存（' + ((res.saved || []).length) + ' 位成员）。', 'ok', 5600);
      $$('#prefConsentList [data-consent]').forEach(function (cb) { cb.checked = false; });
      updatePrefSaveButton();
      loadPreferenceGroups();
    }).catch(function (err) {
      state.prefSaving = false;
      if (btn) btn.innerHTML = '保存偏好';
      updatePrefSaveButton();
      setInline($('#prefSaveStatus'), 'error', '保存失败：' + esc(errText(err)));
      toast('保存偏好失败：' + errText(err), 'error', 6000);
    });
  }

  function renderPrefGroupList(errorText) {
    var box = $('#prefGroupList');
    if (!box) return;
    if (errorText) {
      box.innerHTML = '<p class="inline-status is-error">读取失败：' + esc(errorText) + '</p>';
      return;
    }
    var groups = state.prefGroups || [];
    if (!groups.length) {
      box.innerHTML = '<p class="muted">还没有保存过口味偏好。在第 5 步逐人勾选同意后可保存。</p>';
      return;
    }
    box.innerHTML = groups.map(function (g) {
      var names = (g.nicknames || []).filter(function (n) { return !!n; });
      return '<div class="pref-group">' +
        '<div class="pref-group__main">' +
          '<span class="pref-group__who">' + esc(names.join('、') || '（无昵称）') + '</span>' +
          '<span class="pref-group__meta">' + esc((g.memberCount || names.length) + ' 人 · ' +
            (g.wishCount || 0) + ' 条心愿 · ' + fmtTime(g.createdAt)) + '</span>' +
        '</div>' +
        '<button type="button" class="btn btn--sm btn--danger" data-del-pref="' + esc(g.groupId) + '">删除</button>' +
      '</div>';
    }).join('');
  }

  function deletePreferenceGroup(groupId) {
    var gid = String(groupId || '');
    if (!gid) return;
    var group = null;
    for (var i = 0; i < state.prefGroups.length; i++) {
      if (state.prefGroups[i].groupId === gid) group = state.prefGroups[i];
    }
    var names = ((group && group.nicknames) || []).filter(Boolean).join('、') || '这组偏好';
    confirmDialog({
      title: '撤回这组口味偏好？',
      html: '<p>将删除「' + esc(names) + '」的昵称与三档心愿记录。</p>' +
        '<p class="muted">删除即撤回授权，不可恢复；已经生成的票根不受影响。</p>',
      okText: '确认删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      API.deletePreference(gid).then(function (res) {
        state.prefGroups = state.prefGroups.filter(function (g) { return g.groupId !== gid; });
        renderRevisitBox();
        renderPrefGroupList('');
        toast((res && res.notice) || '已撤回这组口味偏好。', 'ok', 5200);
      }).catch(function (err) {
        toast('删除失败：' + errText(err), 'error');
      });
    });
  }

  /* ========================================================================
   * 4. 步骤控制器
   * ===================================================================== */

  var PANELS = [1, 2, 3, 4, 5];

  function canEnter(step) {
    if (step === 1) return true;
    if (!state.party || !state.party.id) return false;
    if (step === 2) return true;
    if (step === 3) return true;
    if (step === 4) return !!(state.workingPlan && state.plans.length);
    if (step === 5) return state.party.status === 'confirmed' || state.party.status === 'completed';
    return false;
  }

  function goStep(step, opts) {
    opts = opts || {};
    if (!canEnter(step)) {
      if (step === 4) toast('先在第 3 步选一套方案，再来调整。', 'warn');
      else if (step === 5) toast('先在第四步确认一套方案，才能生成票根。', 'warn');
      else toast('先完成前面的步骤。', 'warn');
      return;
    }
    state.step = step;
    PANELS.forEach(function (n) {
      var panel = $('#panel-' + n);
      if (panel) panel.hidden = (n !== step);
    });
    $$('#stepNav .step').forEach(function (li) {
      var n = Number(li.getAttribute('data-step'));
      var locked = !canEnter(n);
      li.classList.toggle('is-active', n === step);
      li.classList.toggle('is-done', n < step);
      li.classList.toggle('is-locked', locked);
      var btn = $('.step__btn', li);
      if (btn) {
        btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
        if (n === step) btn.setAttribute('aria-current', 'step');
        else btn.removeAttribute('aria-current');
      }
    });
    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: 'auto' });

    if (step === 2) {
      if (!state.members.length) {
        state.members = normalizeMembers((state.party && state.party.members) || [], (state.party && state.party.memberCount) || 4);
      }
      renderMemberStage();
    }
    if (step === 3) {
      if (!state.plans.length && !opts.skipAuto) {
        // 直接点步骤条进入第 3 步时，自动生成一次，避免空白页
        generatePlans();
        return;
      }
      if (state.plans.length) renderPlans();
    }
    if (step === 4) {
      renderEdit();
      if (!state.menu.loaded && !state.menu.loading) loadMenu();
    }
    if (step === 5) {
      renderTicketControls();
      renderTicketPreview();
    }
    requestAnimationFrame(function () { layoutAllScenes(); });
  }

  /* ---------------- 步骤 1：创建聚餐 ---------------- */

  function readBeType() {
    var el = $('input[name="beType"]:checked');
    return el ? Number(el.value) : 1;
  }

  function queryStores(opts) {
    opts = opts || {};
    var city = $('#fCity').value.trim();
    var keyword = $('#fKeyword').value.trim();
    var beType = readBeType();
    if (!city) { setInline($('#storeStatus'), 'error', '请先填城市。'); return Promise.resolve([]); }
    if (!keyword) { setInline($('#storeStatus'), 'error', '请填一个商圈或地标关键词。'); return Promise.resolve([]); }

    state.storeQuery = { city: city, keyword: keyword, beType: beType };
    var listBox = $('#storeList');
    if (listBox) listBox.innerHTML = '';
    setInline($('#storeStatus'), '', loadingHtml('正在查询「' + city + ' · ' + keyword + '」的门店…'));

    return API.stores(city, keyword, beType).then(function (res) {
      var stores = res.stores || [];
      state.stores = stores;
      if (opts.selectFirst && stores.length) {
        state.selectedStore = stores[0];
      } else if (state.selectedStore) {
        var still = stores.filter(function (s) { return s.storeCode === state.selectedStore.storeCode; })[0];
        state.selectedStore = still || null;
      }
      renderStores(stores);
      if (stores.length) {
        setInline($('#storeStatus'), 'ok', '找到 ' + stores.length + ' 家门店' +
          (res.dataTime ? '，数据时点 ' + fmtTime(res.dataTime) : '') +
          (res.source === 'replay' ? '（离线回放）' : '') + '。');
        if (res.dataTime) setDataTime(res.dataTime);
        if (res.source === 'replay') { var b = $('#replayBanner'); if (b) b.hidden = false; }
      }
      return stores;
    }).catch(function (err) {
      state.stores = [];
      setInline($('#storeStatus'), 'error', '门店查询失败：' + esc(errText(err)));
      return [];
    });
  }

  function applyDemo() {
    $('#fTitle').value = DEMO.title;
    $('#fMemberCount').value = String(DEMO.memberCount);
    $('#fCity').value = DEMO.city;
    $('#fKeyword').value = DEMO.keyword;
    $('#fBudget').value = String(DEMO.budget);
    $('#fReservation').value = DEMO.reservation;
    var radio = $('input[name="beType"][value="' + DEMO.beType + '"]');
    if (radio) radio.checked = true;

    state.prefillMembers = DEMO.members.map(function (m, i) {
      return {
        id: 'm' + (i + 1), nickname: m.nickname, budget: m.budget,
        must: m.must.slice(), nice: m.nice.slice(), never: m.never.slice()
      };
    });
    state.members = cloneMembers(state.prefillMembers);
    state.memberIndex = 0;
    if (state.party) {
      state.party.title = DEMO.title;
      state.party.budgetTotal = DEMO.budget;
      state.party.members = cloneMembers(state.prefillMembers);
    }
    updateFormTip();
    toast('已填入标准演示场景：4 人 / 上海人民广场 / 共同预算 200 元。记得选中门店。', 'ok', 5200);
    return queryStores({ selectFirst: true }).then(function (stores) {
      if (!stores.length) {
        toast('门店查询没返回结果，请检查后端或改关键词。', 'error');
      } else if (state.selectedStore) {
        $('#formTip').textContent = '已选：' + state.selectedStore.storeName + '。可直接点「下一步」。';
      }
    });
  }

  function membersForSubmit(count) {
    var base = [];
    if (state.prefillMembers && state.prefillMembers.length === count) base = state.prefillMembers;
    else if (state.party && state.party.members && state.party.members.length) base = state.party.members;
    else if (state.members && state.members.length) base = state.members;
    var list = normalizeMembers(base, count);
    list.forEach(function (m, i) { if (!m.nickname || !m.nickname.trim()) m.nickname = '成员' + (i + 1); });
    return list;
  }

  function setFormBusy(busy) {
    var btn = $('#btnCreateParty');
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<span class="spinner"></span> 正在创建…'
      : '下一步：收集心愿' + icon('chevron');
  }

  function handleCreateParty(e) {
    if (e) e.preventDefault();
    var title = $('#fTitle').value.trim();
    var memberCount = clamp(parseInt($('#fMemberCount').value, 10) || 4, 3, 8);
    var budget = Number($('#fBudget').value);
    var beType = readBeType();
    var reservation = $('#fReservation').value.trim();
    var tip = $('#formTip');

    if (!title) { tip.className = 'form-foot__tip is-error'; tip.textContent = '请填写聚餐事由。'; $('#fTitle').focus(); return; }
    if (!state.selectedStore) { tip.className = 'form-foot__tip is-error'; tip.textContent = '请先在门店列表里选一家门店。'; return; }
    if (!isFinite(budget) || budget <= 0) { tip.className = 'form-foot__tip is-error'; tip.textContent = '共同预算需要大于 0。'; $('#fBudget').focus(); return; }
    if (beType === 5 && !state.selectedStore.beCode) {
      tip.className = 'form-foot__tip is-error';
      tip.textContent = '该门店没有返回得来速编号，换「到店自取」或换一家门店。';
      return;
    }

    var store = {
      storeCode: state.selectedStore.storeCode,
      storeName: state.selectedStore.storeName,
      // 地址与预约能力一起存下来：否则「继续这次聚餐」时只能显示「未知」
      address: state.selectedStore.address || null,
      reservation: state.selectedStore.reservation === undefined ? null : state.selectedStore.reservation,
      beType: beType,
      orderType: 1,
      beCode: beType === 5 ? (state.selectedStore.beCode || null) : null,
      reservationDate: reservation || null
    };

    var payload = {
      title: title,
      memberCount: memberCount,
      store: store,
      budgetTotal: budget,
      members: membersForSubmit(memberCount)
    };

    setFormBusy(true);
    tip.className = 'form-foot__tip';
    tip.textContent = '正在保存聚餐…';

    var req = state.party && state.party.id ? API.updateParty(state.party.id, payload) : API.createParty(payload);

    req.then(function (res) {
      state.party = res.party;
      state.prefillMembers = null;
      state.members = normalizeMembers(res.party.members || [], res.party.memberCount || memberCount);
      state.memberIndex = 0;
      state.plans = [];
      state.meta = null;
      state.workingPlan = null;
      state.editPlanId = null;
      state.menu = { items: [], loaded: false, loading: false, error: null };
      state.menuQuery = '';
      state.confirmedHere = false;
      state.ticket = null;
      state.ticketOptions = freshTicketOptions();
      state.photoSent = '';
      state.linkedOrder = null;
      state.linkDiag = null;
      state.linkConfirmed = false;
      state.linkingId = null;
      setFormBusy(false);
      tip.textContent = '已保存：' + res.party.title + '（' + res.party.memberCount + ' 人）。';
      toast('聚餐已创建，接着收集成员心愿。', 'ok');
      goStep(2);
    }).catch(function (err) {
      setFormBusy(false);
      tip.className = 'form-foot__tip is-error';
      tip.textContent = '保存失败：' + errText(err);
      toast('创建聚餐失败：' + errText(err), 'error');
    });
  }

  /* ---------------- 步骤 2：成员心愿 ---------------- */

  function saveMembers(silent) {
    if (!state.party || !state.party.id) return Promise.reject(new Error('还没有聚餐'));
    var err = firstMemberError();
    if (err) {
      if (!silent) toast(err, 'error');
      return Promise.reject(new Error(err));
    }
    var members = state.members.map(function (m) {
      return {
        id: m.id,
        nickname: m.nickname.trim(),
        budget: (m.budget === null || m.budget === '' || isNaN(Number(m.budget))) ? null : Number(m.budget),
        must: m.must.slice(0, MAX_CHIPS),
        nice: m.nice.slice(0, MAX_CHIPS),
        never: m.never.slice(0, MAX_CHIPS)
      };
    });
    return API.updateParty(state.party.id, { members: members }).then(function (res) {
      state.party = res.party;
      return res.party;
    });
  }

  function goToMember(idx) {
    state.showAllMembers = false;
    state.memberIndex = clamp(idx, 0, state.members.length - 1);
    renderMemberStage();
    $('#toggleAllMembers').classList.remove('is-on');
    $('#toggleAllMembers').textContent = '全部展开编辑';
  }

  function handleMemberNext() {
    var m = state.members[state.memberIndex];
    if (!m) return;
    var nick = (m.nickname || '').trim();
    if (!nick) {
      var errEl = $('[data-err]');
      if (errEl) errEl.textContent = '先写个昵称，才知道这份心愿是谁的。';
      var input = $('[data-nick]');
      if (input) { input.classList.add('is-invalid'); input.focus(); }
      return;
    }
    if (state.memberIndex < state.members.length - 1) {
      goToMember(state.memberIndex + 1);
    } else {
      renderMemberStage();
      toast(state.members.length + ' 位成员都记下了，可以「生成三套方案」了。', 'ok');
    }
  }

  function generatePlans() {
    var err = firstMemberError();
    if (err) {
      toast(err + '，先补上再生成方案。', 'error');
      if (!state.showAllMembers) goToMember(0);
      var input = $('[data-nick]');
      if (input) input.focus();
      return;
    }
    goStep(3, { skipAuto: true });
    var grid = $('#planGrid');
    if (grid) grid.innerHTML = skeletonCards(3);
    setInline($('#planStatus'), '', loadingHtml('正在保存心愿并向官方接口查询菜单、核价…（可能需要几秒）'));
    var stamp = $('#planTimeStamp');
    if (stamp) stamp.innerHTML = icon('clock') + '数据时点 获取中…';

    saveMembers(true).then(function () {
      return API.plans(state.party.id);
    }).then(function (res) {
      state.plans = res.plans || [];
      state.meta = res.meta || null;
      if (!state.plans.length) {
        setInline($('#planStatus'), 'error', '没有生成任何方案。可能是菜单为空或全部核价失败，请返回第 1 步换门店后重试。');
        if (grid) grid.innerHTML = '';
        return;
      }
      var warns = (state.meta && state.meta.warnings) || [];
      if (warns.length) {
        setInline($('#planStatus'), 'ok', warns.map(function (w) { return '· ' + esc(w); }).join('<br />'));
      } else {
        setInline($('#planStatus'), '', '');
      }
      applyDataSource(currentDataSource());
      renderPlans();
      toast('三套方案已生成，均为官方核价结果。', 'ok');
    }).catch(function (e) {
      if (grid) grid.innerHTML = '';
      setInline($('#planStatus'), 'error', '生成方案失败：' + esc(errText(e)));
      toast('生成方案失败：' + errText(e), 'error');
    });
  }

  /* ---------------- 步骤 3 → 4：选中方案 ---------------- */

  function pickPlan(planId) {
    var plan = null;
    for (var i = 0; i < state.plans.length; i++) if (state.plans[i].planId === planId) plan = state.plans[i];
    if (!plan) return;
    if (!plan.pricing || plan.pricing.ok !== true) {
      toast('这套方案核价失败，不能确认。换一套试试。', 'error');
      return;
    }
    state.editPlanId = planId;
    state.workingPlan = JSON.parse(JSON.stringify(plan));
    state.confirmedHere = false;
    state.recalcPending = false;
    state.recalcError = null;
    state.recalcBusy = false;
    state.recalcQueued = false;
    state.menuQuery = '';
    var search = $('#menuSearch');
    if (search) search.value = '';
    goStep(4);
    if (!state.menu.loaded && !state.menu.loading) loadMenu();
  }

  /* ---------------- 步骤 4：菜单 / 复算 ---------------- */

  function loadMenu() {
    if (!state.party || !state.party.store) return;
    var storeCode = state.party.store.storeCode;
    var beType = state.party.store.beType || 1;
    if (!storeCode) return;
    state.menu.loading = true;
    state.menu.error = null;
    renderMenu();
    API.menu(storeCode, beType).then(function (res) {
      state.menu.items = res.items || [];
      state.menu.loaded = true;
      state.menu.loading = false;
      state.menu.error = null;
      if (res.dataTime) setDataTime(res.dataTime);
      if (res.source === 'replay') { var b = $('#replayBanner'); if (b) b.hidden = false; }
      renderMenu();
      if (!state.menu.items.length) setInline($('#menuStatus'), 'error', '本店菜单为空，可能是餐段或取餐方式不匹配。');
    }).catch(function (err) {
      state.menu.loading = false;
      state.menu.loaded = false;
      state.menu.error = errText(err);
      renderMenu();
      toast('菜单读取失败：' + errText(err), 'error');
    });
  }

  function addMenuItem(productCode) {
    var item = state.menu.items.filter(function (x) { return String(x.productCode) === String(productCode); })[0];
    if (!item || !state.workingPlan) return;
    var list = state.workingPlan.items;
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (String(it.productCode) === String(productCode) && (it.shared || !it.assigneeId)) { found = it; break; }
    }
    if (found) {
      found.quantity = (found.quantity || 1) + 1;
    } else {
      list.push({
        productCode: item.productCode,
        name: item.name,
        quantity: 1,
        unitPriceCents: item.priceCents,
        assigneeId: null,
        shared: true,
        novelty: !!item.novelty,
        components: item.components || []
      });
    }
    state.confirmedHere = false;
    scheduleRecalc();
    toast('已加入「' + item.name + '」，正在重新核价。', 'ok', 2000);
  }

  function updateItem(idx, patch) {
    var it = state.workingPlan.items[idx];
    if (!it) return;
    Object.keys(patch).forEach(function (k) { it[k] = patch[k]; });
    state.confirmedHere = false;
    scheduleRecalc();
  }

  function removeItem(idx) {
    if (!state.workingPlan) return;
    var it = state.workingPlan.items[idx];
    state.workingPlan.items.splice(idx, 1);
    state.confirmedHere = false;
    scheduleRecalc();
    toast('已移除「' + ((it && (it.name || it.productCode)) || '餐品') + '」，正在重新核价。', 'ok', 2000);
  }

  function scheduleRecalc() {
    state.recalcPending = true;
    state.recalcError = null;
    renderEdit(); // 立刻把金额切到「核价中…」，旧价不再显示
    var strip = $('#recalcStrip');
    if (strip) strip.hidden = false;

    clearTimeout(state.recalcTimer);
    state.recalcTimer = setTimeout(runRecalc, 320);
  }

  function runRecalc() {
    if (!state.workingPlan || !state.party) return;
    if (state.recalcBusy) { state.recalcQueued = true; return; }
    state.recalcBusy = true;

    var items = state.workingPlan.items.map(function (it) {
      return {
        productCode: it.productCode,
        quantity: it.quantity || 1,
        assigneeId: (it.shared || !it.assigneeId) ? null : it.assigneeId
      };
    });

    API.recalc(state.party.id, { items: items, couponId: null, planId: state.editPlanId })
      .then(function (res) {
        state.recalcBusy = false;
        state.recalcPending = false;
        state.recalcError = null;
        if (res.plan) {
          var merged = Object.assign({}, state.workingPlan, res.plan);
          if (!res.plan.items || !res.plan.items.length) merged.items = state.workingPlan.items;
          state.workingPlan = merged;
        }
        renderEdit();
        if (state.recalcQueued) {
          state.recalcQueued = false;
          scheduleRecalc();
        }
      })
      .catch(function (err) {
        state.recalcBusy = false;
        state.recalcQueued = false;
        state.recalcPending = false;
        state.recalcError = errText(err);
        renderEdit();
        toast('核价失败：' + errText(err), 'error');
      });
  }

  function doConfirm() {
    if (!state.party || !state.workingPlan) return;
    if (state.recalcPending || state.recalcError) {
      toast('先等核价结果，或修好失败的核价。', 'warn');
      return;
    }
    var pricing = state.workingPlan.pricing || {};
    if (pricing.ok !== true) { toast('这套方案没有有效核价，不能确认。', 'error'); return; }

    var btn = $('#btnConfirm');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 正在保存…'; }

    API.confirm(state.party.id, state.editPlanId).then(function (res) {
      state.party = res.party;
      state.confirmedHere = true;
      renderConfirmBox();
      toast('已保存为聚餐方案：未下单、未支付。', 'ok', 5000);
      // 把确认后的方案写回候选列表，便于返回对比
      for (var i = 0; i < state.plans.length; i++) {
        if (state.plans[i].planId === state.editPlanId) state.plans[i] = JSON.parse(JSON.stringify(state.workingPlan));
      }
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = '确认这套方案'; }
      toast('确认失败：' + errText(err), 'error');
    });
  }

  /* ---------------- 步骤 5：票根 ---------------- */

  function enterTicket() {
    if (!state.party || !state.party.id) return;
    if (state.party.status !== 'confirmed' && state.party.status !== 'completed') {
      toast('先在第四步确认一套方案，才能生成票根。', 'warn');
      return;
    }
    goStep(5);
    loadTicket();
  }

  function loadTicket() {
    var box = $('#ticketPreview');
    if (box) box.innerHTML = '<p class="muted">' + icon('clock') + ' 正在生成票根…</p>';
    // 先从聚餐记录恢复增强项：ticketExtras / linkedOrder 只在 party 里，
    // 不先拉 party 就会出现「照片没了但提示已保存」的不一致。
    API.getParty(state.party.id).then(function (res) {
      if (res && res.party) {
        state.party = res.party;
        restoreTicketExtras(res.party.ticketExtras);
        state.linkedOrder = res.party.linkedOrder || null;
        state.linkDiag = null;
        state.linkConfirmed = !!state.linkedOrder;
        var linkWarn = $('#linkWarnBox');
        if (linkWarn) { linkWarn.hidden = true; linkWarn.innerHTML = ''; }
      }
      return API.getTicket(state.party.id);
    }).then(function (res) {
      state.ticket = res.ticket;
      var t = state.ticket || {};
      state.ticketOptions.nicknames = {};
      state.ticketOptions.themeLine = t.themeLine || '';
      if (!state.ticketOptions.layout) state.ticketOptions.layout = DEFAULT_LAYOUT;
      renderTicketControls();
      renderTicketPreview();
      renderLinkResult();
    }).catch(function (err) {
      if (box) box.innerHTML = '<p class="muted">票根生成失败：' + esc(errText(err)) + '</p>';
      toast('票根生成失败：' + errText(err), 'error');
    });
  }

  /** 把 party.ticketExtras 还原成控件状态（刷新页面后照片/句子/约定/版式都还在） */
  function restoreTicketExtras(extras) {
    var e = extras && typeof extras === 'object' ? extras : {};
    var opts = state.ticketOptions;
    opts.notes = {};
    if (e.notes && typeof e.notes === 'object' && !Array.isArray(e.notes)) {
      Object.keys(e.notes).forEach(function (mid) {
        if (typeof e.notes[mid] === 'string' && e.notes[mid].trim()) opts.notes[mid] = e.notes[mid];
      });
    }
    opts.nextMeet = typeof e.nextMeet === 'string' ? e.nextMeet : '';
    opts.photo = typeof e.photo === 'string' ? e.photo : '';
    // 恢复时把已存照片视为「已发送」，避免每次改文案都重传几百 KB
    state.photoSent = opts.photo;
    opts.layout = TICKET_LAYOUTS[e.layout] ? e.layout : DEFAULT_LAYOUT;
    opts.themeLine = typeof e.themeLine === 'string' ? e.themeLine : opts.themeLine;
    var vis = e.visibleFields;
    if (Array.isArray(vis)) {
      opts.visibleFields = vis.filter(function (f) { return TICKET_FIELDS.indexOf(f) > -1; });
    } else if (vis && typeof vis === 'object') {
      opts.visibleFields = TICKET_FIELDS.filter(function (f) {
        return Object.prototype.hasOwnProperty.call(vis, f) ? !!vis[f] : true;
      });
    }
  }

  function submitTicket() {
    if (!state.party || !state.party.id) return;
    if (state.ticketBusy) return;
    state.ticketBusy = true;
    var box = $('#ticketPreview');
    if (box) box.style.opacity = '0.55';

    var opts = state.ticketOptions;
    var options = {
      nicknames: opts.nicknames,
      visibleFields: opts.visibleFields,
      themeLine: opts.themeLine || '',
      notes: opts.notes || {},
      nextMeet: opts.nextMeet || '',
      layout: opts.layout || DEFAULT_LAYOUT,
      maxItems: 3
    };
    // 照片只在变化时上传：每次改动都带 600KB 会让「改一句主题」变成上传一张图
    var pendingPhoto = opts.photo || '';
    var sendPhoto = pendingPhoto !== (state.photoSent || '');
    if (sendPhoto) options.photo = pendingPhoto;

    API.makeTicket(state.party.id, options).then(function (res) {
      state.ticketBusy = false;
      if (box) box.style.opacity = '';
      state.ticket = res.ticket;
      if (sendPhoto) state.photoSent = pendingPhoto;
      renderTicketPreview();
      if (sendPhoto && !pendingPhoto) setPhotoStatus('ok', '照片已从票根移除。');
    }).catch(function (err) {
      state.ticketBusy = false;
      if (box) box.style.opacity = '';
      toast('票根更新失败：' + errText(err), 'error');
      if (sendPhoto) setPhotoStatus('error', '票根更新失败：' + errText(err) + '。照片可能没有保存，请重试。');
    });
  }

  var submitTicketDebounced = debounce(submitTicket, 500);

  function toggleTicketStatus(completed) {
    var current = (state.ticket && state.ticket.status) || 'planning';
    var target = completed ? 'completed' : 'planning';
    if (current === target) return;
    if (completed) {
      confirmDialog({
        title: '标记为已完成？',
        html: '<p>只有当你确认这次聚餐真的发生了，才标记「已完成」。</p>' +
          '<p class="muted">未下单或未确认消费的方案不应被标记为已消费。这个状态会写进票根。</p>',
        okText: '确认已完成',
        danger: false
      }).then(function (ok) {
        if (!ok) {
          var r = $('input[name="ticketStatus"][value="' + current + '"]');
          if (r) r.checked = true;
          return;
        }
        setPartyCompleted(true);
      });
    } else {
      setPartyCompleted(false);
    }
  }

  /** 统一的「标记已完成 / 切回计划中」：订单关联区与状态下拉共用同一套接口与刷新逻辑 */
  function setPartyCompleted(completed) {
    return API.complete(state.party.id, !!completed).then(function (res) {
      state.party = res.party;
      return API.getTicket(state.party.id);
    }).then(function (res) {
      state.ticket = res.ticket;
      renderTicketPreview();
      renderTicketControls();
      renderLinkResult();
      toast(completed ? '已标记为已完成。' : '已切回「计划中」。', 'ok');
    }).catch(function (err) { toast('状态更新失败：' + errText(err), 'error'); });
  }

  /* 按需生成「真实导出图」：DOM 预览按屏宽缩放，只有这里能看到 1080 像素的实际排版。
     刻意不挂在输入回路上——每次输入都重画 2160px 画布既慢又没有意义。 */
  function openExportPreview() {
    if (!hasTicketRenderer() || typeof window.TicketRenderer.exportPNG !== 'function') {
      toast('票根渲染器（ticket.js）未加载，暂时无法生成导出效果。', 'error');
      return;
    }
    if (!state.ticket) { toast('还没有票根数据。', 'warn'); return; }
    var sheet = $('#exportSheet');
    var body = $('#exportSheetBody');
    var title = $('#exportSheetTitle');
    var btn = $('#btnPreviewExport');
    if (!sheet || !body) return;

    var layout = state.ticketOptions.layout || DEFAULT_LAYOUT;
    var conf = TICKET_LAYOUTS[layout] || TICKET_LAYOUTS[DEFAULT_LAYOUT];
    if (title) title.textContent = '导出效果 · ' + conf.label + ' ' + conf.size;
    body.innerHTML = '<p class="muted">正在生成…</p>';
    sheet.hidden = false;
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

    var restore = function () {
      if (btn) { btn.disabled = false; btn.textContent = '查看导出效果'; }
    };

    Promise.resolve()
      .then(function () { return window.TicketRenderer.exportPNG(state.ticket, { layout: layout }); })
      .then(function (blob) {
        if (!blob) throw new Error('没有拿到图片数据');
        return readBlobAsDataUrl(blob);
      })
      .then(function (dataUrl) {
        var img = new Image();
        img.alt = '票根导出效果（' + conf.label + ' ' + conf.size + '）';
        img.src = dataUrl;
        body.innerHTML = '';
        body.appendChild(img);
        restore();
      })
      .catch(function (err) {
        body.innerHTML = '<p class="muted">生成失败：' + esc(errText(err)) + '</p>';
        toast('生成导出效果失败：' + errText(err), 'error', 6000);
        restore();
      });
  }

  /** Blob → dataURL。比 createObjectURL 兼容性好（jsdom/内嵌浏览器都支持），也不用管回收。 */
  function readBlobAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') { reject(new Error('当前环境不支持读取图片')); return; }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('读取导出图片失败')); };
      reader.readAsDataURL(blob);
    });
  }

  function closeExportPreview() {
    var sheet = $('#exportSheet');
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    var body = $('#exportSheetBody');
    if (body) body.innerHTML = '';
  }

  function downloadTicket() {
    if (!hasTicketRenderer() || typeof window.TicketRenderer.downloadPNG !== 'function') {
      toast('票根渲染器（ticket.js）未加载，暂时无法导出图片。文字版预览仍可截图。', 'error');
      return;
    }
    if (!state.ticket) { toast('还没有票根数据。', 'warn'); return; }
    var layout = state.ticketOptions.layout || DEFAULT_LAYOUT;
    var conf = TICKET_LAYOUTS[layout] || TICKET_LAYOUTS[DEFAULT_LAYOUT];
    try {
      var ret = window.TicketRenderer.downloadPNG(
        state.ticket,
        'maimai-tongxi-' + (state.party ? state.party.id : 'ticket') + '.png',
        { layout: layout }
      );
      // 新版渲染器返回 Promise：失败必须冒泡成可读提示，不能变成未捕获异常
      if (ret && typeof ret.then === 'function') {
        ret.then(function () {
          toast('已导出' + conf.label + '（' + conf.size + '）。', 'ok');
        }).catch(function (err) {
          toast('导出失败：' + errText(err), 'error', 6000);
        });
      } else {
        toast('正在导出' + conf.label + '（' + conf.size + '）…', 'ok');
      }
    } catch (e) {
      toast('导出失败：' + errText(e), 'error');
    }
  }

  /* ---------------- 清除本地数据 ---------------- */

  /** 清除本地数据：优先清全部；后端清理缓存失败时至少清掉聚餐记录，并如实提示 */
  function cleanupLocal() {
    // 只调一次：后端会逐个文件删除并如实返回删掉多少、失败多少。
    // 失败时不再降级重试，避免重复删除 + 给出误导性提示。
    return API.cleanup('all').then(function (res) {
      return {
        removed: res.removed || 0,
        failed: res.failed || 0,
        remaining: res.remaining || 0,
        note: res.note || (res.remaining ? '还有 ' + res.remaining + ' 个缓存文件，再点一次可继续清理。' : '')
      };
    });
  }

  function cleanupAll() {
    confirmDialog({
      title: '清除本地数据？',
      html: '<p>将删除本机保存的：</p>' +
        '<ul><li>全部聚餐与成员心愿</li><li>三套方案、核价记录与分账结果</li><li>同桌票根与昵称改写</li></ul>' +
        '<p class="muted">不可撤销。已经下载到相册/硬盘的图片不受影响。</p>',
      okText: '确认清除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      cleanupLocal().then(function (res) {
        resetState();
        closeDrawer();
        goStep(1);
        loadPreferenceGroups();
        if (res.note) {
          toast('聚餐记录已清除（' + res.removed + ' 项）；' + res.note, 'warn', 8000);
        } else {
          toast('已清除本地数据（' + res.removed + ' 项）。', 'ok', 5000);
        }
      }).catch(function (err) {
        toast('清除失败：' + errText(err), 'error', 6000);
      });
    });
  }

  function resetState() {
    state.party = null;
    state.plans = [];
    state.meta = null;
    state.workingPlan = null;
    state.editPlanId = null;
    state.members = [];
    state.memberIndex = 0;
    state.showAllMembers = false;
    state.prefillMembers = null;
    state.selectedStore = null;
    state.stores = [];
    state.menu = { items: [], loaded: false, loading: false, error: null };
    state.menuQuery = '';
    state.ticket = null;
    state.ticketOptions = freshTicketOptions();
    state.photoSent = '';
    state.linkedOrder = null;
    state.linkDiag = null;
    state.linkConfirmed = false;
    state.linkingId = null;
    state.orders = { items: [], loaded: false, loading: false, error: null };
    state.confirmedHere = false;
    state.recalcPending = false;
    state.recalcBusy = false;
    state.recalcError = null;
    var list = $('#storeList');
    if (list) list.innerHTML = '';
    setInline($('#storeStatus'), '', '');
    var grid = $('#planGrid');
    if (grid) grid.innerHTML = '';
    setInline($('#planStatus'), '', '');
    var preview = $('#ticketPreview');
    if (preview) preview.innerHTML = '<p class="muted">还没有票根数据。</p>';
    updateFormTip();
  }

  /* ---------------- 健康检查 / 恢复 ---------------- */

  function checkHealth() {
    var banner = $('#healthBanner');
    return API.health().then(function (res) {
      state.health = res;
      if (banner) banner.hidden = true;
      if (res.dataTime) setDataTime(res.dataTime);
      var chip = $('#dataTimeChip');
      if (chip) chip.title = '最近一次官方数据时点；连接正常';
      renderDrawerKv();
      return res;
    }).catch(function (err) {
      state.health = null;
      if (banner) {
        banner.hidden = false;
        var t = $('#healthBannerText');
        if (t) t.textContent = '无法连接 /api/health：' + errText(err) + '。界面仍可浏览，但查询与核价会失败。';
      }
      renderDrawerKv();
      return null;
    });
  }

  function showRestoreBanner(party) {
    if (state.step !== 1 || state.party) return;
    var slot = $('.banner-slot');
    if (!slot) return;
    var old = $('#restoreBanner');
    if (old) old.parentNode.removeChild(old);
    var el = document.createElement('div');
    el.className = 'banner banner--info';
    el.id = 'restoreBanner';

    var text = document.createElement('span');
    text.innerHTML = '<strong>发现上次的聚餐</strong> ';
    var detail = document.createElement('span');
    detail.textContent = '「' + party.title + '」· ' + party.memberCount + ' 人 · ' + statusLabel(party.status) +
      '（' + fmtTime(party.createdAt ? String(party.createdAt).replace('T', ' ') : '') + '）';
    text.appendChild(detail);

    var actions = document.createElement('span');
    actions.className = 'banner__actions';

    var cont = document.createElement('button');
    cont.type = 'button';
    cont.className = 'btn btn--sm btn--primary';
    cont.textContent = '继续这次聚餐';
    cont.addEventListener('click', function () {
      state.party = party;
      state.members = normalizeMembers(party.members || [], party.memberCount || 4);
      state.memberIndex = 0;
      fillFormFromParty(party);
      el.hidden = true;
      toast(party.status === 'confirmed'
        ? '已恢复聚餐。需要看方案请重新生成一次，票根可直接查看。'
        : '已恢复上次的聚餐，接着填写心愿。', 'ok', 5000);
      goStep(2);
    });

    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn btn--sm btn--ghost';
    skip.textContent = '忽略';
    skip.addEventListener('click', function () { el.hidden = true; });

    actions.appendChild(cont);
    actions.appendChild(skip);
    el.appendChild(text);
    el.appendChild(actions);
    slot.appendChild(el);
  }

  function fillFormFromParty(party) {
    if (!party) return;
    $('#fTitle').value = party.title || '';
    $('#fMemberCount').value = String(party.memberCount || 4);
    if (party.store) {
      $('#fCity').value = party.store.city || $('#fCity').value;
      $('#fReservation').value = party.store.reservationDate || '';
      var radio = $('input[name="beType"][value="' + (party.store.beType || 1) + '"]');
      if (radio) radio.checked = true;
      state.selectedStore = {
        storeCode: party.store.storeCode,
        storeName: party.store.storeName,
        address: '',
        beCode: party.store.beCode || null
      };
      renderStores([state.selectedStore]);
    }
    if (party.budgetTotal) $('#fBudget').value = String(party.budgetTotal);
    updateFormTip();
  }

  function tryRestore() {
    API.parties().then(function (res) {
      var list = res.parties || [];
      var pick = null;
      for (var i = 0; i < list.length; i++) {
        var s = list[i].status;
        if (s === 'draft' || s === 'planned' || s === 'confirmed') { pick = list[i]; break; }
      }
      if (!pick) return;
      return API.getParty(pick.id).then(function (r) {
        if (!r.party) return;
        showRestoreBanner(r.party);
      });
    }).catch(function () {
      /* 恢复是增强项：后端未就绪时静默跳过，健康横幅已给出说明 */
    });
  }

  /* ========================================================================
   * 5. 启动与事件绑定
   * ===================================================================== */

  function bindEvents() {
    /* 步骤条 */
    $$('#stepNav .step__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var li = btn.closest('.step');
        var n = Number(li.getAttribute('data-step'));
        if (n === state.step) return;
        if (!canEnter(n)) {
          if (n === 3) toast('先填写成员心愿，再生成方案。', 'warn');
          else if (n === 4) toast('先在第 3 步选一套方案。', 'warn');
          else if (n === 5) toast('先确认方案，才能看票根。', 'warn');
          return;
        }
        goStep(n);
      });
    });

    /* 步骤 1 */
    var form = $('#formParty');
    if (form) form.addEventListener('submit', handleCreateParty);
    $('#btnFindStores').addEventListener('click', function () { queryStores({}); });
    $('#fillDemo').addEventListener('click', applyDemo);

    $('#storeList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-store-idx]');
      if (!btn) return;
      selectStore(Number(btn.getAttribute('data-store-idx')));
    });

    /* 步骤 1：上次这群人 */
    var revisitList = $('#revisitList');
    if (revisitList) {
      revisitList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-revisit]');
        if (!btn) return;
        handleRevisit(btn.getAttribute('data-revisit'));
      });
    }
    var revisitMore = $('#revisitMore');
    if (revisitMore) {
      revisitMore.addEventListener('click', function () {
        state.prefShowAll = !state.prefShowAll;
        renderRevisitBox();
      });
    }
    var closeRevisitBanner = $('#closeRevisitBanner');
    if (closeRevisitBanner) {
      closeRevisitBanner.addEventListener('click', function () {
        var b = $('#revisitBanner');
        if (b) b.hidden = true;
      });
    }

    $$('input[name="beType"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (state.storeQuery.keyword) queryStores({});
      });
    });

    $$('[data-count]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = $('#fMemberCount');
        var next = clamp((parseInt(input.value, 10) || 4) + Number(btn.getAttribute('data-count')), 3, 8);
        input.value = String(next);
      });
    });
    $('#fMemberCount').addEventListener('change', function () {
      this.value = String(clamp(parseInt(this.value, 10) || 4, 3, 8));
    });

    ['fTitle', 'fBudget', 'fCity', 'fKeyword'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('input', function () {
        var tip = $('#formTip');
        if (tip && tip.classList.contains('is-error')) { tip.className = 'form-foot__tip'; tip.textContent = '选好门店后即可进入下一步。'; }
      });
    });

    $('#fKeyword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); queryStores({}); }
    });
    $('#fCity').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); queryStores({}); }
    });

    /* 步骤 2 */
    var stage = $('#memberStage');

    stage.addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-nick')) {
        var m1 = findMember(t.getAttribute('data-nick'));
        if (m1) {
          m1.nickname = t.value;
          t.classList.remove('is-invalid');
          var card = t.closest('.member-card');
          if (card) {
            var echo = $('[data-name-echo]', card);
            if (echo) echo.textContent = t.value.trim() || '待填写昵称';
            var av = $('.avatar', card);
            if (av) av.textContent = initialOf(t.value || '?');
            var err = $('[data-err]', card);
            if (err) err.textContent = '';
          }
          renderMemberProgress();
          renderMemberFootNote();
        }
      } else if (t.hasAttribute('data-budget')) {
        var m2 = findMember(t.getAttribute('data-budget'));
        if (m2) {
          var v = t.value.trim();
          var num = Number(v);
          m2.budget = (v === '' || !isFinite(num)) ? null : Math.max(0, num);
          var card2 = t.closest('.member-card');
          if (card2) {
            var pill = $('.member-card__head .pill', card2);
            if (pill) pill.textContent = m2.budget === null ? '未设个人预算' : '个人预算 ' + moneyYuan(m2.budget);
          }
        }
      }
    });

    stage.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t.hasAttribute('data-chip-field')) return;
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        commitChip(t);
      } else if (e.key === 'Backspace' && !t.value) {
        var box = t.closest('.chip-input');
        if (!box) return;
        var memberId = box.getAttribute('data-chip-input');
        var key = box.getAttribute('data-key');
        var member = findMember(memberId);
        if (member && member[key].length) {
          member[key].pop();
          rerenderChipsBox(memberId, key, '');
          renderMemberFootNote();
        }
      }
    });

    stage.addEventListener('blur', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-chip-field') && t.value.trim()) commitChip(t);
    }, true);

    stage.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-chip-remove]');
      if (rm) {
        e.preventDefault();
        var mid = rm.getAttribute('data-chip-remove');
        var key = rm.getAttribute('data-key');
        var word = rm.getAttribute('data-word');
        var member = findMember(mid);
        if (member) {
          member[key] = member[key].filter(function (w) { return w !== word; });
          rerenderChipsBox(mid, key, '');
          renderMemberFootNote();
        }
        return;
      }
      if (e.target.closest('.chip-input')) {
        var box = e.target.closest('.chip-input');
        var input = $('input', box);
        if (input && !input.disabled) input.focus();
        return;
      }
      if (e.target.closest('.js-member-next')) { handleMemberNext(); return; }
      if (e.target.closest('.js-member-prev')) { goToMember(state.memberIndex - 1); return; }
      if (e.target.closest('[data-pip]')) { goToMember(Number(e.target.closest('[data-pip]').getAttribute('data-pip'))); }
    });

    $('#toggleAllMembers').addEventListener('click', function () {
      state.showAllMembers = !state.showAllMembers;
      this.classList.toggle('is-on', state.showAllMembers);
      this.textContent = state.showAllMembers ? '回到逐位填写' : '全部展开编辑';
      renderMemberStage();
    });

    $('#backTo1').addEventListener('click', function () { goStep(1); });
    $('#btnGoPlans').addEventListener('click', generatePlans);

    /* 步骤 3 */
    $('#planGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pick]');
      if (!btn) return;
      pickPlan(btn.getAttribute('data-pick'));
    });
    $('#btnRegenPlans').addEventListener('click', function () {
      if (state.party) generatePlans();
    });
    $('#backTo2').addEventListener('click', function () { goStep(2); });

    /* 步骤 4 */
    $('#backTo3').addEventListener('click', function () { goStep(3); });

    $('#menuSearch').addEventListener('input', function () {
      state.menuQuery = this.value;
      renderMenu();
    });

    $('#menuList').addEventListener('click', function (e) {
      var add = e.target.closest('[data-add]');
      if (!add) return;
      addMenuItem(add.getAttribute('data-add'));
    });
    $('#menuList').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var item = e.target.closest('[data-add]');
      if (!item || e.target.closest('button[data-add]')) return;
      e.preventDefault();
      addMenuItem(item.getAttribute('data-add'));
    });

    $('#itemEditor').addEventListener('click', function (e) {
      var row = e.target.closest('[data-item-idx]');
      if (!row) return;
      var idx = Number(row.getAttribute('data-item-idx'));
      var it = state.workingPlan && state.workingPlan.items[idx];
      if (!it) return;
      var role = e.target.closest('[data-role]');
      if (!role) return;
      var kind = role.getAttribute('data-role');
      if (kind === 'plus') updateItem(idx, { quantity: (it.quantity || 1) + 1 });
      else if (kind === 'minus') {
        if ((it.quantity || 1) <= 1) removeItem(idx);
        else updateItem(idx, { quantity: it.quantity - 1 });
      } else if (kind === 'del') removeItem(idx);
    });

    $('#itemEditor').addEventListener('change', function (e) {
      var sel = e.target.closest('[data-role="assignee"]');
      if (!sel) return;
      var row = sel.closest('[data-item-idx]');
      if (!row) return;
      var idx = Number(row.getAttribute('data-item-idx'));
      var val = sel.value || null;
      updateItem(idx, { assigneeId: val, shared: !val });
    });

    /* 步骤 5 */
    $('#btnDownload').addEventListener('click', downloadTicket);
    var previewBtn = $('#btnPreviewExport');
    if (previewBtn) previewBtn.addEventListener('click', openExportPreview);
    var sheetClose = $('#exportSheetClose');
    if (sheetClose) sheetClose.addEventListener('click', closeExportPreview);
    var sheetScrim = $('#exportSheetScrim');
    if (sheetScrim) sheetScrim.addEventListener('click', closeExportPreview);
    $('#backTo4').addEventListener('click', function () { goStep(4); });

    $('#fieldToggles').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-field]');
      if (!cb) return;
      var field = cb.getAttribute('data-field');
      var current = (state.ticket && state.ticket.fieldsVisible) || defaultVisibleFields();
      state.ticketOptions.visibleFields = TICKET_FIELDS.filter(function (f) {
        if (f === field) return cb.checked;
        return Object.prototype.hasOwnProperty.call(current, f) ? current[f] : true;
      });
      submitTicketDebounced();
    });

    $('#nickEditor').addEventListener('input', function (e) {
      var input = e.target.closest('[data-nickname]');
      if (!input) return;
      var id = input.getAttribute('data-nickname');
      var v = input.value.trim();
      if (v) state.ticketOptions.nicknames[id] = v;
      else delete state.ticketOptions.nicknames[id];
      submitTicketDebounced();
    });

    $('#themeLine').addEventListener('input', function () {
      state.ticketOptions.themeLine = this.value.trim();
      submitTicketDebounced();
    });

    $$('input[name="ticketStatus"]').forEach(function (r) {
      r.addEventListener('change', function () { toggleTicketStatus(this.value === 'completed'); });
    });

    /* 步骤 5：合照 */
    var photoInput = $('#photoInput');
    if (photoInput) {
      photoInput.addEventListener('change', function () {
        var file = this.files && this.files[0];
        handlePhotoPick(file);
        // 清空 value：选同一张图也能再次触发 change
        try { this.value = ''; } catch (e) { /* 老浏览器忽略 */ }
      });
    }
    var removePhotoBtn = $('#btnRemovePhoto');
    if (removePhotoBtn) removePhotoBtn.addEventListener('click', removePhoto);

    /* 步骤 5：每人一句话 */
    var noteEditor = $('#noteEditor');
    if (noteEditor) {
      noteEditor.addEventListener('input', function (e) {
        var input = e.target.closest('[data-note]');
        if (!input) return;
        var mid = input.getAttribute('data-note');
        var v = input.value.trim();
        if (v) state.ticketOptions.notes[mid] = v.slice(0, NOTE_MAX);
        else delete state.ticketOptions.notes[mid];
        submitTicketDebounced();
      });
    }

    /* 步骤 5：下次约定 */
    var nextMeetInput = $('#nextMeet');
    if (nextMeetInput) {
      nextMeetInput.addEventListener('input', function () {
        state.ticketOptions.nextMeet = this.value.trim().slice(0, NEXT_MEET_MAX);
        submitTicketDebounced();
      });
    }

    /* 步骤 5：版式 */
    $$('input[name="ticketLayout"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!this.checked) return;
        state.ticketOptions.layout = TICKET_LAYOUTS[this.value] ? this.value : DEFAULT_LAYOUT;
        renderLayoutControls();
        renderTicketPreview();
        submitTicketDebounced();
      });
    });

    /* 步骤 5：订单关联 */
    var btnLinkOrder = $('#btnLinkOrder');
    if (btnLinkOrder) btnLinkOrder.addEventListener('click', openOrderSheet);
    var closeOrderBtn = $('#closeOrderSheet');
    if (closeOrderBtn) closeOrderBtn.addEventListener('click', closeOrderSheet);
    var orderScrim = $('#orderSheetScrim');
    if (orderScrim) orderScrim.addEventListener('click', closeOrderSheet);

    var orderSheetEl = $('#orderSheet');
    if (orderSheetEl) {
      orderSheetEl.addEventListener('click', function (e) {
        if (e.target.closest('#btnReloadOrders')) { loadOrders(); return; }
        var card = e.target.closest('[data-order]');
        if (card) { linkOrder(card.getAttribute('data-order')); return; }
      });
      orderSheetEl.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'linkConfirm') {
          state.linkConfirmed = !!e.target.checked;
          var hint = $('#linkWarnHint');
          if (hint) {
            hint.textContent = state.linkConfirmed
              ? '已确认：可以回到票根继续标记「已完成」。'
              : '勾选之后才会显示后续操作；不勾选就当作还没关联成功。';
          }
          renderLinkResult();
        }
      });
    }

    /* 步骤 5：保存口味偏好 */
    var consentBox = $('#prefConsentList');
    if (consentBox) {
      consentBox.addEventListener('change', function (e) {
        if (e.target && e.target.hasAttribute('data-consent')) updatePrefSaveButton();
      });
    }
    var btnSavePrefs = $('#btnSavePrefs');
    if (btnSavePrefs) btnSavePrefs.addEventListener('click', savePreferences);

    /* 抽屉：已保存的偏好组 */
    var prefGroupList = $('#prefGroupList');
    if (prefGroupList) {
      prefGroupList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-del-pref]');
        if (!btn) return;
        deletePreferenceGroup(btn.getAttribute('data-del-pref'));
      });
    }

    /* 抽屉 / 弹层 */
    $('#openDrawer').addEventListener('click', openDrawer);
    $('#footOpenDrawer').addEventListener('click', openDrawer);
    $('#closeDrawer').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#btnCleanup').addEventListener('click', cleanupAll);
    $('#retryHealth').addEventListener('click', function () {
      var b = $('#healthBanner');
      if (b) b.hidden = true;
      checkHealth().then(tryRestore);
    });

    document.addEventListener('keydown', function (e) {
      var exportSheet = document.getElementById('exportSheet');
      if (exportSheet && !exportSheet.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeExportPreview(); }
        return;
      }
      var orderSheet = document.getElementById('orderSheet');
      if (!modalScrim.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
        else trapFocus(e, $('.modal', modalScrim));
        return;
      }
      if (orderSheet && !orderSheet.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeOrderSheet(); }
        else trapFocus(e, orderSheet);
        return;
      }
      if (!drawer.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
        else trapFocus(e, drawer);
      }
    });

    /* 品牌回到第一步 */
    $('#brandHome').addEventListener('click', function (e) {
      e.preventDefault();
      if (state.step !== 1) goStep(1);
    });
  }

  function boot() {
    bindEvents();
    setDataTime('');
    if (!hasTicketRenderer()) {
      var btn = $('#btnDownload');
      if (btn) { btn.disabled = true; btn.title = '票根渲染器（ticket.js）未加载'; }
      var preview = $('#ticketPreview');
      if (preview) preview.innerHTML = '<p class="muted">票根渲染器（ticket.js）尚未加载；确认方案后仍可查看文字版票根。</p>';
    }
    goStep(1);
    loadPreferenceGroups();
    checkHealth().then(function () {
      if (state.health) tryRestore();
      else if (state.step === 1) {
        // 后端未就绪时，仍允许填入演示场景看到表单效果
        setTimeout(function () {
          if (!state.party) toast('后端未连接：可以先看界面。启动 run.py 后才能查询门店与核价。', 'warn', 6000);
        }, 700);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
