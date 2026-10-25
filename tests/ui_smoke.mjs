/* 前端运行时冒烟（开发期校验用，不参与交付运行）
 *
 * 用 jsdom 把真实页面挂起来，走一遍：填示例 → 查门店 → 创建聚餐 → 填完 4 位成员
 * → 生成三案（真实 MCP 核价）→ 选方案 → 确认 → 票根预览，
 * 同时收集所有未捕获异常与 console.error。jsdom 只是本地开发依赖，作品本身零依赖。
 *
 * 运行：先启动 python run.py 8848，然后
 *   NODE_PATH=<jsdom 所在 node_modules> node tests/ui_smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// jsdom 只装在开发机的全局工作区里，这里做一次宽松解析，避免为一次冒烟就在仓库里引依赖
import { pathToFileURL } from 'node:url';

/** 开发期依赖（jsdom / puppeteer-core / canvas）不随作品发布，按下面顺序查找：
 *  1) 仓库根 node_modules（推荐：在根目录 npm i -D jsdom puppeteer-core canvas）
 *  2) 环境变量 MMTX_DEV_MODULES 指向的 node_modules
 */
const DEV_MODULES = process.env.MMTX_DEV_MODULES || path.join(process.cwd(), 'node_modules');

function requireDev(name) {
  const local = createRequire(import.meta.url);
  try { return local(name); } catch (e) { /* 继续找开发目录 */ }
  try {
    return createRequire(pathToFileURL(path.join(DEV_MODULES, 'index.js')))(name);
  } catch (e) {
    throw new Error(
      '缺少开发依赖 ' + name + '。请在仓库根执行：npm i -D jsdom puppeteer-core canvas，' +
      '或设置环境变量 MMTX_DEV_MODULES 指向含该依赖的 node_modules。'
    );
  }
}

const { JSDOM } = requireDev('jsdom');

const BASE = process.env.MMTX_BASE || 'http://127.0.0.1:8848';
const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
const problems = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
    win.scrollTo = () => {};
    win.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.addEventListener('error', e => problems.push('未捕获异常: ' + (e.error && e.error.stack || e.message)));
    const origError = win.console.error.bind(win.console);
    win.console.error = (...args) => { problems.push('console.error: ' + args.map(String).join(' ')); origError(...args); };
  },
});

const win = dom.window;
const doc = win.document;
const $ = sel => doc.querySelector(sel);
const texts = sel => Array.from(doc.querySelectorAll(sel)).map(n => n.textContent.replace(/\s+/g, ' ').trim());

