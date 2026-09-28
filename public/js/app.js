// Vatworks — application module. Wires the scene, the settings, the workers and the printer bridge together.
import * as THREE from 'three';
import { Viewport } from './viewport.js';
import { MaskView } from './preview.js';
import { MACHINES, RELEASE_PRESETS, DEFAULT_PRINT, RESINS, loadState, saveState, getMachine } from './profiles.js';
import { SUPPORT_DEFAULTS, SUPPORT_PRESETS } from './core/supports.js';
import { bakeWorld, bounds, signedVolume, concatF32, TriSink, frustum, bestOrientation, rotationXY } from './core/geom.js';
import { assembleGoo, parseGoo, rgbaToRgb565, estimatePrintTime, exposureForLayer, decodeRuns, HEADER_SIZE, LAYER_DEF_SIZE } from './core/goo.js';
import { layerCountFor } from './core/pipeline.js';
import { $, $$, el, toast, fmtTime, fmt, fmtBytes, confirmDialog, progressDialog, numberField, selectField, toggleField, stat, printerApi } from './ui.js';

const VERSION = '1.0.0';
const state = loadState();
state.supports = { ...SUPPORT_DEFAULTS, raise: 5, ...(state.supports || {}) };
state.hollow = { wall: 2, holeDiameter: 3, holeDepth: 4, ...(state.hollow || {}) };
let machine = getMachine(state);

// ---------------------------------------------------------------- workers
const workerUrl = (name) => new URL(`./workers/${name}`, import.meta.url);
function makeWorker(name) {
  const w = new Worker(workerUrl(name), { type: 'module' });
  w.pending = new Map();
  w.onmessage = (e) => {
    const m = e.data;
    const p = w.pending.get(m.id);
    if (!p) return;
    if (m.progress != null && !m.done && !m.error) { p.onProgress?.(m); return; }
    w.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m);
  };
  w.onerror = (e) => { for (const p of w.pending.values()) p.reject(new Error(e.message || 'Worker crashed')); w.pending.clear(); };
  return w;
}
let msgId = 1;
function call(worker, msg, transfer = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    worker.pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, ...msg }, transfer);
  });
}
const loadWorker = makeWorker('load.worker.js');
const supportWorker = makeWorker('support.worker.js');
const hollowWorker = makeWorker('hollow.worker.js');
const SLICE_THREADS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
let sliceWorkers = null;

// ---------------------------------------------------------------- scene
const viewport = new Viewport($('#viewport'), { onClick, onTransformEnd, onTransformChange });
const maskView = new MaskView($('#mask'));
const objects = [];
let nextId = 1;
let selectedId = null;
let tool = 'move';
let mode = 'prepare';
let sliced = null;
let currentLayer = 0;
let show3d = false;
const byId = (id) => objects.find((o) => o.id === id);
const selected = () => byId(selectedId);

function setStatus(text, busy = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------- machine
function applyMachine() {
  machine = getMachine(state);
  viewport.setMachine(machine);
  if (!sliced?.fromFile) maskView.setMachine(machine); // an opened .goo keeps its own resolution
  $('#foot-machine').textContent = `${machine.name} · ${machine.resX}×${machine.resY} · ${machine.width}×${machine.depth}×${machine.height} mm`;
  for (const o of objects) checkBounds(o);
  markStale();
}
{
  const sel = $('#machine');
  for (const m of MACHINES) sel.append(el('option', { value: m.id, selected: m.id === state.machineId }, m.name));
  sel.addEventListener('change', () => { state.machineId = sel.value; saveState(state); applyMachine(); toast(`Slicing for ${machine.name}`); });
}

// ---------------------------------------------------------------- objects
function flipWinding(p) {
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
}

function addObject(name, positions) {
  const b = bounds(positions);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = b.min[2];
  for (let i = 0; i < positions.length; i += 3) { positions[i] -= cx; positions[i + 1] -= cy; positions[i + 2] -= cz; }
  let vol = signedVolume(positions);
  let flipped = false;
  if (vol < 0) { flipWinding(positions); vol = -vol; flipped = true; }
  const id = nextId++;
  const group = viewport.addModel(id, positions);
  const o = { id, name, positions, tris: positions.length / 9, group, volume: vol, size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], supports: null, hollow: null, holes: [], out: false };
  objects.push(o);
  placeNew(o);
  finishTransform(o, 'place');
  select(id);
  refreshObjects();
  viewport.fit();
  if (flipped) toast(`${name} was inside-out; its faces were flipped so it slices as a solid.`);
  if (vol < 1) toast(`${name} has almost no volume — is it a surface rather than a solid?`, 'error');
  return o;
}

function removeObject(id) {
  const i = objects.findIndex((o) => o.id === id);
  if (i < 0) return;
  viewport.removeModel(id);
  supportWorker.postMessage({ id: 0, type: 'forget', objectId: id });
  objects.splice(i, 1);
  if (selectedId === id) select(objects[0]?.id ?? null);
  refreshObjects();
  markStale();
}

function select(id) {
  selectedId = id;
  viewport.select(id);
  refreshObjects();
  refreshTransformCard();
}

/** Finds a free spot on the plate for a new object (centre first, then a grid scan). */
function placeNew(o) {
  const gap = 4;
  const box = viewport.worldBounds(o.id);
  const w = box.max.x - box.min.x, d = box.max.y - box.min.y;
  const others = objects.filter((x) => x !== o).map((x) => viewport.worldBounds(x.id));
  const free = (x, y) => others.every((b) => x + w / 2 + gap < b.min.x || x - w / 2 - gap > b.max.x || y + d / 2 + gap < b.min.y || y - d / 2 - gap > b.max.y);
  const put = (x, y) => { o.group.position.x += x - (box.min.x + box.max.x) / 2; o.group.position.y += y - (box.min.y + box.max.y) / 2; };
  if (free(0, 0)) return put(0, 0);
  const W = machine.width, D = machine.depth;
  const step = 5;
  for (let y = -D / 2 + d / 2 + gap; y <= D / 2 - d / 2 - gap; y += step)
    for (let x = -W / 2 + w / 2 + gap; x <= W / 2 - w / 2 - gap; x += step) if (free(x, y)) return put(x, y);
  put(0, 0);
}

function checkBounds(o) {
  const b = (o.box = viewport.worldBounds(o.id));
  const m = machine, eps = 0.01;
  o.out = b.min.x < -m.width / 2 - eps || b.max.x > m.width / 2 + eps || b.min.y < -m.depth / 2 - eps || b.max.y > m.depth / 2 + eps || b.min.z < -eps || b.max.z > m.height + eps;
  if (o.supports) {
    const sb = bounds(o.supports.tris);
    if (sb.min[0] < -m.width / 2 - eps || sb.max[0] > m.width / 2 + eps || sb.min[1] < -m.depth / 2 - eps || sb.max[1] > m.depth / 2 + eps) o.out = true;
  }
  viewport.setOutOfBounds(o.id, o.out);
  return !o.out;
}

/** Called after any transform. kind: 'place' | 'translate' | 'rotate' | 'scale' | 'numeric-*'. */
function finishTransform(o, kind) {
  o.group.updateMatrixWorld(true);
  const box = viewport.worldBounds(o.id);
  if (kind !== 'translate' && kind !== 'lift') o.group.position.z -= box.min.z; // rest on the plate
  else if (box.min.z < 0) o.group.position.z -= box.min.z;
  o.group.updateMatrixWorld(true);
  supportWorker.postMessage({ id: 0, type: 'forget', objectId: o.id }); // its cached ray grid is in the old position
  reconcileDependents(o);
  checkBounds(o);
  viewport.updateBox();
  refreshObjects();
  refreshTransformCard();
  markStale();
}

function linearPartEqual(a, b) {
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

/** Keeps supports / cavities consistent with the object's transform: shift them when possible, drop them otherwise. */
function reconcileDependents(o) {
  const M = o.group.matrixWorld.elements;
  if (o.supports) {
    const S = o.supports.matrix;
    if (linearPartEqual(M, S) && Math.abs(M[14] - S[14]) < 1e-6) {
      const dx = M[12] - S[12], dy = M[13] - S[13];
      if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
        shiftSupports(o.supports, dx, dy);
        o.supports.matrix = M.slice();
        viewport.setSupports(o.id, o.supports.tris, o.supports.ranges);
      }
    } else {
      clearSupports(o, true);
      toast(`Supports removed from ${o.name}: it was rotated, scaled or lifted. Generate them again.`);
    }
  }
  if (o.hollow) {
    const H = o.hollow.matrix;
    if (linearPartEqual(M, H)) viewport.moveCavity(o.id, cavityOffset(o));
    else {
      clearHollow(o);
      toast(`${o.name} is solid again: hollowing does not survive rotation or scaling. Hollow it again.`);
    }
  }
}

