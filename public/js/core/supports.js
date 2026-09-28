// Support generation for MSLA printing. Works on a world-space triangle soup (mm, Z up, plate at z = 0).
import { TriSink, VerticalRayGrid, weld, frustum, sphere, convexHull2D } from './geom.js';

export const SUPPORT_PRESETS = {
  light: { tipDiameter: 0.3, pillarDiameter: 0.8, tipLength: 2.0, contactDepth: 0.15, baseDiameter: 3.0 },
  medium: { tipDiameter: 0.45, pillarDiameter: 1.0, tipLength: 2.5, contactDepth: 0.25, baseDiameter: 4.0 },
  heavy: { tipDiameter: 0.7, pillarDiameter: 1.3, tipLength: 3.0, contactDepth: 0.4, baseDiameter: 5.0 },
};

export const SUPPORT_DEFAULTS = {
  ...SUPPORT_PRESETS.medium,
  preset: 'medium',
  spacing: 3.0, // mm between contact points on overhanging faces
  overhangAngle: 45, // faces within this many degrees of facing straight down get supported
  maxTipAngle: 50, // tip may lean at most this far from vertical
  plateOnly: false, // refuse supports that would have to stand on the model
  bracing: true,
  raft: true,
  raftThickness: 1.2,
  raftMargin: 2.5,
  footHeight: 1.0,
  minHeight: 0.35, // ignore overhangs closer than this to the plate
};

/**
 * Finds contact points that need support. Returns [{p:[x,y,z], n:[nx,ny,nz], kind:'min'|'face'}].
 */
export function findContactPoints(tris, opt) {
  const T = tris.length / 9;
  const cosLimit = Math.cos((opt.overhangAngle * Math.PI) / 180);
  const s = opt.spacing;
  const pts = [];

  // 1. local minima of the surface ("islands" as the print grows). These are mandatory.
  const { index, verts, count } = weld(tris);
  const lowestNeighbour = new Float32Array(count).fill(Infinity);
  const nrm = new Float32Array(count * 3);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k];
      nrm[a * 3] += nx; nrm[a * 3 + 1] += ny; nrm[a * 3 + 2] += nz;
      for (let m = 1; m < 3; m++) {
        const bz = verts[index[t * 3 + ((k + m) % 3)] * 3 + 2];
        if (bz < lowestNeighbour[a]) lowestNeighbour[a] = bz;
      }
    }
  }
  // a flat underside is one minimum, not one per vertex: group level-connected minima and keep one per group
  // (the lattice below covers the rest of a large flat face)
  const group = new Int32Array(count).map((_, i) => i);
  const find = (a) => { while (group[a] !== a) a = group[a] = group[group[a]]; return a; };
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)];
      if (Math.abs(verts[a * 3 + 2] - verts[b * 3 + 2]) <= 1e-5) group[find(a)] = find(b);
    }
  }
  const taken = new Set();
  for (let v = 0; v < count; v++) {
    const z = verts[v * 3 + 2];
    if (z < opt.minHeight) continue;
    if (lowestNeighbour[v] < z - 1e-5) continue; // something lower is attached: not a minimum
    const g = find(v);
    if (taken.has(g)) continue;
    let nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nz > -0.05) continue; // vertex normal faces up/sideways: it's the bottom of a pit, not of the part
    taken.add(g);
    pts.push({ p: [verts[v * 3], verts[v * 3 + 1], z], n: [nx, ny, nz], kind: 'min' });
  }

  // 2. lattice samples on overhanging faces (a global lattice keeps density even across triangles)
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz);
    if (l === 0) continue;
    nx /= l; ny /= l; nz /= l;
    if (nz > -cosLimit) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (d === 0) continue;
    const minX = Math.min(ax, bx, cx) / s, maxX = Math.max(ax, bx, cx) / s;
    const y0 = Math.ceil(Math.min(ay, by, cy) / s), y1 = Math.floor(Math.max(ay, by, cy) / s);
    for (let gy = y0; gy <= y1; gy++) {
      // stagger alternate rows for a hexagonal-ish pattern (odd rows sit half a step over, so shift their range too)
      const off = gy & 1 ? 0.5 : 0;
      for (let gx = Math.ceil(minX - off), x1 = Math.floor(maxX - off); gx <= x1; gx++) {
        const x = (gx + off) * s, y = gy * s;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        if (z < opt.minHeight) continue;
        pts.push({ p: [x, y, z], n: [nx, ny, nz], kind: 'face' });
      }
    }
  }

  // 3. thin out: minima first, then lowest first, enforcing a minimum distance
  pts.sort((a, b) => (a.kind === b.kind ? a.p[2] - b.p[2] : a.kind === 'min' ? -1 : 1));
  const minDist = s * 0.55, cell = minDist;
  const hash = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  const kept = [];
  for (const c of pts) {
    const i = Math.floor(c.p[0] / cell), j = Math.floor(c.p[1] / cell), k = Math.floor(c.p[2] / cell);
    let ok = true;
    for (let di = -1; di <= 1 && ok; di++)
      for (let dj = -1; dj <= 1 && ok; dj++)
        for (let dk = -1; dk <= 1 && ok; dk++) {
          const list = hash.get(key(i + di, j + dj, k + dk));
          if (!list) continue;
          for (const q of list) {
            if (Math.hypot(q.p[0] - c.p[0], q.p[1] - c.p[1], q.p[2] - c.p[2]) < minDist) {
              ok = false;
              break;
            }
          }
        }
    if (!ok) continue;
    kept.push(c);
    const kk = key(i, j, k);
    if (!hash.has(kk)) hash.set(kk, []);
    hash.get(kk).push(c);
  }
  return kept;
}

