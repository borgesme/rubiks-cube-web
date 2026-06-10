// 录制魔方演示：手动转层 + Scramble 打乱，输出 assets/hero.png 与 assets/demo.gif
// 用法：node scripts/record.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'docs', 'screenshots');

// ---- 可调参数 ----
const VW = 1100, VH = 880;          // 视口（捕获）尺寸
const GIF_WIDTH = 600;              // gif 目标宽度（等比缩放）
const FRAME_DELAY = 50;             // 每帧 gif 延迟 ms（约 20fps）
const DRAG_STEPS = 18;              // 手动拖拽插值步数
const DRAG_DX = 190, DRAG_DY = 0;   // 拖拽位移（像素，横向）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'));
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function decode(buf) {
  const png = PNG.sync.read(buf);
  return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
}

// 简单双线性缩放，输出 RGBA
function downscale(frame, targetW) {
  const { data, width: sw, height: sh } = frame;
  const targetH = Math.round((sh / sw) * targetW);
  const out = new Uint8Array(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const sy = (y + 0.5) * sh / targetH - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetW; x++) {
      const sx = (x + 0.5) * sw / targetW - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * targetW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = data[(y0 * sw + x0) * 4 + c], p10 = data[(y0 * sw + x1) * 4 + c];
        const p01 = data[(y1 * sw + x0) * 4 + c], p11 = data[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx, bot = p01 + (p11 - p01) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return { data: out, width: targetW, height: targetH };
}

async function run() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const server = await startServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text()); });

  console.log('navigating', url);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app canvas', { timeout: 20000 });
  await sleep(2500); // 等 three.js CDN 加载 + 首帧渲染

  // 1) 高清初始截图
  await page.screenshot({ path: path.join(ASSETS, 'hero.png') });
  console.log('hero.png saved');

  const frames = [];
  const cap = async () => frames.push(decode(await page.screenshot()));

  const canvas = await page.$('#app canvas');
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // 起手点：略偏左下，落在正面的某个 cubie 上
  const startX = cx - 70, startY = cy + 30;

  await cap(); await cap(); // 起始静帧

  // 2) 手动拖拽转层（逐步移动并捕获，呈现 1:1 跟手）
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const t = i / DRAG_STEPS;
    await page.mouse.move(startX + DRAG_DX * t, startY + DRAG_DY * t);
    await cap();
  }
  await page.mouse.up();
  // 捕获磁吸回弹
  for (let i = 0; i < 8; i++) { await sleep(30); await cap(); }
  await sleep(300);
  await cap();

  // 3) 点击 Scramble，全程捕获（20 步 × 100ms ≈ 2s）
  await page.click('#btn-scramble');
  const scrambleEnd = Date.now() + 2400;
  while (Date.now() < scrambleEnd) await cap();
  await cap(); await cap();

  await browser.close();
  server.close();
  console.log('captured frames:', frames.length);

  // 4) 编码 gif（全局调色板）
  const small = frames.map((f) => downscale(f, GIF_WIDTH));
  const { width, height } = small[0];
  // 用中间帧构建全局调色板（魔方配色稳定）
  const mid = small[Math.floor(small.length / 2)].data;
  const palette = quantize(mid, 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  for (const f of small) {
    const index = applyPalette(f.data, palette, 'rgb565');
    gif.writeFrame(index, width, height, { palette, delay: FRAME_DELAY });
  }
  gif.finish();
  fs.writeFileSync(path.join(ASSETS, 'demo.gif'), Buffer.from(gif.bytes()));
  const kb = (fs.statSync(path.join(ASSETS, 'demo.gif')).size / 1024).toFixed(0);
  console.log(`demo.gif saved: ${width}x${height}, ${small.length} frames, ${kb} KB`);
}

run().catch((e) => { console.error(e); process.exit(1); });