function shiftSupports(s, dx, dy) {
  const t = s.tris;
  for (let i = 0; i < t.length; i += 3) { t[i] += dx; t[i + 1] += dy; }
  const mv = (p) => { if (p) { p[0] += dx; p[1] += dy; } };
  for (const p of s.plans) { mv(p.E); mv(p.J); mv(p.K); mv(p.base); mv(p.contact?.p); }
}
const cavityOffset = (o) => { const M = o.group.matrixWorld.elements, H = o.hollow.matrix; return [M[12] - H[12], M[13] - H[13], M[14] - H[14]]; };
function clearSupports(o, quiet) { if (!o.supports) return; o.supports = null; viewport.setSupports(o.id, null); if (!quiet) markStale(); }
function clearHollow(o) { if (!o.hollow) return; o.hollow = null; viewport.setCavity(o.id, null); }

const worldTris = (o) => { o.group.updateMatrixWorld(true); return bakeWorld(o.positions, o.group.matrixWorld.elements); };

// ---------------------------------------------------------------- transform panel
const tc = {
  size: ['#size-x', '#size-y', '#size-z'].map((s) => $(s)), pct: $('#scale-pct'), rot: ['#rot-x', '#rot-y', '#rot-z'].map((s) => $(s)),
  pos: ['#pos-x', '#pos-y', '#pos-z'].map((s) => $(s)), lock: $('#size-lock'),
};
function refreshTransformCard() {
  const o = selected();
  $('#transform-card').hidden = !o;
  $('#btn-orient').disabled = !o;
  $('#btn-duplicate').disabled = !o;
  if (!o) return;
  const b = viewport.worldBounds(o.id);
  const size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  tc.size.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = size[i].toFixed(1); });
  if (document.activeElement !== tc.pct) tc.pct.value = (Math.abs(o.group.scale.x) * 100).toFixed(1);
  const r = o.group.rotation;
  [r.x, r.y, r.z].forEach((v, i) => { if (document.activeElement !== tc.rot[i]) tc.rot[i].value = ((v * 180) / Math.PI).toFixed(1); });
  const pos = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z];
  tc.pos.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = pos[i].toFixed(1); });
  const mm3 = o.volume * Math.abs(o.group.scale.x * o.group.scale.y * o.group.scale.z);
  $('#object-info').textContent = `${o.tris.toLocaleString()} triangles · ${(mm3 / 1000).toFixed(2)} mL solid${o.hollow ? ` · hollowed (${o.hollow.wall} mm wall)` : ''}${o.supports ? ` · ${o.supports.plans.length} supports` : ''}${o.out ? ' · outside the printable area' : ''}`;
}
tc.size.forEach((inp, axis) => inp.addEventListener('change', () => {
  const o = selected();
  if (!o) return;
  const b = viewport.worldBounds(o.id);
  const cur = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z][axis];
  const v = parseFloat(inp.value);
  if (!(v > 0) || !(cur > 0)) return refreshTransformCard();
  const f = v / cur;
  if (tc.lock.getAttribute('aria-pressed') === 'true') o.group.scale.multiplyScalar(f);
  else o.group.scale.setComponent(axis, o.group.scale.getComponent(axis) * f);
  finishTransform(o, 'scale');
}));
tc.pct.addEventListener('change', () => { const o = selected(); const v = parseFloat(tc.pct.value); if (o && v > 0) { o.group.scale.multiplyScalar(v / 100 / Math.abs(o.group.scale.x)); finishTransform(o, 'scale'); } }); // keeps mirroring and per-axis ratios
tc.rot.forEach((inp, axis) => inp.addEventListener('change', () => {
  const o = selected();
  const v = parseFloat(inp.value);
  if (!o || !Number.isFinite(v)) return refreshTransformCard();
  const e = o.group.rotation;
  e[['x', 'y', 'z'][axis]] = (v * Math.PI) / 180;
  finishTransform(o, 'rotate');
}));
tc.pos.forEach((inp, axis) => inp.addEventListener('change', () => {
  const o = selected();
  const v = parseFloat(inp.value);
  if (!o || !Number.isFinite(v)) return refreshTransformCard();
  const b = viewport.worldBounds(o.id);
  const cur = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z][axis];
  o.group.position.setComponent(axis, o.group.position.getComponent(axis) + (Math.max(axis === 2 ? 0 : -Infinity, v) - cur));
  finishTransform(o, axis === 2 ? 'lift' : 'translate');
}));
tc.lock.addEventListener('click', () => {
  const on = tc.lock.getAttribute('aria-pressed') !== 'true';
  tc.lock.setAttribute('aria-pressed', String(on));
  tc.lock.querySelector('use').setAttribute('href', on ? '#i-lock' : '#i-unlock');
});
for (const [id, axis] of [['#mirror-x', 'x'], ['#mirror-y', 'y'], ['#mirror-z', 'z']]) {
  $(id).addEventListener('click', () => { const o = selected(); if (!o) return; o.group.scale[axis] *= -1; finishTransform(o, 'scale'); });
}
$('#btn-drop').addEventListener('click', () => { const o = selected(); if (o) finishTransform(o, 'drop'); });
$('#btn-reset').addEventListener('click', () => {
  const o = selected();
  if (!o) return;
  o.group.rotation.set(0, 0, 0);
  o.group.scale.setScalar(1);
  finishTransform(o, 'rotate');
});
$('#btn-delete').addEventListener('click', () => { if (selectedId) removeObject(selectedId); });
$('#btn-duplicate').addEventListener('click', duplicateSelected);
$('#btn-arrange').addEventListener('click', arrangeAll);
$('#btn-orient').addEventListener('click', autoOrient);

function duplicateSelected() {
  const o = selected();
  if (!o) return;
  const id = nextId++;
  const group = viewport.addModel(id, o.positions);
  group.position.copy(o.group.position);
  group.rotation.copy(o.group.rotation);
  group.scale.copy(o.group.scale);
  const c = { ...o, id, name: `${o.name} copy`, group, supports: null, hollow: null, holes: o.holes.map((h) => ({ ...h })), out: false };
  objects.push(c);
  placeNew(c);
  c.group.updateMatrixWorld(true);
  const dx = c.group.position.x - o.group.position.x, dy = c.group.position.y - o.group.position.y;
  if (o.supports) {
    const s = { plans: structuredClone(o.supports.plans), tris: o.supports.tris.slice(), ranges: o.supports.ranges.map((r) => r.slice()), opt: { ...o.supports.opt }, matrix: c.group.matrixWorld.elements.slice() };
    shiftSupports(s, dx, dy);
    c.supports = s;
    viewport.setSupports(id, s.tris, s.ranges);
  }
  if (o.hollow) {
    c.hollow = o.hollow; // same field, different offset
    viewport.setCavity(id, o.hollow.preview, cavityOffset(c));
  }
  viewport.setHoles(id, c.holes);
  finishTransform(c, 'translate');
  select(id);
}

function arrangeAll() {
  if (!objects.length) return;
  const gap = 4, W = machine.width, D = machine.depth;
  const items = objects.map((o) => { const b = viewport.worldBounds(o.id); return { o, w: b.max.x - b.min.x, d: b.max.y - b.min.y, b }; }).sort((a, b) => b.w * b.d - a.w * a.d);
  let x = -W / 2 + gap, y = -D / 2 + gap, rowD = 0;
  for (const it of items) {
    if (x + it.w > W / 2 - gap + 1e-6 && x > -W / 2 + gap + 1e-6) { x = -W / 2 + gap; y += rowD + gap; rowD = 0; }
    it.o.group.position.x += x - it.b.min.x;
    it.o.group.position.y += y - it.b.min.y;
    x += it.w + gap;
    rowD = Math.max(rowD, it.d);
    finishTransform(it.o, 'translate');
  }
  viewport.fit();
}

function autoOrient() {
  const o = selected();
  if (!o) return;
  setStatus(`Looking for the best orientation of ${o.name}`, true);
  setTimeout(() => {
    try {
      const w = worldTris(o);
      const best = bestOrientation(w, state.supports.overhangAngle);
      const R = rotationXY(best.ax, best.ay);
      const m = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const before = viewport.worldBounds(o.id).getCenter(new THREE.Vector3());
      o.group.quaternion.premultiply(q);
      o.group.updateMatrixWorld(true);
      const after = viewport.worldBounds(o.id).getCenter(new THREE.Vector3());
      o.group.position.x += before.x - after.x;
      o.group.position.y += before.y - after.y;
      finishTransform(o, 'rotate');
      toast(`Rotated ${o.name}: ${fmt(best.overhang, 0)} mm² of overhang left to support, ${fmt(best.height, 1)} mm tall.`);
    } finally { setStatus('Ready'); }
  }, 30);
}

