// Mesh slicing + scanline rasterisation straight into GOO run-length data.
//
// A 16K layer is ~94 million pixels, so no bitmap is ever allocated. For every layer we:
//   1. intersect the active triangles with the slice plane -> oriented 2D segments,
//   2. bucket segment/scanline crossings per (sub-)scanline,
//   3. sweep each scanline with a winding rule -> spans,
//   4. turn span edges into sparse coverage events per pixel row -> gray runs -> RLE.
//
// Two segment classes exist: 0 = solid (models, supports, raft) filled where winding > 0,
// 1 = negative (hollow cavities, drain holes) which always subtracts.

const SUB = 256; // sub-pixel precision of crossing x positions

/** Growable buffer of oriented segments in millimetres. */
export class SegmentBuffer {
  constructor(cap = 4096) {
    this.xy = new Float64Array(cap * 4);
    this.cls = new Uint8Array(cap);
    this.n = 0;
  }
  clear() {
    this.n = 0;
  }
  push(x0, y0, x1, y1, cls) {
    if (this.n === this.cls.length) {
      const xy = new Float64Array(this.xy.length * 2);
      xy.set(this.xy);
      this.xy = xy;
      const c = new Uint8Array(this.cls.length * 2);
      c.set(this.cls);
      this.cls = c;
    }
    const o = this.n * 4;
    this.xy[o] = x0;
    this.xy[o + 1] = y0;
    this.xy[o + 2] = x1;
    this.xy[o + 3] = y1;
    this.cls[this.n++] = cls;
  }
}

/** Triangle soup (9 floats per triangle, world mm) prepared for fast repeated slicing. */
export class TriMesh {
  constructor(tris) {
    this.tris = tris;
    const T = (this.count = (tris.length / 9) | 0);
    const zmin = (this.zmin = new Float32Array(T));
    const zmax = (this.zmax = new Float32Array(T));
    let lo = Infinity, hi = -Infinity;
    for (let t = 0, o = 2; t < T; t++, o += 9) {
      const a = tris[o], b = tris[o + 3], c = tris[o + 6];
      const mn = a < b ? (a < c ? a : c) : b < c ? b : c;
      const mx = a > b ? (a > c ? a : c) : b > c ? b : c;
      zmin[t] = mn;
      zmax[t] = mx;
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }
    this.minZ = T ? lo : 0;
    this.maxZ = T ? hi : 0;
    const order = (this.order = new Uint32Array(T));
    for (let i = 0; i < T; i++) order[i] = i;
    order.sort((p, q) => zmin[p] - zmin[q]);
    this.active = new Uint32Array(1024);
    this.activeN = 0;
    this.ptr = 0;
    this.lastZ = -Infinity;
  }

  /** Positions the sweep at plane z. Cheap when z increases monotonically, full rebuild otherwise. */
  seek(z) {
    const { zmin, zmax, order } = this;
    const T = this.count;
    if (z < this.lastZ) {
      this.activeN = 0;
      this.ptr = 0;
    }
    this.lastZ = z;
    let n = 0;
    let act = this.active;
    for (let i = 0; i < this.activeN; i++) {
      const t = act[i];
      if (zmax[t] > z) act[n++] = t;
    }
    let p = this.ptr;
    while (p < T && zmin[order[p]] <= z) {
      const t = order[p++];
      if (zmax[t] > z) {
        if (n === act.length) {
          const bigger = new Uint32Array(act.length * 2);
          bigger.set(act);
          this.active = act = bigger;
        }
        act[n++] = t;
      }
    }
    this.ptr = p;
    this.activeN = n;
  }

  /**
   * Appends the oriented cross-section at z to `out`. A vertex counts as "above" when v.z > z, so every
   * straddling triangle yields exactly one segment and shared edges produce bit-identical end points.
   * Segments run counter-clockwise around solid material (material on their left, seen from +Z).
   */
  slice(z, out, cls) {
    this.seek(z);
    const tr = this.tris;
    const act = this.active;
    for (let i = 0; i < this.activeN; i++) {
      const o = act[i] * 9;
      const ax = tr[o], ay = tr[o + 1], az = tr[o + 2];
      const bx = tr[o + 3], by = tr[o + 4], bz = tr[o + 5];
      const cx = tr[o + 6], cy = tr[o + 7], cz = tr[o + 8];
      const A = az > z, B = bz > z, C = cz > z;
      let px, py, qx, qy, k = 0;
      // each crossing edge is evaluated from its lower vertex to its upper one (canonical on shared edges)
      if (A !== B) {
        const t = A ? (z - bz) / (az - bz) : (z - az) / (bz - az);
        const x = A ? bx + t * (ax - bx) : ax + t * (bx - ax);
        const y = A ? by + t * (ay - by) : ay + t * (by - ay);
        px = x; py = y; k = 1;
      }
      if (B !== C) {
        const t = B ? (z - cz) / (bz - cz) : (z - bz) / (cz - bz);
        const x = B ? cx + t * (bx - cx) : bx + t * (cx - bx);
        const y = B ? cy + t * (by - cy) : by + t * (cy - by);
        if (k === 0) { px = x; py = y; } else { qx = x; qy = y; }
        k++;
      }
      if (C !== A) {
        const t = C ? (z - az) / (cz - az) : (z - cz) / (az - cz);
        const x = C ? ax + t * (cx - ax) : cx + t * (ax - cx);
        const y = C ? ay + t * (cy - ay) : cy + t * (ay - cy);
        if (k === 0) { px = x; py = y; } else { qx = x; qy = y; }
        k++;
      }
      if (k !== 2) continue;
      // direction = z_hat x normal = (-ny, nx)
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if ((qx - px) * -ny + (qy - py) * nx < 0) out.push(qx, qy, px, py, cls);
      else out.push(px, py, qx, qy, cls);
    }
  }
}

