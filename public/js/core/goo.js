// Elegoo GOO v3.0 container — RLE codec, header / layer-definition writers and a parser.
// Layout verified against the UVtools reference implementation (GooFile.cs).
// Everything is big-endian. Pure JS: runs in the browser, in workers and in Node.

export const GOO_MAGIC = Uint8Array.of(0x07, 0x00, 0x00, 0x00, 0x44, 0x4c, 0x50, 0x00);
export const GOO_DELIM = Uint8Array.of(0x0d, 0x0a);
export const GOO_FOOTER = Uint8Array.of(0, 0, 0, 0x07, 0x00, 0x00, 0x00, 0x44, 0x4c, 0x50, 0x00);
export const HEADER_SIZE = 195477;
export const LAYER_DEF_SIZE = 70;
export const PREVIEW_SMALL = 116;
export const PREVIEW_BIG = 290;
const LAYER_MAGIC = 0x55;
const MAX_RUN = 0xfffffff;

// ---------------------------------------------------------------- RLE encode

/** Streams (gray, length) runs into a GOO layer image. Adjacent equal runs merge. */
export class RleWriter {
  constructor(initialBytes = 8192) {
    this.buf = new Uint8Array(initialBytes);
    this.buf[0] = LAYER_MAGIC;
    this.n = 1;
    this.gray = 0;
    this.len = 0;
    this.pixels = 0; // pixels emitted so far
    this.lit = 0; // sum of gray/255 over all pixels (exposed area in px)
  }

  run(gray, length) {
    if (length <= 0) return;
    this.pixels += length;
    if (gray) this.lit += (gray / 255) * length;
    if (gray === this.gray) {
      this.len += length;
      return;
    }
    this._flush();
    this.gray = gray;
    this.len = length;
  }

  _flush() {
    let len = this.len;
    if (len <= 0) return;
    const gray = this.gray;
    while (len > 0) {
      const l = len > MAX_RUN ? MAX_RUN : len;
      if (this.n + 6 > this.buf.length) {
        const bigger = new Uint8Array(this.buf.length * 2);
        bigger.set(this.buf);
        this.buf = bigger;
      }
      const buf = this.buf;
      const i0 = this.n++;
      let b0;
      if (gray === 0) b0 = 0x00;
      else if (gray === 255) b0 = 0xc0;
      else {
        b0 = 0x40;
        buf[this.n++] = gray;
      }
      b0 |= l & 0xf;
      if (l > 0xfffff) {
        b0 |= 0x30;
        buf[this.n++] = (l >>> 20) & 0xff;
        buf[this.n++] = (l >>> 12) & 0xff;
        buf[this.n++] = (l >>> 4) & 0xff;
      } else if (l > 0xfff) {
        b0 |= 0x20;
        buf[this.n++] = (l >>> 12) & 0xff;
        buf[this.n++] = (l >>> 4) & 0xff;
      } else if (l > 0xf) {
        b0 |= 0x10;
        buf[this.n++] = (l >>> 4) & 0xff;
      }
      buf[i0] = b0;
      len -= l;
    }
    this.len = 0;
  }

  /** Pads with black up to totalPixels, appends the checksum and returns the encoded bytes. */
  finish(totalPixels) {
    if (this.pixels > totalPixels) throw new Error(`RLE overrun: ${this.pixels} > ${totalPixels}`);
    if (this.pixels < totalPixels) this.run(0, totalPixels - this.pixels);
    this._flush();
    let sum = 0;
    for (let i = 1; i < this.n; i++) sum = (sum + this.buf[i]) & 0xff;
    const out = new Uint8Array(this.n + 1);
    out.set(this.buf.subarray(0, this.n));
    out[this.n] = ~sum & 0xff;
    return out;
  }
}

// ---------------------------------------------------------------- RLE decode