// ---------------------------------------------------------------- object list
function refreshObjects() {
  const list = $('#object-list');
  list.replaceChildren(...objects.map((o) => el('li', { 'aria-selected': String(o.id === selectedId), onclick: () => select(o.id), title: o.name },
    el('span', { class: 'name' }, o.name),
    el('span', { class: 'badges' },
      o.hollow ? el('span', { class: 'badge uv' }, 'hollow') : null,
      o.supports ? el('span', { class: 'badge mint' }, `${o.supports.plans.length} sup`) : null,
      o.holes.length ? el('span', { class: 'badge' }, `${o.holes.length} drain`) : null,
      o.out ? el('span', { class: 'badge coral' }, 'outside') : null),
    el('button', { class: 'rm', 'aria-label': `Remove ${o.name}`, onclick: (e) => { e.stopPropagation(); removeObject(o.id); } }, el('span', { html: '<svg class="icon" style="width:14px;height:14px"><use href="#i-x"/></svg>' })))));
  $('#object-empty').hidden = objects.length > 0;
  $('#object-count').textContent = objects.length ? `${objects.length}` : '';
  refreshEstimate();
}

// ---------------------------------------------------------------- tools
const TOOL_HINTS = {
  move: 'Drag the arrows to move. Objects always rest on the plate; drag the blue arrow to lift one for supports.',
  rotate: 'Drag a ring to rotate. The object drops back onto the plate afterwards.',
  scale: 'Drag a handle to scale, or type a size on the left.',
  support: 'Click the model to add a support there; click a support to remove it. Use the Supports tab to generate them automatically.',
  hole: 'Click the model to place a drain hole. Click a hole to remove it. Holes are cut when you slice.',
};
function setTool(t) {
  tool = t;
  viewport.setTool(t);
  for (const b of $$('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  $('#tool-hint').textContent = TOOL_HINTS[t];
}
for (const b of $$('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));

function onTransformChange(id) { refreshTransformCard(); }
function onTransformEnd(id, gizmoMode) {
  const o = byId(id);
  if (!o) return;
  finishTransform(o, gizmoMode === 'translate' ? 'translate' : gizmoMode);
}

async function onClick(hit) {
  if (mode !== 'prepare') return;
  if (!hit) { if (tool === 'move' || tool === 'rotate' || tool === 'scale') select(null); return; }
  const o = byId(hit.id);
  if (!o) return;
  if (tool === 'support') {
    if (hit.kind === 'support') return removeSupportAt(o, hit.faceIndex);
    if (hit.kind === 'model') return addManualSupport(o, hit);
    return;
  }
  if (tool === 'hole') {
    if (hit.kind === 'hole') { o.holes.splice(hit.index, 1); viewport.setHoles(o.id, o.holes); refreshObjects(); markStale(); return; }
    if (hit.kind === 'model') return addHole(o, hit);
    return;
  }
  select(o.id);
}

// ---------------------------------------------------------------- supports
async function generateSupports(list) {
  const opt = { ...state.supports };
  for (const o of list) {
    try {
      clearSupports(o, true);
      const b = viewport.worldBounds(o.id);
      if (opt.raise > 0 && b.min.z < opt.raise - 1e-6) { o.group.position.z += opt.raise - b.min.z; finishTransform(o, 'lift'); }
      setStatus(`Generating supports for ${o.name}`, true);
      const tris = worldTris(o);
      const r = await call(supportWorker, { type: 'auto', objectId: o.id, tris, opt }, [tris.buffer]);
      o.supports = { plans: r.plans, tris: r.tris, ranges: r.ranges, opt, matrix: o.group.matrixWorld.elements.slice() };
      viewport.setSupports(o.id, r.tris, r.ranges);
      toast(`${r.plans.length} supports on ${o.name}${r.skipped ? ` (${r.skipped} spots had no clear path to the plate)` : ''}`, 'ok');
    } catch (e) {
      toast(`Supports failed for ${o.name}: ${e.message}`, 'error');
    }
  }
  setStatus('Ready');
  for (const o of list) checkBounds(o);
  refreshObjects();
  refreshTransformCard();
  markStale();
}

async function ensureSupportGeometry(o) {
  const tris = worldTris(o);
  await call(supportWorker, { type: 'build', objectId: o.id, tris, plans: [], opt: state.supports }, [tris.buffer]).catch(() => {});
}

async function addManualSupport(o, hit) {
  const opt = o.supports?.opt || { ...state.supports };
  const contact = { p: [hit.point.x, hit.point.y, hit.point.z], n: [hit.normal.x, hit.normal.y, hit.normal.z], kind: 'manual' };
  setStatus('Placing support', true);
  try {
    const r = await supportCall(o, { type: 'plan', objectId: o.id, contact, opt });
    if (!r.plan) return toast('No clear path from that spot down to the plate (or the model).', 'error');
    const plans = [...(o.supports?.plans || []), r.plan];
    await rebuildSupports(o, plans, opt);
  } catch (e) { toast(`Could not add a support: ${e.message}`, 'error'); } finally { setStatus('Ready'); }
}

/** Calls the support worker, sending the object's geometry first if the worker has none cached (new, moved or copied). */
async function supportCall(o, msg) {
  try { return await call(supportWorker, msg); } catch (e) {
    if (e.message !== 'needs-geometry') throw e;
    await ensureSupportGeometry(o);
    return call(supportWorker, msg);
  }
}

async function rebuildSupports(o, plans, opt) {
  const r = await supportCall(o, { type: 'build', objectId: o.id, plans, opt });
  if (!plans.length) clearSupports(o, true);
  else { o.supports = { plans: r.plans, tris: r.tris, ranges: r.ranges, opt, matrix: o.group.matrixWorld.elements.slice() }; viewport.setSupports(o.id, r.tris, r.ranges); }
  checkBounds(o);
  refreshObjects();
  refreshTransformCard();
  markStale();
}

async function removeSupportAt(o, faceIndex) {
  if (!o.supports) return;
  const i = o.supports.ranges.findIndex(([a, b]) => faceIndex >= a && faceIndex < b);
  if (i < 0) return toast('That is a brace or the raft; remove the support it belongs to instead.');
  const plans = o.supports.plans.filter((_, k) => k !== i);
  setStatus('Removing support', true);
  try { await rebuildSupports(o, plans, o.supports.opt); } catch (e) { toast(e.message, 'error'); } finally { setStatus('Ready'); }
}

// ---------------------------------------------------------------- hollowing & drains
async function hollowObject(o) {
  const wall = state.hollow.wall;
  const b = viewport.worldBounds(o.id);
  const minDim = Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
  if (minDim < wall * 2.5) return toast(`${o.name} is too thin to hollow with a ${wall} mm wall.`, 'error');
  const dlg = progressDialog(`Hollowing ${o.name}`);
  try {
    const tris = worldTris(o);
    const r = await call(hollowWorker, { tris, wall }, [tris.buffer], (m) => dlg.set(m.progress, m.label));
    if (!r.cavityVoxels) { toast(`${o.name} is thinner than ${wall * 2} mm everywhere; nothing to hollow.`); return; }
    o.hollow = { field: r.field, dims: r.dims, origin: r.origin, voxel: r.voxel, wall, preview: r.preview, matrix: o.group.matrixWorld.elements.slice(), cavityMl: (r.cavityVoxels * r.voxel ** 3) / 1000 };
    viewport.setCavity(o.id, r.preview, [0, 0, 0]);
    if (!viewport.xray) toggleXray(true);
    toast(`${o.name} hollowed: about ${fmt(o.hollow.cavityMl, 1)} mL of resin saved. Add at least one drain hole.`, 'ok');
    refreshObjects();
    refreshTransformCard();
    markStale();
  } catch (e) { toast(`Hollowing failed: ${e.message}`, 'error'); } finally { dlg.close(); }
}

function addHole(o, hit) {
  const inv = o.group.matrixWorld.clone().invert();
  const p = hit.point.clone().applyMatrix4(inv);
  const n = hit.normal.clone().transformDirection(inv).normalize();
  o.holes.push({ p: [p.x, p.y, p.z], n: [n.x, n.y, n.z], d: state.hollow.holeDiameter, depth: state.hollow.holeDepth });
  viewport.setHoles(o.id, o.holes);
  refreshObjects();
  markStale();
}

/** World-space negative solid for a drain hole. */
function holeSolid(o, h) {
  const M = o.group.matrixWorld;
  const p = new THREE.Vector3(...h.p).applyMatrix4(M);
  const n = new THREE.Vector3(...h.n).transformDirection(M).normalize();
  const sink = new TriSink(64);
  const A = [p.x + n.x * 0.6, p.y + n.y * 0.6, p.z + n.z * 0.6];
  const B = [p.x - n.x * h.depth, p.y - n.y * h.depth, p.z - n.z * h.depth];
  frustum(sink, A, B, h.d / 2, h.d / 2, 24);
  return sink.result();
}

function toggleXray(on) {
  const b = $('#btn-xray');
  const v = on ?? b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(v));
  viewport.setXray(v);
}
$('#btn-xray').addEventListener('click', () => toggleXray());
$('#btn-fit').addEventListener('click', () => { if (mode === 'prepare' || show3d) viewport.fit(); else { maskView.resetView(); maskView.redraw(); } });

// ---------------------------------------------------------------- settings panels
const printFields = [];
function buildPrintTab() {
  const p = state.print;
  const c = $('#tab-print');
  const change = () => { saveState(state); markStale(); refreshEstimate(); };
  const nf = (o) => { const f = numberField({ obj: p, onChange: change, ...o }); printFields.push(f); return f; };
  const releaseHint = el('div', { class: 'field-hint' }, RELEASE_PRESETS[p.releasePreset]?.hint || '');
  const applyRelease = (key) => {
    Object.assign(p, RELEASE_PRESETS[key].values);
    releaseHint.textContent = RELEASE_PRESETS[key].hint;
    for (const f of printFields) f.refresh?.();
    change();
  };
  c.replaceChildren(
    el('div', { class: 'panel-title' }, 'Layers'),
    nf({ label: 'Layer height', unit: 'mm', key: 'layerHeight', min: 0.01, max: 0.3, step: 0.005 }),
    nf({ label: 'Exposure', unit: 's', key: 'exposureTime', min: 0.1, max: 120, step: 0.1 }),
    nf({ label: 'Bottom exposure', unit: 's', key: 'bottomExposureTime', min: 0.5, max: 300, step: 0.5 }),
    nf({ label: 'Bottom layers', key: 'bottomLayerCount', min: 0, max: 50, step: 1 }),
    nf({ label: 'Transition layers', key: 'transitionLayerCount', min: 0, max: 50, step: 1, hint: 'Exposure ramps down from bottom to normal over these layers so the model does not shear off the base.' }),
    el('div', { class: 'panel-title' }, 'Rest times'),
    nf({ label: 'Rest before cure', unit: 's', key: 'waitBeforeCure', min: 0, max: 60, step: 0.1 }),
    nf({ label: 'Rest after cure', unit: 's', key: 'waitAfterCure', min: 0, max: 60, step: 0.1 }),
    nf({ label: 'Rest after lift', unit: 's', key: 'waitAfterLift', min: 0, max: 60, step: 0.1 }),
    el('details', { class: 'adv' }, el('summary', {}, 'Bottom-layer rest times'),
      nf({ label: 'Before cure', unit: 's', key: 'bottomWaitBeforeCure', min: 0, max: 60, step: 0.1 }),
      nf({ label: 'After cure', unit: 's', key: 'bottomWaitAfterCure', min: 0, max: 60, step: 0.1 }),
      nf({ label: 'After lift', unit: 's', key: 'bottomWaitAfterLift', min: 0, max: 60, step: 0.1 })),
    el('div', { class: 'panel-title' }, 'Release'),
    (() => { const f = selectField({ label: 'Lift preset', obj: p, key: 'releasePreset', options: Object.entries(RELEASE_PRESETS).map(([k, v]) => [k, v.label]), onChange: applyRelease, wide: true }); printFields.push(f); return f; })(),
    releaseHint,
    el('details', { class: 'adv' }, el('summary', {}, 'Lift and retract values written to the file'),
      el('div', { class: 'field-hint' }, 'Distances in mm, speeds in mm/min. Stage 2 runs after stage 1.'),
      ...[['liftHeight', 'Lift 1'], ['liftSpeed', 'Lift 1 speed'], ['liftHeight2', 'Lift 2'], ['liftSpeed2', 'Lift 2 speed'], ['retractHeight', 'Retract 1'], ['retractSpeed', 'Retract 1 speed'], ['retractHeight2', 'Retract 2'], ['retractSpeed2', 'Retract 2 speed'],
        ['bottomLiftHeight', 'Bottom lift 1'], ['bottomLiftSpeed', 'Bottom lift 1 speed'], ['bottomLiftHeight2', 'Bottom lift 2'], ['bottomLiftSpeed2', 'Bottom lift 2 speed'], ['bottomRetractHeight', 'Bottom retract 1'], ['bottomRetractSpeed', 'Bottom retract 1 speed'], ['bottomRetractHeight2', 'Bottom retract 2'], ['bottomRetractSpeed2', 'Bottom retract 2 speed']]
        .map(([key, label]) => nf({ label, key, min: 0, max: 1000, step: 0.05, unit: key.includes('Speed') ? 'mm/min' : 'mm' }))),
    el('div', { class: 'panel-title' }, 'Light & image'),
    nf({ label: 'Light PWM', key: 'lightPWM', min: 0, max: 255, step: 1 }),
    nf({ label: 'Bottom light PWM', key: 'bottomLightPWM', min: 0, max: 255, step: 1 }),
    (() => { const f = selectField({ label: 'Anti-aliasing', obj: p, key: 'aa', options: [[1, 'Off'], [2, '2×'], [4, '4×'], [8, '8×']], onChange: change, hint: 'Grey edge pixels soften the stair-stepping of the LCD grid. 4× is a good default; Off gives hard binary edges.' }); printFields.push(f); return f; })(),
    (() => { const f = toggleField({ label: 'Detect islands while slicing', obj: p, key: 'detectIslands', onChange: change }); printFields.push(f); return f; })(),
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn small', onclick: () => $('#goo-input').click() }, 'Import settings from a .goo'),
      el('button', { class: 'btn small', onclick: () => { Object.assign(p, DEFAULT_PRINT); applyRelease(p.releasePreset); toast('Print settings reset'); } }, 'Reset')),
    el('input', { type: 'file', id: 'goo-input', accept: '.goo', hidden: true, onchange: (e) => { const f = e.target.files[0]; if (f) importGooSettings(f); e.target.value = ''; } }),
  );
}

function buildResinTab() {
  const c = $('#tab-resin');
  const r = state.resin;
  const change = () => { saveState(state); markStale(); refreshEstimate(); };
  const fields = [];
  const nf = (o) => { const f = numberField({ obj: r, onChange: change, ...o }); fields.push(f); return f; };
  const preset = selectField({ label: 'Resin', obj: state, key: 'resinId', options: RESINS.map((x) => [x.id, x.name]), wide: true, onChange: (id) => {
    const rp = RESINS.find((x) => x.id === id);
    if (!rp) return;
    Object.assign(r, rp);
    state.print.exposureTime = rp.exposureTime;
    state.print.bottomExposureTime = rp.bottomExposureTime;
    for (const f of [...fields, ...printFields]) f.refresh?.();
    change();
    toast(`${rp.name}: exposure set to ${rp.exposureTime} s / bottom ${rp.bottomExposureTime} s. Tune it with a calibration print.`);
  } });
  c.replaceChildren(
    preset,
    el('div', { class: 'field-hint' }, 'Picking a resin fills in starting exposures. Every bottle is different: run an exposure test and adjust the Print tab.'),
    el('div', { class: 'panel-title' }, 'Cost estimate'),
    nf({ label: 'Density', unit: 'g/mL', key: 'density', min: 0.5, max: 3, step: 0.01 }),
    nf({ label: 'Price per kg', key: 'pricePerKg', min: 0, max: 1000, step: 1 }),
    (() => { const inp = el('input', { type: 'text', value: state.currency, maxlength: 3 }); inp.addEventListener('change', () => { state.currency = inp.value.trim() || '$'; change(); }); return el('div', { class: 'field' }, el('label', {}, 'Currency'), el('span', { class: 'in' }, inp)); })(),
  );
}

function buildSupportsTab() {
  const c = $('#tab-supports');
  const s = state.supports;
  const fields = [];
  const change = () => { saveState(state); };
  const nf = (o) => { const f = numberField({ obj: s, onChange: change, ...o }); fields.push(f); return f; };
  const tf = (o) => { const f = toggleField({ obj: s, onChange: change, ...o }); fields.push(f); return f; };
  c.replaceChildren(
    selectField({ label: 'Thickness preset', obj: s, key: 'preset', options: [['light', 'Light — miniatures, fine detail'], ['medium', 'Medium — general use'], ['heavy', 'Heavy — large or heavy parts']], wide: true, onChange: (k) => { Object.assign(s, SUPPORT_PRESETS[k]); for (const f of fields) f.refresh?.(); change(); } }),
    el('div', { class: 'panel-title' }, 'Placement'),
    nf({ label: 'Spacing', unit: 'mm', key: 'spacing', min: 1, max: 20, step: 0.5, hint: 'Distance between contact points on overhanging surfaces.' }),
    nf({ label: 'Overhang angle', unit: '°', key: 'overhangAngle', min: 10, max: 89, step: 1, hint: 'Faces tilted more than this from vertical get supported.' }),
    nf({ label: 'Raise model', unit: 'mm', key: 'raise', min: 0, max: 30, step: 0.5, hint: 'Lifts the model off the plate so supports fit underneath.' }),
    tf({ label: 'Only stand on the plate', key: 'plateOnly', hint: 'Off: supports may also stand on the model itself where there is no path to the plate.' }),
    el('div', { class: 'panel-title' }, 'Shape'),
    nf({ label: 'Tip diameter', unit: 'mm', key: 'tipDiameter', min: 0.1, max: 3, step: 0.05 }),
    nf({ label: 'Contact depth', unit: 'mm', key: 'contactDepth', min: 0, max: 2, step: 0.05 }),
    nf({ label: 'Tip length', unit: 'mm', key: 'tipLength', min: 0.5, max: 10, step: 0.1 }),
    nf({ label: 'Pillar diameter', unit: 'mm', key: 'pillarDiameter', min: 0.3, max: 6, step: 0.05 }),
    nf({ label: 'Foot diameter', unit: 'mm', key: 'baseDiameter', min: 1, max: 12, step: 0.1 }),
    tf({ label: 'Brace tall pillars', key: 'bracing' }),
    tf({ label: 'Raft', key: 'raft' }),
    nf({ label: 'Raft thickness', unit: 'mm', key: 'raftThickness', min: 0.3, max: 5, step: 0.1 }),
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn', onclick: () => { const o = selected(); if (o) generateSupports([o]); else toast('Select an object first'); } }, 'Generate for selected'),
      el('button', { class: 'btn', onclick: () => generateSupports(objects) }, 'All')),
    el('div', { class: 'row', style: 'margin-top:6px' },
      el('button', { class: 'btn small', onclick: () => { const o = selected(); if (o?.supports) { clearSupports(o); refreshObjects(); refreshTransformCard(); } } }, 'Clear selected'),
      el('button', { class: 'btn small', onclick: () => { setTool('support'); } }, 'Place by hand')),
  );
}

function buildHollowTab() {
  const c = $('#tab-hollow');
  const h = state.hollow;
  const change = () => saveState(state);
  c.replaceChildren(
    el('div', { class: 'field-hint' }, 'Hollowing keeps a shell of resin and empties the inside. The cavity is cut exactly at slice time, so what you preview is what prints.'),
    numberField({ label: 'Wall thickness', unit: 'mm', obj: h, key: 'wall', min: 0.5, max: 10, step: 0.1, onChange: change }),
    el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'btn', onclick: () => { const o = selected(); if (o) hollowObject(o); else toast('Select an object first'); } }, 'Hollow selected'),
      el('button', { class: 'btn small', onclick: () => { const o = selected(); if (o?.hollow) { clearHollow(o); refreshObjects(); refreshTransformCard(); markStale(); } } }, 'Make solid')),
    el('div', { class: 'panel-title' }, 'Drain holes'),
    el('div', { class: 'field-hint' }, 'A hollow part needs at least one hole low on the model, or uncured resin and suction will wreck the print. Pick the Drain tool and click the model.'),
    numberField({ label: 'Hole diameter', unit: 'mm', obj: h, key: 'holeDiameter', min: 0.5, max: 12, step: 0.1, onChange: change }),
    numberField({ label: 'Hole depth', unit: 'mm', obj: h, key: 'holeDepth', min: 0.5, max: 30, step: 0.5, onChange: change }),
    el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: () => setTool('hole') }, 'Place drain holes')),
  );
}

