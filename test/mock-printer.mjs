// A fake SDCP v3 printer for testing the bridge: UDP discovery on 3000, WebSocket + HTTP upload on 3030.
// Run standalone:  node test/mock-printer.mjs   (uses the `ws` package from the tools folder; test-only)
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export function startMockPrinter({ udpPort = 3000, port = 3030, ip = '127.0.0.1' } = {}) {
  const ID = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8', BOARD = '0000000000mock01';
  const state = { uploads: new Map(), prints: [], commands: [] };
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    if (msg.toString() !== 'M99999') return;
    udp.send(JSON.stringify({ Id: ID, Data: { Name: 'Mock Saturn', MachineName: 'Saturn 4 Ultra 16K', BrandName: 'ELEGOO', MainboardIP: ip, MainboardID: BOARD, ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6B' } }), rinfo.port, rinfo.address);
  });
  udp.bind(udpPort);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/uploadFile/upload') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const boundary = '--' + /boundary=(.+)$/.exec(req.headers['content-type'])[1];
      const fields = {};
      let file = null;
      let p = body.indexOf(boundary);
      while (p >= 0) {
        const hdrEnd = body.indexOf('\r\n\r\n', p);
        if (hdrEnd < 0) break;
        const header = body.slice(p, hdrEnd).toString('latin1');
        const next = body.indexOf(boundary, hdrEnd);
        if (next < 0) break;
        const content = body.slice(hdrEnd + 4, next - 2);
        const name = /name="([^"]+)"/.exec(header)?.[1];
        if (/filename="/.test(header)) file = { name: /filename="([^"]+)"/.exec(header)[1], data: content };
        else if (name) fields[name] = content.toString();
        p = next;
        if (body.slice(next, next + boundary.length + 2).toString() === boundary + '--') break;
      }
      const u = state.uploads.get(fields.Uuid) || { parts: [], md5: fields['S-File-MD5'], total: +fields.TotalSize, name: file?.name, received: 0 };
      if (+fields.Offset !== u.received) { res.writeHead(200); return res.end(JSON.stringify({ code: '111111', messages: [{ field: 'common_field', message: -2 }], success: false })); }
      u.parts.push(file.data);
      u.received += file.data.length;
      state.uploads.set(fields.Uuid, u);
      if (u.received >= u.total) u.ok = crypto.createHash('md5').update(Buffer.concat(u.parts)).digest('hex') === u.md5;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: '000000', messages: null, data: {}, success: true }));
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/websocket' });
  wss.on('connection', (ws) => {
    const send = (o) => ws.send(JSON.stringify(o));
    ws.on('message', (raw) => {
      if (raw.toString() === 'ping') return ws.send('pong');
      const m = JSON.parse(raw);
      const { Cmd, RequestID } = m.Data;
      state.commands.push(Cmd);
      let data = { Ack: 0 };
      if (Cmd === 258) data = { Ack: 0, FileList: [{ name: '/local/test.goo', usedSize: 100, totalSize: 200, storageType: 0, type: 1 }] };
      if (Cmd === 128) state.prints.push(m.Data.Data.Filename);
      send({ Id: ID, Data: { Cmd, Data: data, RequestID, MainboardID: BOARD, TimeStamp: 1 }, Topic: `sdcp/response/${BOARD}` });
      if (Cmd === 1) send({ Attributes: { Name: 'Mock Saturn', MachineName: 'Saturn 4 Ultra 16K', Resolution: '15120x6230', XYZsize: '211x118x220', SupportFileType: ['GOO', 'CTB'], FirmwareVersion: 'V1.5.6B' }, MainboardID: BOARD, TimeStamp: 1, Topic: `sdcp/attributes/${BOARD}` });
      if (Cmd === 0) send({ Status: { CurrentStatus: [0], PreviousStatus: 0, TempOfUVLED: 25, PrintInfo: { Status: 0, CurrentLayer: 0, TotalLayer: 0, Filename: '' } }, MainboardID: BOARD, TimeStamp: 1, Topic: `sdcp/status/${BOARD}` });
    });
  });
  server.listen(port, '127.0.0.1');
  return { state, close: () => { udp.close(); wss.close(); server.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockPrinter();
  console.log('mock printer up: udp 3000, ws/http 3030');
}