/** Calls onRun(gray, length) for every run in an encoded layer. Handles all four chunk types. */
export function decodeRuns(rle, onRun, verify = true) {
  if (rle.length < 3) return;
  if (rle[0] !== LAYER_MAGIC) throw new Error('Layer data does not start with 0x55');
  const last = rle.length - 1;
  if (verify) {
    let sum = 0;
    for (let i = 1; i < last; i++) sum = (sum + rle[i]) & 0xff;
    if ((~sum & 0xff) !== rle[last]) throw new Error('Layer checksum mismatch');
  }
  let color = 0;
  for (let i = 1; i < last; i++) {
    const b0 = rle[i];
    const type = b0 >> 6;
    let stride;
    if (type === 2) {
      const dt = (b0 >> 4) & 3;
      const dv = b0 & 0xf;
      color = (dt & 2 ? color - dv : color + dv) & 0xff;
      stride = dt & 1 ? rle[++i] : 1;
    } else {
      if (type === 0) color = 0;
      else if (type === 3) color = 255;
      else color = rle[++i];
      const lt = (b0 >> 4) & 3;
      stride = b0 & 0xf;
      if (lt === 1) {
        stride |= rle[i + 1] << 4;
        i += 1;
      } else if (lt === 2) {
        stride |= (rle[i + 1] << 12) | (rle[i + 2] << 4);
        i += 2;
      } else if (lt === 3) {
        stride |= (rle[i + 1] << 20) | (rle[i + 2] << 12) | (rle[i + 3] << 4);
        i += 3;
      }
    }
    onRun(color, stride);
  }
}

// ---------------------------------------------------------------- header

const te = new TextEncoder();
const td = new TextDecoder();

function putStr(u8, off, len, str) {
  const bytes = te.encode(String(str ?? ''));
  u8.set(bytes.subarray(0, len - 1), off); // keep at least one NUL terminator
  return off + len;
}
function getStr(u8, off, len) {
  let end = off;
  while (end < off + len && u8[end] !== 0) end++;
  return td.decode(u8.subarray(off, end));
}

// Ordered list of the numeric header fields that follow the preview images.
const HEADER_FIELDS = [
  ['layerCount', 'u32'],
  ['resolutionX', 'u16'],
  ['resolutionY', 'u16'],
  ['mirrorX', 'u8'],
  ['mirrorY', 'u8'],
  ['displayWidth', 'f32'],
  ['displayHeight', 'f32'],
  ['machineZ', 'f32'],
  ['layerHeight', 'f32'],
  ['exposureTime', 'f32'],
  ['delayMode', 'u8'], // 0 = light-off delay, 1 = wait times
  ['lightOffDelay', 'f32'],
  ['bottomWaitAfterCure', 'f32'],
  ['bottomWaitAfterLift', 'f32'],
  ['bottomWaitBeforeCure', 'f32'],
  ['waitAfterCure', 'f32'],
  ['waitAfterLift', 'f32'],
  ['waitBeforeCure', 'f32'],
  ['bottomExposureTime', 'f32'],
  ['bottomLayerCount', 'u32'],
  ['bottomLiftHeight', 'f32'],
  ['bottomLiftSpeed', 'f32'],
  ['liftHeight', 'f32'],
  ['liftSpeed', 'f32'],
  ['bottomRetractHeight', 'f32'],
  ['bottomRetractSpeed', 'f32'],
  ['retractHeight', 'f32'],
  ['retractSpeed', 'f32'],
  ['bottomLiftHeight2', 'f32'],
  ['bottomLiftSpeed2', 'f32'],
  ['liftHeight2', 'f32'],
  ['liftSpeed2', 'f32'],
  ['bottomRetractHeight2', 'f32'],
  ['bottomRetractSpeed2', 'f32'],
  ['retractHeight2', 'f32'],
  ['retractSpeed2', 'f32'],
  ['bottomLightPWM', 'u16'],
  ['lightPWM', 'u16'],
  ['perLayerSettings', 'u8'],
  ['printTime', 'u32'],
  ['volume', 'f32'], // mm^3
  ['materialGrams', 'f32'],
  ['materialCost', 'f32'],
  ['currency', 's8'],
  ['layerDefAddress', 'u32'],
  ['grayScaleLevel', 'u8'],
  ['transitionLayerCount', 'u16'],
];