for (const t of $$('.tabs [role=tab]')) t.addEventListener('click', () => {
  for (const x of $$('.tabs [role=tab]')) x.setAttribute('aria-selected', String(x === t));
  for (const pane of $$('.tabpane')) pane.hidden = pane.id !== `tab-${t.dataset.tab}`;
});

// ---------------------------------------------------------------- estimates
const pxArea = () => (machine.width / machine.resX) * (machine.depth / machine.resY);
function refreshEstimate() {
  const e = $('#estimate');
  $('#btn-slice').disabled = objects.length === 0;
  if (!objects.length) { e.replaceChildren(el('span', {}, 'Add a model to see estimates')); return; }
  let mm3 = 0, maxZ = 0;
  for (const o of objects) {
    const b = o.box || viewport.worldBounds(o.id);
    maxZ = Math.max(maxZ, b.max.z);
    mm3 += o.volume * Math.abs(o.group.scale.x * o.group.scale.y * o.group.scale.z) - (o.hollow ? o.hollow.cavityMl * 1000 : 0);
    if (o.supports) mm3 += Math.abs(signedVolume(o.supports.tris));
  }
  const layers = layerCountFor(maxZ, state.print.layerHeight);
  const secs = estimatePrintTime(state.print, layers, machine.tiltSeconds);
  e.replaceChildren(el('span', {}, `≈ ${fmtTime(secs)}`), el('span', {}, `${layers} layers`), el('span', {}, el('strong', {}, `${fmt(mm3 / 1000, 1)} mL`)));
}

