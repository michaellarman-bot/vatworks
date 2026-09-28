// Drives the real app in headless Chromium: load a model, support, hollow, drain, slice, export, screenshot.
//   node test/ui.test.mjs   (server on 8090; uses puppeteer-core + @sparticuz/chromium from the tools folder)
import fs from 'node:fs';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { TriSink, frustum, sphere } from '../public/js/core/geom.js';

const base = process.env.BASE || 'http://127.0.0.1:8090';
const OUT = '/tmp/ui';
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) failed++; };

function box(sink, [x0, y0, z0], [x1, y1, z1]) {
  const q = (a, b, c, d) => { sink.tri(...a, ...b, ...c); sink.tri(...a, ...c, ...d); };
  q([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
}
function writeSTL(path, tris) {
  const n = tris.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('Vatworks test model', 0);
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) { for (let k = 0; k < 9; k++) buf.writeFloatLE(tris[t * 9 + k], 84 + t * 50 + 12 + k * 4); }
  fs.writeFileSync(path, buf);
}
// a mushroom (needs supports) and a fat sphere-topped block (worth hollowing)
{ const s = new TriSink(); frustum(s, [0, 0, 0], [0, 0, 22], 3.5, 3.5, 40); box(s, [-14, -14, 22], [14, 14, 27]); sphere(s, [0, 0, 30], 5, 24, 12); writeSTL(`${OUT}/mushroom.stl`, s.result()); }
{ const s = new TriSink(); box(s, [-16, -12, 0], [16, 12, 28]); sphere(s, [0, 0, 28], 12, 40, 20); writeSTL(`${OUT}/block.stl`, s.result()); }

const exe = await chromium.executablePath();
const browser = await puppeteer.launch({ args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1440,900'], executablePath: exe, headless: 'shell', defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const wait = (fn, ms = 60000) => page.waitForFunction(fn, { timeout: ms, polling: 100 });

try {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await wait(() => !!window.vatworks);
  await new Promise((r) => setTimeout(r, 600));
  await shot('01-empty');
  const input = await page.$('#file-input');
  await input.uploadFile(`${OUT}/mushroom.stl`, `${OUT}/block.stl`);
  await wait(() => window.vatworks.objects.length === 2, 30000);
  await new Promise((r) => setTimeout(r, 500));
  const names = await page.evaluate(() => window.vatworks.objects.map((o) => `${o.name}:${o.tris}`));
  ok(names.length === 2, `loaded two models (${names.join(', ')})`);
  const outOfBounds = await page.evaluate(() => window.vatworks.objects.some((o) => o.out));
  ok(!outOfBounds, 'both objects placed inside the plate');
  await shot('02-loaded');

  // supports on the mushroom
  await page.evaluate(() => window.vatworks.generateSupports([window.vatworks.objects[0]]));
  await wait(() => window.vatworks.objects[0].supports && window.vatworks.objects[0].supports.plans.length > 0, 60000);
  const sup = await page.evaluate(() => ({ n: window.vatworks.objects[0].supports.plans.length, minZ: window.vatworks.objects[0].box.min.z }));
  ok(sup.n > 20, `auto supports generated (${sup.n})`);
  ok(Math.abs(sup.minZ - 5) < 0.01, `model raised to 5 mm for supports (${sup.minZ.toFixed(2)})`);
  await shot('03-supports');

  // hollow the block + drain hole
  await page.evaluate(() => { window.vatworks.select(window.vatworks.objects[1].id); return window.vatworks.hollowObject(window.vatworks.objects[1]); });
  await wait(() => !!window.vatworks.objects[1].hollow, 60000);
  const hol = await page.evaluate(() => window.vatworks.objects[1].hollow.cavityMl);
  ok(hol > 5, `block hollowed, ${hol.toFixed(1)} mL saved`);
  await page.evaluate(() => { const o = window.vatworks.objects[1]; const b = o.box; window.vatworks.addHoleAt(o.id, [b.min.x + 8, b.min.y + 0.01, 3], [0, -1, 0]); });
  ok(await page.evaluate(() => window.vatworks.objects[1].holes.length === 1), 'drain hole placed');
  await new Promise((r) => setTimeout(r, 300));
  await shot('04-hollow-xray');

  // slice
  await page.evaluate(() => { window.vatworks.state.print.layerHeight = 0.1; window.vatworks.slice(); });
  await wait(() => !!window.vatworks.sliced, 240000);
  const sl = await page.evaluate(() => { const s = window.vatworks.sliced; return { layers: s.layerCount, ml: s.volumeMm3 / 1000, islands: s.islands.length, secs: s.totalSeconds, size: s.size }; });
  ok(sl.layers > 300, `sliced ${sl.layers} layers`);
  ok(sl.ml > 5 && sl.ml < 40, `resin estimate ${sl.ml.toFixed(1)} mL`);
  ok(sl.islands === 0, `no islands (found ${sl.islands})`);
  await new Promise((r) => setTimeout(r, 400));
  await shot('05-preview-top');
  await page.evaluate(() => window.vatworks.showLayer(60));
  await new Promise((r) => setTimeout(r, 300));
  await shot('06-preview-layer60');
  await page.click('#btn-3d');
  await new Promise((r) => setTimeout(r, 500));
  await shot('07-preview-3d');

  // export + validate size
  const b64 = await page.evaluate(async () => { const b = window.vatworks.gooBlob(); const buf = await b.arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); });
  const file = Buffer.from(b64, 'base64');
  fs.writeFileSync(`${OUT}/export.goo`, file);
  ok(file.length === sl.size, `exported .goo is ${(file.length / 1e6).toFixed(1)} MB (size matches the estimate)`);
  ok(file.subarray(0, 4).toString() === 'V3.0', 'exported file has the GOO signature');

  // back to prepare, tabs, printer popover
  await page.click('#btn-back');
  await page.click('.tabs [data-tab=supports]');
  await new Promise((r) => setTimeout(r, 300));
  await shot('08-supports-tab');
  await page.click('#printer-pill');
  await new Promise((r) => setTimeout(r, 300));
  await shot('09-printer');
  await page.setViewport({ width: 820, height: 800 });
  await new Promise((r) => setTimeout(r, 400));
  await shot('10-narrow');
} catch (e) {
  ok(false, `exception: ${e.message}`);
  await shot('99-failure').catch(() => {});
}
ok(errors.length === 0, `no console errors (${errors.slice(0, 3).join(' | ')})`);
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ui: all passed');
process.exit(failed ? 1 : 0);
