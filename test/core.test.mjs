// Run with:  node test/core.test.mjs
import { writeFileSync } from 'node:fs';
import {
  RleWriter, decodeRuns, buildHeader, parseGoo, assembleGoo, HEADER_SIZE, estimatePrintTime, exposureForLayer,
} from '../public/js/core/goo.js';
import { TriSink, frustum, sphere, signedVolume, bakeWorld, bounds, VerticalRayGrid, concatF32 } from '../public/js/core/geom.js';
import { SliceJob, layerCountFor } from '../public/js/core/pipeline.js';
import { computeCavity, chooseVoxel } from '../public/js/core/voxel.js';
import { autoSupports, buildAll, SUPPORT_DEFAULTS } from '../public/js/core/supports.js';
import { MACHINES, DEFAULT_PRINT } from '../public/js/profiles.js';

let failed = 0, passed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('  ok  ', msg); }
  else { failed++; console.log('  FAIL', msg); }
};
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}  (got ${+a.toFixed(4)}, want ${+b.toFixed(4)} ±${tol})`);

export function box(sink, [x0, y0, z0], [x1, y1, z1]) {
  const q = (a, b, c, d) => { sink.tri(...a, ...b, ...c); sink.tri(...a, ...c, ...d); };
  const p = (x, y, z) => [x, y, z];
  q(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)); // bottom (-z)
  q(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)); // top (+z)
  q(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)); // -y
  q(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)); // +y
  q(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)); // -x
  q(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)); // +x
}
const soup = (fn) => { const s = new TriSink(); fn(s); return s.result(); };

const M16 = MACHINES.find((m) => m.id === 's4u-16k');
const M12 = MACHINES.find((m) => m.id === 's4u-12k');
const pxArea = (m) => (m.width / m.resX) * (m.depth / m.resY);

/** Decodes a window of a layer into a Uint8Array bitmap (for shape checks). */
function windowOf(rle, m, x0, y0, w, h) {
  const out = new Uint8Array(w * h);
  let pos = 0;
  decodeRuns(rle, (g, len) => {
    if (g) {
      let p = pos, left = len;
      while (left > 0) {
        const r = Math.floor(p / m.resX), c = p - r * m.resX;
        const n = Math.min(left, m.resX - c);
        if (r >= y0 && r < y0 + h) {
          const a = Math.max(c, x0), b = Math.min(c + n, x0 + w);
          for (let x = a; x < b; x++) out[(r - y0) * w + (x - x0)] = g;
        }
        p += n; left -= n;
      }
    }
    pos += len;
  });
  return { out, total: pos };
}

console.log('RLE codec');
{
  const runs = [[0, 5], [255, 15], [255, 1], [128, 16], [0, 4095], [7, 4096], [255, 1048575], [0, 1048576], [200, 3], [0, 70000000]];
  const w = new RleWriter(16);
  let total = 0;
  for (const [g, l] of runs) { w.run(g, l); total += l; }
  const data = w.finish(total + 1234);
  const back = [];
  decodeRuns(data, (g, l) => back.push([g, l]));
  const merged = [[0, 5], [255, 16], [128, 16], [0, 4095], [7, 4096], [255, 1048575], [0, 1048576], [200, 3], [0, 70000000 + 1234]];
  ok(JSON.stringify(back) === JSON.stringify(merged), 'runs survive encode/decode across all 4 length classes');
  ok(data[0] === 0x55, 'layer magic 0x55');
  let sum = 0; for (let i = 1; i < data.length - 1; i++) sum = (sum + data[i]) & 255;
  ok(((~sum) & 255) === data[data.length - 1], 'checksum is inverted byte sum');
  // diff chunks (written by other slicers) decode too: 0x55, gray 100 x2, +5 x1, -3 run 4
  const hand = [0x55, 0x42, 100, 0x85, 0xb3, 4];
  let s2 = 0; for (let i = 1; i < hand.length; i++) s2 = (s2 + hand[i]) & 255;
  hand.push((~s2) & 255);
  const got = []; decodeRuns(Uint8Array.from(hand), (g, l) => got.push([g, l]));
  ok(JSON.stringify(got) === JSON.stringify([[100, 2], [105, 1], [102, 4]]), 'diff-type chunks decode');
}

console.log('Header');
{
  const h = buildHeader({ ...DEFAULT_PRINT, machineName: 'ELEGOO Saturn 4 Ultra 16K', softwareName: 'Vatworks', layerCount: 3,
    resolutionX: 15120, resolutionY: 6230, displayWidth: 211.68, displayHeight: 118.37, machineZ: 220, mirrorX: 1 });
  ok(h.length === HEADER_SIZE && HEADER_SIZE === 195477, 'header is 195477 bytes (matches reference LayerDefAddress)');
  ok(String.fromCharCode(...h.subarray(0, 4)) === 'V3.0' && h[4] === 7 && h[8] === 0x44, 'version + magic');
  const dv = new DataView(h.buffer);
  ok(dv.getUint32(195310) === 3 && dv.getUint16(195314) === 15120 && dv.getUint16(195316) === 6230, 'layer count / resolution at expected offsets');
  ok(dv.getUint32(HEADER_SIZE - 7) === HEADER_SIZE, 'LayerDefAddress points just past the header');
}

console.log('Primitives face outward');
{
  const cyl = soup((s) => frustum(s, [0, 0, 0], [0, 0, 10], 2, 2, 48));
  near(signedVolume(cyl), Math.PI * 4 * 10, 1.5, 'cylinder volume');
  const tilted = soup((s) => frustum(s, [1, 2, 3], [6, -3, 9], 1, 0.4, 24));
  ok(signedVolume(tilted) > 0, 'tilted frustum positive volume');
  const sph = soup((s) => sphere(s, [0, 0, 0], 5, 48, 24));
  near(signedVolume(sph), (4 / 3) * Math.PI * 125, 8, 'sphere volume');
  const b = soup((s) => box(s, [0, 0, 0], [2, 3, 4]));
  near(signedVolume(b), 24, 1e-6, 'box volume');
  const mirrored = bakeWorld(b, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  near(signedVolume(mirrored), 24, 1e-6, 'mirrored transform keeps outward winding');
}

console.log('Slicing accuracy (16K)');
{
  const cube = soup((s) => box(s, [40, 10, 0], [60, 30, 10]));
  const job = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: cube });
  ok(layerCountFor(bounds(cube).max[2], 0.05) === 200, '10 mm at 0.05 mm = 200 layers');
  const L = job.layer(100);
  near(L.lit * pxArea(M16), 400, 0.05, 'AA cross-section area of a 20x20 mm cube (mm^2)');
  // plate centre is image centre; row 0 = back; LCD mirror flips X
  const cx = M16.resX / 2 - 50 / (M16.width / M16.resX), cy = M16.resY / 2 - 20 / (M16.depth / M16.resY);
  near((L.box.x0 + L.box.x1) / 2, cx, 1.5, 'mirrored X position of the cube');
  near((L.box.y0 + L.box.y1) / 2, cy, 1.5, 'Y position of the cube (row 0 at the back)');
  const win = windowOf(L.rle, M16, Math.round(cx) - 4, Math.round(cy) - 4, 8, 8);
  ok(win.total === M16.resX * M16.resY, 'layer decodes to exactly resX*resY pixels');
  ok(win.out.every((g) => g === 255), 'interior pixels are fully lit');
  const jobBin = new SliceJob({ machine: M16, aa: 1, layerHeight: 0.05, solids: cube });
  const B = jobBin.layer(3);
  near(B.lit * pxArea(M16), 400, 0.6, 'binary (no AA) area');
  const noMirror = new SliceJob({ machine: { ...M16, mirrorX: false }, aa: 4, layerHeight: 0.05, solids: cube }).layer(10);
  near((noMirror.box.x0 + noMirror.box.x1) / 2, M16.resX / 2 + 50 / (M16.width / M16.resX), 1.5, 'unmirrored X position');
  near(noMirror.lit * pxArea(M16), 400, 0.05, 'area unchanged without mirror (winding handled)');
  const m12 = new SliceJob({ machine: M12, aa: 4, layerHeight: 0.05, solids: cube }).layer(10);
  near(m12.lit * pxArea(M12), 400, 0.05, 'same cube on the 12K profile');
}

console.log('Booleans through winding rules');
{
  const two = soup((s) => { box(s, [0, 0, 0], [10, 10, 5]); box(s, [5, 0, 0], [15, 10, 5]); });
  const U = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: two }).layer(20);
  near(U.lit * pxArea(M16), 150, 0.05, 'overlapping solids union (not double, not XOR)');
  const block = soup((s) => box(s, [-10, -10, 0], [10, 10, 10]));
  const hole = soup((s) => frustum(s, [0, 0, -1], [0, 0, 11], 3, 3, 64));
  const Hn = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: block, negatives: hole }).layer(50);
  near(Hn.lit * pxArea(M16), 400 - Math.PI * 9, 0.15, 'negative cylinder drills a hole');
  const stray = soup((s) => frustum(s, [50, 0, -1], [50, 0, 11], 3, 3, 32));
  const S = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: block, negatives: stray }).layer(50);
  near(S.lit * pxArea(M16), 400, 0.05, 'negative volume outside any solid adds nothing');
  const shell = soup((s) => { box(s, [-10, -10, 0], [10, 10, 10]); });
  const inner = bakeWorld(soup((s) => box(s, [-5, -5, 2], [5, 5, 8])), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], true);
  const C = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: concatF32([shell, inner]) }).layer(100);
  near(C.lit * pxArea(M16), 300, 0.25, 'inward-facing inner shell stays an empty cavity');
  const openMesh = block.slice(0, block.length - 18); // drop the +x face: open contour
  const O = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: openMesh }).layer(50);
  ok(O.lit * pxArea(M16) <= 400.1, 'open mesh never streaks across the plate');
}

console.log('Hollowing');
{
  const cube = soup((s) => box(s, [-15, -15, 0], [15, 15, 30]));
  const bb = bounds(cube);
  const voxel = chooseVoxel(bb, 2);
  const t0 = Date.now();
  const cav = computeCavity(cube, bb, 2, voxel);
  console.log(`      cavity grid ${cav.dims.join('x')} @ ${voxel} mm in ${Date.now() - t0} ms`);
  const job = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: cube, hollows: [{ ...cav, offset: [0, 0, 0] }] });
  near(job.layer(300).lit * pxArea(M16), 900 - 26 * 26, 12, 'mid-height ring area for a 2 mm wall');
  near(job.layer(10).lit * pxArea(M16), 900, 0.5, 'floor stays solid');
  near(job.layer(590).lit * pxArea(M16), 900, 0.5, 'roof stays solid');
  const moved = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05,
    solids: bakeWorld(cube, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, -10, 0, 1]), hollows: [{ ...cav, offset: [20, -10, 0] }] });
  near(moved.layer(300).lit * pxArea(M16), 900 - 26 * 26, 12, 'cavity follows a moved model');
}

console.log('Island detection');
{
  const parts = soup((s) => { box(s, [-5, -5, 0], [5, 5, 10]); box(s, [20, 0, 5], [24, 4, 8]); });
  const job = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: parts, detectIslands: true });
  const found = [];
  for (let i = 0; i < 200; i++) for (const is of job.layer(i).islands) found.push({ i, ...is });
  ok(found.length === 1 && found[0].i === 100, `floating block flagged once, at its first layer (got ${JSON.stringify(found.map((f) => f.i))})`);
  near(found[0]?.x ?? 0, 22, 0.3, 'island X in plate mm');
  near(found[0]?.y ?? 0, 2, 0.3, 'island Y in plate mm');
  const random = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: parts, detectIslands: true });
  ok(random.layer(150).islands.length === 0, 'random access rebuilds the previous layer (no false island)');
  ok(random.layer(100).islands.length === 1, 'random access still finds the true island');
}

console.log('Supports');
{
  // a mushroom: stem on the plate + wide cap -> the cap underside needs supports
  const model = soup((s) => { frustum(s, [0, 0, 0], [0, 0, 20], 3, 3, 32); box(s, [-15, -15, 20], [15, 15, 24]); });
  const opt = { ...SUPPORT_DEFAULTS };
  const { plans, skipped, grid } = autoSupports(model, opt);
  ok(plans.length > 40 && plans.length < 200, `auto supports placed under the cap (${plans.length}, skipped ${skipped})`);
  ok(plans.every((p) => Math.hypot(p.base[0], p.base[1]) > 3.5 || p.onModel), 'no pillar runs through or grazes the stem');
  const built = buildAll(plans, grid, opt);
  ok(signedVolume(built.tris) > 0, 'support solid faces outward');
  ok(built.ranges.length === plans.length, 'pick ranges cover every support');
  const job = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: concatF32([model, built.tris]), detectIslands: true });
  let islands = 0;
  for (let i = 0; i < 480; i++) islands += job.layer(i).islands.length;
  ok(islands === 0, `supported mushroom prints without islands (found ${islands})`);
  const bare = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: model, detectIslands: true });
  let bareIslands = 0;
  for (let i = 395; i < 405; i++) bareIslands += bare.layer(i).islands.length;
  ok(bareIslands === 0, 'cap attached to the stem is not an island (sanity)');
  const g = new VerticalRayGrid(model);
  near(g.castDown(10, 10, 100), 24, 1e-4, 'ray grid: top of cap');
  near(g.castUp(10, 10, 0), 20, 1e-4, 'ray grid: underside of cap');
  ok(g.inside(0, 0, 10) && !g.inside(10, 10, 10) && g.inside(10, 10, 22), 'ray grid: inside tests');
}

console.log('Print parameters');
{
  const s = { ...DEFAULT_PRINT, bottomLayerCount: 4, transitionLayerCount: 4, bottomExposureTime: 30, exposureTime: 2.5 };
  near(exposureForLayer(s, 3), 30, 1e-9, 'bottom exposure');
  near(exposureForLayer(s, 4), 30 - 27.5 / 5, 1e-9, 'first transition layer');
  near(exposureForLayer(s, 8), 2.5, 1e-9, 'normal exposure after the ramp');
  ok(estimatePrintTime(s, 1000) > 1000 * 2.5, 'time estimate includes motion');
}

console.log('Full file round trip + speed');
{
  const ball = soup((s) => sphere(s, [0, 0, 30], 30, 256, 160)); // ~81k triangles
  console.log(`      sphere: ${ball.length / 9} triangles`);
  const job = new SliceJob({ machine: M16, aa: 4, layerHeight: 0.05, solids: ball, detectIslands: true });
  const t0 = Date.now();
  const layers = [];
  let vol = 0;
  const N = layerCountFor(60, 0.05);
  for (let i = 0; i < N; i += 1) { const L = job.layer(i); layers.push(L.rle); vol += L.lit * pxArea(M16) * 0.05; }
  const ms = Date.now() - t0;
  console.log(`      ${N} layers @16K AAx4 in ${ms} ms  (${(ms / N).toFixed(1)} ms/layer, single thread)`);
  near(vol / 1000, ((4 / 3) * Math.PI * 27000) / 1000, 0.4, 'integrated volume of a 60 mm sphere (cm^3)');
  const parts = assembleGoo({ softwareName: 'Vatworks', softwareVersion: '1.0.0', fileTime: '2026-09-21 12:00:00',
    machineName: M16.gooName, machineType: M16.gooType, profileName: 'test', aaLevel: 4,
    resolutionX: M16.resX, resolutionY: M16.resY, mirrorX: 1, mirrorY: 0, displayWidth: M16.width, displayHeight: M16.depth,
    machineZ: M16.height, printTime: 1234, volume: vol, materialGrams: vol / 1000 * 1.1, materialCost: 1 }, DEFAULT_PRINT, layers, M16.height);
  const file = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  writeFileSync('/tmp/vatworks-test.goo', file);
  console.log(`      wrote /tmp/vatworks-test.goo (${(file.length / 1e6).toFixed(2)} MB)`);
  const back = parseGoo(new Uint8Array(file.buffer, file.byteOffset, file.length));
  ok(back.header.layerCount === N && back.layers.length === N, 'parser walks every layer');
  ok(back.header.machineName === M16.gooName && back.header.resolutionX === 15120, 'header strings / numbers round-trip');
  near(back.layers[N - 1].positionZ, 60, 1e-4, 'last layer Z');
  let px = 0; decodeRuns(back.layers[600].rle, (g, l) => (px += l));
  ok(px === M16.resX * M16.resY, 'parsed layer decodes to full resolution');
  const tail = file.subarray(file.length - 11);
  ok(tail[3] === 7 && tail[7] === 0x44 && tail[0] === 0, 'footer magic');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