function markStale() {
  if (sliced && !sliced.fromFile) {
    sliced = null;
    if (mode === 'preview') setMode('prepare');
  }
  $('#mode-preview').disabled = !sliced;
  refreshEstimate();
}

// ---------------------------------------------------------------- slicing
let slicing = false;
async function slice() {
  if (slicing) return; // the desktop menu / shortcut can fire while a slice is running
  slicing = true;
  try { await sliceNow(); } finally { slicing = false; }
}

async function sliceNow() {
  if (!objects.length) return;
  for (const o of objects) checkBounds(o);
  if (objects.some((o) => o.out)) return toast('Something is outside the printable area (shown in red). Move it inside first.', 'error');
  const hollowNoDrain = objects.filter((o) => o.hollow && !o.holes.length);
  if (hollowNoDrain.length && !(await confirmDialog({ title: 'No drain holes', body: `${hollowNoDrain.map((o) => o.name).join(', ')} ${hollowNoDrain.length > 1 ? 'are' : 'is'} hollow but has no drain hole. Trapped resin and suction will likely fail the print. Slice anyway?`, ok: 'Slice anyway' }))) return;
  const lh = state.print.layerHeight;
  const solids = [], negatives = [], hollows = [];
  let maxZ = 0;
  for (const o of objects) {
    const w = worldTris(o);
    solids.push(w);
    maxZ = Math.max(maxZ, bounds(w).max[2]);
    if (o.supports) { solids.push(o.supports.tris); maxZ = Math.max(maxZ, bounds(o.supports.tris).max[2]); }
    if (o.hollow) hollows.push({ field: o.hollow.field, dims: o.hollow.dims, origin: o.hollow.origin, voxel: o.hollow.voxel, offset: cavityOffset(o) });
    for (const h of o.holes) negatives.push(holeSolid(o, h));
  }
  const layers = layerCountFor(maxZ, lh);
  if (layers < 1) return toast('Nothing to slice', 'error');
  const allSolids = concatF32(solids), allNeg = concatF32(negatives);
  const threads = Math.max(1, Math.min(SLICE_THREADS, Math.ceil(layers / 40)));
  if (!sliceWorkers) sliceWorkers = [];
  while (sliceWorkers.length < threads) sliceWorkers.push(makeWorker('slice.worker.js'));
  const per = Math.ceil(layers / threads);
  const done = new Array(threads).fill(0);
  let cancelled = false;
  const dlg = progressDialog(`Slicing ${layers} layers`, { onCancel: () => {
    cancelled = true;
    // terminate() never answers pending calls; reject them so slice() finishes and releases its buffers
    for (const w of sliceWorkers || []) { w.terminate(); for (const p of w.pending.values()) p.reject(new Error('cancelled')); w.pending.clear(); }
    sliceWorkers = null;
    setStatus('Slicing cancelled');
  } });
  const t0 = performance.now();
  setStatus(`Slicing ${layers} layers on ${threads} thread${threads > 1 ? 's' : ''}`, true);
  try {
    const jobs = [];
    for (let k = 0; k < threads; k++) {
      const from = k * per, to = Math.min(layers, from + per);
      if (from >= to) break;
      const cfg = { machine: { resX: machine.resX, resY: machine.resY, width: machine.width, depth: machine.depth, mirrorX: !!machine.mirrorX, mirrorY: !!machine.mirrorY }, aa: +state.print.aa || 1, layerHeight: lh, solids: allSolids, negatives: allNeg, hollows, detectIslands: !!state.print.detectIslands };
      jobs.push(call(sliceWorkers[k], { cfg, from, to }, [], (m) => { done[k] = m.progress; const n = done.reduce((a, b) => a + b, 0); dlg.set(n / layers, `${n} of ${layers} layers`); }));
    }
    const results = (await Promise.all(jobs)).sort((a, b) => a.from - b.from);
    if (cancelled) return;
    const rles = results.flatMap((r) => r.rles), stats = results.flatMap((r) => r.stats);
    const area = pxArea();
    let mm3 = 0;
    const islands = [];
    stats.forEach((s, i) => { mm3 += s.lit * area * lh; for (const is of s.islands) islands.push({ layer: i, ...is }); });
    const totalSeconds = estimatePrintTime(state.print, layers, machine.tiltSeconds);
    dlg.set(1, 'Rendering thumbnails');
    await new Promise((r) => setTimeout(r, 20));
    if (cancelled) return;
    const big = rgbaToRgb565(viewport.snapshot(290), 290, 290);
    const small = rgbaToRgb565(viewport.snapshot(116), 116, 116);
    const name = (objects[0].name || 'print').replace(/[^\w\- ]+/g, '_').slice(0, 40);
    sliced = { layers: rles, stats, islands, layerHeight: lh, layerCount: layers, volumeMm3: mm3, totalSeconds, previewBig: big, previewSmall: small, print: { ...state.print }, machine: { ...machine }, name: `${name}_${machine.id}_${fmtTime(totalSeconds).replace(/\s+/g, '')}`, size: HEADER_SIZE + rles.reduce((a, r) => a + r.length + LAYER_DEF_SIZE + 2, 0) + 11 };
    const ms = performance.now() - t0;
    setStatus(`Sliced ${layers} layers in ${(ms / 1000).toFixed(1)} s`);
    toast(`Sliced ${layers} layers in ${(ms / 1000).toFixed(1)} s${islands.length ? ` — ${islands.length} island${islands.length > 1 ? 's' : ''} found` : ''}`, islands.length ? 'error' : 'ok');
    $('#mode-preview').disabled = false;
    setMode('preview');
  } catch (e) {
    if (!cancelled) { toast(`Slicing failed: ${e.message}`, 'error'); setStatus('Ready'); }
  } finally {
    dlg.close();
  }
}
$('#btn-slice').addEventListener('click', slice);