const DODGE_DIRS = Array.from({ length: 12 }, (_, i) => [Math.cos((i * Math.PI) / 6), Math.sin((i * Math.PI) / 6)]);

/**
 * Plans one support: tip direction, joint, where the pillar lands. Returns null when it cannot be built.
 * grid: VerticalRayGrid over the model (world space).
 */
export function planSupport(contact, grid, opt) {
  const [px, py, pz] = contact.p;
  let [nx, ny, nz] = contact.n;
  if (nz > -0.02) {
    // side or top face picked manually: approach from below anyway
    nx *= 0.5; ny *= 0.5; nz = -Math.max(0.35, Math.abs(nz));
  }
  let l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  // limit the lean of the tip
  const maxA = (opt.maxTipAngle * Math.PI) / 180;
  const ang = Math.acos(Math.min(1, -nz));
  let dx = nx, dy = ny, dz = nz;
  if (ang > maxA) {
    const hl = Math.hypot(nx, ny) || 1;
    dx = (nx / hl) * Math.sin(maxA);
    dy = (ny / hl) * Math.sin(maxA);
    dz = -Math.cos(maxA);
  }
  const floorZ = opt.raft ? opt.raftThickness : 0;
  const tipLen = Math.min(opt.tipLength, Math.max(0.6, (pz - floorZ) * 0.8));
  const E = [px - dx * opt.contactDepth, py - dy * opt.contactDepth, pz - dz * opt.contactDepth];
  let J = [px + dx * tipLen, py + dy * tipLen, pz + dz * tipLen];
  if (J[2] < floorZ + 0.2) J[2] = floorZ + 0.2;
  if (J[2] >= pz - 0.05) return null; // contact sits at or below the raft/plate: no room for a tip (raise the model)

  // a drop is usable when the pillar (centre + its rim) is outside the model and sees nothing below but the plate
  const rim = opt.pillarDiameter / 2 + 0.15;
  const RIM = [[0, 0], [rim, 0], [-rim, 0], [0, rim], [0, -rim]];
  const clear = (x, y, z) =>
    RIM.every(([ox, oy]) => !grid.inside(x + ox, y + oy, z) && grid.castDown(x + ox, y + oy, z - 0.02) <= 0.02);
  if (clear(J[0], J[1], J[2])) {
    return { E, J, base: [J[0], J[1], floorZ], onModel: false, contact };
  }
  // dodge sideways: slope the link ~50 degrees from vertical until a clear drop is found
  for (const m of [1.5, 3, 5, 8]) {
    for (const [ux, uy] of DODGE_DIRS) {
      const x = J[0] + ux * m, y = J[1] + uy * m, z = J[2] - m * 0.85;
      if (z < floorZ + 0.5) continue;
      if (grid.inside(x, y, z) || grid.inside((x + J[0]) / 2, (y + J[1]) / 2, (z + J[2]) / 2)) continue;
      if (!clear(x, y, z)) continue;
      return { E, J, K: [x, y, z], base: [x, y, floorZ], onModel: false, contact };
    }
  }
  if (opt.plateOnly) return null;
  const hit = grid.castDown(J[0], J[1], J[2] - 0.02);
  if (!(hit > 0.02) || J[2] - hit < 0.8) return null;
  return { E, J, base: [J[0], J[1], hit], onModel: true, contact };
}

