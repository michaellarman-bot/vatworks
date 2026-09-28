// Exercises server.js against the mock printer.  node test/bridge.test.mjs  (server must be running on 8090)
import crypto from 'node:crypto';
import { startMockPrinter } from './mock-printer.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8090';
const mock = startMockPrinter();
let failed = 0;
const ok = (c, m) => { console.log(c ? '  ok  ' : '  FAIL', m); if (!c) failed++; };
await new Promise((r) => setTimeout(r, 300));
try {
  const d = await (await fetch(`${base}/api/discover?ip=127.0.0.1`)).json();
  ok(d.printers?.length === 1 && d.printers[0].mainboardId === '0000000000mock01', `discovery finds the printer (${JSON.stringify(d).slice(0, 80)})`);
  const info = await (await fetch(`${base}/api/printer/127.0.0.1/info`)).json();
  ok(info.attributes?.Resolution === '15120x6230' && info.status?.CurrentStatus?.[0] === 0, 'info returns attributes + status');
  const files = await (await fetch(`${base}/api/printer/127.0.0.1/files`)).json();
  ok(files.Data?.FileList?.length === 1, 'file list');
  const payload = crypto.randomBytes(2_500_000);
  const md5 = crypto.createHash('md5').update(payload).digest('hex');
  const r = await fetch(`${base}/api/printer/127.0.0.1/upload?name=test%20file.goo&print=1`, { method: 'POST', body: payload });
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  const up = [...mock.state.uploads.values()][0];
  ok(lines.some((l) => l.stage === 'uploaded') && lines.at(-1).done, `upload streams progress and finishes (${lines.length} lines)`);
  ok(up && up.received === payload.length && up.parts.length === 3, `printer received 3 packets of 1 MB (got ${up?.parts.length})`);
  ok(up?.md5 === md5 && up.ok === true, 'MD5 header matches the reassembled file');
  ok(up?.name === 'test file.goo' && mock.state.prints[0] === 'test file.goo', 'print started with the uploaded file name');
  const p = await (await fetch(`${base}/api/printer/127.0.0.1/print`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'test.goo' }) })).json();
  ok(p.Data?.Ack === 0, 'explicit print command acknowledged');
  const bad = await (await fetch(`${base}/api/printer/8.8.8.8/info`)).json();
  ok(!!bad.error, 'public IPs are refused');
  ok(lines.at(-1).ack?.Data?.Ack === 0, 'final upload line carries the print acknowledgement');
  const octal = await (await fetch(`${base}/api/printer/010.010.010.010/info`)).json();
  ok(!!octal.error, 'leading-zero (octal) IPs are refused');
  const cross = await fetch(`${base}/api/printer/127.0.0.1/stop`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  ok(cross.status === 403 && !mock.state.commands.includes(130), 'cross-origin printer commands are refused');
  const empty = (await (await fetch(`${base}/api/printer/127.0.0.1/upload?name=e.goo&print=1`, { method: 'POST', body: new Uint8Array(0) })).text()).trim().split('\n').map((l) => JSON.parse(l));
  ok(empty.at(-1).error && !mock.state.prints.includes('e.goo'), 'an empty upload is rejected and never printed');
} catch (e) { ok(false, e.message); } finally { mock.close(); }
console.log(failed ? `${failed} FAILED` : 'bridge: all passed');
process.exit(failed ? 1 : 0);