function gooBlob() {
  if (!sliced) return null;
  if (sliced.fromFile) return sliced.blob;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const p = sliced.print, m = sliced.machine, r = state.resin;
  const grams = (sliced.volumeMm3 / 1000) * r.density;
  const header = {
    softwareName: 'Vatworks', softwareVersion: VERSION, fileTime: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    machineName: m.gooName, machineType: m.gooType, profileName: r.name, aaLevel: +p.aa || 1, greyLevel: 1, blurLevel: 0,
    previewSmall: sliced.previewSmall, previewBig: sliced.previewBig,
    resolutionX: m.resX, resolutionY: m.resY, mirrorX: m.mirrorX ? 1 : 0, mirrorY: m.mirrorY ? 1 : 0, displayWidth: m.width, displayHeight: m.depth, machineZ: m.height,
    printTime: Math.round(sliced.totalSeconds), volume: sliced.volumeMm3, materialGrams: grams, materialCost: (grams / 1000) * r.pricePerKg, currency: state.currency,
  };
  return new Blob(assembleGoo(header, p, sliced.layers, m.height), { type: 'application/octet-stream' });
}

const desktop = window.vatworksDesktop || null;
async function saveGoo() {
  const blob = gooBlob();
  if (!blob) return;
  if (desktop) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const saved = await desktop.saveGoo(`${sliced.name}.goo`, buf);
    if (saved) {
      const t = toast(`Saved ${saved.split('/').pop()}`, 'ok', 8000);
      t.append(el('button', { class: 'btn small', style: 'margin-left:6px', onclick: () => desktop.reveal(saved) }, 'Show in Finder'));
    }
    return;
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: `${sliced.name}.goo` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$('#btn-download').addEventListener('click', saveGoo);

// ---------------------------------------------------------------- preview
function setMode(m) {
  mode = m;
  const preview = m === 'preview';
  $('#mode-prepare').setAttribute('aria-pressed', String(!preview));
  $('#mode-preview').setAttribute('aria-pressed', String(preview));
  $('#left-prepare').hidden = preview;
  $('#left-preview').hidden = !preview;
  $('#right-prepare').hidden = preview;
  $('#right-preview').hidden = !preview;
  $('#layer-nav').hidden = !preview;
  $('#btn-3d').hidden = !preview;
  $('#btn-xray').hidden = preview;
  if (preview) {
    maskView.setMachine(sliced.machine);
    viewport.select(null);
    viewport.gizmoHelper.visible = false;
    applyPreviewView();
    const n = sliced.layerCount;
    $('#layer-range').max = n - 1;
    $('#layer-num').max = n;
    showLayer(n - 1);
    refreshSummary();
  } else {
    $('#viewport').hidden = false;
    $('#mask').hidden = true;
    viewport.setClip(null);
    viewport.select(selectedId);
    viewport.resize();
  }
}
function applyPreviewView() {
  $('#viewport').hidden = !show3d;
  $('#mask').hidden = show3d;
  $('#btn-3d').setAttribute('aria-pressed', String(show3d));
  if (show3d) viewport.resize(); else maskView.resize();
}
$('#btn-3d').addEventListener('click', () => { show3d = !show3d; applyPreviewView(); showLayer(currentLayer); });
$('#mode-prepare').addEventListener('click', () => setMode('prepare'));
$('#mode-preview').addEventListener('click', () => { if (sliced) setMode('preview'); });
$('#btn-back').addEventListener('click', () => setMode('prepare'));

function layerLit(i) {
  const s = sliced.stats[i];
  if (s.lit != null) return s.lit;
  let lit = 0;
  decodeRuns(sliced.layers[i], (g, l) => { if (g) lit += (g / 255) * l; }, false);
  s.lit = lit;
  return lit;
}

function showLayer(i) {
  if (!sliced) return;
  i = Math.max(0, Math.min(sliced.layerCount - 1, i | 0));
  currentLayer = i;
  const z = (i + 1) * sliced.layerHeight;
  const islands = sliced.stats[i].islands || [];
  maskView.setLayer(sliced.layers[i], islands, `Layer ${i + 1} of ${sliced.layerCount} · z = ${z.toFixed(3)} mm`);
  viewport.setClip(z + 1e-3);
  $('#layer-range').value = i;
  $('#layer-num').value = i + 1;
  $('#layer-z').textContent = `${z.toFixed(2)} mm`;
  const exp = exposureForLayer(sliced.print, i);
  const litMm2 = layerLit(i) * ((sliced.machine.width / sliced.machine.resX) * (sliced.machine.depth / sliced.machine.resY));
  $('#layer-stats').replaceChildren(stat('Height', `${z.toFixed(3)} mm`), stat('Exposure', `${fmt(exp, 2)} s`), stat('Lit area', `${fmt(litMm2, 1)} mm²`), stat('Islands here', String(islands.length)));
}
$('#layer-range').addEventListener('input', (e) => showLayer(+e.target.value));
$('#layer-num').addEventListener('change', (e) => showLayer(+e.target.value - 1));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (mode === 'preview') {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { showLayer(currentLayer + step); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { showLayer(currentLayer - step); e.preventDefault(); }
    if (e.key === 'PageUp') { showLayer(currentLayer + 25); e.preventDefault(); }
    if (e.key === 'PageDown') { showLayer(currentLayer - 25); e.preventDefault(); }
    if (e.key === 'Home') showLayer(0);
    if (e.key === 'End') showLayer(sliced.layerCount - 1);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId) removeObject(selectedId); }
  if (e.key === 'Escape') select(null);
  if (e.key === 'm') setTool('move');
  if (e.key === 'r') setTool('rotate');
  if (e.key === 's') setTool('scale');
  if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateSelected(); }
});

