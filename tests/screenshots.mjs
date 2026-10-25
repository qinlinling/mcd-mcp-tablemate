/* 真实浏览器截图（开发期交付物生成脚本）
 *
 * 用本机 Edge（puppeteer-core，不下载浏览器）在 1440×900 与 390×844 两档宽度下
 * 走完五步主流程，逐屏截图；票根页再分别截三种版式，并保存三张真实导出 PNG。
 * 产出目录：docs/screenshots/
 *
 * 运行：node tests/screenshots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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

const puppeteer = requireDev('puppeteer-core');

const BASE = process.env.MMTX_BASE || 'http://127.0.0.1:8848';
/** 浏览器路径：优先环境变量，其次常见安装位置（Windows Edge / Chrome，macOS Chrome） */
function findBrowser() {
  if (process.env.MMTX_BROWSER) return process.env.MMTX_BROWSER;
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  throw new Error('找不到可用的 Chromium 内核浏览器，请设置环境变量 MMTX_BROWSER 指向 msedge.exe / chrome。');
}
const EDGE = findBrowser();
const OUT = path.join(process.cwd(), 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const problems = [];
const note = m => { log.push('  ✓ ' + m); };
const bad = m => { log.push('  ✗ ' + m); problems.push(m); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等待某个选择器出现且可见 */
async function waitVisible(page, sel, timeout = 60000) {
  await page.waitForFunction(
    s => { const el = document.querySelector(s); return el && !el.hidden; },
    { timeout }, sel);
}

/** 用 DOM click 而不是鼠标坐标：长页面里元素常在视口外，puppeteer 的鼠标点击会判「不可点」 */
async function clickSel(page, sel, timeout = 30000) {
  await page.waitForFunction(s => {
    const el = document.querySelector(s);
    return el && !el.disabled;
  }, { timeout }, sel);
  await page.evaluate(s => document.querySelector(s).click(), sel);
}

async function waitToastsClear(page, timeout = 9000) {
  const start = Date.now();
  for (;;) {
    const n = await page.evaluate(() => (document.querySelector('#toastRoot') || { children: [] }).children.length);
    if (!n) return;
    if (Date.now() - start > timeout) return;
    await sleep(200);
  }
}

/** fullPage 截图时临时取消 sticky/fixed：Chromium 长图拼接会把它们画在分片边界上 */
async function withFlatLayout(page, fn) {
  const handle = await page.addStyleTag({
    content: '.topbar,.edit-right,.menu-group__title{position:static !important;}',
  });
  try { return await fn(); } finally { await handle.evaluate(n => n.remove()); }
}

async function shot(page, name, viewport) {
  const file = path.join(OUT, `${name}${viewport.width <= 480 ? '-390' : '-1440'}.png`);
  await waitToastsClear(page);
  await withFlatLayout(page, () => page.screenshot({ path: file, fullPage: true }));
  const { width, height, vw } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    vw: window.innerWidth,
  }));
  // 横向溢出是最常见的窄屏问题：直接量 scrollWidth 与视口宽度比
  const overflowX = width - vw;
  note(`${path.basename(file)}  ${width}×${height}${overflowX > 2 ? `  ⚠ 横向溢出 ${overflowX}px` : ''}`);
  if (overflowX > 2) bad(`${name} 在 ${viewport.width} 宽下横向溢出 ${overflowX}px`);
  return file;
}

