import { computeCavity, chooseVoxel, surfaceNets } from '../core/voxel.js';
import { bounds } from '../core/geom.js';
self.onmessage = (e) => {
  const { id, tris, wall, maxVoxels } = e.data;
  try {
    const bb = bounds(tris);
    const voxel = chooseVoxel(bb, wall, maxVoxels || 12e6);
    const cav = computeCavity(tris, bb, wall, voxel, (p, label) => self.postMessage({ id, progress: p, label }));
    const cells = cav.dims[0] * cav.dims[1] * cav.dims[2];
    const preview = surfaceNets(cav, cells > 3e6 ? 2 : 1);
    self.postMessage({ id, done: true, ...cav, preview }, [cav.field.buffer, preview.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