const LAYER_FIELDS = [
  ['pause', 'u16'],
  ['pausePositionZ', 'f32'],
  ['positionZ', 'f32'],
  ['exposureTime', 'f32'],
  ['lightOffDelay', 'f32'],
  ['waitAfterCure', 'f32'],
  ['waitAfterLift', 'f32'],
  ['waitBeforeCure', 'f32'],
  ['liftHeight', 'f32'],
  ['liftSpeed', 'f32'],
  ['liftHeight2', 'f32'],
  ['liftSpeed2', 'f32'],
  ['retractHeight', 'f32'],
  ['retractSpeed', 'f32'],
  ['retractHeight2', 'f32'],
  ['retractSpeed2', 'f32'],
  ['lightPWM', 'u16'],
];

function writeFields(dv, u8, off, fields, src) {
  for (const [name, type] of fields) {
    const v = src[name] ?? 0;
    switch (type) {
      case 'u8': dv.setUint8(off, v ? (v === true ? 1 : v) : 0); off += 1; break;
      case 'u16': dv.setUint16(off, Math.round(v)); off += 2; break;
      case 'u32': dv.setUint32(off, Math.round(v)); off += 4; break;
      case 'f32': dv.setFloat32(off, v); off += 4; break;
      case 's8': off = putStr(u8, off, 8, v || ''); break;
    }
  }
  return off;
}
function readFields(dv, u8, off, fields, dst) {
  for (const [name, type] of fields) {
    switch (type) {
      case 'u8': dst[name] = dv.getUint8(off); off += 1; break;
      case 'u16': dst[name] = dv.getUint16(off); off += 2; break;
      case 'u32': dst[name] = dv.getUint32(off); off += 4; break;
      case 'f32': dst[name] = dv.getFloat32(off); off += 4; break;
      case 's8': dst[name] = getStr(u8, off, 8); off += 8; break;
    }
  }
  return off;
}

/**
 * h: { softwareName, softwareVersion, fileTime, machineName, machineType, profileName,
 *      aaLevel, greyLevel, blurLevel, previewSmall(Uint8Array 116*116*2), previewBig(Uint8Array 290*290*2),
 *      ...HEADER_FIELDS }
 */
export function buildHeader(h) {
  const u8 = new Uint8Array(HEADER_SIZE);
  const dv = new DataView(u8.buffer);
  let off = 0;
  off = putStr(u8, off, 4 + 1, 'V3.0') - 1; // exactly 4 chars, no terminator
  u8.set(GOO_MAGIC, off); off += 8;
  off = putStr(u8, off, 32, h.softwareName);
  off = putStr(u8, off, 24, h.softwareVersion);
  off = putStr(u8, off, 24, h.fileTime);
  off = putStr(u8, off, 32, h.machineName);
  off = putStr(u8, off, 32, h.machineType);
  off = putStr(u8, off, 32, h.profileName);
  dv.setUint16(off, h.aaLevel ?? 1); off += 2;
  dv.setUint16(off, h.greyLevel ?? 1); off += 2;
  dv.setUint16(off, h.blurLevel ?? 0); off += 2;
  const small = PREVIEW_SMALL * PREVIEW_SMALL * 2;
  const big = PREVIEW_BIG * PREVIEW_BIG * 2;
  if (h.previewSmall?.length === small) u8.set(h.previewSmall, off);
  off += small;
  u8.set(GOO_DELIM, off); off += 2;
  if (h.previewBig?.length === big) u8.set(h.previewBig, off);
  off += big;
  u8.set(GOO_DELIM, off); off += 2;
  off = writeFields(dv, u8, off, HEADER_FIELDS, { ...h, layerDefAddress: HEADER_SIZE, grayScaleLevel: 1 });
  if (off !== HEADER_SIZE) throw new Error(`GOO header size ${off} != ${HEADER_SIZE}`);
  return u8;
}

