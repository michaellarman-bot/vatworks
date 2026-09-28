// Hollowing. The model is voxelised, an exact Euclidean distance transform gives every interior voxel its
// distance to the surface, and everything deeper than the wall thickness becomes cavity. The cavity is kept
// as a small signed field; at slice time its iso-contour is traced per layer (marching squares) and handed
// to the rasteriser as "negative" outlines. No mesh booleans required, and the result is exactly what prints.
import { TriMesh, SegmentBuffer } from './raster.js';

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher). f and out have length n. */
function edt1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      // k === 0 and the new parabola wins everywhere
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      k = 0;
    } else {
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    out[q] = (q - p) * (q - p) + f[p];
  }
}

/** Solid voxelisation with a positive-winding fill. Returns Uint8Array nx*ny*nz (1 = inside). */
export function voxelize(tris, origin, dims, v) {
  const [nx, ny, nz] = dims;
  const grid = new Uint8Array(nx * ny * nz);
  const mesh = new TriMesh(tris);
  const segs = new SegmentBuffer(2048);
  const xs = [];
  for (let k = 0; k < nz; k++) {
    const z = origin[2] + (k + 0.5) * v;
    if (z <= mesh.minZ || z >= mesh.maxZ) continue;
    segs.clear();
    mesh.slice(z, segs, 0);
    if (!segs.n) continue;
    const rows = Array.from({ length: ny }, () => []);
    for (let s = 0, o = 0; s < segs.n; s++, o += 4) {
      const x0 = segs.xy[o], y0 = segs.xy[o + 1], x1 = segs.xy[o + 2], y1 = segs.xy[o + 3];
      if (y0 === y1) continue;
      const up = y1 > y0;
      const ylo = up ? y0 : y1, yhi = up ? y1 : y0;
      let j0 = Math.ceil((ylo - origin[1]) / v - 0.5), j1 = Math.ceil((yhi - origin[1]) / v - 0.5) - 1;
      if (j0 < 0) j0 = 0;
      if (j1 >= ny) j1 = ny - 1;
      for (let j = j0; j <= j1; j++) {
        const y = origin[1] + (j + 0.5) * v;
        rows[j].push([x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), up ? -1 : 1]);
      }
    }
    for (let j = 0; j < ny; j++) {
      const r = rows[j];
      if (r.length < 2) continue;
      r.sort((a, b) => a[0] - b[0]);
      let w = 0, xa = 0;
      for (const [x, d] of r) {
        const was = w > 0;
        w += d;
        if (!was && w > 0) xa = x;
        else if (was && w <= 0) {
          let i0 = Math.ceil((xa - origin[0]) / v - 0.5), i1 = Math.ceil((x - origin[0]) / v - 0.5);
          if (i0 < 0) i0 = 0;
          if (i1 > nx) i1 = nx;
          if (i1 > i0) grid.fill(1, (k * ny + j) * nx + i0, (k * ny + j) * nx + i1);
        }
      }
    }
  }
  xs.length = 0;
  return grid;
}

/**
 * Computes the cavity field for a solid.
 * Returns { field: Int8Array, dims:[nx,ny,nz], origin:[x,y,z], voxel, scale, cavityVoxels, solidVoxels }.
 * field value = (distanceToSurface - wall) mapped so that +-127 == +-2 voxels; > 0 means cavity.
 */
