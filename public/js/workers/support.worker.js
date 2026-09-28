import { VerticalRayGrid } from '../core/geom.js';
import { autoSupports, buildAll, planSupport } from '../core/supports.js';
const cache = new Map();
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'forget') { cache.delete(m.objectId); return; }
    let entry = cache.get(m.objectId);
    if (m.tris) { entry = { tris: m.tris, grid: new VerticalRayGrid(m.tris) }; cache.set(m.objectId, entry); }
    if (!entry) throw new Error('needs-geometry');
    if (m.type === 'auto') {
      const { plans, skipped } = autoSupports(entry.tris, m.opt, entry.grid);
      const built = buildAll(plans, entry.grid, m.opt);
      self.postMessage({ id: m.id, plans, skipped, tris: built.tris, ranges: built.ranges }, [built.tris.buffer]);
    } else if (m.type === 'build') {
      const built = buildAll(m.plans, entry.grid, m.opt);
      self.postMessage({ id: m.id, plans: m.plans, tris: built.tris, ranges: built.ranges }, [built.tris.buffer]);
    } else if (m.type === 'plan') {
      self.postMessage({ id: m.id, plan: planSupport(m.contact, entry.grid, m.opt) });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: err.message || String(err) });
  }
};