/** 70-byte layer definition; the RLE bytes and a CRLF follow it in the file. */
export function buildLayerDef(l, dataLength) {
  const u8 = new Uint8Array(LAYER_DEF_SIZE);
  const dv = new DataView(u8.buffer);
  let off = writeFields(dv, u8, 0, LAYER_FIELDS, l);
  u8.set(GOO_DELIM, off); off += 2;
  dv.setUint32(off, dataLength); off += 4;
  if (off !== LAYER_DEF_SIZE) throw new Error('GOO layer def size mismatch');
  return u8;
}

/** RGBA (Uint8ClampedArray) -> RGB565 big-endian. */
export function rgbaToRgb565(rgba, w, h) {
  const out = new Uint8Array(w * h * 2);
  for (let i = 0, o = 0; i < w * h; i++, o += 2) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
  }
  return out;
}
export function rgb565ToRgba(src, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (src[i * 2] << 8) | src[i * 2 + 1];
    out[i * 4] = ((v >> 11) & 31) * 255 / 31;
    out[i * 4 + 1] = ((v >> 5) & 63) * 255 / 63;
    out[i * 4 + 2] = (v & 31) * 255 / 31;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- parse

/** Parses a .goo file. Layer image bytes are returned as subarray views (no copies). */
export function parseGoo(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < HEADER_SIZE + GOO_FOOTER.length) throw new Error('File is too small to be a .goo');
  for (let i = 0; i < 8; i++) if (u8[4 + i] !== GOO_MAGIC[i]) throw new Error('Not a .goo file (magic mismatch)');
  const header = { version: getStr(u8, 0, 4) };
  let off = 12;
  header.softwareName = getStr(u8, off, 32); off += 32;
  header.softwareVersion = getStr(u8, off, 24); off += 24;
  header.fileTime = getStr(u8, off, 24); off += 24;
  header.machineName = getStr(u8, off, 32); off += 32;
  header.machineType = getStr(u8, off, 32); off += 32;
  header.profileName = getStr(u8, off, 32); off += 32;
  header.aaLevel = dv.getUint16(off); off += 2;
  header.greyLevel = dv.getUint16(off); off += 2;
  header.blurLevel = dv.getUint16(off); off += 2;
  const small = PREVIEW_SMALL * PREVIEW_SMALL * 2;
  const big = PREVIEW_BIG * PREVIEW_BIG * 2;
  header.previewSmall = u8.subarray(off, off + small); off += small + 2;
  header.previewBig = u8.subarray(off, off + big); off += big + 2;
  off = readFields(dv, u8, off, HEADER_FIELDS, header);
  if (!header.version.startsWith('V3')) {
    throw new Error(`GOO ${header.version} is not supported (this reader handles V3.0)`);
  }
  const layers = [];
  let p = header.layerDefAddress || HEADER_SIZE;
  for (let i = 0; i < header.layerCount; i++) {
    if (p + LAYER_DEF_SIZE > u8.length) throw new Error(`File truncated at layer ${i}`);
    const def = {};
    let q = readFields(dv, u8, p, LAYER_FIELDS, def);
    q += 2;
    const dataLength = dv.getUint32(q); q += 4;
    if (q + dataLength + 2 > u8.length) throw new Error(`File truncated in layer ${i} image`);
    def.rle = u8.subarray(q, q + dataLength);
    layers.push(def);
    p = q + dataLength + 2;
  }
  return { header, layers };
}

// ---------------------------------------------------------------- print parameters

