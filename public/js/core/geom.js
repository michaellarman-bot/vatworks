// Geometry helpers shared by the UI thread, the workers and the Node tests. No dependencies.

/** Growable triangle soup (9 floats per triangle). */
export class TriSink {
  constructor(capTris = 1024) {
    this.a = new Float32Array(capTris * 9);
    this.n = 0; // floats used
  }
  get triCount() {
    return this.n / 9;
  }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (this.n + 9 > this.a.length) {
      const bigger = new Float32Array(this.a.length * 2);
      bigger.set(this.a);
      this.a = bigger;
    }
    const a = this.a;
    let n = this.n;
    a[n++] = ax; a[n++] = ay; a[n++] = az;
    a[n++] = bx; a[n++] = by; a[n++] = bz;
    a[n++] = cx; a[n++] = cy; a[n++] = cz;
    this.n = n;
  }
  result() {
    return this.a.slice(0, this.n);
  }
}

/** Applies a column-major 4x4 matrix to a position array. Mirrored transforms get their winding repaired. */
export function bakeWorld(positions, e, flip = false) {
  const out = new Float32Array(positions.length);
  const det =
    e[0] * (e[5] * e[10] - e[6] * e[9]) - e[4] * (e[1] * e[10] - e[2] * e[9]) + e[8] * (e[1] * e[6] - e[2] * e[5]);
  const swap = det < 0 !== flip;
  for (let i = 0; i < positions.length; i += 9) {
    for (let v = 0; v < 3; v++) {
      const s = i + v * 3;
      const d = i + (swap && v > 0 ? 3 - v : v) * 3; // swap vertices 1 and 2
      const x = positions[s], y = positions[s + 1], z = positions[s + 2];
      out[d] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[d + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[d + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  return out;
}

/** Signed volume (mm^3). Negative means the mesh is inside-out. */
export function signedVolume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    v +=
      t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) -
      t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) +
      t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6]);
  }
  return v / 6;
}

export function bounds(t) {
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = t[i + k];
      if (v < b.min[k]) b.min[k] = v;
      if (v > b.max[k]) b.max[k] = v;
    }
  }
  return b;
}

/** Concatenates Float32Arrays. */
export function concatF32(list) {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const a of list) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// ------------------------------------------------------------------ vertical ray grid

/** 2D bucket grid over XY for fast vertical ray casts against a triangle soup. */
export class VerticalRayGrid {
  constructor(tris) {
    this.t = tris;
    const T = (tris.length / 9) | 0;
    const b = bounds(tris);
    this.b = b;
    const w = Math.max(b.max[0] - b.min[0], 1e-3), h = Math.max(b.max[1] - b.min[1], 1e-3);
    const target = Math.max(1, Math.sqrt(T / 2));
    const aspect = w / h;
    this.nx = Math.max(1, Math.min(1024, Math.round(target * Math.sqrt(aspect))));
    this.ny = Math.max(1, Math.min(1024, Math.round(target / Math.sqrt(aspect))));
    this.cx = w / this.nx;
    this.cy = h / this.ny;
    const { nx, ny } = this;
    const counts = new Uint32Array(nx * ny + 1);
    const range = (o) => {
      const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const y0 = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]), y1 = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
      return [
        Math.max(0, Math.min(nx - 1, ((x0 - b.min[0]) / this.cx) | 0)),
        Math.max(0, Math.min(nx - 1, ((x1 - b.min[0]) / this.cx) | 0)),
        Math.max(0, Math.min(ny - 1, ((y0 - b.min[1]) / this.cy) | 0)),
        Math.max(0, Math.min(ny - 1, ((y1 - b.min[1]) / this.cy) | 0)),
      ];
    };
    for (let t = 0; t < T; t++) {
      const [i0, i1, j0, j1] = range(t * 9);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * nx + i + 1]++;
    }
    for (let c = 0; c < nx * ny; c++) counts[c + 1] += counts[c];
    const items = new Uint32Array(counts[nx * ny]);
    const cur = counts.slice(0, nx * ny);
    for (let t = 0; t < T; t++) {
      const [i0, i1, j0, j1] = range(t * 9);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) items[cur[j * nx + i]++] = t;
    }
    this.start = counts;
    this.items = items;
  }

  /** Calls fn(z, triIndex) for every triangle pierced by the vertical line through (x, y). */
  forEachHit(x, y, fn) {
    const b = this.b;
    if (x < b.min[0] || x > b.max[0] || y < b.min[1] || y > b.max[1]) return;
    const i = Math.min(this.nx - 1, ((x - b.min[0]) / this.cx) | 0);
    const j = Math.min(this.ny - 1, ((y - b.min[1]) / this.cy) | 0);
    const c = j * this.nx + i;
    const t = this.t;
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const ti = this.items[k];
      const o = ti * 9;
      const ax = t[o], ay = t[o + 1], bx = t[o + 3], by = t[o + 4], cx = t[o + 6], cy = t[o + 7];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (d === 0) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      fn(l1 * t[o + 2] + l2 * t[o + 5] + l3 * t[o + 8], ti, d);
    }
  }

  /** Highest surface strictly below zFrom, or -Infinity. */
  castDown(x, y, zFrom) {
    let best = -Infinity;
    this.forEachHit(x, y, (z) => {
      if (z < zFrom && z > best) best = z;
    });
    return best;
  }

  /** Lowest surface strictly above zFrom, or +Infinity. */
  castUp(x, y, zFrom) {
    let best = Infinity;
    this.forEachHit(x, y, (z) => {
      if (z > zFrom && z < best) best = z;
    });
    return best;
  }

  /**
   * Winding test along +Z: faces whose normal points up are exits (+1), faces pointing down are entries (-1).
   * Unlike a parity count this stays correct where several shells overlap (very common in miniatures).
   */
  inside(x, y, z) {
    let w = 0;
    this.forEachHit(x + 1.3e-4, y + 0.7e-4, (hz, ti, d) => {
      if (hz > z) w += d > 0 ? 1 : -1;
    });
    return w > 0;
  }
}