function refreshSummary() {
  const s = sliced;
  const r = state.resin;
  const ml = s.volumeMm3 / 1000, grams = ml * r.density, cost = (grams / 1000) * r.pricePerKg;
  $('#summary-stats').replaceChildren(
    stat('Print time', fmtTime(s.totalSeconds)), stat('Layers', `${s.layerCount} × ${s.layerHeight} mm`),
    stat('Resin', `${fmt(ml, 1)} mL · ${fmt(grams, 0)} g`), stat('Cost', `${state.currency}${fmt(cost, 2)}`),
    stat('Height', `${fmt(s.layerCount * s.layerHeight, 2)} mm`), stat('Islands', String(s.islands?.length ?? '–')));
  const note = $('#summary-note');
  if (s.fromFile) note.textContent = `Opened from ${s.fileName}. Sliced by ${s.header.softwareName || 'unknown software'} for ${s.header.machineName || 'an unknown printer'}.`;
  else if (s.islands.length) { note.className = 'callout warn'; note.textContent = `${s.islands.length} island${s.islands.length > 1 ? 's' : ''} found. Add supports under them (Support tool) or they will detach and float in the vat.`; }
  else { note.className = 'callout ok'; note.textContent = 'No islands. Print time assumes the lift settings on the Print tab; the printer decides the real pace.'; }
  const kv = $('#file-kv');
  const rows = [['Format', 'Elegoo .goo v3.0'], ['Printer', s.machine?.gooName || s.header?.machineName], ['Resolution', `${s.machine?.resX || s.header?.resolutionX} × ${s.machine?.resY || s.header?.resolutionY}`], ['Size', fmtBytes(s.size)], ['Exposure', `${s.print.exposureTime} s (bottom ${s.print.bottomExposureTime} s × ${s.print.bottomLayerCount})`], ['Release', s.fromFile ? `lift ${fmt(s.print.liftHeight, 2)} mm @ ${fmt(s.print.liftSpeed, 1)}` : RELEASE_PRESETS[s.print.releasePreset]?.label]];
  kv.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v ?? '–'))]));
  const list = $('#issue-list');
  const islands = s.islands || [];
  list.replaceChildren(...islands.slice(0, 200).map((is) => el('li', { onclick: () => showLayer(is.layer) }, el('span', { class: 'sw' }), `Layer ${is.layer + 1} · ${fmt(is.area, 1)} mm² at (${fmt(is.x, 1)}, ${fmt(is.y, 1)})`)));
  $('#issue-none').hidden = islands.length > 0;
  $('#issue-count').textContent = islands.length ? String(islands.length) : '';
}

// ---------------------------------------------------------------- files
$('#btn-open').addEventListener('click', async () => {
  if (!desktop) return $('#file-input').click();
  const files = await desktop.openModels();
  openFiles(files.map((f) => new File([f.data], f.name)));
});
$('#file-input').addEventListener('change', (e) => { openFiles([...e.target.files]); e.target.value = ''; });
const dz = $('#dropzone');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('show'); });
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('show'); } });
document.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; dz.classList.remove('show'); openFiles([...e.dataTransfer.files]); });

async function openFiles(files) {
  for (const f of files) {
    if (/\.goo$/i.test(f.name)) { await openGoo(f); continue; }
    setStatus(`Reading ${f.name}`, true);
    try {
      const buffer = await f.arrayBuffer();
      const r = await call(loadWorker, { name: f.name, buffer }, [buffer]);
      if (!r.ok) throw new Error(r.error);
      for (const w of r.warnings) toast(w, 'error');
      if (mode === 'preview') setMode('prepare');
      addObject(f.name.replace(/\.[^.]+$/, ''), r.positions);
      setStatus(`${f.name}: ${(r.positions.length / 9).toLocaleString()} triangles`);
    } catch (e) {
      toast(`${f.name}: ${e.message}`, 'error');
      setStatus('Ready');
    }
  }
}

function headerToPrint(h, base = DEFAULT_PRINT) {
  const p = { ...base };
  for (const k of ['layerHeight', 'exposureTime', 'bottomExposureTime', 'bottomLayerCount', 'transitionLayerCount', 'delayMode', 'lightOffDelay', 'bottomWaitAfterCure', 'bottomWaitAfterLift', 'bottomWaitBeforeCure', 'waitAfterCure', 'waitAfterLift', 'waitBeforeCure',
    'bottomLiftHeight', 'bottomLiftSpeed', 'liftHeight', 'liftSpeed', 'bottomRetractHeight', 'bottomRetractSpeed', 'retractHeight', 'retractSpeed', 'bottomLiftHeight2', 'bottomLiftSpeed2', 'liftHeight2', 'liftSpeed2', 'bottomRetractHeight2', 'bottomRetractSpeed2', 'retractHeight2', 'retractSpeed2', 'bottomLightPWM', 'lightPWM']) {
    if (Number.isFinite(h[k])) p[k] = Math.round(h[k] * 1000) / 1000;
  }
  p.releasePreset = 'custom';
  return p;
}

async function importGooSettings(file) {
  try {
    const { header } = parseGoo(await file.arrayBuffer());
    const p = headerToPrint(header, state.print); // keep slicer-only options such as anti-aliasing
    if (!(await confirmDialog({ title: `Use settings from ${file.name}?`, body: `Sliced by ${header.softwareName || 'unknown software'} for ${header.machineName || 'an unknown printer'}: ${p.layerHeight} mm layers, ${p.exposureTime} s exposure, ${p.bottomExposureTime} s × ${p.bottomLayerCount} bottom layers, lift ${p.liftHeight} mm at ${p.liftSpeed} mm/min. This replaces your Print tab values.`, ok: 'Use these settings' }))) return;
    Object.assign(state.print, p);
    buildPrintTab();
    saveState(state);
    markStale();
    toast('Print settings imported', 'ok');
  } catch (e) { toast(`Could not read ${file.name}: ${e.message}`, 'error'); }
}

async function openGoo(file) {
  setStatus(`Reading ${file.name}`, true);
  try {
    const buffer = await file.arrayBuffer();
    const { header, layers } = parseGoo(buffer);
    const print = headerToPrint(header);
    sliced = {
      fromFile: true, fileName: file.name, blob: file, header, layers: layers.map((l) => l.rle), stats: layers.map(() => ({ lit: null, islands: [] })), islands: [],
      layerHeight: print.layerHeight, layerCount: header.layerCount, volumeMm3: header.volume, totalSeconds: header.printTime, print, size: buffer.byteLength,
      machine: { gooName: header.machineName, resX: header.resolutionX, resY: header.resolutionY, width: header.displayWidth, depth: header.displayHeight, height: header.machineZ, mirrorX: !!header.mirrorX, mirrorY: !!header.mirrorY },
      name: file.name.replace(/\.goo$/i, ''),
    };
    maskView.setMachine(sliced.machine);
    $('#mode-preview').disabled = false;
    setMode('preview');
    setStatus(`${file.name}: ${header.layerCount} layers, ${header.machineName}`);
    toast(`Previewing ${file.name}. Use the Print tab’s “Import settings” to copy its parameters.`);
  } catch (e) { toast(`Could not open ${file.name}: ${e.message}`, 'error'); setStatus('Ready'); }
}

// ---------------------------------------------------------------- printer
const pp = { pop: $('#printer-pop'), ip: $('#printer-ip'), kv: $('#printer-kv'), files: $('#printer-filelist'), found: $('#printer-found'), pill: $('#printer-pill'), pillText: $('#printer-pill-text') };
pp.ip.value = state.printerIp || '';
$('#printer-pill').addEventListener('click', () => { pp.pop.hidden = !pp.pop.hidden; if (!pp.pop.hidden) pp.ip.focus(); });
$('#printer-close').addEventListener('click', () => { pp.pop.hidden = true; });
document.addEventListener('click', (e) => { if (!pp.pop.hidden && !pp.pop.contains(e.target) && !pp.pill.contains(e.target)) pp.pop.hidden = true; });
pp.ip.addEventListener('change', () => { state.printerIp = pp.ip.value.trim(); saveState(state); });
const STATUS_TEXT = { 0: 'Idle', 1: 'Printing', 2: 'Receiving a file', 3: 'Exposure test', 4: 'Self-check' };
const PRINT_TEXT = { 0: 'idle', 1: 'homing', 2: 'lowering', 3: 'exposing', 4: 'lifting', 5: 'pausing', 6: 'paused', 7: 'stopping', 8: 'stopped', 9: 'complete', 10: 'checking file' };
let printerInfo = null;