function click(el, label) {
  if (!el) throw new Error('找不到可点击元素：' + label);
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const report = [];
function ok(msg) { report.push('  ✓ ' + msg); }
function bad(msg) { report.push('  ✗ ' + msg); problems.push(msg); }

try {
  // 占位文案本身就是「数据时点 —」，不能拿「非空」当就绪条件：
  // 要等 setDataTime 真的写入日期（或健康横幅出现），再留一点时间让事件绑定完成。
  await waitFor(() => /\d{4}-\d{2}/.test($('#dataTimeText').textContent) || !$('#healthBanner').hidden,
    '页面初始化', 25000);
  await sleep(300);
  ok('页面加载完成，MCP 健康检查回填数据时点：' + $('#dataTimeText').textContent.trim());

  click($('#fillDemo'), '填入标准演示场景');
  await sleep(200);
  if ($('#fTitle').value.includes('庆功')) ok('示例按钮已填好事由：' + $('#fTitle').value);
  else bad('示例按钮没有填好事由，实际值：' + $('#fTitle').value);

  click($('#btnFindStores'), '查找门店');
  try {
    await waitFor(() => doc.querySelectorAll('.store-item').length > 0, '门店列表渲染', 30000);
  } catch (e) {
    const diag = {
      storeStatus: ($('#storeStatus') || {}).textContent,
      storeChildren: ($('#storeList') || { children: [] }).children.length,
      toast: ($('#toastRoot') || {}).textContent,
      findBtnDisabled: ($('#btnFindStores') || {}).disabled,
      keyword: ($('#fKeyword') || {}).value,
      city: ($('#fCity') || {}).value,
    };
    throw new Error(e.message + ' | 诊断: ' + JSON.stringify(diag));
  }
  ok('门店查询返回 ' + doc.querySelectorAll('.store-item').length + ' 家，首条：' +
     doc.querySelector('.store-item__name').textContent.trim());

  click(doc.querySelectorAll('.store-item')[0], '选择第一家门店');
  await sleep(200);
  const createBtn = $('#btnCreateParty');
  await waitFor(() => !createBtn.disabled, '创建按钮可用');
  ok('选中门店后创建按钮可用');

  click(createBtn, '创建聚餐');
  await waitFor(() => !$('#panel-2').hidden, '进入成员心愿页');
  ok('已进入第 2 步（成员心愿）');

  for (let i = 0; i < 6; i++) {
    const next = doc.querySelector('.js-member-next');
    if (!next) break;
    click(next, '下一位');
    await sleep(120);
  }
  await waitFor(() => !$('#btnGoPlans').disabled, '生成方案按钮可用', 20000);
  ok('4 位成员心愿填写完成，生成方案按钮可用');

  const t0 = Date.now();
  click($('#btnGoPlans'), '生成方案');
  await waitFor(() => doc.querySelectorAll('.plan-card[data-plan]').length >= 3, '三套方案渲染', 150000);
  const cards = Array.from(doc.querySelectorAll('.plan-card[data-plan]'));
  ok('三套方案渲染完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，卡片数 ' + cards.length);
  cards.forEach(c => {
    const name = c.querySelector('.plan-card__name')?.textContent.trim();
    const price = c.querySelector('.plan-card__price')?.textContent.replace(/\s+/g, ' ').trim();
    const dead = c.classList.contains('plan-card--dead');
    if (dead) bad('方案「' + name + '」显示核价失败');
    else ok('方案「' + name + '」· ' + price);
  });
  ok('方案卡数据时点：' + ($('#planTimeStamp').textContent.replace(/\s+/g, ' ').trim() || '（空）'));
  if (doc.querySelector('.plan-card--dead')) bad('存在核价失败的方案卡');

  click(doc.querySelector('[data-pick]'), '选方案');
  await waitFor(() => !$('#panel-4').hidden, '进入调整页');
  await waitFor(() => doc.querySelectorAll('#billBody tr').length > 0, '分账表渲染');
  ok('进入第 4 步，分账表 ' + doc.querySelectorAll('#billBody tr').length + ' 行；合计校验文案：' +
     $('#billSumCheck').textContent.replace(/\s+/g, ' ').trim());

  await waitFor(() => !$('#btnConfirm').disabled, '确认按钮可用');
  click($('#btnConfirm'), '确认方案');
  await waitFor(() => $('#btnGoTicket'), '确认成功提示');
  ok('方案已确认（页面提示：' + $('#confirmBox').textContent.replace(/\s+/g, ' ').slice(0, 60) + '…）');

  click($('#btnGoTicket'), '生成票根');
  await waitFor(() => !$('#panel-5').hidden, '进入票根页');
  await waitFor(() => $('#ticketPreview').querySelector('.mtx-ticket'), '票根渲染', 30000);
  const ticketText = $('#ticketPreview').textContent.replace(/\s+/g, ' ').trim();
  ok('票根渲染完成，长度 ' + ticketText.length + ' 字');
  ok('票根状态文案包含「计划中」：' + (ticketText.includes('计划中') ? '是' : '否'));
  if (!ticketText.includes('计划中')) bad('票根没有标注「计划中」');
  if (/¥\d/.test(ticketText)) bad('票根上出现了金额，违反默认脱敏');
  else ok('票根未出现任何金额');
  ok('隐藏字段提示：' + $('#hiddenFieldsList').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
} catch (err) {
  problems.push('流程中断：' + err.message);
  report.push('  ✗ 流程中断：' + err.message);
}

console.log('\n前端运行时冒烟结果');
console.log(report.join('\n'));
console.log('\n问题总数：' + problems.length);
problems.forEach(p => console.log(' - ' + p));
dom.window.close();
process.exit(problems.length ? 1 : 0);