// ------------------------------------------------------------------ welding / adjacency

/** Welds a soup into indexed form. Returns { index: Uint32Array(3T), verts: Float32Array(3V), count }. */
export function weld(tris, tol = 1e-4) {
  const nCorners = tris.length / 3;
  let size = 1;
  while (size < nCorners * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const index = new Uint32Array(nCorners);
  const verts = new Float32Array(nCorners * 3);
  let count = 0;
  const inv = 1 / tol;
  for (let c = 0; c < nCorners; c++) {
    const x = tris[c * 3], y = tris[c * 3 + 1], z = tris[c * 3 + 2];
    const qx = Math.round(x * inv), qy = Math.round(y * inv), qz = Math.round(z * inv);
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    for (;;) {
      const v = table[h];
      if (v < 0) {
        table[h] = count;
        verts[count * 3] = x; verts[count * 3 + 1] = y; verts[count * 3 + 2] = z;
        index[c] = count++;
        break;
      }
      if (
        Math.round(verts[v * 3] * inv) === qx &&
        Math.round(verts[v * 3 + 1] * inv) === qy &&
        Math.round(verts[v * 3 + 2] * inv) === qz
      ) {
        index[c] = v;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { index, verts: verts.slice(0, count * 3), count };
}

// ------------------------------------------------------------------ solid primitives (outward facing)

function basis(dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l; dy /= l; dz /= l;
  // pick the axis least aligned with d
  let ux, uy, uz;
  if (Math.abs(dz) < 0.9) { ux = -dy; uy = dx; uz = 0; } // z_hat x d
  else { ux = 0; uy = -dz; uz = dy; } // x_hat x d
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  // v = d x u  (so that u x v = d)
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  return [ux, uy, uz, vx, vy, vz];
}

/** Capped conical frustum from A (radius ra) to B (radius rb). */
export function frustum(sink, A, B, ra, rb, segs = 12) {
  const [ux, uy, uz, vx, vy, vz] = basis(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  let pax, pay, paz, pbx, pby, pbz;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const rx = c * ux + s * vx, ry = c * uy + s * vy, rz = c * uz + s * vz;
    const ax = A[0] + ra * rx, ay = A[1] + ra * ry, az = A[2] + ra * rz;
    const bx = B[0] + rb * rx, by = B[1] + rb * ry, bz = B[2] + rb * rz;
    if (i > 0) {
      sink.tri(pax, pay, paz, ax, ay, az, bx, by, bz);
      sink.tri(pax, pay, paz, bx, by, bz, pbx, pby, pbz);
      sink.tri(A[0], A[1], A[2], ax, ay, az, pax, pay, paz); // cap A faces -d
      sink.tri(B[0], B[1], B[2], pbx, pby, pbz, bx, by, bz); // cap B faces +d
    }
    pax = ax; pay = ay; paz = az; pbx = bx; pby = by; pbz = bz;
  }
}

export function sphere(sink, C, r, segs = 10, rings = 6) {
  const P = (i, j) => {
    const th = (i / rings) * Math.PI, ph = (j / segs) * Math.PI * 2;
    const st = Math.sin(th);
    return [C[0] + r * st * Math.cos(ph), C[1] + r * st * Math.sin(ph), C[2] + r * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const p00 = P(i, j), p10 = P(i + 1, j), p11 = P(i + 1, j + 1), p01 = P(i, j + 1);
      if (i < rings - 1) sink.tri(...p00, ...p10, ...p11);
      if (i > 0) sink.tri(...p00, ...p11, ...p01);
    }
  }
}

/** Convex hull of 2D points (Andrew monotone chain). Returns indices into pts, counter-clockwise. */
export function convexHull2D(pts) {
  const n = pts.length;
  if (n < 3) return pts.map((_, i) => i);
  const idx = pts.map((_, i) => i).sort((a, b) => pts[a][0] - pts[b][0] || pts[a][1] - pts[b][1]);
  const cross = (o, a, b) =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const hull = [];
  for (const i of idx) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  const lower = hull.length + 1;
  for (let k = n - 2; k >= 0; k--) {
    const i = idx[k];
    while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop();
    hull.push(i);
  }
  hull.pop();
  return hull;
}

// ------------------------------------------------------------------ orientation scoring

/** Per-triangle area and unit normal. */
export function triangleNormals(t) {
  const T = t.length / 9;
  const area = new Float32Array(T), n = new Float32Array(T * 3);
  for (let i = 0, o = 0; i < T; i++, o += 9) {
    const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
    const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[i] = l / 2;
    if (l > 0) { n[i * 3] = nx / l; n[i * 3 + 1] = ny / l; n[i * 3 + 2] = nz / l; }
  }
  return { area, n };
}

/** Row-major 3x3 rotation: first ax degrees about X, then ay degrees about Y. */
export function rotationXY(ax, ay) {
  const a = (ax * Math.PI) / 180, b = (ay * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  // Ry * Rx
  return [cb, sa * sb, ca * sb, 0, ca, -sa, -sb, sa * cb, ca * cb];
}

/**
 * Scores an orientation: supported-overhang area (mm^2) plus a small height penalty. Faces that would lie flat on
 * the plate are not overhangs. `stride` subsamples triangles for speed on huge meshes.
 */
export function orientationScore(t, info, R, cosLimit, stride = 1) {
  const T = t.length / 9;
  const r20 = R[6], r21 = R[7], r22 = R[8];
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < T; i += stride) {
    const o = i * 9;
    for (let k = 0; k < 9; k += 3) {
      const z = r20 * t[o + k] + r21 * t[o + k + 1] + r22 * t[o + k + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  let overhang = 0;
  const n = info.n, area = info.area;
  for (let i = 0; i < T; i += stride) {
    const nz = r20 * n[i * 3] + r21 * n[i * 3 + 1] + r22 * n[i * 3 + 2];
    if (nz >= -cosLimit) continue;
    const o = i * 9;
    let lo = Infinity;
    for (let k = 0; k < 9; k += 3) {
      const z = r20 * t[o + k] + r21 * t[o + k + 1] + r22 * t[o + k + 2];
      if (z < lo) lo = z;
    }
    if (nz < -0.985 && lo < minZ + 0.05) continue; // sits on the plate
    overhang += area[i] * stride;
  }
  return { overhang, height: maxZ - minZ, score: overhang + 0.5 * (maxZ - minZ) };
}

/** Tries a grid of tilts and returns the best rotation as [ax, ay] degrees plus its score. */
export function bestOrientation(t, overhangAngle = 45) {
  const info = triangleNormals(t);
  const cosLimit = Math.cos((overhangAngle * Math.PI) / 180);
  const T = t.length / 9;
  const stride = T > 400000 ? Math.ceil(T / 400000) : 1;
  const angles = [0, -15, 15, -30, 30, -45, 45, -60, 60, -90, 90, 180];
  let best = null;
  for (const ax of angles)
    for (const ay of angles) {
      if (ax === 180 && ay === 180) continue;
      const s = orientationScore(t, info, rotationXY(ax, ay), cosLimit, stride);
      if (!best || s.score < best.score - 1e-6) best = { ax, ay, ...s };
    }
  return best;
}