/** 走完五步，返回进入票根页时的状态 */
async function runFlow(page, viewport) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => /\d{4}-\d{2}/.test((document.querySelector('#dataTimeText') || {}).textContent || '')
    || !document.querySelector('#healthBanner').hidden, { timeout: 30000 });
  await sleep(400);

  // 第 1 步：填入演示场景 + 查门店 + 选门店
  await clickSel(page, '#fillDemo');
  await sleep(200);
  await clickSel(page, '#btnFindStores');
  await page.waitForSelector('.store-item', { timeout: 40000 });
  await shot(page, '01-创建聚餐', viewport);

  await page.evaluate(() => document.querySelector('.store-item').click());
  await page.waitForFunction(() => !document.querySelector('#btnCreateParty').disabled, { timeout: 20000 });
  await clickSel(page, '#btnCreateParty');
  await waitVisible(page, '#panel-2');

  // 第 2 步：逐位填完 4 人
  for (let i = 0; i < 6; i++) {
    const next = await page.$('.js-member-next');
    if (!next) break;
    const panel3 = await page.evaluate(() => !document.querySelector('#panel-3').hidden);
    if (panel3) break;
    await next.click();
    await sleep(150);
  }
  await shot(page, '02-成员心愿', viewport);

  // 第 3 步：三案
  await waitVisible(page, '#btnGoPlans');
  await clickSel(page, '#btnGoPlans');
  await page.waitForFunction(() => document.querySelectorAll('.plan-card[data-plan]').length >= 3, { timeout: 180000 });
  await sleep(500);
  await shot(page, '03-三案对比', viewport);

  // 第 4 步：调整与确认
  await clickSel(page, '[data-pick]');
  await waitVisible(page, '#panel-4');
  await page.waitForFunction(() => document.querySelectorAll('#billBody tr').length > 0, { timeout: 30000 });
  await sleep(400);
  await shot(page, '04-分账与确认', viewport);

  await clickSel(page, '#btnConfirm');
  await page.waitForSelector('#btnGoTicket', { timeout: 30000 });
  await clickSel(page, '#btnGoTicket');
  await waitVisible(page, '#panel-5');
  await page.waitForSelector('#ticketPreview .mtx-ticket', { timeout: 60000 });
  await sleep(500);
  await shot(page, '05-同桌票根', viewport);
}

