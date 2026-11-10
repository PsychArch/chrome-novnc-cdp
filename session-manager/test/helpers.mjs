import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const tlsOptions = {
  key: fs.readFileSync(new URL('./fixtures/key.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/ca.pem', import.meta.url)),
};
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function listen(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function origin(secure = false) {
  const requests = [];
  const handler = (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>direct-origin</body></html>');
  };
  return { ...await listen(secure ? https.createServer(tlsOptions, handler) : http.createServer(handler)), requests };
}

export async function upstreamProxy(label, { secure = false, username, password } = {}) {
  const requests = [];
  const authorized = (req) => username === undefined || req.headers['proxy-authorization'] === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = secure ? https.createServer(tlsOptions) : http.createServer();
  server.on('request', (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      res.end('Proxy authentication required');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body>${label}</body></html>`);
  });
  server.on('connect', (req, socket, head) => {
    requests.push({ url: req.url, headers: req.headers, connect: true });
    if (!authorized(req)) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const port = Number(req.url.split(':').at(-1));
    const target = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy());
  });
  return { ...await listen(server), requests };
}

export async function socksProxy({ username, password } = {}) {
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    const handle = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (stage === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          const method = username === undefined ? 0 : 2;
          assert.equal(buffer[0], 5);
          assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(method));
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, method]));
          stage = method === 2 ? 'auth' : 'request';
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userEnd = 2 + buffer[1];
          if (buffer.length < userEnd + 1 || buffer.length < userEnd + 1 + buffer[userEnd]) return;
          const passEnd = userEnd + 1 + buffer[userEnd];
          const valid = buffer.subarray(2, userEnd).toString() === username && buffer.subarray(userEnd + 1, passEnd).toString() === password;
          buffer = buffer.subarray(passEnd);
          socket.write(Buffer.from([1, valid ? 0 : 1]));
          if (!valid) { socket.end(); return; }
          stage = 'request';
        } else {
          if (buffer.length < 5) return;
          const atyp = buffer[3];
          const hostEnd = atyp === 3 ? 5 + buffer[4] : atyp === 1 ? 8 : 20;
          if (buffer.length < hostEnd + 2) return;
          const hostname = atyp === 3 ? buffer.subarray(5, hostEnd).toString() : '127.0.0.1';
          const port = buffer.readUInt16BE(hostEnd);
          requests.push({ hostname, port, atyp });
          const rest = buffer.subarray(hostEnd + 2);
          socket.off('data', handle);
          socket.pause();
          const target = net.connect(port, '127.0.0.1', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (rest.length) target.write(rest);
            socket.pipe(target).pipe(socket);
            socket.resume();
          });
          target.on('error', () => socket.destroy());
          socket.on('close', () => target.destroy());
          return;
        }
      }
    };
    socket.on('data', handle);
  });
  return { ...await listen(server), requests };
}

export async function connectCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connection timed out')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const payload = JSON.parse(data);
    const command = pending.get(payload.id);
    if (!command) return;
    pending.delete(payload.id);
    clearTimeout(command.timer);
    if (payload.error) command.reject(new Error(payload.error.message));
    else command.resolve(payload.result);
  });
  ws.addEventListener('close', () => {
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(new Error('CDP closed')); }
    pending.clear();
  });
  return {
    close: () => ws.close(),
    command: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
  };
}

export async function pageClient(session) {
  const cdp = await connectCdp(session.links.cdp);
  const { targetInfos } = await cdp.command('Target.getTargets');
  const target = targetInfos.find((info) => info.type === 'page');
  assert.ok(target, 'session should contain a page');
  const { sessionId } = await cdp.command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return {
    cdp,
    sessionId,
    navigate: async (url, expected) => {
      const result = await cdp.command('Page.navigate', { url }, sessionId);
      if (result.errorText) return { error: result.errorText };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await cdp.command('Runtime.evaluate', { expression: 'document.body?.innerText', returnByValue: true }, sessionId);
        if (result.result?.value === expected) return { text: expected };
        await delay(100);
      }
      throw new Error(`Page did not show expected response: ${expected}`);
    },
  };
}
