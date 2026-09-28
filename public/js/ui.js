// Small DOM helpers, toasts, dialogs, form fields and the printer API client.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

export function toast(message, kind = 'info', ms = 4200) {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}`, role: 'status' }, el('span', {}, message), el('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  box.append(t);
  if (ms > 0) setTimeout(() => t.remove(), ms);
  return t;
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 1) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
export const fmt = (v, d = 1) => (Number.isFinite(v) ? (+v).toFixed(d) : '–');
export const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);

export function confirmDialog({ title, body, ok = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    const back = el('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); resolve(v); };
    back.append(el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('h2', {}, title), el('p', {}, body),
      el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), el('button', { class: `btn primary ${danger ? 'danger' : ''}`, onclick: () => close(true) }, ok))));
    back.addEventListener('click', (e) => { if (e.target === back) close(false); });
    document.body.append(back);
    back.querySelector('.btn.primary').focus();
  });
}

/** Progress modal. returns { set(fraction, label), close() } */
export function progressDialog(title, { onCancel } = {}) {
  const bar = el('div');
  const label = el('p', {}, 'Starting');
  const back = el('div', { class: 'modal-back' },
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-busy': 'true' }, el('h2', {}, title), label, el('div', { class: 'progress' }, bar),
      onCancel ? el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => { onCancel(); back.remove(); } }, 'Cancel')) : null));
  document.body.append(back);
  return {
    set(p, text) { bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; if (text) label.textContent = text; },
    close() { back.remove(); },
  };
}

/** Numeric field bound to obj[key]. */
export function numberField({ label, unit, obj, key, min, max, step = 0.01, onChange, hint, title }) {
  const input = el('input', { type: 'number', step, min, max, value: obj[key], title });
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) { input.value = obj[key]; return; }
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    input.value = v;
    obj[key] = v;
    onChange?.(v, key);
  });
  const f = el('div', { class: 'field' }, el('label', {}, label), el('span', { class: 'in' }, input, unit ? el('span', { class: 'unit' }, unit) : null));
  f.refresh = () => { input.value = obj[key]; };
  return hint ? el('div', {}, f, el('div', { class: 'field-hint' }, hint)) : f;
}

export function selectField({ label, obj, key, options, onChange, hint, wide }) {
  const sel = el('select', {}, options.map(([v, text]) => el('option', { value: v, selected: String(obj[key]) === String(v) }, text)));
  sel.addEventListener('change', () => { obj[key] = sel.value; onChange?.(sel.value); });
  const f = el('div', { class: `field ${wide ? 'wide' : ''}` }, el('label', {}, label), el('span', { class: 'in' }, sel));
  f.refresh = () => { sel.value = obj[key]; };
  return hint ? el('div', {}, f, el('div', { class: 'field-hint' }, hint)) : f;
}

export function toggleField({ label, obj, key, onChange, hint }) {
  const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!obj[key]), 'aria-label': label });
  b.addEventListener('click', () => { obj[key] = !obj[key]; b.setAttribute('aria-checked', String(obj[key])); onChange?.(obj[key]); });
  const f = el('div', { class: 'field toggle' }, el('label', {}, label), b);
  f.refresh = () => b.setAttribute('aria-checked', String(!!obj[key]));
  return hint ? el('div', {}, f, el('div', { class: 'field-hint' }, hint)) : f;
}

export function stat(k, v) { return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v)); }

// ---------------------------------------------------------------- printer bridge client

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export const printerApi = {
  discover: (ip) => jfetch(`/api/discover${ip ? `?ip=${encodeURIComponent(ip)}` : ''}`),
  info: (ip) => jfetch(`/api/printer/${encodeURIComponent(ip)}/info`),
  files: (ip) => jfetch(`/api/printer/${encodeURIComponent(ip)}/files`),
  print: (ip, filename) => jfetch(`/api/printer/${encodeURIComponent(ip)}/print`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) }),
  /** Streams progress lines; onLine gets each parsed JSON object. Resolves with the final line. */
  async upload(ip, blob, name, startPrint, onLine) {
    const r = await fetch(`/api/printer/${encodeURIComponent(ip)}/upload?name=${encodeURIComponent(name)}${startPrint ? '&print=1' : ''}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok || !r.body) throw new Error(`Upload failed (HTTP ${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', last = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { last = JSON.parse(line); onLine?.(last); } catch { /* partial */ }
        if (last?.error) throw new Error(last.error);
      }
    }
    return last;
  },
};