/** Exposure for a layer index, with a linear ramp across the transition layers. */
export function exposureForLayer(s, i) {
  if (i < s.bottomLayerCount) return s.bottomExposureTime;
  const t = s.transitionLayerCount | 0;
  if (t > 0 && i < s.bottomLayerCount + t) {
    const k = i - s.bottomLayerCount + 1;
    return s.bottomExposureTime - ((s.bottomExposureTime - s.exposureTime) * k) / (t + 1);
  }
  return s.exposureTime;
}

function moveSeconds(dist, speed) {
  // speeds are mm/min. Distances/speeds at or below 0.05 are tilt-release markers, not real moves.
  return dist > 0.05 && speed > 0.05 ? (dist / speed) * 60 : 0;
}

/** Seconds per layer + total, including motion. tiltSeconds is used when no real Z lift is configured. */
export function estimatePrintTime(s, layerCount, tiltSeconds = 6) {
  let total = 0;
  for (let i = 0; i < layerCount; i++) {
    const b = i < s.bottomLayerCount;
    const lift = b
      ? moveSeconds(s.bottomLiftHeight, s.bottomLiftSpeed) + moveSeconds(s.bottomLiftHeight2, s.bottomLiftSpeed2) +
        moveSeconds(s.bottomRetractHeight, s.bottomRetractSpeed) + moveSeconds(s.bottomRetractHeight2, s.bottomRetractSpeed2)
      : moveSeconds(s.liftHeight, s.liftSpeed) + moveSeconds(s.liftHeight2, s.liftSpeed2) +
        moveSeconds(s.retractHeight, s.retractSpeed) + moveSeconds(s.retractHeight2, s.retractSpeed2);
    const waits = b
      ? s.bottomWaitAfterCure + s.bottomWaitAfterLift + s.bottomWaitBeforeCure
      : s.waitAfterCure + s.waitAfterLift + s.waitBeforeCure;
    total += exposureForLayer(s, i) + waits + (lift > 0 ? lift : tiltSeconds);
  }
  return total;
}

/** Layer definition values for layer i from the global settings. */
export function layerDefFor(s, i, machineZ) {
  const b = i < s.bottomLayerCount;
  return {
    pause: 0,
    pausePositionZ: machineZ,
    positionZ: Math.round((i + 1) * s.layerHeight * 1000) / 1000,
    exposureTime: exposureForLayer(s, i),
    lightOffDelay: s.lightOffDelay ?? 0,
    waitAfterCure: b ? s.bottomWaitAfterCure : s.waitAfterCure,
    waitAfterLift: b ? s.bottomWaitAfterLift : s.waitAfterLift,
    waitBeforeCure: b ? s.bottomWaitBeforeCure : s.waitBeforeCure,
    liftHeight: b ? s.bottomLiftHeight : s.liftHeight,
    liftSpeed: b ? s.bottomLiftSpeed : s.liftSpeed,
    liftHeight2: b ? s.bottomLiftHeight2 : s.liftHeight2,
    liftSpeed2: b ? s.bottomLiftSpeed2 : s.liftSpeed2,
    retractHeight: b ? s.bottomRetractHeight : s.retractHeight,
    retractSpeed: b ? s.bottomRetractSpeed : s.retractSpeed,
    retractHeight2: b ? s.bottomRetractHeight2 : s.retractHeight2,
    retractSpeed2: b ? s.bottomRetractSpeed2 : s.retractSpeed2,
    lightPWM: b ? s.bottomLightPWM : s.lightPWM,
  };
}

/**
 * Assembles the final file as an array of parts suitable for `new Blob(parts)`.
 * layers: array of Uint8Array RLE images, in order.
 */
export function assembleGoo(header, settings, layers, machineZ) {
  const parts = [buildHeader({ ...settings, ...header, layerCount: layers.length })];
  for (let i = 0; i < layers.length; i++) {
    parts.push(buildLayerDef(layerDefFor(settings, i, machineZ), layers[i].length), layers[i], GOO_DELIM);
  }
  parts.push(GOO_FOOTER);
  return parts;
}