/**
 * Maps plate millimetres to LCD pixels. Plate origin is its centre; image row 0 is the back edge (max Y),
 * then the optional LCD mirror flips are applied.
 */
export function plateTransform(m) {
  const pxX = m.resX / m.width; // px per mm
  const pxY = m.resY / m.depth;
  let ax = pxX, bx = m.resX / 2;
  let ay = -pxY, by = m.resY / 2;
  if (m.mirrorX) { ax = -ax; }
  if (m.mirrorY) { ay = -ay; }
  return { ax, bx, ay, by, orient: Math.sign(ax * ay) };
}

export class LayerRasterizer {
  /** machine: {resX,resY,width,depth,mirrorX,mirrorY}; aa: 1 (off), 2, 4 or 8 sub-scanlines per row. */
  constructor(machine, aa = 4) {
    this.m = machine;
    this.aa = Math.max(1, aa | 0);
    this.tf = plateTransform(machine);
    const W = machine.resX;
    this.D = new Float64Array(W + 2);
    this.stamp = new Int32Array(W + 2);
    this.rowStamp = 0;
    this.touched = new Int32Array(1024);
    this.cj = new Int32Array(1 << 14);
    this.ck = new Uint32Array(1 << 14);
    this.sorted = new Uint32Array(1 << 14);
    this.counts = new Uint32Array(machine.resY * this.aa + 1);
  }

  _growCrossings() {
    const cj = new Int32Array(this.cj.length * 2);
    cj.set(this.cj);
    this.cj = cj;
    const ck = new Uint32Array(this.ck.length * 2);
    ck.set(this.ck);
    this.ck = ck;
  }

