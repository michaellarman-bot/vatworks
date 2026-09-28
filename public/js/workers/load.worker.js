import { parseModel } from '../loaders.js';
self.onmessage = async (e) => {
  const { id, name, buffer } = e.data;
  try {
    const r = await parseModel(name, buffer);
    if (!r.positions.length) throw new Error('The file contains no triangles.');
    self.postMessage({ id, ok: true, positions: r.positions, warnings: r.warnings }, [r.positions.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
