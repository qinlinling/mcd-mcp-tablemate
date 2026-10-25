/*!
 * 同桌食光票根渲染器 —— 麦麦同席
 * ---------------------------------------------------------------------------
 * 设计原则：票根只呈现最终确认方案的事实。这里不计算金额、不推断信息、
 * 不编造门店与订单；所有内容都来自 app/ticket.py 产出的 ticket 对象。
 * 未标记「已完成」的聚餐只会显示「计划中」，绝不写成已消费。
 *
 * 对外接口：window.TicketRenderer = { render, exportPNG, downloadPNG }
 * 无外部依赖、无网络字体、不引用任何外部资源。
 *
 * P1 增强：合照（手帐贴纸）、每人一句话、下次约定；
 * 导出支持 portrait / square / story 三种版式，各自独立排布而非整体缩放。
 */
(function (global) {
  'use strict';

  var CREAM = '#FFF8EC';
  var CREAM_DEEP = '#F5E6CE';
  var RED = '#DA291C';
  var YELLOW = '#FFC72C';
  var INK = '#3A2C22';
  var MUTED = '#8A7566';
  var THEME_INK = '#B3261E';
  var FONT_SANS = '"PingFang SC","Microsoft YaHei","Heiti SC","Hiragino Sans GB",sans-serif';
  var FONT_SERIF = '"Songti SC","STSong","Noto Serif SC","SimSun",serif';
  var FONT_HAND = '"Kaiti SC","KaiTi","STKaiti",cursive';
  var FONT_KAI = '"Kaiti SC","KaiTi","STKaiti",serif';
  var SOURCE_LABEL = { live: '实时数据', replay: '缓存回放', unavailable: '数据暂不可用' };
  var STYLE_ID = 'mtx-ticket-style';
  var PLACEHOLDER = '—';

  var MAX_NOTES = 8;            // 服务端已限制，这里只做兜底
  var NEXT_MEET_MAX = 40;
  var PHOTO_MAX_BYTES = 600 * 1024;
  var PHOTO_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,/i;

  // -------------------------------------------------------------------------
  // 基础工具
  // -------------------------------------------------------------------------

  function text(value, fallback) {
    if (value === null || value === undefined) return fallback || PLACEHOLDER;
    var str = String(value).replace(/\s+/g, ' ').trim();
    return str || (fallback || PLACEHOLDER);
  }

  // 与 text 不同：空值返回空串，用于「有才渲染」的 P1 字段
  function plain(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function isVisible(ticket, key) {
    var map = ticket && ticket.fieldsVisible;
    if (!map || typeof map !== 'object') return true; // 缺省视为全部可见
    return map[key] !== false;
  }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  function membersOf(ticket) {
    var list = ticket && ticket.members;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var name = plain(list[i]);
      if (name) out.push(name);
    }
    return out;
  }

  // 成员多于 6 人时收敛为「… 等 N 人」，保证一屏可读
  function membersLine(ticket, maxChars) {
    var list = membersOf(ticket);
    if (!list.length) return PLACEHOLDER;
    var joined = list.length > 6
      ? list.slice(0, 6).join(' · ') + ' 等 ' + list.length + ' 人'
      : list.join(' · ');
    if (maxChars && joined.length > maxChars) return joined.slice(0, maxChars - 1) + '…';
    return joined;
  }

  function itemsOf(ticket) {
    var list = ticket && ticket.items;
    return Array.isArray(list) ? list : [];
  }

  function wishesOf(ticket) {
    var list = ticket && ticket.wishes;
    return Array.isArray(list) ? list : [];
  }

  // 合照：只接受服务端已校验过的 dataURL（离线可导出的前提）
  function photoOf(ticket) {
    var raw = ticket && ticket.photo;
    if (typeof raw !== 'string') return '';
    var src = raw.trim();
    if (!PHOTO_PATTERN.test(src)) return '';
    if (src.length > PHOTO_MAX_BYTES) return '';
    return src;
  }

  // 每人一句话：0—8 条，空句子直接跳过
  function notesOf(ticket) {
    var list = ticket && ticket.notes;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_NOTES; i += 1) {
      var row = list[i] || {};
      var note = plain(row.note);
      if (!note) continue;
      out.push({ member: plain(row.member) || '同桌', note: note });
    }
    return out;
  }

  function nextMeetOf(ticket) {
    var str = plain(ticket && ticket.nextMeet);
    if (!str) return '';
    return str.length > NEXT_MEET_MAX ? str.slice(0, NEXT_MEET_MAX - 1) + '…' : str;
  }

  // 「下次」前缀与用户文案重复时收敛成一句，避免「下次下次」
  function nextMeetBody(value) {
    return value.replace(/^下次[，,：:\s]*/, '');
  }

  // 文案本身已经是「下周五 / 再聚 / 明年 / 后天」这类时间或再会表述时，
  // 再加「下次」会连读成「下次下周五」，此时胶囊只保留文案本身。
  function nextMeetNeedsPrefix(value) {
    return !/^(下|再|明|后)/.test(nextMeetBody(value));
  }

  function statusLabelOf(ticket) {
    var t = ticket || {};
    if (t.statusLabel) return text(t.statusLabel);
    return t.status === 'completed' ? '已完成' : '计划中';
  }

  function statusKindOf(ticket) {
    return ticket && ticket.status === 'completed' ? 'completed' : 'planning';
  }

  function hiddenNoteOf(ticket) {
    var list = ticket && ticket.hiddenFields;
    if (!Array.isArray(list) || !list.length) return '';
    return '已隐去：' + list.join(' / ');
  }

  function hiddenCountOf(ticket) {
    var list = ticket && ticket.hiddenFields;
    return Array.isArray(list) ? list.length : 0;
  }

  function dataSourceLabel(ticket) {
    var src = ticket && ticket.dataSource;
    return SOURCE_LABEL[src] || text(src, '数据暂不可用');
  }

  // 贴纸旋转角：同一张票根每次渲染角度一致（-2° ~ 2°）
  function stickerAngle(ticket) {
    var seed = String((ticket && ticket.ticketId) || '') + '|' + String((ticket && ticket.title) || '');
    var hash = 0;
    for (var i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
    return Math.round(((hash % 41) - 20)) / 10; // -2.0 ~ 2.0，一位小数
  }

  // -------------------------------------------------------------------------
  // 样式（一次性注入，保持文件自包含；不依赖 styles.css）
  // -------------------------------------------------------------------------

  var CSS = [
    '.mtx-ticket{box-sizing:border-box;width:100%;max-width:420px;margin:0 auto;padding:12px;',
    'background:', CREAM_DEEP, ';border-radius:18px;color:', INK, ';',
    'font-family:', FONT_SANS, ';font-size:14px;line-height:1.6;text-align:left;',
    '-webkit-font-smoothing:antialiased;}',
    '.mtx-ticket *{box-sizing:border-box;}',
    '.mtx-ticket__paper{position:relative;overflow:hidden;padding:26px 30px 22px;border-radius:10px;',
    'background-color:', CREAM, ';',
    'background-image:radial-gradient(rgba(58,44,34,.06) 1px,transparent 1.2px),',
    'radial-gradient(rgba(218,41,28,.05) 1px,transparent 1.2px);',
    'background-size:7px 7px,13px 13px;background-position:0 0,3px 4px;',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 10px 20px rgba(58,44,34,.18);}',
    /* 左右撕线：径向渐变挖出半圆缺口（背景透出深奶油色），配竖向虚线穿孔 */
    '.mtx-ticket__edge{position:absolute;top:0;bottom:0;width:14px;pointer-events:none;}',
    '.mtx-ticket__edge--left{left:0;background-image:radial-gradient(circle at 0 50%,',
    CREAM_DEEP, ' 0 6px,transparent 6.5px);background-size:14px 16px;background-repeat:repeat-y;}',
    '.mtx-ticket__edge--right{right:0;background-image:radial-gradient(circle at 100% 50%,',
    CREAM_DEEP, ' 0 6px,transparent 6.5px);background-size:14px 16px;background-repeat:repeat-y;}',
    '.mtx-ticket__perf{position:absolute;top:8px;bottom:8px;width:0;',
    'border-left:2px dashed rgba(218,41,28,.28);}',
    '.mtx-ticket__perf--l{left:8px;}',
    '.mtx-ticket__perf--r{right:8px;}',
    '.mtx-ticket__head{text-align:center;padding:0 0 12px;}',
    '.mtx-ticket__brand{font-size:12px;font-weight:600;letter-spacing:.28em;color:', RED, ';}',
    '.mtx-ticket__headline{margin:6px 0 0;font-family:', FONT_SERIF, ';font-size:24px;',
    'font-weight:700;letter-spacing:.08em;color:', INK, ';}',
    '.mtx-ticket__badge{display:inline-block;margin-top:10px;padding:3px 14px;border-radius:999px;',
    'font-size:12px;font-weight:600;letter-spacing:.1em;}',
    '.mtx-ticket__badge--planning{background:', YELLOW, ';color:#6A4600;}',
    '.mtx-ticket__badge--completed{background:', RED, ';color:', CREAM, ';}',
    '.mtx-ticket__body{margin-top:6px;}',
    '.mtx-ticket__row{margin-top:14px;}',
    '.mtx-ticket__label{font-size:12px;letter-spacing:.18em;color:', MUTED, ';}',
    '.mtx-ticket__value{margin-top:2px;font-size:16px;line-height:1.5;color:', INK, ';word-break:break-word;}',
    '.mtx-ticket__value--title{font-size:19px;font-weight:700;line-height:1.4;}',
    '.mtx-ticket__value--date{letter-spacing:.04em;}',
    '.mtx-ticket__items,.mtx-ticket__wishes{list-style:none;margin:6px 0 0;padding:0;}',
    '.mtx-ticket__item{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:3px 0;}',
    '.mtx-ticket__qty{font-size:12px;font-weight:700;color:', RED, ';}',
    '.mtx-ticket__item-name{font-size:15px;line-height:1.4;}',
    '.mtx-ticket__who{font-size:12px;color:', MUTED, ';max-width:9em;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;}',
    '.mtx-ticket__wish{padding:3px 0;font-size:14px;}',
    '.mtx-ticket__wish-name{font-weight:600;color:', THEME_INK, ';}',
    '.mtx-ticket__wish-by{display:block;font-size:12px;color:', MUTED, ';}',
    '.mtx-ticket__empty{font-size:13px;color:', MUTED, ';}',
    /* 合照：白边相纸 + 轻微旋转 + 投影，像贴在手帐上的一张照片 */
    '.mtx-ticket__photo-wrap{margin:18px auto 2px;width:78%;max-width:320px;',
    'padding:7px 7px 9px;border-radius:6px;background:#FFFDF8;',
    'border:1px solid rgba(58,44,34,.10);transform:rotate(-1.4deg);',
    'box-shadow:0 9px 18px rgba(58,44,34,.22),inset 0 1px 0 rgba(255,255,255,.9);}',
    '.mtx-ticket__photo{display:block;margin:0 auto;max-width:100%;max-height:176px;',
    'width:auto;height:auto;border-radius:6px;}',
    /* 每人一句话：左侧细竖线 + 楷体，名字用暖红小字 */
    '.mtx-ticket__notes{margin-top:8px;padding:2px 0 2px 12px;',
    'border-left:2px solid rgba(218,41,28,.30);}',
    '.mtx-ticket__note{font-size:15px;line-height:1.75;color:', INK, ';}',
    '.mtx-ticket__note-name{font-family:', FONT_SANS, ';font-weight:700;font-size:12.5px;',
    'color:', THEME_INK, ';margin-right:2px;}',
    '.mtx-ticket__note-text{font-family:', FONT_KAI, ';font-size:16.5px;color:', INK, ';}',
    /* 下次约定：麦黄底小标签，位置在主题短句下方 */
    '.mtx-ticket__nextwrap{margin-top:12px;text-align:center;}',
    '.mtx-ticket__next{display:inline-block;max-width:100%;padding:4px 14px;border-radius:999px;',
    'background:rgba(255,199,44,.30);color:#6A4600;font-size:13px;line-height:1.6;}',
    '.mtx-ticket__next-prefix{font-weight:700;color:#8A5A00;margin-right:4px;}',
    '.mtx-ticket__tear{margin:18px -30px 14px;border-top:2px dashed rgba(218,41,28,.32);}',
    '.mtx-ticket__theme{font-family:', FONT_HAND, ';font-size:18px;line-height:1.6;',
    'color:', THEME_INK, ';text-align:center;letter-spacing:.04em;}',
    '.mtx-ticket__meta{margin-top:10px;font-size:12px;line-height:1.6;color:', MUTED, ';text-align:center;}',
    '.mtx-ticket__hidden{margin-top:2px;font-size:12px;line-height:1.6;',
    'color:rgba(138,117,102,.85);text-align:center;}',
    /* 方图 / 竖屏预览：与导出版式一致地「照片在左、事由日期同桌在右」，不裁切内容 */
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body,',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body{',
    'display:grid;grid-template-columns:42% 1fr;column-gap:14px;align-items:start;}',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body{',
    'grid-template-columns:46% 1fr;column-gap:16px;}',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body>.mtx-ticket__row,',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body>.mtx-ticket__row{',
    'grid-column:1 / -1;margin-top:12px;}',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body>.mtx-ticket__row[data-field="title"],',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body>.mtx-ticket__row[data-field="date"],',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body>.mtx-ticket__row[data-field="members"],',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body>.mtx-ticket__row[data-field="title"],',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body>.mtx-ticket__row[data-field="date"],',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body>.mtx-ticket__row[data-field="members"]{',
    'grid-column:2;margin-top:10px;}',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__body>.mtx-ticket__row[data-field="title"],',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__body>.mtx-ticket__row[data-field="title"]{',
    'margin-top:0;}',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__photo-wrap,',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__photo-wrap{',
    'grid-column:1;grid-row:1 / span 3;width:100%;margin:0;}',
    '.mtx-ticket[data-photo="1"][data-layout="square"] .mtx-ticket__photo{max-height:150px;}',
    '.mtx-ticket[data-photo="1"][data-layout="story"] .mtx-ticket__photo{max-height:200px;}',
    '@media (max-width:420px){.mtx-ticket__photo{max-height:38vw;}}',
    '@media (max-width:380px){',
    '.mtx-ticket{padding:8px;}',
    '.mtx-ticket__paper{padding:20px 22px 18px;}',
    '.mtx-ticket__headline{font-size:21px;}',
    '.mtx-ticket__tear{margin-left:-22px;margin-right:-22px;}',
    '}'
  ].join('');

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(style);
  }

  // -------------------------------------------------------------------------
  // DOM 渲染
  // -------------------------------------------------------------------------

  function row(label, valueNode, extraClass, field) {
    var wrap = el('div', 'mtx-ticket__row');
    if (field) wrap.setAttribute('data-field', field);
    wrap.appendChild(el('div', 'mtx-ticket__label', label));
    if (valueNode) {
      if (extraClass) valueNode.className = (valueNode.className || '') + ' ' + extraClass;
      wrap.appendChild(valueNode);
    }
    return wrap;
  }

  function valueNode(str, extraClass) {
    return el('div', 'mtx-ticket__value' + (extraClass ? ' ' + extraClass : ''), str);
  }

  function buildItems(ticket) {
    var list = itemsOf(ticket);
    if (!list.length) return valueNode(PLACEHOLDER);
    var ul = el('ul', 'mtx-ticket__items');
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i] || {};
      var li = el('li', 'mtx-ticket__item');
      li.appendChild(el('span', 'mtx-ticket__qty', text(item.quantity, '1') + '×'));
      li.appendChild(el('span', 'mtx-ticket__item-name', text(item.name)));
      li.appendChild(el('span', 'mtx-ticket__who', text(item.assignee, '同桌共享')));
      ul.appendChild(li);
    }
    return ul;
  }

  function buildWishes(ticket) {
    var list = wishesOf(ticket);
    if (!list.length) return el('p', 'mtx-ticket__empty', '这次没有记下小心愿');
    var ul = el('ul', 'mtx-ticket__wishes');
    for (var i = 0; i < list.length; i += 1) {
      var wish = list[i] || {};
      var li = el('li', 'mtx-ticket__wish');
      li.appendChild(el('span', 'mtx-ticket__wish-name',
        text(wish.member) + '「' + text(wish.wish) + '」'));
      li.appendChild(el('span', 'mtx-ticket__wish-by', '由 ' + text(wish.byProduct) + ' 满足'));
      ul.appendChild(li);
    }
    return ul;
  }

  // 合照贴纸：白边 + 旋转 + 阴影；宽度 ≤ 内容区 78%，高度按原图比例且 ≤ 约 42% 票根宽
  function buildPhoto(ticket) {
    var src = photoOf(ticket);
    if (!src) return null;
    var wrap = el('div', 'mtx-ticket__photo-wrap');
    wrap.setAttribute('data-field', 'photo');
    wrap.style.transform = 'rotate(' + stickerAngle(ticket).toFixed(1) + 'deg)';
    var img = document.createElement('img');
    img.className = 'mtx-ticket__photo';
    img.src = src;
    img.alt = '这一桌人的合照';
    img.decoding = 'async';
    wrap.appendChild(img);
    return wrap;
  }

  function buildNotes(ticket) {
    var list = notesOf(ticket);
    if (!list.length) return null;
    var box = el('div', 'mtx-ticket__notes');
    box.setAttribute('data-field', 'notes');
    for (var i = 0; i < list.length; i += 1) {
      var line = el('div', 'mtx-ticket__note');
      line.appendChild(el('span', 'mtx-ticket__note-name', list[i].member + '：'));
      line.appendChild(el('span', 'mtx-ticket__note-text', '「' + list[i].note + '」'));
      box.appendChild(line);
    }
    return row('每 人 一 句', box);
  }

  function buildNextMeet(ticket) {
    var value = nextMeetOf(ticket);
    if (!value) return null;
    var wrap = el('div', 'mtx-ticket__nextwrap');
    wrap.setAttribute('data-field', 'nextMeet');
    var tag = el('span', 'mtx-ticket__next');
    if (nextMeetNeedsPrefix(value)) {
      tag.appendChild(el('span', 'mtx-ticket__next-prefix', '下次'));
    }
    tag.appendChild(el('span', 'mtx-ticket__next-body', nextMeetBody(value)));
    wrap.appendChild(tag);
    return wrap;
  }

  function render(container, ticket, opts) {
    if (!container || typeof container.appendChild !== 'function') return null;
    ensureStyles();
    var t = ticket || {};

    var root = el('div', 'mtx-ticket');
    // 记录版式，供样式与自动化测试识别（DOM 预览始终为竖版排版）
    root.setAttribute('data-layout', (opts && opts.layout) || 'portrait');
    root.setAttribute('data-ticket-id', text(t.ticketId, ''));
    // 预览也要跟着「版式」变：方图/竖屏走「照片在左、事实在右」的双栏
    root.setAttribute('data-layout', normalizeLayout(opts && opts.layout));

    var paper = el('div', 'mtx-ticket__paper');
    paper.appendChild(el('div', 'mtx-ticket__edge mtx-ticket__edge--left'));
    paper.appendChild(el('div', 'mtx-ticket__edge mtx-ticket__edge--right'));
    paper.appendChild(el('div', 'mtx-ticket__perf mtx-ticket__perf--l'));
    paper.appendChild(el('div', 'mtx-ticket__perf mtx-ticket__perf--r'));

    // 票头：品牌 + 标题（标题不是可勾选字段，始终作为票根框架出现）
    var head = el('div', 'mtx-ticket__head');
    head.appendChild(el('div', 'mtx-ticket__brand', '麦麦同席'));
    head.appendChild(el('h3', 'mtx-ticket__headline', '同桌食光票根'));
    if (isVisible(t, 'status')) {
      head.appendChild(el('span',
        'mtx-ticket__badge mtx-ticket__badge--' + statusKindOf(t), statusLabelOf(t)));
    }
    paper.appendChild(head);

    var body = el('div', 'mtx-ticket__body');

    // 每个字段都按 fieldsVisible 决定「是否渲染」，未勾选则整块不进入 DOM
    if (isVisible(t, 'title')) {
      body.appendChild(row('事 由', valueNode(text(t.title), 'mtx-ticket__value--title'),
        null, 'title'));
    }
    if (isVisible(t, 'date')) {
      body.appendChild(row('日 期', valueNode(text(t.date), 'mtx-ticket__value--date'),
        null, 'date'));
    }
    if (isVisible(t, 'members')) {
      var memberValue = valueNode(membersLine(t));
      memberValue.setAttribute('data-count', String(membersOf(t).length));
      body.appendChild(row('同 桌', memberValue, null, 'members'));
    }
    // 合照放在事由/日期之后、代表餐品之前：这一桌人的视觉锚点
    if (isVisible(t, 'photo')) {
      var photo = buildPhoto(t);
      if (photo) {
        body.appendChild(photo);
        root.setAttribute('data-photo', '1');
      }
    }
    if (isVisible(t, 'items')) {
      body.appendChild(row('代表餐品', buildItems(t), null, 'items'));
    }
    if (isVisible(t, 'wishes')) {
      body.appendChild(row('小心愿', buildWishes(t), null, 'wishes'));
    }
    if (isVisible(t, 'notes')) {
      var notes = buildNotes(t);
      if (notes) body.appendChild(notes);
    }
    paper.appendChild(body);

    paper.appendChild(el('div', 'mtx-ticket__tear'));

    if (isVisible(t, 'themeLine')) {
      paper.appendChild(el('p', 'mtx-ticket__theme', text(t.themeLine)));
    }
    // 下次约定：主题短句下方的一枚麦黄小标签
    if (isVisible(t, 'nextMeet')) {
      var next = buildNextMeet(t);
      if (next) paper.appendChild(next);
    }

    var meta = el('div', 'mtx-ticket__meta');
    meta.appendChild(el('div', null, '数据时点 ' + text(t.dataTime) + ' · ' + dataSourceLabel(t)));
    paper.appendChild(meta);

    var hidden = hiddenNoteOf(t);
    if (hidden) paper.appendChild(el('div', 'mtx-ticket__hidden', hidden));

    root.appendChild(paper);

    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(root);
    return root;
  }

  // -------------------------------------------------------------------------
  // Canvas 布局参数：逻辑宽 540，输出时 ×2 → 1080 宽
  // portrait 高度自适应；square 540×540（1080×1080）；story 540×960（1080×1920）
  // -------------------------------------------------------------------------

  var PAPER_INSET = 18;

  var LAYOUTS = {
    portrait: {
      key: 'portrait', label: '竖版',
      width: 540, height: null,
      pad: 46, topPad: 44, bottomPad: 28,
      scale: 1, minScale: 1,
      photoMaxH: 540 * 0.42,
      twoColumn: false,
      minHeight: 620
    },
    square: {
      key: 'square', label: '方图',
      width: 540, height: 540,
      pad: 30, topPad: 24, bottomPad: 18,
      scale: 0.8, minScale: 0.68,
      photoMaxH: 168,
      twoColumn: true,
      leftRatio: 0.4,
      notesInColumn: true,
      minHeight: 540
    },
    story: {
      key: 'story', label: '竖屏',
      width: 540, height: 960,
      pad: 42, topPad: 42, bottomPad: 44,
      scale: 0.9, minScale: 0.8,
      photoMaxH: 540 * 0.48,
      twoColumn: true,
      leftRatio: 0.44,
      notesInColumn: false,
      minHeight: 960
    }
  };

  function normalizeLayout(key) {
    return LAYOUTS[key] ? key : 'portrait';
  }

  // 可用内容条数：方版最多 3 件餐品；长图允许更完整的呈现
  function budgetLadder(cfg) {
    if (!cfg.height) {
      return [{ items: 99, wishes: 99, notes: MAX_NOTES, nick: 0 }];
    }
    var itemTop = cfg.key === 'square' ? 3 : 4;
    var itemFloor = Math.min(2, itemTop); // 「代表餐品」至少留 2 件才像一桌菜
    var wishTop = 4;
    var noteTop = MAX_NOTES;
    var out = [];
    var it;
    var wi;
    var no;
    // 裁剪优先级：先减餐品条数 → 再减心愿条数 → 再减一句话 → 最后截断昵称
    for (it = itemTop; it >= itemFloor; it -= 1) {
      out.push({ items: it, wishes: wishTop, notes: noteTop, nick: 0 });
    }
    for (wi = wishTop - 1; wi >= 0; wi -= 1) {
      out.push({ items: itemFloor, wishes: wi, notes: noteTop, nick: 0 });
    }
    out.push({ items: 1, wishes: 0, notes: noteTop, nick: 0 });
    for (no = noteTop - 1; no >= 1; no -= 1) {
      out.push({ items: 1, wishes: 0, notes: no, nick: 0 });
    }
    out.push({ items: 1, wishes: 0, notes: 0, nick: 10 });
    out.push({ items: 1, wishes: 0, notes: 0, nick: 6 });
    // 实在放不下才完全省略餐品
    out.push({ items: 0, wishes: 0, notes: 0, nick: 6 });
    return out;
  }

  function scaleLadder(cfg) {
    var out = [cfg.scale];
    if (cfg.minScale && cfg.minScale < cfg.scale) {
      out.push((cfg.scale * 2 + cfg.minScale) / 3);
      out.push(cfg.minScale);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Canvas 折行/截断
  // -------------------------------------------------------------------------

  function wrapText(ctx, str, maxWidth, maxLines) {
    var source = String(str === null || str === undefined ? '' : str);
    var lines = [];
    var line = '';
    for (var i = 0; i < source.length; i += 1) {
      var next = line + source.charAt(i);
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = source.charAt(i);
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    if (!lines.length) lines = [''];

    if (maxLines && lines.length > maxLines) {
      var kept = lines.slice(0, maxLines);
      var last = kept[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      kept[maxLines - 1] = last + '…';
      return kept;
    }
    return lines;
  }

  function truncate(ctx, str, maxWidth) {
    var source = String(str === null || str === undefined ? '' : str);
    if (ctx.measureText(source).width <= maxWidth) return source;
    var line = '';
    for (var i = 0; i < source.length; i += 1) {
      if (ctx.measureText(line + source.charAt(i) + '…').width > maxWidth) break;
      line += source.charAt(i);
    }
    return line ? line + '…' : '…';
  }

  // -------------------------------------------------------------------------
  // 绘制游标：所有块都往同一个 ops 数组里追加绝对坐标指令
  // -------------------------------------------------------------------------

  function Pen(ops, ctx, opts) {
    this.ops = ops;
    this.ctx = ctx;
    this.x = opts.x;
    this.y = opts.y;
    this.w = opts.w;
    this.scale = opts.scale;
  }

  Pen.prototype.px = function (size) {
    return Math.max(8, Math.round(size * this.scale * 10) / 10);
  };

  Pen.prototype.adv = function (n) {
    this.y += Math.round(n * this.scale);
    return this;
  };

  Pen.prototype.text = function (str, o) {
    o = o || {};
    var size = this.px(o.size || 18);
    var font = (o.weight || '400') + ' ' + size + 'px ' + (o.family || FONT_SANS);
    var lh = Math.max(Math.round(size * 1.2), Math.round((o.lh || (o.size || 18) * 1.45) * this.scale));
    this.ctx.font = font;
    var lines = wrapText(this.ctx, str, this.w, o.maxLines || 0);
    var align = o.align || 'left';
    var ax = align === 'center' ? this.x + this.w / 2
      : (align === 'right' ? this.x + this.w : this.x);
    var baseline = this.y + Math.round(size * 0.86);
    for (var i = 0; i < lines.length; i += 1) {
      this.ops.push({
        k: 'text', s: lines[i], f: font, c: o.color || INK,
        x: ax, y: baseline + i * lh, a: align
      });
    }
    this.y += lines.length * lh;
    return this;
  };

  Pen.prototype.label = function (str) {
    this.text(str, { size: 13, weight: '600', color: MUTED, lh: 24 });
    this.adv(3);
    return this;
  };

  Pen.prototype.rule = function (color, dash) {
    this.ops.push({
      k: 'line', x1: this.x - 6, y1: this.y, x2: this.x + this.w + 6, y2: this.y,
      c: color || 'rgba(218,41,28,.36)', w: 2 * this.scale, d: dash || [7, 7]
    });
    return this;
  };

  Pen.prototype.badge = function (label, done) {
    var font = '600 ' + this.px(16) + 'px ' + FONT_SANS;
    this.ctx.font = font;
    var w = Math.max(this.px(96), this.ctx.measureText(label).width + this.px(44));
    var h = Math.round(this.px(32));
    this.ops.push({
      k: 'rect', x: this.x + (this.w - w) / 2, y: this.y, w: w, h: h, r: h / 2,
      c: done ? RED : YELLOW
    });
    this.ops.push({
      k: 'text', s: label, f: font, c: done ? CREAM : '#6A4600',
      x: this.x + this.w / 2, y: this.y + Math.round(h * 0.69), a: 'center'
    });
    this.y += h;
    return this;
  };

  // 单个圆角填充块（用于「下次」标签）
  Pen.prototype.pill = function (w, h, fill) {
    this.ops.push({
      k: 'rect', x: this.x + (this.w - w) / 2, y: this.y, w: w, h: h, r: h / 2, c: fill
    });
    return this;
  };

  Pen.prototype.photo = function (img, maxW, maxH) {
    if (!img || !img.width || !img.height) return this;
    var ratio = img.height / img.width;
    var w = Math.min(maxW, this.w);
    var h = w * ratio;
    if (h > maxH) {
      h = maxH;
      w = h / ratio;
    }
    // 白边相纸比照片本身大 7px，占位时一并算进去，避免压到下一块
    var border = 7;
    this.ops.push({
      k: 'photo', img: img, x: this.x + (this.w - w) / 2, y: this.y + border,
      w: w, h: h, angle: this.angle
    });
    this.y += h + border * 2;
    return this;
  };

  Pen.prototype.itemRow = function (qty, name, who) {
    var qSize = 17, nSize = 21, wSize = 17;
    var qFont = '700 ' + this.px(qSize) + 'px ' + FONT_SANS;
    var nFont = '500 ' + this.px(nSize) + 'px ' + FONT_SANS;
    var wFont = '400 ' + this.px(wSize) + 'px ' + FONT_SANS;
    var qW = this.px(38);
    var gap = this.px(10);

    this.ctx.font = wFont;
    var whoText = truncate(this.ctx, who, this.px(130));
    var whoW = this.ctx.measureText(whoText).width;

    this.ctx.font = nFont;
    var nameMax = Math.max(this.px(60), this.w - qW - whoW - gap);
    var base = this.y + Math.round(this.px(nSize) * 0.86);

    this.ops.push({ k: 'text', s: qty + '×', f: qFont, c: RED, x: this.x, y: base, a: 'left' });
    this.ops.push({
      k: 'text', s: truncate(this.ctx, name, nameMax), f: nFont, c: INK,
      x: this.x + qW, y: base, a: 'left'
    });
    this.ops.push({
      k: 'text', s: whoText, f: wFont, c: MUTED, x: this.x + this.w, y: base, a: 'right'
    });
    this.y += Math.round(this.px(30));
    return this;
  };

  // 一人一句：名字（暖红加粗小字）+ 楷体句子，最多两行
  Pen.prototype.note = function (name, body) {
    var nameSize = 13, bodySize = 17;
    var nameFont = '700 ' + this.px(nameSize) + 'px ' + FONT_SANS;
    var bodyFont = '400 ' + this.px(bodySize) + 'px ' + FONT_KAI;

    this.ctx.font = nameFont;
    var prefix = truncate(this.ctx, name + '：', this.w * 0.42);
    var preW = this.ctx.measureText(prefix).width;

    this.ctx.font = bodyFont;
    var avail = Math.max(this.w * 0.4, this.w - preW);
    var lines = wrapText(this.ctx, '「' + body + '」', avail, 2);
    var lh = Math.round(this.px(26));
    var base = this.y + Math.round(this.px(bodySize) * 0.88);

    this.ops.push({ k: 'text', s: prefix, f: nameFont, c: THEME_INK, x: this.x, y: base, a: 'left' });
    for (var i = 0; i < lines.length; i += 1) {
      this.ops.push({
        k: 'text', s: lines[i], f: bodyFont, c: INK,
        x: this.x + preW, y: base + i * lh, a: 'left'
      });
    }
    this.y += Math.max(1, lines.length) * lh;
    return this;
  };

  // 下次约定：麦黄小标签；文案本身已是「下周五…」时不重复加前缀
  Pen.prototype.nextTag = function (prefix, body) {
    var pFont = '700 ' + this.px(15) + 'px ' + FONT_SANS;
    var bFont = '500 ' + this.px(16) + 'px ' + FONT_SANS;
    var padX = this.px(16);
    var gap = this.px(6);
    var h = Math.round(this.px(32));
    var hasPrefix = !!prefix;
    var pw = 0;

    if (hasPrefix) {
      this.ctx.font = pFont;
      pw = this.ctx.measureText(prefix).width;
    }
    this.ctx.font = bFont;
    var maxBody = Math.max(this.px(40), this.w - padX * 2 - (hasPrefix ? pw + gap : 0));
    var bodyText = truncate(this.ctx, body, maxBody);
    var bw = this.ctx.measureText(bodyText).width;
    var w = Math.min(this.w, (hasPrefix ? pw + gap : 0) + bw + padX * 2);

    this.pill(w, h, 'rgba(255,199,44,.30)');
    var x = this.x + (this.w - w) / 2;
    var base = this.y + Math.round(h * 0.68);
    if (hasPrefix) {
      this.ops.push({ k: 'text', s: prefix, f: pFont, c: '#8A5A00', x: x + padX, y: base, a: 'left' });
    }
    this.ops.push({
      k: 'text', s: bodyText, f: bFont, c: '#6A4600',
      x: x + padX + (hasPrefix ? pw + gap : 0), y: base, a: 'left'
    });
    this.y += h;
    return this;
  };

  // -------------------------------------------------------------------------
  // 内容块
  // -------------------------------------------------------------------------

  function blockTitle(pen, t, cfg) {
    if (!isVisible(t, 'title')) return;
    pen.label('事 由');
    pen.text(text(t.title), {
      size: 27, weight: '700', color: INK, lh: 36, maxLines: cfg.key === 'square' ? 2 : 3
    });
    pen.adv(cfg.key === 'square' ? 10 : 14);
  }

  function blockDate(pen, t, cfg) {
    if (!isVisible(t, 'date')) return;
    pen.label('日 期');
    pen.text(text(t.date), { size: 23, weight: '500', color: INK, lh: 32, maxLines: 2 });
    pen.adv(cfg.key === 'square' ? 8 : 12);
  }

  function blockMembers(pen, t, cfg, budget) {
    if (!isVisible(t, 'members')) return;
    pen.label('同 桌');
    pen.text(membersLine(t, budget && budget.nick), {
      size: 21, weight: '500', color: INK, lh: 30, maxLines: 2
    });
    pen.adv(cfg.key === 'square' ? 10 : 14);
  }

  function blockPhoto(pen, t, cfg, img) {
    if (!img) return;
    pen.photo(img, pen.w * 0.78, cfg.photoMaxH);
    pen.adv(cfg.key === 'square' ? 10 : 16);
  }

  function blockItems(pen, t, cfg, budget) {
    if (!isVisible(t, 'items')) return;
    var list = itemsOf(t);
    var limit = Math.min(list.length, budget.items);
    // 空间不足时整块省略餐品，而不是留一个空的「代表餐品」标题
    if (list.length && !limit) return;
    pen.label('代表餐品');
    if (!list.length) {
      pen.text(PLACEHOLDER, { size: 20, color: MUTED, lh: 30 });
    } else {
      for (var i = 0; i < limit; i += 1) {
        var item = list[i] || {};
        pen.itemRow(text(item.quantity, '1'), text(item.name), text(item.assignee, '同桌共享'));
      }
      if (!cfg.height && limit < list.length) {
        pen.adv(2);
        pen.text('共 ' + list.length + ' 件，票根只留 ' + limit + ' 件', {
          size: 13, color: MUTED, lh: 20, maxLines: 1
        });
      }
    }
    pen.adv(cfg.key === 'square' ? 8 : 14);
  }

  function blockWishes(pen, t, cfg, budget) {
    if (!isVisible(t, 'wishes')) return;
    var list = wishesOf(t);
    if (!list.length) return; // 没有心愿就不占版面
    var limit = Math.min(list.length, budget.wishes);
    if (!limit) return;
    pen.label('小心愿');
    for (var i = 0; i < limit; i += 1) {
      var wish = list[i] || {};
      pen.text(text(wish.member) + '「' + text(wish.wish) + '」', {
        size: 20, weight: '600', color: INK, lh: 26, maxLines: 1
      });
      pen.text('由 ' + text(wish.byProduct) + ' 满足', {
        size: 16, color: MUTED, lh: 24, maxLines: 1
      });
    }
    pen.adv(cfg.key === 'square' ? 8 : 12);
  }

  function blockNotes(pen, t, cfg, budget) {
    if (!isVisible(t, 'notes')) return;
    var list = notesOf(t);
    if (!list.length) return;
    var limit = Math.min(list.length, budget.notes);
    if (!limit) return;
    pen.label('每 人 一 句');
    for (var i = 0; i < limit; i += 1) {
      pen.note(list[i].member, list[i].note);
    }
    pen.adv(cfg.key === 'square' ? 8 : 12);
  }

  function shiftOps(ops, from, dy) {
    if (!dy) return;
    for (var i = from; i < ops.length; i += 1) {
      var o = ops[i];
      if (o.k === 'line') {
        o.y1 += dy;
        o.y2 += dy;
      } else {
        o.y += dy;
      }
    }
  }

  var measureCtxCache = null;

  function measureCtx() {
    if (measureCtxCache) return measureCtxCache;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持 canvas，无法导出票根图片');
    measureCtxCache = ctx;
    return ctx;
  }

  function compose(ticket, cfg, budget, img) {
    var t = ticket || {};
    var ctx = measureCtx();
    var ops = [];
    var pad = cfg.pad;
    var inner = cfg.width - pad * 2;
    var pen = new Pen(ops, ctx, { x: pad, y: cfg.topPad, w: inner, scale: cfg.scale });
    pen.angle = stickerAngle(t);

    // ---- 票头 ----
    if (cfg.key === 'square') {
      // 方版：品牌与状态同排，标题独立一行，尽量省纵向空间
      var bFont = '600 ' + pen.px(13) + 'px ' + FONT_SANS;
      var badgeLabel = statusLabelOf(t);
      ctx.font = bFont;
      var bw = ctx.measureText(badgeLabel).width + pen.px(18);
      var bh = Math.round(pen.px(22));
      if (isVisible(t, 'status')) {
        ops.push({
          k: 'rect', x: pen.x + pen.w - bw, y: pen.y + 2, w: bw, h: bh, r: bh / 2,
          c: statusKindOf(t) === 'completed' ? RED : YELLOW
        });
        ops.push({
          k: 'text', s: badgeLabel, f: bFont,
          c: statusKindOf(t) === 'completed' ? CREAM : '#6A4600',
          x: pen.x + pen.w - bw / 2, y: pen.y + 2 + Math.round(bh * 0.7), a: 'center'
        });
      }
      ops.push({
        k: 'text', s: '麦 麦 同 席', f: bFont, c: RED,
        x: pen.x, y: pen.y + Math.round(pen.px(13) * 1.35), a: 'left'
      });
      pen.y += Math.max(bh + 2, Math.round(pen.px(18)));
      pen.adv(4);
      pen.text('同桌食光票根', {
        size: 30, weight: '700', family: FONT_SERIF, color: INK, align: 'center', lh: 40
      });
      pen.adv(10);
      pen.rule();
      pen.adv(14);
    } else {
      pen.text('麦 麦 同 席', { size: 17, weight: '600', color: RED, align: 'center', lh: 24 });
      pen.adv(10);
      pen.text('同桌食光票根', {
        size: 38, weight: '700', family: FONT_SERIF, color: INK, align: 'center', lh: 48
      });
      if (isVisible(t, 'status')) {
        pen.adv(8);
        pen.badge(statusLabelOf(t), statusKindOf(t) === 'completed');
      }
      pen.adv(cfg.key === 'story' ? 18 : 16);
      pen.rule();
      pen.adv(cfg.key === 'story' ? 26 : 22);
    }

    // ---- 主体 ----
    if (cfg.twoColumn && img) {
      // 方版/长图：照片在左、文字在右，用横向空间换纵向空间
      var gutter = Math.round(inner * 0.05);
      var leftW = Math.round(inner * (cfg.leftRatio || 0.4));
      var rightW = inner - leftW - gutter;
      var left = new Pen(ops, ctx, { x: pad, y: pen.y, w: leftW, scale: cfg.scale });
      var right = new Pen(ops, ctx, { x: pad + leftW + gutter, y: pen.y, w: rightW, scale: cfg.scale });
      left.angle = pen.angle;
      right.angle = pen.angle;
      left.photo(img, leftW, cfg.photoMaxH);
      blockTitle(right, t, cfg);
      blockDate(right, t, cfg);
      blockMembers(right, t, cfg, budget);
      if (cfg.notesInColumn) blockNotes(right, t, cfg, budget);
      pen.y = Math.max(left.y, right.y);
      pen.adv(cfg.key === 'square' ? 10 : 14);
      blockItems(pen, t, cfg, budget);
      blockWishes(pen, t, cfg, budget);
      if (!cfg.notesInColumn) blockNotes(pen, t, cfg, budget);
    } else {
      blockTitle(pen, t, cfg);
      blockDate(pen, t, cfg);
      blockMembers(pen, t, cfg, budget);
      blockPhoto(pen, t, cfg, img);
      blockItems(pen, t, cfg, budget);
      blockWishes(pen, t, cfg, budget);
      blockNotes(pen, t, cfg, budget);
    }

    // ---- 撕线 + 手写主题短句 ----
    pen.adv(cfg.key === 'square' ? 4 : 6);
    pen.rule();
    pen.adv(cfg.key === 'square' ? 14 : 20);

    if (isVisible(t, 'themeLine')) {
      pen.text(text(t.themeLine), {
        size: 24, family: FONT_HAND, color: THEME_INK, align: 'center', lh: 34, maxLines: 2
      });
      pen.adv(cfg.key === 'square' ? 6 : 10);
    }

    var nextMeet = nextMeetOf(t);
    if (isVisible(t, 'nextMeet') && nextMeet) {
      pen.nextTag(nextMeetNeedsPrefix(nextMeet) ? '下次' : '', nextMeetBody(nextMeet));
      pen.adv(cfg.key === 'square' ? 2 : 6);
    }

    // ---- 页脚：数据时点 + 已隐去字段 ----
    var footerStart = ops.length;
    var footer = new Pen(ops, ctx, {
      x: pad, y: pen.y + (cfg.key === 'square' ? 10 : 18), w: inner, scale: cfg.scale
    });
    footer.text('数据时点 ' + text(t.dataTime) + ' · ' + dataSourceLabel(t), {
      size: 15, color: MUTED, align: 'center', lh: 22, maxLines: 2
    });
    var hidden = cfg.key === 'square' && hiddenCountOf(t)
      ? '已隐去 ' + hiddenCountOf(t) + ' 项隐私字段'
      : hiddenNoteOf(t);
    if (hidden) {
      footer.adv(4);
      footer.text(hidden, {
        size: 14, color: 'rgba(138,117,102,.85)', align: 'center', lh: 20, maxLines: 2
      });
    }

    var natural = Math.round(footer.y + cfg.bottomPad);
    var height = cfg.height || Math.max(natural, cfg.minHeight || 0);
    if (cfg.height && natural <= cfg.height) {
      // 固定画幅时把页脚压到底部，剩下的留白都留在内容与页脚之间
      shiftOps(ops, footerStart, cfg.height - cfg.bottomPad - footer.y);
    }

    return {
      width: cfg.width,
      height: height,
      natural: natural,
      ops: ops,
      stats: {
        items: budget.items,
        wishes: budget.wishes,
        notes: budget.notes,
        nick: budget.nick,
        scale: cfg.scale
      }
    };
  }

  function buildCanvasModel(ticket, cfg, img) {
    var ladder = budgetLadder(cfg);
    var scales = cfg.height ? scaleLadder(cfg) : [cfg.scale];
    var attempt = null;

    for (var b = 0; b < ladder.length; b += 1) {
      for (var s = 0; s < scales.length; s += 1) {
        var tuned = {};
        for (var key in cfg) {
          if (Object.prototype.hasOwnProperty.call(cfg, key)) tuned[key] = cfg[key];
        }
        tuned.scale = scales[s];
        var model = compose(ticket, tuned, ladder[b], img);
        model.layout = cfg.key;
        if (!cfg.height || model.natural <= cfg.height) return model;
        attempt = model;
      }
    }

    // 极端情况兜底：缩照片，再缩字号——宁可小一点，也不切字
    var tail = ladder[ladder.length - 1];
    for (var k = 0; k < 4; k += 1) {
      var fallback = {};
      for (var fk in cfg) {
        if (Object.prototype.hasOwnProperty.call(cfg, fk)) fallback[fk] = cfg[fk];
      }
      fallback.scale = Math.max(0.5, cfg.minScale * 0.9);
      fallback.photoMaxH = cfg.photoMaxH * Math.pow(0.78, k + 1);
      var last = compose(ticket, fallback, tail, img);
      last.layout = cfg.key;
      if (last.natural <= cfg.height) return last;
      attempt = last;
    }

    // 仍然放不下时保持原比例输出，绝不裁切文字（画幅会略高于目标）
    attempt.height = Math.max(attempt.natural, cfg.height);
    return attempt;
  }

  // -------------------------------------------------------------------------
  // 画布绘制
  // -------------------------------------------------------------------------

  function roundRect(ctx, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function drawNoise(ctx, width, height) {
    // 固定种子：同一张票根每次导出的纹理一致
    var seed = 20261025;
    function rand() {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    }
    ctx.save();
    ctx.fillStyle = 'rgba(58,44,34,0.05)';
    for (var i = 0; i < 700; i += 1) {
      var x = PAPER_INSET + rand() * (width - PAPER_INSET * 2);
      var py = PAPER_INSET + rand() * (height - PAPER_INSET * 2);
      ctx.fillRect(x, py, 1.4, 1.4);
    }
    ctx.restore();
  }

  // 合照：白边相纸 + 轻微旋转 + 投影；图片按 cover 裁进圆角框内，不变形
  function drawPhoto(ctx, op) {
    var w = op.w;
    var h = op.h;
    ctx.save();
    ctx.translate(op.x + w / 2, op.y + h / 2);
    ctx.rotate((op.angle || 0) * Math.PI / 180);

    ctx.save();
    ctx.shadowColor = 'rgba(58,44,34,.28)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    roundRect(ctx, -w / 2 - 7, -h / 2 - 7, w + 14, h + 14, 6);
    ctx.fillStyle = '#FFFDF8';
    ctx.fill();
    ctx.restore();

    roundRect(ctx, -w / 2, -h / 2, w, h, 5);
    ctx.save();
    ctx.clip();
    try {
      ctx.drawImage(op.img, -w / 2, -h / 2, w, h);
    } catch (e) {
      // 图片解码失败：留白，不影响其余内容导出
    }
    ctx.restore();
    ctx.restore();
  }

  function drawModel(ctx, model) {
    var width = model.width;
    var height = model.height;

    // 底色与纸面差一档，撕线缺口才看得出是「撕」而不是阴影
    ctx.fillStyle = CREAM_DEEP;
    ctx.fillRect(0, 0, width, height);

    roundRect(ctx, PAPER_INSET, PAPER_INSET, width - PAPER_INSET * 2, height - PAPER_INSET * 2, 14);
    ctx.fillStyle = CREAM;
    ctx.fill();

    drawNoise(ctx, width, height);

    // 左右半圆缺口
    ctx.fillStyle = CREAM_DEEP;
    for (var yy = PAPER_INSET + 14; yy < height - PAPER_INSET - 8; yy += 17) {
      ctx.beginPath();
      ctx.arc(PAPER_INSET, yy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(width - PAPER_INSET, yy, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // 竖向穿孔虚线
    ctx.save();
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(218,41,28,.26)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAPER_INSET + 14, PAPER_INSET + 18);
    ctx.lineTo(PAPER_INSET + 14, height - PAPER_INSET - 18);
    ctx.moveTo(width - PAPER_INSET - 14, PAPER_INSET + 18);
    ctx.lineTo(width - PAPER_INSET - 14, height - PAPER_INSET - 18);
    ctx.stroke();
    ctx.restore();

    // 指令回放
    for (var i = 0; i < model.ops.length; i += 1) {
      var c = model.ops[i];
      if (c.k === 'text') {
        ctx.font = c.f;
        ctx.fillStyle = c.c;
        ctx.textAlign = c.a;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(c.s, c.x, c.y);
      } else if (c.k === 'rect') {
        roundRect(ctx, c.x, c.y, c.w, c.h, c.r);
        ctx.fillStyle = c.c;
        ctx.fill();
      } else if (c.k === 'line') {
        ctx.save();
        ctx.strokeStyle = c.c;
        ctx.lineWidth = c.w;
        ctx.setLineDash(c.d || []);
        ctx.beginPath();
        ctx.moveTo(c.x1, c.y1);
        ctx.lineTo(c.x2, c.y2);
        ctx.stroke();
        ctx.restore();
      } else if (c.k === 'photo') {
        drawPhoto(ctx, c);
      }
    }
    ctx.textAlign = 'left';
  }

  // 照片加载：成功才画；超时 5s / onerror 都只跳过照片，不让整张导出失败
  function loadPhoto(ticket) {
    return new Promise(function (resolve) {
      if (!isVisible(ticket, 'photo')) {
        resolve(null);
        return;
      }
      var src = photoOf(ticket);
      if (!src || typeof global.Image !== 'function') {
        resolve(null);
        return;
      }
      var img = new global.Image();
      var settled = false;
      var timer = global.setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 5000);

      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) global.clearTimeout(timer);
        resolve(value);
      }

      img.onload = function () {
        finish(img.width && img.height ? img : null);
      };
      img.onerror = function () {
        finish(null);
      };
      try {
        img.src = src;
        // 部分浏览器对 dataURL 是同步解码的，补一次完成检测
        if (img.complete && img.width && img.height) finish(img);
      } catch (e) {
        finish(null);
      }
    });
  }

  function exportPNG(ticket, opts) {
    var key = normalizeLayout(opts && opts.layout);
    var cfg = LAYOUTS[key];
    return loadPhoto(ticket).then(function (img) {
      return new Promise(function (resolve, reject) {
        if (typeof document === 'undefined') {
          reject(new Error('导出票根需要浏览器环境'));
          return;
        }
        try {
          var model = buildCanvasModel(ticket, cfg, img);
          var dpr = 2; // 540 逻辑宽 → 1080 输出宽
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(model.width * dpr);
          canvas.height = Math.round(model.height * dpr);
          var ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('当前环境不支持 canvas，无法导出票根图片');
          ctx.scale(dpr, dpr);
          drawModel(ctx, model);

          if (typeof canvas.toBlob === 'function') {
            canvas.toBlob(function (blob) {
              if (blob) resolve(blob);
              else reject(new Error('票根图片生成失败'));
            }, 'image/png');
          } else {
            var dataUrl = canvas.toDataURL('image/png');
            var base64 = dataUrl.split(',')[1] || '';
            var binary = global.atob(base64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            resolve(new Blob([bytes], { type: 'image/png' }));
          }
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  function safeFilename(name) {
    var cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > 80) cleaned = cleaned.slice(0, 80);
    return cleaned;
  }

  function defaultFilename(ticket, opts) {
    var t = ticket || {};
    var cfg = LAYOUTS[normalizeLayout(opts && opts.layout)];
    var parts = ['麦麦同席', text(t.title, '同桌'), text(t.date, ''), cfg.label];
    var name = safeFilename(parts.join('-'));
    return (name || '麦麦同席-票根') + '.png';
  }

  function downloadPNG(ticket, filename, opts) {
    var name = safeFilename(filename || defaultFilename(ticket, opts));
    if (!name) name = '麦麦同席-票根.png';
    if (!/\.png$/i.test(name)) name += '.png';

    return exportPNG(ticket, opts).then(function (blob) {
      var url = global.URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      global.setTimeout(function () {
        if (link.parentNode) link.parentNode.removeChild(link);
        global.URL.revokeObjectURL(url);
      }, 1500);
      return name;
    });
  }

  global.TicketRenderer = {
    render: render,
    exportPNG: exportPNG,
    downloadPNG: downloadPNG,
    defaultFilename: defaultFilename,
    layoutSize: function (layout) {
      var cfg = LAYOUTS[normalizeLayout(layout)];
      return { width: cfg.width * 2, height: cfg.height ? cfg.height * 2 : null };
    },
    version: '1.1.0'
  };
}(typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : this)));