  /**
   * Rasterises the segments into `rle` (an RleWriter). Optional onRun(row, x0, x1, gray) observes every lit run
   * (used for island detection). Returns the bounding box of lit pixels or null.
   */
  rasterize(segs, rle, onRun) {
    const { resX: W, resY: H } = this.m;
    const n = this.aa;
    const { ax, bx, ay, by, orient } = this.tf;
    const J = H * n;
    const counts = this.counts;
    counts.fill(0);
    let cn = 0;
    const xy = segs.xy, cls = segs.cls;

    // 1. crossings of every segment with every sub-scanline centre y = (j + 0.5) / n
    for (let s = 0, o = 0; s < segs.n; s++, o += 4) {
      const x0 = ax * xy[o] + bx, y0 = ay * xy[o + 1] + by;
      const x1 = ax * xy[o + 2] + bx, y1 = ay * xy[o + 3] + by;
      if (y0 === y1) continue;
      const up = y1 > y0;
      const ylo = up ? y0 : y1, yhi = up ? y1 : y0;
      let j0 = Math.ceil(ylo * n - 0.5), j1 = Math.ceil(yhi * n - 0.5) - 1;
      if (j0 < 0) j0 = 0;
      if (j1 >= J) j1 = J - 1;
      if (j1 < j0) continue;
      // CCW material-on-left: an edge heading down the (y-up) frame enters material. `orient` fixes flipped frames.
      const enters = (up ? -1 : 1) * orient > 0 ? 1 : 0;
      const tag = (cls[s] << 1) | enters;
      const slope = (x1 - x0) / (y1 - y0);
      while (cn + (j1 - j0 + 1) > this.cj.length) this._growCrossings();
      const cj = this.cj, ck = this.ck;
      for (let j = j0; j <= j1; j++) {
        let x = x0 + ((j + 0.5) / n - y0) * slope;
        if (x < 0) x = 0;
        else if (x > W) x = W;
        cj[cn] = j;
        ck[cn++] = (Math.round(x * SUB) << 3) | tag;
        counts[j]++;
      }
    }
    if (cn === 0) return null;

    // 2. counting sort by sub-scanline
    if (this.sorted.length < cn) this.sorted = new Uint32Array(this.cj.length);
    const sorted = this.sorted;
    let jMin = -1, jMax = -1, acc = 0;
    for (let j = 0; j < J; j++) {
      const c = counts[j];
      counts[j] = acc;
      if (c) {
        if (jMin < 0) jMin = j;
        jMax = j;
      }
      acc += c;
    }
    counts[J] = acc;
    {
      const cj = this.cj, ck = this.ck;
      // place using a moving cursor stored in `fill`
      const fill = this._fill && this._fill.length >= J ? this._fill : (this._fill = new Uint32Array(J));
      for (let j = jMin; j <= jMax; j++) fill[j] = counts[j];
      for (let i = 0; i < cn; i++) sorted[fill[cj[i]]++] = ck[i];
    }

    // 3. per pixel row: sweep sub-scanlines -> spans -> coverage events -> runs
    const D = this.D, stamp = this.stamp;
    let touched = this.touched;
    let pos = rle.pixels; // linear cursor (rle.pixels tracks what has been emitted)
    let bbx0 = W, bbx1 = -1, bby0 = H, bby1 = -1;
    const rMin = (jMin / n) | 0, rMax = (jMax / n) | 0;
    const inv = 1 / SUB;

    for (let r = rMin; r <= rMax; r++) {
      if (counts[(r + 1) * n] === counts[r * n]) continue; // nothing crosses this row
      if (++this.rowStamp > 0x7ffffff0) {
        stamp.fill(0);
        this.rowStamp = 1;
      }
      const rs = this.rowStamp;
      let tn = 0;

      for (let j = r * n; j < (r + 1) * n; j++) {
        const a = counts[j], b = counts[j + 1];
        const len = b - a;
        if (len < 2) continue;
        if (len <= 12) {
          for (let i = a + 1; i < b; i++) {
            const v = sorted[i];
            let k = i - 1;
            while (k >= a && sorted[k] > v) {
              sorted[k + 1] = sorted[k];
              k--;
            }
            sorted[k + 1] = v;
          }
        } else sorted.subarray(a, b).sort();

        let wPos = 0, wNeg = 0, filled = false, xa = 0;
        for (let i = a; i < b; i++) {
          const key = sorted[i];
          const d = key & 1 ? 1 : -1;
          if (key & 2) wNeg += d;
          else wPos += d;
          const now = wPos > 0 && wNeg === 0;
          if (now === filled) continue;
          filled = now;
          const x = (key >>> 3) * inv;
          if (now) {
            xa = x;
            continue;
          }
          const xb = x;
          if (xb <= xa) continue;
          if (tn + 4 > touched.length) {
            const bigger = new Int32Array(touched.length * 2);
            bigger.set(touched);
            this.touched = touched = bigger;
          }
          if (n === 1) {
            // binary: a pixel is lit when its centre lies inside the span
            const i0 = Math.ceil(xa - 0.5), i1 = Math.ceil(xb - 0.5);
            if (i1 > i0) {
              if (stamp[i0] !== rs) { stamp[i0] = rs; D[i0] = 1; touched[tn++] = i0; } else D[i0] += 1;
              if (stamp[i1] !== rs) { stamp[i1] = rs; D[i1] = -1; touched[tn++] = i1; } else D[i1] -= 1;
            }
          } else {
            // exact horizontal coverage: 4 difference events per span
            const ia = xa | 0, ib = xb | 0;
            const fa = xa - ia, fb = xb - ib;
            let idx = ia, v = 1 - fa;
            if (stamp[idx] !== rs) { stamp[idx] = rs; D[idx] = v; touched[tn++] = idx; } else D[idx] += v;
            idx = ia + 1; v = fa;
            if (stamp[idx] !== rs) { stamp[idx] = rs; D[idx] = v; touched[tn++] = idx; } else D[idx] += v;
            idx = ib; v = fb - 1;
            if (stamp[idx] !== rs) { stamp[idx] = rs; D[idx] = v; touched[tn++] = idx; } else D[idx] += v;
            idx = ib + 1; v = -fb;
            if (stamp[idx] !== rs) { stamp[idx] = rs; D[idx] = v; touched[tn++] = idx; } else D[idx] += v;
          }
        }
        // an unclosed span (open / damaged mesh) is dropped rather than streaked across the plate
      }

      if (tn === 0) continue;
      const tv = touched.subarray(0, tn);
      if (tn <= 12) {
        for (let i = 1; i < tn; i++) {
          const v = tv[i];
          let k = i - 1;
          while (k >= 0 && tv[k] > v) {
            tv[k + 1] = tv[k];
            k--;
          }
          tv[k + 1] = v;
        }
      } else tv.sort();

      let cum = 0;
      const rowBase = r * W;
      for (let t = 0; t < tn; t++) {
        const idx = tv[t];
        if (idx >= W) break;
        cum += D[idx];
        const next = t + 1 < tn ? (tv[t + 1] < W ? tv[t + 1] : W) : idx;
        if (next <= idx) continue;
        const cov = cum / n;
        const g = cov <= 0.002 ? 0 : cov >= 0.998 ? 255 : Math.round(cov * 255);
        if (g === 0) continue;
        const start = rowBase + idx;
        if (start > pos) rle.run(0, start - pos);
        rle.run(g, next - idx);
        pos = rowBase + next;
        if (idx < bbx0) bbx0 = idx;
        if (next - 1 > bbx1) bbx1 = next - 1;
        if (r < bby0) bby0 = r;
        bby1 = r;
        if (onRun) onRun(r, idx, next, g);
      }
    }
    return bbx1 >= 0 ? { x0: bbx0, y0: bby0, x1: bbx1, y1: bby1 } : null;
  }
}

