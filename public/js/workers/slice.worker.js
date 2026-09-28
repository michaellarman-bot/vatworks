import { SliceJob } from '../core/pipeline.js';
self.onmessage = (e) => {
  const { id, cfg, from, to } = e.data;
  try {
    const job = new SliceJob(cfg);
    const rles = [], stats = [];
    let last = performance.now();
    for (let i = from; i < to; i++) {
      const L = job.layer(i);
      rles.push(L.rle);
      stats.push({ lit: L.lit, box: L.box, islands: L.islands });
      const now = performance.now();
      if (now - last > 100) { last = now; self.postMessage({ id, progress: i - from + 1 }); }
    }
    self.postMessage({ id, done: true, from, rles, stats }, rles.map((r) => r.buffer));
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
