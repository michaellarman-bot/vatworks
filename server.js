#!/usr/bin/env node
// Vatworks server — serves the app and bridges the browser to Elegoo / ChiTu printers that speak SDCP v3.0
// on the local network (the Saturn 4 Ultra family). No dependencies; needs Node 22+ (built-in WebSocket + fetch).
//
//   PORT=8090 node server.js
//
// Printer bridge (all JSON):
//   GET  /api/discover?ip=192.168.0.29      UDP "M99999" broadcast + unicast; lists printers that answered
//   GET  /api/printer/:ip/info              discovery record + SDCP attributes + status
//   GET  /api/printer/:ip/files             files in the printer's local storage
//   POST /api/printer/:ip/upload?name=x.goo raw body -> 1 MB multipart chunks to the printer; streams progress lines
//   POST /api/printer/:ip/print   {filename}  start printing an uploaded file
//   POST /api/printer/:ip/pause | /resume | /stop
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let PUBLIC = path.join(__dirname, 'public');
const SDCP_PORT = +(process.env.SDCP_PORT || 3030);
const DISCOVERY_PORT = +(process.env.SDCP_DISCOVERY_PORT || 3000);
const DISCOVERY_MS = +(process.env.DISCOVERY_MS || 2500);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- helpers

function isPrivateIp(ip) {
  // no leading zeros: URL and getaddrinfo read "010" as octal, which would slip past this check
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(ip || '');
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const ip = ni.address.split('.').map(Number), mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/** Sends "M99999" to the LAN (and to `ip` directly when given) and collects the JSON replies. */
function discover({ ip, timeout = DISCOVERY_MS } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
      return resolve([]);
    }
    const finish = () => {
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        const d = j.Data || {};
        const rec = {
          id: j.Id, name: d.Name, model: d.MachineName, brand: d.BrandName, ip: d.MainboardIP || rinfo.address,
          mainboardId: d.MainboardID, protocol: d.ProtocolVersion, firmware: d.FirmwareVersion, from: rinfo.address,
        };
        found.set(rec.mainboardId || rec.ip, rec);
      } catch { /* not an SDCP reply */ }
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* not permitted in some sandboxes */ }
      const targets = broadcastAddresses();
      if (ip) targets.push(ip);
      const payload = Buffer.from('M99999');
      for (const t of targets) sock.send(payload, DISCOVERY_PORT, t, () => {});
      setTimeout(finish, timeout);
    });
  });
}

const boardCache = new Map(); // ip -> { rec, ts }
async function board(ip) {
  const c = boardCache.get(ip);
  if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.rec;
  const list = await discover({ ip, timeout: 1500 });
  const rec = list.find((r) => r.ip === ip || r.from === ip) || null;
  if (!rec) throw new Error(`No SDCP printer answered at ${ip} (UDP port ${DISCOVERY_PORT}). Check the IP and that the printer is on and connected to Wi-Fi.`);
  boardCache.set(ip, { rec, ts: Date.now() });
  return rec;
}

/** Opens a WebSocket session with the printer; send(cmd, data) resolves with the response's Data block. */
function openSdcp(ip, rec, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') return reject(new Error('This Node version has no built-in WebSocket; use Node 22 or newer.'));
    const ws = new WebSocket(`ws://${ip}:${SDCP_PORT}/websocket`);
    const pending = new Map();
    const listeners = [];
    const topics = { attributes: null, status: null };
    const openTimer = setTimeout(() => { ws.close(); reject(new Error('Timed out connecting to the printer\u2019s WebSocket (port 3030).')); }, timeout);
    ws.onerror = () => { clearTimeout(openTimer); reject(new Error(`Could not open ws://${ip}:${SDCP_PORT}/websocket`)); };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const topic = String(msg.Topic || '');
      if (topic.startsWith('sdcp/attributes/')) topics.attributes = msg.Attributes || msg.Data?.Attributes || msg;
      if (topic.startsWith('sdcp/status/')) topics.status = msg.Status || msg.Data?.Status || msg;
      const rid = msg.Data?.RequestID;
      if (rid && pending.has(rid)) {
        const p = pending.get(rid);
        pending.delete(rid);
        clearTimeout(p.timer);
        p.resolve(msg.Data);
      }
      for (const fn of listeners) fn(msg);
    };
    ws.onopen = () => {
      clearTimeout(openTimer);
      resolve({
        topics,
        onMessage: (fn) => listeners.push(fn),
        send(cmd, data = {}, ms = timeout) {
          return new Promise((res, rej) => {
            const requestId = crypto.randomBytes(8).toString('hex');
            const timer = setTimeout(() => { pending.delete(requestId); rej(new Error(`Printer did not acknowledge command ${cmd}.`)); }, ms);
            pending.set(requestId, { resolve: res, timer });
            ws.send(JSON.stringify({
              Id: rec.id, Topic: `sdcp/request/${rec.mainboardId}`,
              Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: rec.mainboardId, TimeStamp: Math.floor(Date.now() / 1000), From: 0 },
            }));
          });
        },
        close: () => { try { ws.close(); } catch { /* ignore */ } },
      });
    };
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function withPrinter(ip, fn) {
  const rec = await board(ip);
  const s = await openSdcp(ip, rec);
  try { return await fn(s, rec); } finally { s.close(); }
}

async function printerInfo(ip) {
  return withPrinter(ip, async (s, rec) => {
    const ack1 = await s.send(1).catch((e) => ({ error: e.message }));
    const ack0 = await s.send(0).catch((e) => ({ error: e.message }));
    for (let i = 0; i < 30 && !(s.topics.attributes && s.topics.status); i++) await delay(100);
    return { discovery: rec, attributes: s.topics.attributes, status: s.topics.status, acks: { attributes: ack1, status: ack0 } };
  });
}