/**
 * Coarse occupancy mask for island detection. Cells are `cell` mm square in image space.
 */
export class IslandDetector {
  constructor(machine, cell = 0.25) {
    this.cell = cell;
    this.sx = machine.width / machine.resX / cell; // px -> cells
    this.sy = machine.depth / machine.resY / cell;
    this.cw = Math.ceil(machine.width / cell) + 1;
    this.ch = Math.ceil(machine.depth / cell) + 1;
    this.prev = new Uint8Array(this.cw * this.ch);
    this.cur = new Uint8Array(this.cw * this.ch);
    this.prevBox = null;
    this.curBox = null;
    this.stack = new Int32Array(4096);
    this.machine = machine;
    this.tf = plateTransform(machine);
    this.mark = this.mark.bind(this);
  }

  beginLayer() {
    // the finished layer becomes `prev`; the older mask is wiped (dirty box only) and reused as `cur`
    const recycled = this.prev, box = this.prevBox;
    this.prev = this.cur;
    this.prevBox = this.curBox;
    this.cur = recycled;
    this.curBox = null;
    if (box) for (let y = box.y0; y <= box.y1; y++) recycled.fill(0, y * this.cw + box.x0, y * this.cw + box.x1 + 1);
  }

  mark(row, x0, x1, gray) {
    if (gray < 96) return;
    const cy = (row * this.sy) | 0;
    const c0 = (x0 * this.sx) | 0, c1 = ((x1 - 1) * this.sx) | 0;
    this.cur.fill(1, cy * this.cw + c0, cy * this.cw + c1 + 1);
    const b = this.curBox || (this.curBox = { x0: c0, y0: cy, x1: c1, y1: cy });
    if (c0 < b.x0) b.x0 = c0;
    if (c1 > b.x1) b.x1 = c1;
    if (cy < b.y0) b.y0 = cy;
    if (cy > b.y1) b.y1 = cy;
  }

  /** Call after a layer has been marked. Returns islands [{x, y, cells}] in plate mm (unsupported regions). */
  endLayer(checkIslands) {
    const out = [];
    const b = this.curBox;
    if (b && checkIslands) {
      const { cw, ch, cur, prev } = this;
      // flood fill components (8-connected); value 1 = unvisited, 2 = visited
      for (let y = b.y0; y <= b.y1; y++) {
        for (let x = b.x0; x <= b.x1; x++) {
          if (cur[y * cw + x] !== 1) continue;
          let sp = 0, cells = 0, sxm = 0, sym = 0, supported = false;
          this.stack[sp++] = y * cw + x;
          cur[y * cw + x] = 2;
          while (sp > 0) {
            const p = this.stack[--sp];
            const py = (p / cw) | 0, px = p - py * cw;
            cells++;
            sxm += px;
            sym += py;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = py + dy;
              if (ny < 0 || ny >= ch) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = px + dx;
                if (nx < 0 || nx >= cw) continue;
                const q = ny * cw + nx;
                if (prev[q]) supported = true;
                if (cur[q] === 1) {
                  cur[q] = 2;
                  if (sp === this.stack.length) {
                    const bigger = new Int32Array(this.stack.length * 2);
                    bigger.set(this.stack);
                    this.stack = bigger;
                  }
                  this.stack[sp++] = q;
                }
              }
            }
          }
          if (!supported) {
            // cell centre -> image px -> plate mm
            const ipx = (sxm / cells + 0.5) / this.sx, ipy = (sym / cells + 0.5) / this.sy;
            out.push({
              x: (ipx - this.tf.bx) / this.tf.ax,
              y: (ipy - this.tf.by) / this.tf.ay,
              cells,
              area: cells * this.cell * this.cell,
            });
          }
        }
      }
    }
    return out;
  }
}