/** Emits the solid for one planned support. */
export function buildSupport(sink, plan, opt) {
  const rt = opt.tipDiameter / 2, rp = opt.pillarDiameter / 2;
  const { E, J, K, base } = plan;
  frustum(sink, E, J, rt, rp * 0.85, 10);
  sphere(sink, J, rp, 10, 6);
  let top = J;
  if (K) {
    frustum(sink, J, K, rp * 0.9, rp, 10);
    sphere(sink, K, rp, 10, 6);
    top = K;
  }
  if (plan.onModel) {
    // stand on the model: pillar, then a short inverted tip that bites into the surface below
    const tl = Math.min(opt.tipLength * 0.6, (top[2] - base[2]) * 0.5);
    const mid = [base[0], base[1], base[2] + tl];
    if (top[2] - mid[2] > 0.05) frustum(sink, mid, top, rp, rp, 10);
    frustum(sink, [base[0], base[1], base[2] - opt.contactDepth], mid, rt * 1.2, rp, 10);
  } else {
    const fh = Math.min(opt.footHeight, Math.max(0.2, top[2] - base[2] - 0.1));
    const foot = [base[0], base[1], base[2] + fh];
    frustum(sink, base, foot, opt.baseDiameter / 2, rp, 14);
    if (top[2] - foot[2] > 0.02) frustum(sink, foot, top, rp, rp, 10);
  }
}

/** Zig-zag braces between neighbouring tall pillars that stand on the plate. */
export function buildBracing(sink, plans, grid, opt) {
  const pillars = plans
    .filter((p) => !p.onModel)
    .map((p) => ({ x: p.base[0], y: p.base[1], z0: p.base[2] + opt.footHeight, z1: (p.K || p.J)[2] }))
    .filter((p) => p.z1 - p.z0 > 10);
  const done = new Set();
  const r = Math.max(0.3, opt.pillarDiameter * 0.35);
  let braces = 0;
  pillars.forEach((a, ia) => {
    const near = pillars
      .map((b, ib) => ({ b, ib, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((o) => o.ib !== ia && o.d > 1.5 && o.d < 14)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2);
    for (const { b, ib, d } of near) {
      const k = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
      if (done.has(k)) continue;
      done.add(k);
      const step = Math.min(12, Math.max(4, d));
      const zTop = Math.min(a.z1, b.z1) - 1;
      let z = Math.max(a.z0, b.z0) + 2, flip = false;
      while (z + step <= zTop) {
        const P = flip ? [b.x, b.y, z] : [a.x, a.y, z];
        const Q = flip ? [a.x, a.y, z + step] : [b.x, b.y, z + step];
        let blocked = false;
        for (let s = 1; s < 6 && !blocked; s++) {
          const t = s / 6;
          blocked = grid.inside(P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, P[2] + (Q[2] - P[2]) * t);
        }
        if (!blocked) {
          frustum(sink, P, Q, r, r, 8);
          braces++;
        }
        z += step;
        flip = !flip;
      }
    }
  });
  return braces;
}

/** Chamfered convex raft under every plate-standing support. */
export function buildRaft(sink, plans, opt) {
  const feet = plans.filter((p) => !p.onModel).map((p) => p.base);
  if (!feet.length) return false;
  const R = opt.baseDiameter / 2 + opt.raftMargin;
  const h = opt.raftThickness;
  const inset = Math.min(h, R * 0.5);
  const ring = [];
  const N = 16;
  for (const f of feet) {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      ring.push([f[0] + R * Math.cos(a), f[1] + R * Math.sin(a), f[0], f[1], Math.cos(a), Math.sin(a)]);
    }
  }
  const hull = convexHull2D(ring).map((i) => ring[i]); // CCW
  const n = hull.length;
  if (n < 3) return false;
  const bot = hull.map((q) => [q[0], q[1], 0]);
  const top = hull.map((q) => [q[2] + (R - inset) * q[4], q[3] + (R - inset) * q[5], h]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sink.tri(...bot[i], ...bot[j], ...top[j]); // walls (outward for a CCW ring)
    sink.tri(...bot[i], ...top[j], ...top[i]);
    if (i > 0 && i < n - 1) {
      sink.tri(...bot[0], ...bot[j], ...bot[i]); // bottom faces -Z
      sink.tri(...top[0], ...top[i], ...top[j]); // top faces +Z
    }
  }
  return true;
}

/**
 * Full automatic pass. Returns { plans, skipped } — geometry is produced by buildAll so that manual edits
 * can reuse it.
 */
export function autoSupports(tris, opt, grid = new VerticalRayGrid(tris)) {
  const contacts = findContactPoints(tris, opt);
  const plans = [];
  let skipped = 0;
  for (const c of contacts) {
    const plan = planSupport(c, grid, opt);
    if (plan) plans.push(plan);
    else skipped++;
  }
  return { plans, skipped, grid };
}

/** Builds the support solid for a list of plans. ranges[i] = [firstTri, endTri) of plan i (for picking). */
export function buildAll(plans, grid, opt) {
  const sink = new TriSink(plans.length * 120 + 256);
  const ranges = [];
  for (const p of plans) {
    const a = sink.triCount;
    buildSupport(sink, p, opt);
    ranges.push([a, sink.triCount]);
  }
  if (opt.bracing && grid) buildBracing(sink, plans, grid, opt);
  if (opt.raft) buildRaft(sink, plans, opt);
  return { tris: sink.result(), ranges };
}