async function md5File(file) {
  const h = crypto.createHash('md5');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Uploads a file to the printer in 1 MB multipart packets, as the SDCP spec describes. */
async function uploadToPrinter(ip, file, filename, size, onProgress) {
  const md5 = await md5File(file);
  const uuid = crypto.randomUUID().replace(/-/g, '');
  const CHUNK = 1 << 20;
  const fh = await fs.promises.open(file, 'r');
  try {
    for (let off = 0; off < size; off += CHUNK) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, off);
      const fd = new FormData();
      fd.append('S-File-MD5', md5);
      fd.append('Check', '1');
      fd.append('Offset', String(off));
      fd.append('Uuid', uuid);
      fd.append('TotalSize', String(size));
      fd.append('File', new Blob([buf]), filename);
      const res = await fetch(`http://${ip}:${SDCP_PORT}/uploadFile/upload`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON reply */ }
      if (!res.ok || (json && json.success === false)) {
        const why = json?.messages ? JSON.stringify(json.messages) : text.slice(0, 200) || `HTTP ${res.status}`;
        throw new Error(`Printer rejected the packet at offset ${off}: ${why}`);
      }
      onProgress(off + len);
    }
  } finally {
    await fh.close();
  }
  return { md5, uuid };
}

// ---------------------------------------------------------------- http

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Browsers always send Origin on cross-site POSTs; refuse them so other pages cannot drive the printer. */
function crossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  // a reverse proxy may rewrite Host; it then usually passes the original in X-Forwarded-Host
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',').map((h) => h.trim())];
  try { return !hosts.includes(new URL(origin).host); } catch { return true; }
}

async function api(req, res, url) {
  if (crossOrigin(req)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'discover' && req.method === 'GET') {
    const ip = url.searchParams.get('ip') || undefined;
    if (ip && !isPrivateIp(ip)) return json(res, 400, { error: 'Only private LAN addresses are allowed.' });
    const printers = await discover({ ip });
    for (const p of printers) if (p.ip) boardCache.set(p.ip, { rec: p, ts: Date.now() });
    return json(res, 200, { printers });
  }
  if (parts[1] === 'printer' && parts[2]) {
    const ip = parts[2];
    if (!isPrivateIp(ip)) return json(res, 400, { error: 'Only private LAN addresses are allowed.' });
    const action = parts[3];
    if (action === 'info' && req.method === 'GET') return json(res, 200, await printerInfo(ip));
    if (action === 'files' && req.method === 'GET') {
      const data = await withPrinter(ip, (s) => s.send(258, { Url: url.searchParams.get('path') || '/local/' }));
      return json(res, 200, data);
    }
    if (action === 'print' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.filename) return json(res, 400, { error: 'filename is required' });
      const data = await withPrinter(ip, (s) => s.send(128, { Filename: body.filename, StartLayer: body.startLayer | 0 }, 20000));
      return json(res, 200, data);
    }
    const simple = { pause: 129, stop: 130, resume: 131, refresh: 0 };
    if (action in simple && req.method === 'POST') return json(res, 200, await withPrinter(ip, (s) => s.send(simple[action])));
    if (action === 'upload' && req.method === 'POST') {
      const filename = (url.searchParams.get('name') || 'vatworks.goo').replace(/[^\w.\- ]+/g, '_');
      const tmp = path.join(os.tmpdir(), `vatworks-${crypto.randomUUID()}.upload`);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const line = (o) => res.write(JSON.stringify(o) + '\n');
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        const size = (await fs.promises.stat(tmp)).size;
        if (!size) throw new Error('The upload was empty.');
        line({ stage: 'received', total: size });
        const startPrint = url.searchParams.get('print') === '1';
        const r = await uploadToPrinter(ip, tmp, filename, size, (sent) => line({ stage: 'upload', sent, total: size }));
        line({ stage: 'uploaded', filename, md5: r.md5, total: size });
        if (startPrint) {
          const ack = await withPrinter(ip, (s) => s.send(128, { Filename: filename, StartLayer: 0 }, 20000));
          line({ stage: 'print', ack });
          line({ done: true, filename, ack });
        } else line({ done: true, filename });
      } catch (e) {
        line({ error: e.message });
      } finally {
        fs.promises.unlink(tmp).catch(() => {});
        res.end();
      }
      return;
    }
  }
  json(res, 404, { error: 'Unknown API route' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return json(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    const immutable = p.startsWith('/vendor/') || p.startsWith('/fonts/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/** Creates the HTTP server without listening. Used by the CLI below and by the desktop app. */
export function createServer({ publicDir } = {}) {
  if (publicDir) PUBLIC = publicDir;
  return http.createServer(async (req, res) => {
    let url;
    try {
      // a fixed base: a malformed Host header must not throw outside the try (it would kill the process)
      url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      log('error', req.method, url?.pathname ?? req.url, e.message);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });
}

/** Starts listening; resolves with the bound port (pass port 0 for a random free port). */
export function start({ port = +(process.env.PORT || 8090), host = process.env.HOST || '0.0.0.0', publicDir } = {}) {
  const server = createServer({ publicDir });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      log(`Vatworks listening on http://${host}:${bound}  (static: ${PUBLIC})`);
      resolve({ server, port: bound });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) start().catch((e) => { console.error(e.message); process.exit(1); });