export function computeCavity(tris, bbox, wall, voxel, onProgress) {
  const pad = 2;
  const v = voxel;
  const origin = [bbox.min[0] - pad * v, bbox.min[1] - pad * v, bbox.min[2] - pad * v];
  const dims = [0, 1, 2].map((a) => Math.ceil((bbox.max[a] - bbox.min[a]) / v) + pad * 2);
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  onProgress?.(0.05, 'Voxelising');
  const solid = voxelize(tris, origin, dims, v);
  let solidVoxels = 0;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (solid[i]) {
      d[i] = INF;
      solidVoxels++;
    }
  }
  // The plate side is closed: a model standing on the plate must keep a floor of full wall thickness,
  // which falls out naturally because everything below z=0 is "outside".
  const maxN = Math.max(nx, ny, nz);
  const f = new Float64Array(maxN), out = new Float64Array(maxN);
  const vv = new Int32Array(maxN), zz = new Float64Array(maxN + 1);
  onProgress?.(0.3, 'Measuring wall depth');
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const base = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) f[i] = d[base + i];
      edt1d(f, nx, out, vv, zz);
      for (let i = 0; i < nx; i++) d[base + i] = out[i];
    }
  onProgress?.(0.5, 'Measuring wall depth');
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      const base = k * ny * nx + i;
      for (let j = 0; j < ny; j++) f[j] = d[base + j * nx];
      edt1d(f, ny, out, vv, zz);
      for (let j = 0; j < ny; j++) d[base + j * nx] = out[j];
    }
  onProgress?.(0.7, 'Measuring wall depth');
  const slab = nx * ny;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const base = j * nx + i;
      for (let k = 0; k < nz; k++) f[k] = d[base + k * slab];
      edt1d(f, nz, out, vv, zz);
      for (let k = 0; k < nz; k++) d[base + k * slab] = out[k];
    }
  onProgress?.(0.9, 'Carving cavity');
  const field = new Int8Array(N);
  const scale = 127 / (2 * v);
  let cavityVoxels = 0;
  for (let i = 0; i < N; i++) {
    // distance from voxel centre to the surface ~ distance to nearest outside centre minus half a voxel
    const dist = solid[i] ? Math.sqrt(d[i]) * v - 0.5 * v : -0.5 * v;
    let q = Math.round((dist - wall) * scale);
    if (q > 127) q = 127;
    else if (q < -127) q = -127;
    field[i] = q;
    if (q > 0) cavityVoxels++;
  }
  onProgress?.(1, 'Done');
  return { field, dims, origin, voxel: v, scale, cavityVoxels, solidVoxels };
}

/** Picks a voxel size that keeps the grid under maxVoxels. */
export function chooseVoxel(bbox, wall, maxVoxels = 14e6) {
  const s = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]);
  let v = Math.max(0.2, Math.min(0.5, wall / 4));
  while (((s[0] / v + 4) * (s[1] / v + 4) * (s[2] / v + 4)) > maxVoxels) v *= 1.15;
  return Math.round(v * 1000) / 1000;
}

