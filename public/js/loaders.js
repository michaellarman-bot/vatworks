// Model file parsers (STL binary/ASCII, OBJ, 3MF). Pure JS; runs inside a worker. Output is a triangle soup in mm.

export async function parseModel(name, buffer) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'stl') return parseSTL(buffer);
  if (ext === 'obj') return parseOBJ(buffer);
  if (ext === '3mf') return parse3MF(buffer);
  throw new Error(`Cannot open .${ext} files. Use STL, OBJ or 3MF.`);
}

function isBinarySTL(u8) {
  if (u8.length < 84) return false;
  const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(80, true);
  if (u8.length === 84 + n * 50) return true;
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(512, u8.length)));
  return !/^\s*solid/i.test(head) || /[^\t\n\r\x20-\x7e]/.test(head);
}

export function parseSTL(buffer) {
  const u8 = new Uint8Array(buffer);
  if (isBinarySTL(u8)) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(80, true);
    const count = Math.min(n, Math.floor((u8.length - 84) / 50));
    const out = new Float32Array(count * 9);
    for (let t = 0, p = 84 + 12; t < count; t++, p += 50) {
      for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(p + k * 4, true);
    }
    return { positions: out, warnings: count < n ? ['The STL is truncated; some triangles are missing.'] : [] };
  }
  const text = new TextDecoder().decode(u8);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const tri = Math.floor(vals.length / 9);
  return { positions: Float32Array.from(vals.slice(0, tri * 9)), warnings: [] };
}

export function parseOBJ(buffer) {
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  const v = [];
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      v.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1);
      const idx = p.map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return (i < 0 ? v.length / 3 + i : i - 1) * 3;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        const a = idx[0], b = idx[k], c = idx[k + 1];
        out.push(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]);
      }
    }
  }
  return { positions: Float32Array.from(out), warnings: [] };
}

// ------------------------------------------------------------------ 3MF (zip + XML)

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack 3MF files (no DecompressionStream).');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid 3MF (zip directory missing).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let e = 0; e < count; e++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    files.set(name, async () => {
      const ln = dv.getUint16(local + 26, true), le = dv.getUint16(local + 28, true);
      const start = local + 30 + ln + le;
      const raw = u8.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error(`Unsupported zip compression method ${method}`);
    });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const attrs = (s) => {
  const o = {};
  const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
};
const parseTransform = (s) => (s ? s.trim().split(/\s+/).map(Number) : null); // 12 numbers, row-major 3x4 (row vectors)
const I34 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function mul34(a, b) {
  // result = apply a then b  (p' = (p*A)*B) in 3MF row-vector convention
  const r = new Array(12);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

export async function parse3MF(buffer) {
  const files = await unzip(new Uint8Array(buffer));
  let modelName = [...files.keys()].find((n) => n.toLowerCase() === '3d/3dmodel.model') || [...files.keys()].find((n) => n.toLowerCase().endsWith('.model'));
  if (!modelName) throw new Error('No 3D model found inside the 3MF.');
  const xml = new TextDecoder().decode(await files.get(modelName)());
  const unit = (xml.match(/<model[^>]*\bunit="(\w+)"/) || [])[1] || 'millimeter';
  const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[unit] || 1;
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const a = attrs(m[1]);
    const body = m[2];
    const obj = { verts: [], tris: [], components: [] };
    const meshMatch = body.match(/<mesh\b[\s\S]*?<\/mesh>/);
    if (meshMatch) {
      const vre = /<vertex\b([^>]*)\/?>/g;
      let vm;
      while ((vm = vre.exec(meshMatch[0]))) { const va = attrs(vm[1]); obj.verts.push(+va.x, +va.y, +va.z); }
      const tre = /<triangle\b([^>]*)\/?>/g;
      let tm;
      while ((tm = tre.exec(meshMatch[0]))) { const ta = attrs(tm[1]); obj.tris.push(+ta.v1, +ta.v2, +ta.v3); }
    }
    const cre = /<component\b([^>]*)\/?>/g;
    let cm;
    while ((cm = cre.exec(body))) { const ca = attrs(cm[1]); obj.components.push({ id: ca.objectid, t: parseTransform(ca.transform) || I34 }); }
    objects.set(a.id, obj);
  }
  const out = [];
  const emit = (id, T, depth) => {
    const obj = objects.get(id);
    if (!obj || depth > 16) return;
    const { verts, tris } = obj;
    for (let i = 0; i < tris.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = tris[i + k] * 3;
        const x = verts[vi], y = verts[vi + 1], z = verts[vi + 2];
        out.push(
          (x * T[0] + y * T[3] + z * T[6] + T[9]) * scale,
          (x * T[1] + y * T[4] + z * T[7] + T[10]) * scale,
          (x * T[2] + y * T[5] + z * T[8] + T[11]) * scale,
        );
      }
    }
    for (const c of obj.components) emit(c.id, mul34(c.t, T), depth + 1);
  };
  const build = xml.match(/<build\b[\s\S]*?<\/build>/);
  const ire = /<item\b([^>]*)\/?>/g;
  let any = false;
  if (build) while ((m = ire.exec(build[0]))) { const ia = attrs(m[1]); emit(ia.objectid, parseTransform(ia.transform) || I34, 0); any = true; }
  if (!any) for (const id of objects.keys()) emit(id, I34, 0);
  return { positions: Float32Array.from(out), warnings: [] };
}
