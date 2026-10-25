/* 票根三版式导出的真实画布验证（开发期）
 *
 * 用 jsdom + canvas（已在开发机全局安装）真实调用 TicketRenderer.exportPNG，
 * 读 PNG 头里的宽高，确认三种版式的像素尺寸与「照片不崩」。
 * 这是唯一能证明「多尺寸导出」真的生效的自动化手段——DOM 预览证明不了画布逻辑。
 *
 * 运行：node tests/export_sizes.mjs
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

const { JSDOM } = requireDev('jsdom');
requireDev('canvas');   // jsdom 的 canvas 后端，导出 PNG 需要

const BASE = process.env.MMTX_BASE || 'http://127.0.0.1:8848';
const problems = [];
const report = [];

const html = fs.readFileSync(path.join(process.cwd(), 'web', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: BASE + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = (input, init) => fetch(new URL(String(input), BASE), init);
    win.scrollTo = () => {};
    win.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  },
});
const win = dom.window;

function pngSize(buffer) {
  const b = Buffer.from(buffer);
  const sig = b.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error('不是合法 PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

async function exportOnce(ticket, layout) {
  const blob = await win.TicketRenderer.exportPNG(ticket, { layout });
  const buf = Buffer.from(await blob.arrayBuffer());
  return pngSize(buf);
}

// 1x1 透明 PNG，用来验证「有照片」时导出不崩
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ticket = {
  ticketId: 't_test_A', partyId: 'p_test', status: 'planning', statusLabel: '计划中',
  title: '周五项目庆功', date: '2026-10-25',
  members: ['小北', '阿岚', '大可', '糖糖'],
  items: [
    { name: '麦辣鸡腿汉堡', quantity: 1, assignee: '小北' },
    { name: '麦乐鸡', quantity: 1, assignee: '阿岚' },
    { name: '巨无霸', quantity: 1, assignee: '大可' },
  ],
  wishes: [{ member: '小北', wish: '麦辣鸡腿堡', byProduct: '麦辣鸡腿汉堡' }],
  themeLine: '4 个人，一顿庆功',
  photo: TINY_PNG,
  notes: [{ member: '小北', note: '今晚的薯条最香' }, { member: '阿岚', note: '下次换我请' }],
  nextMeet: '下周五同一家',
  fieldsVisible: { title: true, date: true, members: true, items: true, wishes: true,
                   themeLine: true, photo: true, notes: true, nextMeet: true, status: true },
  hiddenFields: ['订单号', '门店详址', '个人预算', '个人分摊', '实际支付金额'],
  dataTime: '2026-10-25 16:00', dataSource: 'live', generatedAt: '2026-10-25 16:30',
};

async function waitFor(fn, label, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
    await new Promise(r => setTimeout(r, 100));
  }
}

try {
  await waitFor(() => win.TicketRenderer && typeof win.TicketRenderer.exportPNG === 'function',
    'TicketRenderer 加载');

  const portrait = await exportOnce(ticket, 'portrait');
  report.push(`  ✓ portrait  ${portrait.width}×${portrait.height}  ${(portrait.bytes / 1024).toFixed(0)}KB`);
  if (portrait.width !== 1080) problems.push(`portrait 宽度应为 1080，实际 ${portrait.width}`);
  if (portrait.height <= 1080) problems.push(`portrait 高度应随内容自适应（>1080），实际 ${portrait.height}`);

  const square = await exportOnce(ticket, 'square');
  report.push(`  ✓ square    ${square.width}×${square.height}  ${(square.bytes / 1024).toFixed(0)}KB`);
  if (square.width !== 1080 || square.height !== 1080) problems.push(`square 应为 1080×1080，实际 ${square.width}×${square.height}`);

  const story = await exportOnce(ticket, 'story');
  report.push(`  ✓ story     ${story.width}×${story.height}  ${(story.bytes / 1024).toFixed(0)}KB`);
  if (story.width !== 1080 || story.height !== 1920) problems.push(`story 应为 1080×1920，实际 ${story.width}×${story.height}`);

  // 边界：没有照片、没有句子、没有约定 → 仍要能导出
  const bare = { ...ticket, photo: null, notes: [], nextMeet: null };
  const bareShot = await exportOnce(bare, 'square');
  report.push(`  ✓ 无照片/无句子  ${bareShot.width}×${bareShot.height}`);
  if (bareShot.width !== 1080) problems.push('无增强字段时导出尺寸异常');

  // 边界：坏照片（非白名单）不应让导出失败
  const badPhoto = await exportOnce({ ...ticket, photo: 'https://evil.example/a.png' }, 'portrait');
  report.push(`  ✓ 非法照片被忽略且仍能导出  ${badPhoto.width}×${badPhoto.height}`);
} catch (err) {
  problems.push('导出失败：' + err.message);
}

console.log('\n票根导出尺寸验证');
console.log(report.join('\n'));
console.log('\n问题总数：' + problems.length);
problems.forEach(p => console.log(' - ' + p));
dom.window.close();
process.exit(problems.length ? 1 : 0);
