// One slicing job: meshes in, encoded GOO layer images out. Used by the web worker and by the Node tests.
import { RleWriter } from './goo.js';
import { TriMesh, SegmentBuffer, LayerRasterizer, IslandDetector } from './raster.js';
import { cavityContours } from './voxel.js';

const NULL_SINK = { pixels: 0, run() {} };

export class SliceJob {
  /**
   * cfg: { machine, aa, layerHeight, solids:Float32Array, negatives?:Float32Array,
   *        hollows?:[{field,dims,origin,voxel,offset:[x,y,z]}], detectIslands?:boolean, islandCell?:number }
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.machine = cfg.machine;
    this.solid = new TriMesh(cfg.solids);
    this.neg = cfg.negatives && cfg.negatives.length ? new TriMesh(cfg.negatives) : null;
    this.hollows = cfg.hollows || [];
    this.raster = new LayerRasterizer(cfg.machine, cfg.aa);
    this.segs = new SegmentBuffer(1 << 14);
    this.detector = cfg.detectIslands ? new IslandDetector(cfg.machine, cfg.islandCell || 0.25) : null;
    this.lastIndex = -2;
    this.totalPixels = cfg.machine.resX * cfg.machine.resY;
  }

  _collect(i) {
    const z = (i + 0.5) * this.cfg.layerHeight;
    const segs = this.segs;
    segs.clear();
    this.solid.slice(z, segs, 0);
    if (this.neg) this.neg.slice(z, segs, 1);
    for (const h of this.hollows) cavityContours(h, z, segs, h.offset?.[0] || 0, h.offset?.[1] || 0, h.offset?.[2] || 0);
    return segs;
  }

  /** Slices layer i. Layers should be requested in ascending runs for best speed. */
  layer(i) {
    const det = this.detector;
    if (det && i > 0 && this.lastIndex !== i - 1) {
      // rebuild the previous layer's occupancy so the island test has something to compare with
      det.beginLayer();
      this.raster.rasterize(this._collect(i - 1), NULL_SINK, det.mark);
      det.endLayer(false);
    }
    const segs = this._collect(i);
    const rle = new RleWriter(16384);
    if (det) det.beginLayer();
    const box = this.raster.rasterize(segs, rle, det ? det.mark : undefined);
    const islands = det ? det.endLayer(i > 0) : [];
    const data = rle.finish(this.totalPixels);
    this.lastIndex = i;
    return { index: i, rle: data, lit: rle.lit, box, islands, segments: segs.n };
  }
}

/** Total layers needed to cover the solids: layers are sampled mid-height, so one whose sample plane is above maxZ is blank. */
export function layerCountFor(maxZ, layerHeight) {
  return Math.max(0, Math.ceil(maxZ / layerHeight - 0.5));
}
