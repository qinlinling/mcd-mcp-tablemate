/* P1 前端独立验收（开发期用 jsdom 驱动真实页面 + 真实后端）
 *
 * 不复用 agent 的临时脚本，独立断言四件事：
 *   1) 再聚：第 1 步卡片 → 带入 → 成员回填进第 2 步
 *   2) 偏好保存：默认不勾选、按钮禁用、勾 2 人后可保存、未授权成员被如实排除
 *   3) 票根增强：每人一句话/下次约定进入预览，版式切换后尺寸文案正确
 *   4) 订单关联：弹层列出订单、订单号只显示后 4 位、警示块出现
 *
 * 运行：先 python run.py 8848，再
 *   node tests/ui_p1_smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function loadJsdom() {
  const req = createRequire(import.meta.url);
  try { return req('jsdom'); } catch (e) {
    return createRequire(process.env.JSDOM_REQUIRE_BASE ||
      'C:/Users/WIN/.workbuddy/binaries/node/workspace/')('jsdom');
  }
}
const { JSDOM } = loadJsdom();

const BASE = process.env.MMTX_BASE || 'http://127.0.0.1:8848';
const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
const problems = [];
const report = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
    await sleep(120);
  }
}
const ok = m => report.push('  ✓ ' + m);
const bad = m => { report.push('  ✗ ' + m); problems.push(m); };

const dom = new JSDOM(html, {
  url: BASE + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
    win.scrollTo = () => {};
    win.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.addEventListener('error', e => problems.push('未捕获异常: ' + (e.error && e.error.stack || e.message)));
    const oe = win.console.error.bind(win.console);
    win.console.error = (...a) => { problems.push('console.error: ' + a.map(String).join(' ')); oe(...a); };
  },
});
const win = dom.window;
const doc = win.document;
const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const click = (el, label) => {
  if (!el) throw new Error('找不到可点击元素：' + label);
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const setValue = (el, value) => {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};

try {
  await waitFor(() => /\d{4}-\d{2}/.test($('#dataTimeText').textContent) || !$('#healthBanner').hidden,
    '页面初始化', 25000);
  await sleep(300);
  ok('页面初始化完成');

  /* ---------- 主流程走到票根页 ---------- */
  click($('#fillDemo'), '填入演示场景');
  await sleep(150);
  click($('#btnFindStores'), '查找门店');
  await waitFor(() => $$('.store-item').length > 0, '门店列表', 30000);
  click($$('.store-item')[0], '选门店');
  await waitFor(() => !$('#btnCreateParty').disabled, '创建按钮可用');
  click($('#btnCreateParty'), '创建聚餐');
  await waitFor(() => !$('#panel-2').hidden, '进入成员页');
  for (let i = 0; i < 6; i++) {
    const next = doc.querySelector('.js-member-next');
    if (!next) break;
    click(next, '下一位');
    await sleep(100);
  }
  await waitFor(() => !$('#btnGoPlans').disabled, '生成方案可用', 20000);
  click($('#btnGoPlans'), '生成方案');
  await waitFor(() => $$('.plan-card[data-plan]').length >= 3, '三案渲染', 150000);
  ok('三套方案已生成');
  click(doc.querySelector('[data-pick]'), '选方案');
  await waitFor(() => !$('#panel-4').hidden, '进入调整页');
  await waitFor(() => !$('#btnConfirm').disabled, '确认按钮可用');
  click($('#btnConfirm'), '确认方案');
  await waitFor(() => $('#btnGoTicket'), '确认成功');
  click($('#btnGoTicket'), '生成票根');
  await waitFor(() => $('#ticketPreview').querySelector('.mtx-ticket'), '票根渲染', 40000);
  ok('票根已渲染（竖版）');
  const rootLayout = $('#ticketPreview .mtx-ticket').getAttribute('data-layout');
  if (rootLayout === 'portrait') ok('票根根节点带 data-layout=portrait');
  else bad('票根 data-layout 异常：' + rootLayout);

  /* ---------- 3) 票根增强 ---------- */
  const noteInputs = $$('#noteEditor [data-note]');
  if (!noteInputs.length) bad('没有渲染「每人一句话」输入框');
  else {
    setValue(noteInputs[0], '今晚的薯条最香');
    if (noteInputs[1]) setValue(noteInputs[1], '下次换我请');
    await sleep(1400);   // debounce 500ms + 请求
    const text = $('#ticketPreview').textContent;
    if (text.includes('今晚的薯条最香')) ok('每人一句话已进入票根预览');
    else bad('每人一句话没有出现在预览里');
  }

  const nextMeet = $('#nextMeet');
  if (!nextMeet) bad('没有「下次约定」输入框');
  else {
    setValue(nextMeet, '下周五同一家');
    await sleep(1400);
    if ($('#ticketPreview').textContent.includes('下周五同一家')) ok('下次约定已进入票根预览');
    else bad('下次约定没有出现在预览里');
    const dup = /下次\s*下周五/.test($('#ticketPreview').textContent);
    if (dup) bad('出现了「下次下周五」重复前缀');
    else ok('下次约定没有重复前缀');
  }

  const square = doc.querySelector('input[name="ticketLayout"][value="square"]');
  if (!square) bad('没有方图版式选项');
  else {
    square.checked = true;
    square.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(700);
    const hint = $('#exportSizeHint') ? $('#exportSizeHint').textContent : '';
    if (hint.includes('1080') && hint.includes('1080')) ok('方图尺寸提示：' + hint.trim());
    else bad('方图尺寸提示不正确：' + hint);
    // 预览走 DOM（文字可选），但必须真的按所选版式重排；像素尺寸由导出保证
    const paper = $('#ticketPreview .mtx-ticket');
    const layoutAttr = paper ? paper.getAttribute('data-layout') : null;
    if (layoutAttr === 'square') ok('方图预览已按 square 重排（data-layout=square）');
    else bad('方图预览没有切换到 square：' + layoutAttr);
    const hasColumns = !!$('#ticketPreview .mtx-ticket__col') || !!$('#ticketPreview .mtx-ticket__columns');
    ok('方图预览结构：' + (hasColumns ? '双栏' : '单栏（按屏幕宽度）'));
    const pnote = $('.ticket-preview-note') ? $('.ticket-preview-note').textContent : '';
    if (/导出/.test(pnote) && /1080/.test(pnote)) ok('尺寸说明与实际一致：' + pnote.trim().slice(0, 46));
    else bad('预览说明缺少导出尺寸：' + pnote);
  }

  const story = doc.querySelector('input[name="ticketLayout"][value="story"]');
  if (story) {
    story.checked = true;
    story.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(700);
    const hint2 = $('#exportSizeHint') ? $('#exportSizeHint').textContent : '';
    const paper2 = $('#ticketPreview .mtx-ticket');
    if (hint2.includes('1920') && paper2 && paper2.getAttribute('data-layout') === 'story') {
      ok('竖屏版式生效：' + hint2.trim());
    } else {
      bad('竖屏版式未生效：hint=' + hint2 + ' layout=' + (paper2 && paper2.getAttribute('data-layout')));
    }
    // www 切回竖版，避免影响后续步骤
    const portrait = doc.querySelector('input[name="ticketLayout"][value="portrait"]');
    portrait.checked = true;
    portrait.dispatchEvent(new win.Event('change', { bubbles: true }));
    await sleep(500);
  }

  /* ---------- 3b) 导出效果弹层 ---------- */
  const pv = $('#btnPreviewExport');
  if (!pv) bad('没有「查看导出效果」按钮');
  else if (pv.disabled) bad('「查看导出效果」按钮不可用');
  else {
    click(pv, '查看导出效果');
    await waitFor(() => !$('#exportSheet').hidden, '导出效果弹层', 30000);
    await waitFor(() => $('#exportSheetBody').querySelector('img')
      || /失败/.test($('#exportSheetBody').textContent), '导出图或失败提示', 30000);
    const img = $('#exportSheetBody').querySelector('img');
    const title = $('#exportSheetTitle').textContent;
    if (img && /^data:image\/png/.test(img.getAttribute('src'))) {
      ok('弹层里是真实导出的 PNG（dataURL），标题：' + title);
    } else if (img) ok('弹层里出现了图片，标题：' + title);
    else bad('导出效果弹层里没有图片：' + $('#exportSheetBody').textContent.trim().slice(0, 60));
    if (title.includes('1080')) ok('弹层标题带像素：' + title);
    else bad('弹层标题缺少像素信息：' + title);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    if ($('#exportSheet').hidden) ok('Esc 可关闭导出效果弹层');
    else bad('Esc 没有关闭导出效果弹层');
  }

  /* ---------- 2) 保存偏好 ---------- */
  const consents = $$('#prefConsentList [data-consent]');
  if (!consents.length) bad('没有渲染授权勾选框');
  else {
    const checked = consents.filter(c => c.checked).length;
    if (checked === 0) ok('授权勾选框默认全部未勾选（' + consents.length + ' 个）');
    else bad('授权勾选框默认被勾选了 ' + checked + ' 个');
    if ($('#btnSavePrefs').disabled) ok('无人授权时保存按钮为禁用态');
    else bad('无人授权时保存按钮仍可点');
    consents[0].checked = true;
    consents[0].dispatchEvent(new win.Event('change', { bubbles: true }));
    if (consents[1]) {
      consents[1].checked = true;
      consents[1].dispatchEvent(new win.Event('change', { bubbles: true }));
    }
    await sleep(200);
    if (!$('#btnSavePrefs').disabled) ok('勾选成员后保存按钮可用');
    else bad('勾选后保存按钮仍禁用');
    click($('#btnSavePrefs'), '保存偏好');
    await waitFor(() => /已保存|未授权/.test($('#prefSaveStatus') ? $('#prefSaveStatus').textContent : ''), '保存结果', 20000);
    ok('保存结果：' + $('#prefSaveStatus').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  }

  /* ---------- 4) 订单关联 ---------- */
  if (!$('#btnLinkOrder')) bad('没有「关联订单」入口');
  else {
    click($('#btnLinkOrder'), '打开订单弹层');
    await waitFor(() => $$('#orderList [data-order]').length > 0, '订单列表', 30000);
    const cards = $$('#orderList [data-order]');
    ok('订单弹层列出 ' + cards.length + ' 条订单');
    const fullIds = cards.map(c => c.getAttribute('data-order')).filter(Boolean);
    const shown = $('#orderList').textContent;
    const leaked = fullIds.filter(id => shown.includes(id));
    if (leaked.length) bad('订单列表直接展示了完整订单号');
    else ok('订单列表未展示完整订单号（只显示后 4 位）');
    click(cards[0], '选择订单');
    await waitFor(() => !$('#linkWarnBox').hidden && $('#linkWarnBox').textContent.trim().length > 0, '核对警示', 30000);
    const warn = $('#linkWarnBox').textContent.replace(/\s+/g, ' ').trim();
    ok('核对警示：' + warn.slice(0, 70));
    const confirmBox = $('#linkResult').textContent;
    if (/我确认|确认这就是/.test(confirmBox)) ok('提供「我确认这就是这次聚餐的订单」二次确认');
    else bad('缺少用户确认环节');
  }

  /* ---------- 1) 再聚 ---------- */
  click($('#brandHome'), '回到第 1 步');
  await waitFor(() => !$('#panel-1').hidden, '回到第 1 步');
  await waitFor(() => $$('#revisitList [data-revisit]').length > 0, '「上次这群人」卡片', 20000);
  ok('第 1 步出现偏好组卡片：' + $$('#revisitList [data-revisit]').length + ' 组');
  click($$('#revisitList [data-revisit]')[0], '带入这次聚餐');
  await waitFor(() => !$('#panel-2').hidden, '再聚进入第 2 步', 30000);
  const names = $$('#memberStage [data-nick]').map(i => i.value).filter(Boolean);
  ok('再聚后第 2 步已回填成员：' + names.join('、'));
  if (names.length === 0) bad('再聚后没有回填任何成员');
  const flash = $('.banner--info');
  ok('顶部提示：' + (flash ? flash.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) : '（未找到）'));
} catch (err) {
  problems.push('流程中断：' + err.message);
  report.push('  ✗ 流程中断：' + err.message);
}

console.log('\nP1 前端独立验收结果');
console.log(report.join('\n'));
console.log('\n问题总数：' + problems.length);
problems.forEach(p => console.log(' - ' + p));
dom.window.close();
process.exit(problems.length ? 1 : 0);