// marching squares segment table: [fromEdge, toEdge] pairs, cavity on the left.
// corners: bit0 = (i,j) bit1 = (i+1,j) bit2 = (i+1,j+1) bit3 = (i,j+1); edges: 0 bottom, 1 right, 2 top, 3 left
const MS = [
  [], [[0, 3]], [[1, 0]], [[1, 3]], [[2, 1]], null, [[2, 0]], [[2, 3]],
  [[3, 2]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];

/**
 * Appends the cavity outline at height z (world mm, offset by [ox, oy, oz] for moved models) to `out`
 * as class-1 (negative) segments.
 */
export function cavityContours(h, z, out, ox = 0, oy = 0, oz = 0) {
  const [nx, ny, nz] = h.dims;
  const v = h.voxel;
  const kf = (z - oz - h.origin[2]) / v - 0.5;
  if (kf < 0 || kf > nz - 1) return;
  const k0 = Math.min(nz - 2, Math.floor(kf)), t = kf - k0;
  const f = h.field, slab = nx * ny;
  const a = k0 * slab, b = a + slab;
  const x0 = h.origin[0] + ox + 0.5 * v, y0 = h.origin[1] + oy + 0.5 * v;
  const val = (i, j) => f[a + j * nx + i] * (1 - t) + f[b + j * nx + i] * t;
  const pt = (edge, i, j, v00, v10, v11, v01) => {
    switch (edge) {
      case 0: return [x0 + (i + v00 / (v00 - v10)) * v, y0 + j * v];
      case 1: return [x0 + (i + 1) * v, y0 + (j + v10 / (v10 - v11)) * v];
      case 2: return [x0 + (i + v01 / (v01 - v11)) * v, y0 + (j + 1) * v];
      default: return [x0 + i * v, y0 + (j + v00 / (v00 - v01)) * v];
    }
  };
  for (let j = 0; j < ny - 1; j++) {
    let v00 = val(0, j), v01 = val(0, j + 1);
    for (let i = 0; i < nx - 1; i++) {
      const v10 = val(i + 1, j), v11 = val(i + 1, j + 1);
      const c = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (c !== 0 && c !== 15) {
        let list = MS[c];
        if (!list) {
          const centre = (v00 + v10 + v11 + v01) / 4 > 0;
          if (c === 5) list = centre ? [[0, 1], [2, 3]] : [[0, 3], [2, 1]];
          else list = centre ? [[3, 0], [1, 2]] : [[1, 0], [3, 2]];
        }
        for (const [e0, e1] of list) {
          const p = pt(e0, i, j, v00, v10, v11, v01), q = pt(e1, i, j, v00, v10, v11, v01);
          out.push(p[0], p[1], q[0], q[1], 1);
        }
      }
      v00 = v10;
      v01 = v11;
    }
  }
}

// ---------------------------------------------------------------- cavity preview mesh (naive surface nets)

const SN_DX = [0, 1, 1, 0, 0, 1, 1, 0], SN_DY = [0, 0, 1, 1, 0, 0, 1, 1], SN_DZ = [0, 0, 0, 0, 1, 1, 1, 1];
const SN_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/**
 * Triangle soup of the cavity surface (iso-level 0 of the field), for on-screen preview only.
 * stride > 1 samples a coarser grid to keep big fields cheap.
 */
export function surfaceNets(h, stride = 1) {
  const [nx, ny, nz] = h.dims;
  const f = h.field;
  const gx = Math.floor((nx - 1) / stride) + 1, gy = Math.floor((ny - 1) / stride) + 1, gz = Math.floor((nz - 1) / stride) + 1;
  const cx = gx - 1, cy = gy - 1, cz = gz - 1;
  if (cx < 1 || cy < 1 || cz < 1) return new Float32Array(0);
  const S = (i, j, k) => f[(k * stride * ny + j * stride) * nx + i * stride];
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const verts = [];
  const v = h.voxel * stride;
  const o = [h.origin[0] + 0.5 * h.voxel, h.origin[1] + 0.5 * h.voxel, h.origin[2] + 0.5 * h.voxel];
  const c = new Float32Array(8);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let m = 0; m < 8; m++) {
          c[m] = S(i + SN_DX[m], j + SN_DY[m], k + SN_DZ[m]);
          if (c[m] > 0) mask |= 1 << m;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of SN_EDGES) {
          if ((c[a] > 0) === (c[b] > 0)) continue;
          const t = c[a] / (c[a] - c[b]);
          sx += SN_DX[a] + (SN_DX[b] - SN_DX[a]) * t;
          sy += SN_DY[a] + (SN_DY[b] - SN_DY[a]) * t;
          sz += SN_DZ[a] + (SN_DZ[b] - SN_DZ[a]) * t;
          n++;
        }
        cell[(k * cy + j) * cx + i] = verts.length / 3;
        verts.push(o[0] + (i + sx / n) * v, o[1] + (j + sy / n) * v, o[2] + (k + sz / n) * v);
      }
  const out = [];
  const quad = (a, b, cc, d, flip) => {
    if (a < 0 || b < 0 || cc < 0 || d < 0) return;
    const P = (q) => [verts[q * 3], verts[q * 3 + 1], verts[q * 3 + 2]];
    const [p0, p1, p2, p3] = flip ? [P(a), P(d), P(cc), P(b)] : [P(a), P(b), P(cc), P(d)];
    out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  };
  const C = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= cx || j >= cy || k >= cz ? -1 : cell[(k * cy + j) * cx + i]);
  for (let k = 0; k < gz; k++)
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) {
        const s0 = S(i, j, k) > 0;
        if (i + 1 < gx && (S(i + 1, j, k) > 0) !== s0) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), s0);
        if (j + 1 < gy && (S(i, j + 1, k) > 0) !== s0) quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), s0);
        if (k + 1 < gz && (S(i, j, k + 1) > 0) !== s0) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), s0);
      }
  return Float32Array.from(out);
}
