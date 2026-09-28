// LCD mask preview: draws a run-length layer exactly as the printer's screen would show it, with pan and zoom.
import { decodeRuns } from './core/goo.js';
import { plateTransform } from './core/raster.js';

export class MaskView {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.h = handlers;
    this.ctx = canvas.getContext('2d');
    this.scale = 0.1;
    this.ox = 0;
    this.oy = 0;
    this.rle = null;
    this.islands = [];
    this.acc = null;
    this.img = null;
    this.ro = new ResizeObserver(() => { this.resize(); });
    this.ro.observe(canvas.parentElement);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dpr = this.dpr;
      const mx = (e.clientX - rect.left) * dpr, my = (e.clientY - rect.top) * dpr;
      const k = Math.exp(-e.deltaY * 0.0015);
      const ns = Math.min(12, Math.max(this.fitScale * 0.6, this.scale * k));
      this.ox += mx / this.scale - mx / ns;
      this.oy += my / this.scale - my / ns;
      this.scale = ns;
      this.redraw();
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dpr = this.dpr;
      this.ox = this.drag.ox - ((e.clientX - this.drag.x) * dpr) / this.scale;
      this.oy = this.drag.oy - ((e.clientY - this.drag.y) * dpr) / this.scale;
      this.redraw();
    });
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('dblclick', () => { this.resetView(); this.redraw(); });
  }

  get dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  setMachine(m) {
    this.m = m;
    this.tf = plateTransform(m);
    this.resize();
    this.resetView();
    this.redraw();
  }

  resize() {
    const el = this.canvas.parentElement;
    const W = Math.max(1, Math.round(el.clientWidth * this.dpr)), H = Math.max(1, Math.round(el.clientHeight * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.acc = new Float32Array(W * H);
      this.img = this.ctx.createImageData(W, H);
      if (this.m) { this.resetView(); }
    }
    this.redraw();
  }

  resetView() {
    if (!this.m) return;
    const W = this.canvas.width - 80 * this.dpr, H = this.canvas.height; // leave room for the layer slider on the right
    this.fitScale = Math.min((W * 0.9) / this.m.resX, (H * 0.86) / this.m.resY);
    this.scale = this.fitScale;
    this.ox = this.m.resX / 2 - W / 2 / this.scale;
    this.oy = this.m.resY / 2 - H / 2 / this.scale;
  }

  setLayer(rle, islands = [], label = '') {
    this.rle = rle;
    this.islands = islands;
    this.label = label;
    this.redraw();
  }

  redraw() {
    if (!this.m || this.canvas.hidden) return;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, W, H);
    const s = this.scale, ox = this.ox, oy = this.oy;
    // LCD area
    ctx.fillStyle = '#000';
    ctx.fillRect(-ox * s, -oy * s, this.m.resX * s, this.m.resY * s);
    if (this.rle) {
      const acc = this.acc;
      acc.fill(0);
      const resX = this.m.resX;
      let pos = 0;
      decodeRuns(this.rle, (g, len) => {
        if (g) {
          let p = pos, left = len;
          while (left > 0) {
            const r = (p / resX) | 0, c = p - r * resX;
            const n = Math.min(left, resX - c);
            const Y0 = (r - oy) * s, Y1 = Y0 + s;
            if (Y1 > 0 && Y0 < H) {
              const X0 = (c - ox) * s, X1 = (c + n - ox) * s;
              if (X1 > 0 && X0 < W) {
                const j0 = Math.max(0, Y0 | 0), j1 = Math.min(H - 1, Math.ceil(Y1) - 1);
                const i0 = Math.max(0, X0 | 0), i1 = Math.min(W - 1, Math.ceil(X1) - 1);
                for (let j = j0; j <= j1; j++) {
                  const fy = Math.min(Y1, j + 1) - Math.max(Y0, j);
                  if (fy <= 0) continue;
                  const base = j * W;
                  for (let i = i0; i <= i1; i++) {
                    const fx = Math.min(X1, i + 1) - Math.max(X0, i);
                    if (fx > 0) acc[base + i] += g * fx * fy;
                  }
                }
              }
            }
            p += n;
            left -= n;
          }
        }
        pos += len;
      }, false);
      const d = this.img.data;
      const lx0 = Math.round(-ox * s), lx1 = Math.round((this.m.resX - ox) * s), ly0 = Math.round(-oy * s), ly1 = Math.round((this.m.resY - oy) * s);
      for (let j = 0, o = 0; j < H; j++) {
        const inRow = j >= ly0 && j < ly1;
        for (let i = 0; i < W; i++, o += 4) {
          const v = acc[j * W + i];
          if (v > 0.5) {
            const g = v > 255 ? 255 : v;
            d[o] = g; d[o + 1] = g; d[o + 2] = g;
          } else if (inRow && i >= lx0 && i < lx1) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; }
          else { d[o] = 11; d[o + 1] = 13; d[o + 2] = 17; }
          d[o + 3] = 255;
        }
      }
      ctx.putImageData(this.img, 0, 0);
    }
    // frame + centre lines
    ctx.strokeStyle = 'rgba(157,123,255,0.55)';
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.strokeRect(-ox * s, -oy * s, this.m.resX * s, this.m.resY * s);
    ctx.strokeStyle = 'rgba(157,123,255,0.18)';
    ctx.beginPath();
    ctx.moveTo((this.m.resX / 2 - ox) * s, -oy * s); ctx.lineTo((this.m.resX / 2 - ox) * s, (this.m.resY - oy) * s);
    ctx.moveTo(-ox * s, (this.m.resY / 2 - oy) * s); ctx.lineTo((this.m.resX - ox) * s, (this.m.resY / 2 - oy) * s);
    ctx.stroke();
    // islands
    for (const is of this.islands) {
      const px = this.tf.ax * is.x + this.tf.bx, py = this.tf.ay * is.y + this.tf.by;
      const X = (px - ox) * s, Y = (py - oy) * s;
      ctx.strokeStyle = '#e45f4e';
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.arc(X, Y, 11 * this.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    // scale bar (10 mm)
    const pxPerMm = (this.m.resX / this.m.width) * s;
    const barMm = pxPerMm * 10 > 40 * this.dpr ? 10 : pxPerMm * 50 > 40 * this.dpr ? 50 : 100;
    const bar = pxPerMm * barMm;
    ctx.fillStyle = 'rgba(243,244,243,0.9)';
    ctx.fillRect(16 * this.dpr, H - 22 * this.dpr, bar, 3 * this.dpr);
    ctx.font = `${12 * this.dpr}px Archivo, sans-serif`;
    ctx.fillText(`${barMm} mm`, 16 * this.dpr, H - 28 * this.dpr);
    if (this.label) ctx.fillText(this.label, 16 * this.dpr, 24 * this.dpr);
  }
}