function setPill(stateName, text) { pp.pill.dataset.state = stateName; pp.pillText.textContent = text; }

async function connectPrinter() {
  const ip = pp.ip.value.trim();
  if (!ip) return toast('Enter the printer’s IP address (Settings → Device info on the touchscreen).');
  state.printerIp = ip;
  saveState(state);
  setPill('offline', 'Connecting…');
  pp.kv.replaceChildren();
  try {
    printerInfo = await printerApi.info(ip);
    const d = printerInfo.discovery || {}, a = printerInfo.attributes || {}, s = printerInfo.status || {};
    const cur = Array.isArray(s.CurrentStatus) ? s.CurrentStatus[0] : s.CurrentStatus;
    const statusText = STATUS_TEXT[cur] ?? 'Online';
    const pi = s.PrintInfo || {};
    setPill(cur === 1 ? 'printing' : 'online', `${d.model || a.MachineName || 'Printer'} · ${statusText}${cur === 1 && pi.TotalLayer ? ` ${pi.CurrentLayer}/${pi.TotalLayer}` : ''}`);
    const rows = [['Name', d.name || a.Name], ['Model', d.model || a.MachineName], ['Firmware', d.firmware || a.FirmwareVersion], ['Protocol', d.protocol || a.ProtocolVersion], ['Resolution', a.Resolution], ['Build volume', a.XYZsize], ['Accepts', (a.SupportFileType || []).join(', ')], ['Status', `${statusText}${pi.Status != null ? ` (${PRINT_TEXT[pi.Status] || pi.Status})` : ''}`], ['Current file', pi.Filename], ['UV LED', s.TempOfUVLED != null ? `${s.TempOfUVLED} °C` : null], ['Enclosure', s.TempOfBox != null ? `${s.TempOfBox} °C` : null]].filter(([, v]) => v != null && v !== '');
    pp.kv.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]));
    if (a.SupportFileType && !a.SupportFileType.some((t) => /goo/i.test(t))) toast(`This printer lists ${a.SupportFileType.join(', ')} as its file types, not GOO. Check before printing.`, 'error', 8000);
    listPrinterFiles().catch(() => {});
  } catch (e) {
    printerInfo = null;
    setPill('error', 'Printer unreachable');
    toast(e.message, 'error', 8000);
  }
}
async function listPrinterFiles() {
  const ip = pp.ip.value.trim();
  if (!ip) return;
  const r = await printerApi.files(ip);
  const files = (r.Data?.FileList || []).filter((f) => f.type === 1);
  pp.files.replaceChildren(...(files.length ? files.map((f) => el('li', {}, el('span', { title: f.name }, f.name.replace(/^\/local\//, '')), el('button', { class: 'btn small', onclick: () => startPrint(f.name) }, 'Print'))) : [el('li', {}, el('span', {}, 'No printable files on the printer'))]));
}
async function startPrint(filename) {
  const ip = pp.ip.value.trim();
  if (!(await confirmDialog({ title: 'Start printing?', body: `The printer at ${ip} will start ${filename} now. Make sure the vat has resin and the plate is clean and level.`, ok: 'Start print' }))) return;
  try {
    const r = await printerApi.print(ip, filename.replace(/^\/local\//, ''));
    const ack = r.Data?.Ack;
    if (ack === 0) toast('Print started', 'ok');
    else toast(`Printer answered ${({ 1: 'busy', 2: 'file not found', 3: 'MD5 check failed', 4: 'file read failed', 5: 'resolution mismatch', 6: 'unknown format', 7: 'wrong machine model' })[ack] || `code ${ack}`}`, 'error', 8000);
    setTimeout(connectPrinter, 1500);
  } catch (e) { toast(e.message, 'error'); }
}
$('#printer-connect').addEventListener('click', connectPrinter);
$('#printer-files').addEventListener('click', () => listPrinterFiles().catch((e) => toast(e.message, 'error')));
$('#printer-discover').addEventListener('click', async () => {
  pp.found.textContent = 'Listening for printers (3 s)…';
  try {
    const r = await printerApi.discover(pp.ip.value.trim() || undefined);
    if (!r.printers.length) { pp.found.textContent = 'No printers answered. They must be on the same network as the Vatworks server.'; return; }
    pp.found.replaceChildren(...r.printers.map((p) => el('button', { class: 'btn small', style: 'margin:2px 4px 2px 0', onclick: () => { pp.ip.value = p.ip; pp.ip.dispatchEvent(new Event('change')); connectPrinter(); } }, `${p.model || p.name} — ${p.ip}`)));
  } catch (e) { pp.found.textContent = e.message; }
});

$('#btn-send').addEventListener('click', async () => {
  const blob = gooBlob();
  if (!blob) return;
  const ip = pp.ip.value.trim();
  if (!ip) { pp.pop.hidden = false; pp.ip.focus(); return toast('Set the printer address first'); }
  const startAfter = el('input', { type: 'checkbox', id: 'start-after' });
  const back = el('div', { class: 'modal-back' });
  const filename = `${sliced.name}.goo`;
  const choice = await new Promise((resolve) => {
    back.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, el('h2', {}, 'Send to printer'),
      el('p', {}, `${filename} (${fmtBytes(blob.size)}) will be uploaded to the printer at ${ip}.`),
      el('div', { class: 'body' }, el('label', { class: 'row' }, startAfter, el('span', {}, 'Start printing as soon as the upload finishes'))),
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => resolve(false) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => resolve(true) }, 'Upload'))));
    document.body.append(back);
  });
  back.remove();
  if (!choice) return;
  const dlg = progressDialog(`Uploading ${filename}`);
  try {
    const last = await printerApi.upload(ip, blob, filename, startAfter.checked, (l) => {
      if (l.stage === 'upload') dlg.set(l.sent / l.total, `${fmtBytes(l.sent)} of ${fmtBytes(l.total)} sent to the printer`);
      else if (l.stage === 'received') dlg.set(0, 'File received by the server, contacting the printer');
      else if (l.stage === 'uploaded') dlg.set(1, 'Upload complete; the printer is checking the file');
    });
    const ack = last?.ack?.Data?.Ack;
    if (startAfter.checked) toast(ack === 0 ? 'Uploaded and printing' : `Uploaded, but the printer answered code ${ack ?? '?'} when asked to print`, ack === 0 ? 'ok' : 'error', 8000);
    else toast('Uploaded. Start it from the printer’s screen or from the printer panel here.', 'ok', 8000);
    listPrinterFiles().catch(() => {});
  } catch (e) { toast(`Upload failed: ${e.message}`, 'error', 9000); } finally { dlg.close(); }
});

// ---------------------------------------------------------------- drawers (narrow screens)
$('#btn-left').addEventListener('click', () => { $('#left-panel').classList.toggle('open'); $('#right-panel').classList.remove('open'); });
$('#btn-right').addEventListener('click', () => { $('#right-panel').classList.toggle('open'); $('#left-panel').classList.remove('open'); });

// ---------------------------------------------------------------- desktop app (Electron) integration
if (desktop) {
  document.body.classList.add('desktop', `platform-${desktop.platform}`);
  $('#btn-download').textContent = 'Save .goo…';
  desktop.onFilesOpened((files) => openFiles(files.map((f) => new File([f.data], f.name))));
  desktop.onMenu((action) => {
    if (action === 'save') { if (sliced) saveGoo(); else toast('Slice first, then save the .goo'); }
    else if (action === 'slice') { if (objects.length) slice(); }
    else if (action === 'send') { if (sliced) $('#btn-send').click(); else toast('Slice first, then send to the printer'); }
    else if (action === 'prepare') setMode('prepare');
    else if (action === 'preview') { if (sliced) setMode('preview'); }
    else if (action === 'fit') $('#btn-fit').click();
    else if (action === 'xray') toggleXray();
  });
  desktop.ready();
}

// ---------------------------------------------------------------- boot
buildPrintTab();
buildResinTab();
buildSupportsTab();
buildHollowTab();
applyMachine();
setTool('move');
refreshObjects();
refreshTransformCard();
if (state.printerIp) setPill('offline', `${state.printerIp} · not connected`);
setStatus('Ready — open a model or drop one onto the vat');

// test hooks (also handy in the browser console)
window.vatworks = {
  state, objects, get sliced() { return sliced; }, addObject, slice, gooBlob, generateSupports, hollowObject, setMode, showLayer, arrangeAll, autoOrient, select, viewport, get machine() { return machine; },
  addHoleAt: (id, p, n) => { const o = byId(id); if (o) addHole(o, { point: new THREE.Vector3(...p), normal: new THREE.Vector3(...n) }); },
};