async function ticketLayouts(page, viewport) {
  // 先把一句话与下次约定填上，让票根的 P1 内容也进截图
  const noteInput = await page.$('#noteEditor [data-note]');
  if (noteInput) {
    await noteInput.click({ clickCount: 3 });
    await noteInput.type('今晚的薯条最香');
  }
  const nextMeet = await page.$('#nextMeet');
  if (nextMeet) {
    await nextMeet.click({ clickCount: 3 });
    await nextMeet.type('下周五同一家');
  }
  await sleep(1600);

  for (const layout of ['portrait', 'square', 'story']) {
    await page.evaluate(l => {
      const r = document.querySelector(`input[name="ticketLayout"][value="${l}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    }, layout);
    await sleep(900);
    await waitToastsClear(page);
    const el = await page.$('#ticketPreview');
    const suffix = viewport.width <= 480 ? '-390' : '-1440';
    const fname = `06-票根-${layout}${suffix}.png`;
    if (el) {
      await el.screenshot({ path: path.join(OUT, fname) });
      const box = await el.boundingBox();
      note(`${fname}  ${Math.round(box.width)}×${Math.round(box.height)}（票根本体）`);
      if (box.width > viewport.width + 1) bad(`票根在 ${viewport.width} 宽下超出容器`);
    }
  }

  // 真实导出三张 PNG（与用户点「下载图片」得到的完全一致）
  const dataUrls = await page.evaluate(async () => {
    const out = {};
    for (const l of ['portrait', 'square', 'story']) {
      const blob = await window.TicketRenderer.exportPNG(window.__ticket || null, { layout: l })
        .catch(() => null);
      if (!blob) { out[l] = null; continue; }
      out[l] = await new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(blob);
      });
    }
    return out;
  }).catch(() => ({}));

  for (const [layout, dataUrl] of Object.entries(dataUrls || {})) {
    if (!dataUrl || !dataUrl.startsWith('data:image/png')) { bad(`导出 ${layout} 失败`); continue; }
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const suffix = viewport.width <= 480 ? '-390' : '-1440';
    const fname = `07-导出-${layout}${suffix}.png`;
    fs.writeFileSync(path.join(OUT, fname), buf);
    note(`${fname}  ${w}×${h}  ${(buf.length / 1024).toFixed(0)}KB`);
    if (layout === 'square' && (w !== 1080 || h !== 1080)) bad(`square 导出尺寸异常 ${w}×${h}`);
    if (layout === 'story' && (w !== 1080 || h !== 1920)) bad(`story 导出尺寸异常 ${w}×${h}`);
    if (layout === 'portrait' && w !== 1080) bad(`portrait 导出宽度异常 ${w}`);
  }
}

async function exportModalShot(page, viewport) {
  await page.evaluate(() => {
    const r = document.querySelector('input[name="ticketLayout"][value="square"]');
    if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(600);
  const btn = await page.$('#btnPreviewExport');
  if (!btn) { bad('截图时找不到「查看导出效果」按钮'); return; }
  await page.evaluate(() => document.querySelector('#btnPreviewExport').click());
  await page.waitForFunction(() => {
    const sheet = document.querySelector('#exportSheet');
    const img = document.querySelector('#exportSheetBody img');
    return sheet && !sheet.hidden && img;
  }, { timeout: 30000 });
  await sleep(300);
  const suffix = viewport.width <= 480 ? '-390' : '-1440';
  const panel = await page.$('.export-sheet__panel');
  await panel.screenshot({ path: path.join(OUT, `08-导出效果${suffix}.png`) });
  note(`08-导出效果${suffix}.png（方图成品预览）`);
  await page.keyboard.press('Escape');
  await sleep(300);
}

async function orderSheetShot(page, viewport) {
  const open = await page.$('#btnLinkOrder');
  if (!open) { bad('截图时找不到「关联订单」入口'); return; }
  await page.evaluate(() => document.querySelector('#btnLinkOrder').click());
  await page.waitForSelector('#orderList [data-order]', { timeout: 30000 });
  await sleep(500);
  const suffix = viewport.width <= 480 ? '-390' : '-1440';
  const sheet = await page.$('#orderSheet');
  if (sheet) {
    await sheet.screenshot({ path: path.join(OUT, `09-关联订单${suffix}.png`) });
    note(`09-关联订单${suffix}.png`);
  }
  // 选一条再看警示块
  await page.evaluate(() => document.querySelector('#orderList [data-order]').click());
  await page.waitForFunction(() => {
    const b = document.querySelector('#linkWarnBox');
    return b && !b.hidden && b.textContent.trim().length > 0;
  }, { timeout: 30000 });
  await sleep(400);
  const sheet2 = await page.$('#orderSheet');
  if (sheet2) {
    await sheet2.screenshot({ path: path.join(OUT, `10-订单核对警告${suffix}.png`) });
    note(`10-订单核对警告${suffix}.png`);
  }
  await page.keyboard.press('Escape');
  await sleep(300);
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
});

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage();
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(v => { window.__vpWidth = v; }, viewport.width);
    page.on('pageerror', e => problems.push(`页面异常(${viewport.width}): ${e.message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/favicon/i.test(text)) return;   // 浏览器自动请求的图标，不算页面错误
      problems.push(`console.error(${viewport.width}): ${text}`);
    });

    await runFlow(page, viewport);
    // 暴露当前票根给导出用（只读用途）
    await page.evaluate(() => {
      const w = window;
      w.__ticket = w.__ticket || null;
    });
    if (viewport.width === 1440) {
      // ticket 只在 app 内部持有，这里通过一次 POST 票根接口拿同一份模型来导出
      const ticket = await page.evaluate(async () => {
        const parties = await (await fetch('/api/parties')).json();
        const p = (parties.parties || []).find(x => x.status === 'confirmed' || x.status === 'completed');
        if (!p) return null;
        const res = await (await fetch(`/api/party/${p.id}/ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        return res.ticket || null;
      });
      await page.evaluate(t => { window.__ticket = t; }, ticket);
      await ticketLayouts(page, viewport);
      await exportModalShot(page, viewport);
      await orderSheetShot(page, viewport);
    } else {
      await ticketLayouts(page, viewport);
    }
    await page.close();
  }
} catch (err) {
  problems.push('截图流程失败：' + err.message);
} finally {
  await browser.close();
}

console.log('\n真实浏览器截图');
console.log(log.join('\n'));
console.log(`\n输出目录：${OUT}`);
console.log('问题总数：' + problems.length);
problems.forEach(p => console.log(' - ' + p));
process.exit(problems.length ? 1 : 0);
