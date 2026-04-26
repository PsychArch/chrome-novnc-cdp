import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const env = process.env;
const config = {
  bindHost: envValue('BIND_HOST', ['SERVICE_BIND_HOST'], '0.0.0.0'),
  publicHost: env.PUBLIC_CDP_HOST || '127.0.0.1',
  publicBasePath: normalizeBasePath(envValue('PUBLIC_CDP_BASE_PATH', ['CDP_BASE_PATH'], '')),
  port: parseInteger(envValue('CDP_PORT', ['SESSION_MANAGER_PORT'], '9222'), 'CDP_PORT'),
  chromePort: parseInteger(envValue('PRIVATE_CDP_PORT', ['CHROME_REMOTE_DEBUGGING_PORT'], '9223'), 'PRIVATE_CDP_PORT'),
  idleTtlMs: parseDurationMs(
    envValue('SESSION_IDLE_TIMEOUT', ['SESSION_IDLE_TIMEOUT_MS', 'SESSION_IDLE_TTL_MS'], '1h'),
    'SESSION_IDLE_TIMEOUT',
  ),
  sweepIntervalMs: parseDurationMs(
    envValue('SESSION_SWEEP_INTERVAL', ['SESSION_SWEEP_INTERVAL_MS'], '15s'),
    'SESSION_SWEEP_INTERVAL',
  ),
  maxSessions: parseInteger(envValue('MAX_SESSIONS', ['MAX_CONCURRENT_SESSIONS'], '4'), 'MAX_SESSIONS'),
  compatAutoSession: parseBool(
    envValue('CDP_COMPAT_AUTO_SESSION', ['COMPAT_AUTO_SESSION'], 'true'),
    true,
    'CDP_COMPAT_AUTO_SESSION',
  ),
  compatUnauthLocal: parseBool(
    envValue('CDP_ALLOW_UNAUTHENTICATED_LOCAL', ['COMPAT_UNAUTH_LOCAL'], 'false'),
    false,
    'CDP_ALLOW_UNAUTHENTICATED_LOCAL',
  ),
  allowQueryToken: parseBool(
    envValue('CDP_ALLOW_QUERY_TOKEN', ['ALLOW_QUERY_TOKEN'], 'false'),
    false,
    'CDP_ALLOW_QUERY_TOKEN',
  ),
  apiToken: envValue('CDP_AUTH_TOKEN', ['API_TOKEN'], ''),
  startUrl: envValue('BROWSER_START_URL', ['START_URL'], 'about:blank'),
  screenWidth: parseInteger(envValue('BROWSER_WIDTH', ['SCREEN_WIDTH'], '1920'), 'BROWSER_WIDTH'),
  screenHeight: parseInteger(envValue('BROWSER_HEIGHT', ['SCREEN_HEIGHT'], '1080'), 'BROWSER_HEIGHT'),
  chromeExtraArgs: splitArgs(envValue('BROWSER_EXTRA_ARGS', ['CHROME_EXTRA_ARGS'], '')),
};

validateConfig();

let chromeProc = null;
let chromeUserDataDir = null;
let chromeStopping = false;
let controlWs = null;
let controlReady = null;
let controlId = 0;
const controlPending = new Map();
const sessions = new Map();
let pendingSessionCreations = 0;
let compatSessionId = null;
const targetToSession = new Map();
let sweepTimer = null;

class ManagedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function envValue(primaryName, aliasNames = [], fallback = '') {
  for (const name of [primaryName, ...aliasNames]) {
    if (env[name] !== undefined && env[name] !== '') return env[name];
  }
  return fallback;
}

function parseInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function parseDurationMs(value, name) {
  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/^([0-9]+)(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`${name} must be a positive duration such as 15000, 15s, 30m, or 1h`);
  }
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  const ms = amount * multiplier;
  if (ms <= 0) {
    throw new Error(`${name} must be a positive duration such as 15000, 15s, 30m, or 1h`);
  }
  return ms;
}

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  if (!raw.startsWith('/')) {
    throw new Error('PUBLIC_CDP_BASE_PATH must be empty or start with /');
  }
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('PUBLIC_CDP_BASE_PATH must be a path, not a URL or query string');
  }
  return raw.replace(/\/+$/, '');
}

class SimpleWebSocket extends EventEmitter {
  constructor(socket, { maskOutgoing }) {
    super();
    this.socket = socket;
    this.maskOutgoing = maskOutgoing;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#emitClose());
    socket.on('error', (error) => this.emit('error', error));
  }

  sendText(text) {
    this.#sendFrame(0x1, Buffer.from(text));
  }

  sendJson(payload) {
    this.sendText(JSON.stringify(payload));
  }

  sendPong(payload = Buffer.alloc(0)) {
    this.#sendFrame(0xA, payload);
  }

  ping() {
    this.#sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason);
    const payload = Buffer.alloc(Math.min(123, 2 + reasonBuffer.length));
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2, 0, payload.length - 2);
    this.#sendFrame(0x8, payload);
    this.socket.end();
    this.#emitClose();
  }

  destroy() {
    this.socket.destroy();
    this.#emitClose();
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          this.destroy();
          return;
        }
        length = low;
        offset += 8;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
      else if (opcode === 0x8) this.close();
      else if (opcode === 0x9) this.sendPong(payload);
      else if (opcode === 0xA) this.emit('pong');
    }
  }

  #sendFrame(opcode, payload) {
    if (this.closed) return;
    const length = payload.length;
    let headerLength = 2;
    if (length >= 126 && length <= 65535) headerLength += 2;
    else if (length > 65535) headerLength += 8;
    if (this.maskOutgoing) headerLength += 4;
    const header = Buffer.alloc(headerLength);
    header[0] = 0x80 | opcode;
    let offset = 2;
    if (length < 126) {
      header[1] = length;
    } else if (length <= 65535) {
      header[1] = 126;
      header.writeUInt16BE(length, offset);
      offset += 2;
    } else {
      header[1] = 127;
      header.writeUInt32BE(0, offset);
      header.writeUInt32BE(length, offset + 4);
      offset += 8;
    }
    let body = payload;
    if (this.maskOutgoing) {
      header[1] |= 0x80;
      const mask = crypto.randomBytes(4);
      mask.copy(header, offset);
      offset += 4;
      body = Buffer.from(payload);
      for (let index = 0; index < body.length; index += 1) {
        body[index] ^= mask[index % 4];
      }
    }
    this.socket.write(Buffer.concat([header, body]));
  }

  #emitClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class Session {
  constructor({ id, browserContextId, kind }) {
    const now = new Date();
    this.id = id;
    this.browserContextId = browserContextId;
    this.kind = kind;
    this.state = 'running';
    this.mode = 'context';
    this.createdAt = now;
    this.lastActivityAt = now;
    this.activeConnections = 0;
    this.targets = new Set();
    this.clientSockets = new Set();
    this.cdpSessions = new Set();
    this.closing = false;
  }

  touch() {
    this.lastActivityAt = new Date();
  }

  summary() {
    return {
      id: this.id,
      state: this.state,
      mode: this.mode,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
      idleExpiresAt: new Date(this.lastActivityAt.getTime() + config.idleTtlMs).toISOString(),
      activeConnections: this.activeConnections,
      ttlPolicy: 'idle',
    };
  }
}

function parseBool(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value`);
}

function splitArgs(value) {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function jsonResponse(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function textResponse(res, status, message, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(message);
}

function normalizePathname(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function stripPublicBasePath(pathname) {
  const normalized = normalizePathname(pathname);
  if (!config.publicBasePath) return normalized;
  if (normalized === config.publicBasePath) return '/';
  if (normalized.startsWith(`${config.publicBasePath}/`)) {
    return normalizePathname(normalized.slice(config.publicBasePath.length) || '/');
  }
  return normalized;
}

function publicPath(pathname) {
  return `${config.publicBasePath}${pathname}`;
}

function requireAuth(req, url, { compatibility = false } = {}) {
  if (!config.apiToken) return;
  if (compatibility && config.compatUnauthLocal && isLocalRequest(req)) return;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const queryToken = config.allowQueryToken ? url.searchParams.get('token') || '' : '';
  if (!constantTimeEqual(bearer, config.apiToken) && !constantTimeEqual(queryToken, config.apiToken)) {
    throw new ManagedError(401, 'Unauthorized');
  }
}

function validateConfig() {
  for (const [name, value] of [
    ['SESSION_IDLE_TIMEOUT', config.idleTtlMs],
    ['SESSION_SWEEP_INTERVAL', config.sweepIntervalMs],
    ['MAX_SESSIONS', config.maxSessions],
    ['CDP_PORT', config.port],
    ['PRIVATE_CDP_PORT', config.chromePort],
    ['BROWSER_WIDTH', config.screenWidth],
    ['BROWSER_HEIGHT', config.screenHeight],
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must resolve to a positive integer`);
    }
  }
}

function constantTimeEqual(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isLocalRequest(req) {
  // When BIND_HOST is a loopback address, the OS kernel has already enforced
  // that only loopback peers can reach us, so every request is local by
  // construction. In bridge-networking mode with -p 127.0.0.1:9222:9222,
  // Docker may route through a userland proxy that rewrites the source to the
  // bridge gateway IP, so we cannot rely solely on req.socket.remoteAddress.
  const bind = String(config.bindHost).toLowerCase();
  if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') return true;
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function externalWsUrl(req, pathname) {
  const host = req.headers.host || `${config.publicHost}:${config.port}`;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const scheme = forwardedProto === 'https' ? 'wss' : 'ws';
  return `${scheme}://${host}${publicPath(pathname)}`;
}

function sessionLinks(req, session) {
  return {
    cdp: externalWsUrl(req, `/sessions/${session.id}/cdp`),
    version: publicPath(`/sessions/${session.id}/json/version`),
    list: publicPath(`/sessions/${session.id}/json/list`),
  };
}

async function httpJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${config.chromePort}${pathname}`);
  if (!response.ok) throw new Error(`Chromium ${pathname} returned ${response.status}`);
  return response.json();
}

async function connectWebSocket(wsUrl) {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== 'ws:') throw new Error(`Unsupported WebSocket protocol: ${parsed.protocol}`);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(Number(parsed.port || '80'), parsed.hostname);
  socket.setNoDelay(true);
  await onceEvent(socket, 'connect');
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  socket.write([
    `GET ${pathWithQuery} HTTP/1.1`,
    `Host: ${parsed.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n'));

  let buffer = Buffer.alloc(0);
  while (!buffer.includes(Buffer.from('\r\n\r\n'))) {
    const chunk = await onceEvent(socket, 'data');
    buffer = Buffer.concat([buffer, chunk]);
  }
  const headerEnd = buffer.indexOf('\r\n\r\n');
  const header = buffer.subarray(0, headerEnd).toString('latin1');
  if (!header.startsWith('HTTP/1.1 101')) {
    socket.destroy();
    throw new Error(`WebSocket upgrade failed: ${header.split('\r\n')[0]}`);
  }
  const ws = new SimpleWebSocket(socket, { maskOutgoing: true });
  const rest = buffer.subarray(headerEnd + 4);
  if (rest.length) ws.socket.emit('data', rest);
  return ws;
}

function onceEvent(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      cleanup();
      resolve(args.length === 1 ? args[0] : args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      emitter.off(eventName, onEvent);
      emitter.off('error', onError);
    };
    emitter.once(eventName, onEvent);
    emitter.once('error', onError);
  });
}

async function ensureChrome() {
  if (chromeProc && !chromeProc.killed && controlWs && !controlWs.closed) return;
  if (controlReady) return controlReady;
  controlReady = startChromeAndControl().finally(() => {
    controlReady = null;
  });
  await controlReady;
}

async function startChromeAndControl() {
  chromeStopping = false;
  if (!chromeProc) {
    fs.mkdirSync('/tmp/chrome-sessions', { recursive: true });
    chromeUserDataDir = fs.mkdtempSync(path.join('/tmp/chrome-sessions', 'user-data-'));
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-crash-reporter',
      `--remote-debugging-port=${config.chromePort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${chromeUserDataDir}`,
      `--window-size=${config.screenWidth},${config.screenHeight}`,
      ...config.chromeExtraArgs,
      config.startUrl,
    ];
    chromeProc = spawn('chromium-browser', args, {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', HOME: '/home/chrome' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    chromeProc.once('exit', (code, signal) => onChromeExit(code, signal));
  }

  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const version = await httpJson('/json/version');
      controlWs = await connectWebSocket(version.webSocketDebuggerUrl);
      controlWs.on('message', (message) => handleControlMessage(message));
      controlWs.on('close', () => {
        rejectControlPending(new Error('Chromium control connection closed'));
        if (!chromeStopping) {
          failAllSessions('control connection closed');
          chromeStopping = true;
          chromeProc?.kill('SIGTERM');
        }
      });
      await controlCommand('Target.setDiscoverTargets', { discover: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error('Chromium did not become ready');
}

function onChromeExit(code, signal) {
  const wasStopping = chromeStopping;
  chromeProc = null;
  controlWs = null;
  rejectControlPending(new Error('Chromium exited'));
  targetToSession.clear();
  if (!wasStopping) {
    console.error(`Chromium exited unexpectedly (${signal || code}); closing sessions.`);
    failAllSessions('chromium exited');
  }
  cleanupChromeTempDir();
}

function cleanupChromeTempDir() {
  if (!chromeUserDataDir) return;
  fs.rmSync(chromeUserDataDir, { recursive: true, force: true });
  chromeUserDataDir = null;
}

function handleControlMessage(message) {
  let payload;
  try {
    payload = JSON.parse(message);
  } catch {
    return;
  }
  if (payload.id && controlPending.has(payload.id)) {
    const pending = controlPending.get(payload.id);
    controlPending.delete(payload.id);
    if (payload.error) pending.reject(new Error(payload.error.message || 'CDP command failed'));
    else pending.resolve(payload.result || {});
    return;
  }
  if (payload.method === 'Target.targetCreated' || payload.method === 'Target.targetInfoChanged') {
    const targetInfo = payload.params?.targetInfo;
    const session = findSessionByContext(targetInfo?.browserContextId);
    if (session && targetInfo?.targetId) {
      session.targets.add(targetInfo.targetId);
      targetToSession.set(targetInfo.targetId, session.id);
    }
  } else if (payload.method === 'Target.targetDestroyed') {
    const targetId = payload.params?.targetId;
    const sessionId = targetToSession.get(targetId);
    if (sessionId) {
      sessions.get(sessionId)?.targets.delete(targetId);
      targetToSession.delete(targetId);
    }
  }
}

function controlCommand(method, params = {}) {
  if (!controlWs || controlWs.closed) throw new Error('Chromium control connection is not ready');
  const id = ++controlId;
  const payload = { id, method, params };
  const promise = new Promise((resolve, reject) => {
    controlPending.set(id, { resolve, reject });
  });
  controlWs.sendJson(payload);
  return promise;
}

function rejectControlPending(error) {
  for (const pending of controlPending.values()) pending.reject(error);
  controlPending.clear();
}

async function createSession(kind = 'explicit') {
  if (sessions.size + pendingSessionCreations >= config.maxSessions) {
    throw new ManagedError(429, 'Session capacity reached');
  }
  pendingSessionCreations += 1;
  let session = null;
  try {
    await ensureChrome();
    const id = `ses_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const { browserContextId } = await controlCommand('Target.createBrowserContext', { disposeOnDetach: false });
    session = new Session({ id, browserContextId, kind });
    sessions.set(id, session);
    const { targetId } = await controlCommand('Target.createTarget', {
      url: config.startUrl,
      browserContextId,
    });
    if (targetId) {
      session.targets.add(targetId);
      targetToSession.set(targetId, id);
    }
    session.touch();
    if (kind === 'compat') compatSessionId = id;
    return session;
  } catch (error) {
    if (session) await cleanupSession(session, `create target failed: ${error.message}`);
    throw error;
  } finally {
    pendingSessionCreations -= 1;
  }
}

async function ensureCompatSessionForWs() {
  if (!config.compatAutoSession) throw new ManagedError(404, 'Compatibility auto-session is disabled');
  const existing = compatSessionId ? sessions.get(compatSessionId) : null;
  if (existing && existing.state === 'running') {
    // Reusing an existing compat session never consumes new capacity, so do
    // not gate it on MAX_SESSIONS. Multiple concurrent compat WS clients share
    // the same managed BrowserContext.
    existing.touch();
    return { session: existing, created: false };
  }
  const session = await createSession('compat');
  return { session, created: true };
}

async function cleanupSession(session, reason = 'deleted') {
  if (!session || session.closing) return;
  session.closing = true;
  session.state = reason.includes('fail') || reason.includes('exit') ? 'failed' : 'closed';
  for (const ws of [...session.clientSockets]) ws.close(1001, reason);
  session.clientSockets.clear();
  session.activeConnections = 0;
  if (compatSessionId === session.id) compatSessionId = null;
  for (const targetId of [...session.targets]) {
    targetToSession.delete(targetId);
    try {
      if (controlWs && !controlWs.closed) await controlCommand('Target.closeTarget', { targetId });
    } catch {
      // Disposing the context below is the authoritative cleanup path.
    }
  }
  try {
    if (controlWs && !controlWs.closed) {
      await controlCommand('Target.disposeBrowserContext', { browserContextId: session.browserContextId });
    }
  } catch {
    // Chromium may already be gone during crash cleanup.
  }
  sessions.delete(session.id);
  await stopChromeIfIdle();
}

async function stopChromeIfIdle() {
  if (sessions.size > 0 || !chromeProc) return;
  chromeStopping = true;
  if (controlWs && !controlWs.closed) controlWs.close(1000, 'idle');
  controlWs = null;
  chromeProc.kill('SIGTERM');
  const proc = chromeProc;
  await Promise.race([onceEvent(proc, 'exit').catch(() => {}), delay(3000)]);
  if (chromeProc === proc) {
    proc.kill('SIGKILL');
    chromeProc = null;
  }
  cleanupChromeTempDir();
}

function failAllSessions(reason) {
  for (const session of [...sessions.values()]) {
    session.state = 'failed';
    for (const ws of [...session.clientSockets]) ws.close(1011, reason);
    sessions.delete(session.id);
  }
  compatSessionId = null;
  if (!chromeProc) cleanupChromeTempDir();
}

function findSessionByContext(browserContextId) {
  for (const session of sessions.values()) {
    if (session.browserContextId === browserContextId) return session;
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function versionPayload(req, session, compat = false) {
  await ensureChrome();
  const version = await httpJson('/json/version');
  const pathName = compat ? '/devtools/browser/compat' : `/sessions/${session.id}/cdp`;
  return {
    ...version,
    webSocketDebuggerUrl: externalWsUrl(req, pathName),
  };
}

async function listTargets(session, req) {
  await ensureChrome();
  const targets = await httpJson('/json/list');
  return targets
    .filter((target) => session.targets.has(target.id))
    .map((target) => ({
      ...target,
      webSocketDebuggerUrl: externalWsUrl(req, `/sessions/${session.id}/cdp`),
    }));
}

async function createTarget(session, targetUrl) {
  await ensureChrome();
  const { targetId } = await controlCommand('Target.createTarget', {
    url: targetUrl || config.startUrl,
    browserContextId: session.browserContextId,
  });
  session.targets.add(targetId);
  targetToSession.set(targetId, session.id);
  session.touch();
  return targetId;
}

async function closeTarget(session, targetId) {
  if (!session.targets.has(targetId)) throw new ManagedError(404, 'Target not found in session');
  await controlCommand('Target.closeTarget', { targetId });
  session.targets.delete(targetId);
  targetToSession.delete(targetId);
  session.touch();
}

function acknowledgeAndCloseSession(session, clientWs, id, reason) {
  if (id !== undefined && id !== null) clientWs.sendJson({ id, result: {} });
  setTimeout(() => {
    cleanupSession(session, reason).catch((error) => console.error(error));
  }, 25);
}

function hasCdpId(payload) {
  return payload.id !== undefined && payload.id !== null;
}

function isOwnedTargetInfo(session, targetInfo) {
  if (!targetInfo) return false;
  if (targetInfo.browserContextId === session.browserContextId) return true;
  return session.targets.has(targetInfo.targetId);
}

function cdpError(id, code, message) {
  return { id, error: { code, message } };
}

async function handleCdpProxy(session, clientWs, upstreamWs, req, { compatibility = false } = {}) {
  const pendingCreate = new Set();
  const pendingAttach = new Map();
  const pendingTargets = new Set();
  const pendingContexts = new Set();
  let closed = false;
  let clientAlive = true;
  let upstreamAlive = true;
  const heartbeat = setInterval(() => {
    if (!clientAlive || !upstreamAlive) {
      closeBoth();
      return;
    }
    clientAlive = false;
    upstreamAlive = false;
    clientWs.ping();
    upstreamWs.ping();
  }, 30000);
  heartbeat.unref();

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    upstreamWs.destroy();
    clientWs.destroy();
    session.clientSockets.delete(clientWs);
    session.activeConnections = Math.max(0, session.activeConnections - 1);
    session.touch();
  };

  session.clientSockets.add(clientWs);
  session.activeConnections += 1;
  session.touch();

  clientWs.on('message', (message) => {
    session.touch();
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      upstreamWs.sendText(message);
      return;
    }
    if (payload.sessionId && !session.cdpSessions.has(payload.sessionId)) {
      clientWs.sendJson(cdpError(payload.id, -32000, 'CDP session is outside this managed browser session'));
      return;
    }
    // Any command that explicitly names a different browserContextId is
    // rejected before we even look at the method. This covers Browser.*,
    // Storage.*, Network.*, and Target.* variants that accept an optional
    // browserContextId parameter and would otherwise cross session boundaries.
    if (
      payload.params
      && typeof payload.params.browserContextId === 'string'
      && payload.params.browserContextId !== session.browserContextId
    ) {
      clientWs.sendJson(cdpError(payload.id, -32000, 'Browser context is outside this managed session'));
      return;
    }
    if (payload.method === 'Browser.close' || payload.method === 'Browser.crash' || payload.method === 'Browser.crashGpuProcess') {
      if (payload.method === 'Browser.close') {
        acknowledgeAndCloseSession(session, clientWs, payload.id, 'client browser.close');
      } else {
        clientWs.sendJson(cdpError(payload.id, -32000, `${payload.method} is blocked by the session manager`));
      }
      return;
    }
    if (payload.method === 'Target.disposeBrowserContext') {
      if (payload.params?.browserContextId === session.browserContextId) {
        acknowledgeAndCloseSession(session, clientWs, payload.id, 'client context.close');
      } else {
        clientWs.sendJson(cdpError(payload.id, -32000, 'Browser context is outside this managed session'));
      }
      return;
    }
    if (payload.method === 'Target.createBrowserContext' || payload.method === 'Target.attachToBrowserTarget') {
      clientWs.sendJson(cdpError(payload.id, -32000, `${payload.method} is blocked by the session manager`));
      return;
    }
    if (payload.method === 'Target.createTarget') {
      payload.params = { ...(payload.params || {}), browserContextId: session.browserContextId };
      if (hasCdpId(payload)) pendingCreate.add(payload.id);
    } else if (payload.method === 'Target.getTargets') {
      if (hasCdpId(payload)) pendingTargets.add(payload.id);
    } else if (payload.method === 'Target.getBrowserContexts') {
      if (hasCdpId(payload)) pendingContexts.add(payload.id);
    } else if (payload.method === 'Target.closeTarget' || payload.method === 'Target.activateTarget') {
      const targetId = payload.params?.targetId;
      if (targetId && !session.targets.has(targetId)) {
        clientWs.sendJson(cdpError(payload.id, -32000, 'Target is outside this managed browser session'));
        return;
      }
    } else if (payload.method === 'Target.attachToTarget') {
      const targetId = payload.params?.targetId;
      if (targetId && !session.targets.has(targetId)) {
        clientWs.sendJson(cdpError(payload.id, -32000, 'Target is outside this managed browser session'));
        return;
      }
      if (hasCdpId(payload) && targetId) pendingAttach.set(payload.id, targetId);
    } else if (payload.method === 'Target.detachFromTarget') {
      const cdpSessionId = payload.params?.sessionId;
      if (cdpSessionId && !session.cdpSessions.has(cdpSessionId)) {
        clientWs.sendJson(cdpError(payload.id, -32000, 'CDP session is outside this managed browser session'));
        return;
      }
    }
    upstreamWs.sendText(JSON.stringify(payload));
  });

  upstreamWs.on('message', (message) => {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      clientWs.sendText(message);
      return;
    }
    if (hasCdpId(payload)) {
      if (pendingCreate.delete(payload.id) && payload.result?.targetId) {
        session.targets.add(payload.result.targetId);
        targetToSession.set(payload.result.targetId, session.id);
      }
      if (pendingAttach.has(payload.id) && payload.result?.sessionId) {
        session.cdpSessions.add(payload.result.sessionId);
        pendingAttach.delete(payload.id);
      }
      if (pendingTargets.delete(payload.id) && Array.isArray(payload.result?.targetInfos)) {
        payload.result.targetInfos = payload.result.targetInfos.filter((targetInfo) => isOwnedTargetInfo(session, targetInfo));
      }
      if (pendingContexts.delete(payload.id) && Array.isArray(payload.result?.browserContextIds)) {
        payload.result.browserContextIds = payload.result.browserContextIds.filter((browserContextId) => browserContextId === session.browserContextId);
      }
      if (payload.result?.webSocketDebuggerUrl) {
        const pathName = compatibility ? '/devtools/browser/compat' : `/sessions/${session.id}/cdp`;
        payload.result.webSocketDebuggerUrl = externalWsUrl(req, pathName);
      }
      clientWs.sendJson(payload);
      return;
    }

    if (payload.method === 'Target.targetCreated' || payload.method === 'Target.targetInfoChanged') {
      const targetInfo = payload.params?.targetInfo;
      if (!isOwnedTargetInfo(session, targetInfo)) return;
      session.targets.add(targetInfo.targetId);
      targetToSession.set(targetInfo.targetId, session.id);
    } else if (payload.method === 'Target.targetDestroyed') {
      const targetId = payload.params?.targetId;
      if (!session.targets.has(targetId)) return;
      session.targets.delete(targetId);
      targetToSession.delete(targetId);
    } else if (payload.method === 'Target.attachedToTarget') {
      const targetInfo = payload.params?.targetInfo;
      if (!isOwnedTargetInfo(session, targetInfo)) return;
      session.cdpSessions.add(payload.params.sessionId);
    } else if (payload.method === 'Target.detachedFromTarget') {
      const cdpSessionId = payload.params?.sessionId;
      if (!session.cdpSessions.has(cdpSessionId)) return;
      session.cdpSessions.delete(cdpSessionId);
    } else if (payload.sessionId && !session.cdpSessions.has(payload.sessionId)) {
      return;
    }
    clientWs.sendJson(payload);
  });

  clientWs.on('close', closeBoth);
  upstreamWs.on('close', closeBoth);
  clientWs.on('error', closeBoth);
  upstreamWs.on('error', closeBoth);
  clientWs.on('pong', () => {
    clientAlive = true;
  });
  upstreamWs.on('pong', () => {
    upstreamAlive = true;
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = stripPublicBasePath(url.pathname);
  try {
    if (pathname === '/healthz') {
      jsonResponse(res, 200, { ok: true, service: 'managed-cdp', sessions: sessions.size });
      return;
    }
    if (pathname === '/readyz') {
      jsonResponse(res, 200, { ok: true, chrome: Boolean(chromeProc), sessions: sessions.size });
      return;
    }
    if (pathname === '/json/version' && req.method === 'GET') {
      requireAuth(req, url, { compatibility: true });
      const existing = compatSessionId ? sessions.get(compatSessionId) : null;
      const version = existing
        ? await versionPayload(req, existing, true)
        : { webSocketDebuggerUrl: externalWsUrl(req, '/devtools/browser/compat'), Browser: 'Managed Chromium' };
      jsonResponse(res, 200, version);
      return;
    }
    if (pathname === '/json/list' && req.method === 'GET') {
      requireAuth(req, url, { compatibility: true });
      const existing = compatSessionId ? sessions.get(compatSessionId) : null;
      jsonResponse(res, 200, existing ? await listTargets(existing, req) : []);
      return;
    }
    if (pathname === '/json/new' && req.method === 'PUT') {
      requireAuth(req, url, { compatibility: true });
      const { session, created } = await ensureCompatSessionForWs();
      try {
        const targetId = await createTarget(session, url.searchParams.get('url') || config.startUrl);
        const targets = await listTargets(session, req);
        jsonResponse(res, 200, targets.find((target) => target.id === targetId) || { id: targetId });
      } catch (error) {
        if (created) await cleanupSession(session, `compat /json/new failed: ${error.message}`).catch(() => {});
        throw error;
      }
      return;
    }
    const compatClose = pathname.match(/^\/json\/close\/([^/]+)$/);
    if (compatClose && req.method === 'DELETE') {
      requireAuth(req, url, { compatibility: true });
      const session = compatSessionId ? sessions.get(compatSessionId) : null;
      if (!session) throw new ManagedError(404, 'Compatibility session not found');
      await closeTarget(session, decodeURIComponent(compatClose[1]));
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (pathname === '/sessions' && req.method === 'POST') {
      requireAuth(req, url);
      const session = await createSession('explicit');
      jsonResponse(res, 201, { ...session.summary(), links: sessionLinks(req, session) });
      return;
    }
    if (pathname === '/sessions' && req.method === 'GET') {
      requireAuth(req, url);
      jsonResponse(res, 200, [...sessions.values()].map((session) => session.summary()));
      return;
    }
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch) {
      requireAuth(req, url);
      const session = sessions.get(decodeURIComponent(sessionMatch[1]));
      if (!session) throw new ManagedError(404, 'Session not found');
      const subpath = sessionMatch[2] || '';
      session.touch();
      if (!subpath && req.method === 'GET') {
        jsonResponse(res, 200, { ...session.summary(), links: sessionLinks(req, session) });
        return;
      }
      if (!subpath && req.method === 'DELETE') {
        await cleanupSession(session, 'deleted');
        jsonResponse(res, 200, { ok: true });
        return;
      }
      if (subpath === 'json/version' && req.method === 'GET') {
        jsonResponse(res, 200, await versionPayload(req, session));
        return;
      }
      if (subpath === 'json/list' && req.method === 'GET') {
        jsonResponse(res, 200, await listTargets(session, req));
        return;
      }
      if (subpath === 'json/new' && req.method === 'PUT') {
        const targetId = await createTarget(session, url.searchParams.get('url') || config.startUrl);
        const targets = await listTargets(session, req);
        jsonResponse(res, 200, targets.find((target) => target.id === targetId) || { id: targetId });
        return;
      }
      const closeMatch = subpath.match(/^json\/close\/([^/]+)$/);
      if (closeMatch && req.method === 'DELETE') {
        await closeTarget(session, decodeURIComponent(closeMatch[1]));
        jsonResponse(res, 200, { ok: true });
        return;
      }
    }
    textResponse(res, 404, 'Not found\n');
  } catch (error) {
    if (error instanceof ManagedError) {
      jsonResponse(res, error.status, { error: error.message });
    } else {
      console.error('HTTP handler error:', error);
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }
}

function sendUpgradeError(socket, status, message) {
  const body = Buffer.from(String(message), 'utf8');
  const head = Buffer.from(
    `HTTP/1.1 ${status} Upgrade Error\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n\r\n`,
    'utf8',
  );
  socket.write(Buffer.concat([head, body]));
  socket.destroy();
}

async function handleUpgrade(req, socket) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = stripPublicBasePath(url.pathname);
  let createdSession = null;
  try {
    let session;
    let compatibility = false;
    const explicit = pathname.match(/^\/sessions\/([^/]+)\/cdp$/);
    if (explicit) {
      requireAuth(req, url);
      session = sessions.get(decodeURIComponent(explicit[1]));
      if (!session) throw new ManagedError(404, 'Session not found');
    } else if (pathname === '/devtools/browser/compat') {
      requireAuth(req, url, { compatibility: true });
      compatibility = true;
      const result = await ensureCompatSessionForWs();
      session = result.session;
      if (result.created) createdSession = session;
    } else {
      throw new ManagedError(404, 'WebSocket endpoint not found');
    }
    await ensureChrome();
    const upstreamVersion = await httpJson('/json/version');
    const upstreamWs = await connectWebSocket(upstreamVersion.webSocketDebuggerUrl);
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      upstreamWs.destroy();
      throw new ManagedError(400, 'Missing WebSocket key');
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));
    const clientWs = new SimpleWebSocket(socket, { maskOutgoing: false });
    // From this point on, the session is wired up to a live client; do not
    // tear it down on later failures in handleCdpProxy.
    createdSession = null;
    await handleCdpProxy(session, clientWs, upstreamWs, req, { compatibility });
  } catch (error) {
    if (createdSession) {
      cleanupSession(createdSession, `upgrade failed: ${error.message}`).catch(() => {});
    }
    if (error instanceof ManagedError) {
      sendUpgradeError(socket, error.status, error.message);
    } else {
      console.error('WebSocket upgrade error:', error);
      sendUpgradeError(socket, 500, 'Internal server error');
    }
  }
}

function startSweep() {
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (session.activeConnections > 0) continue;
      if (now - session.lastActivityAt.getTime() >= config.idleTtlMs) {
        cleanupSession(session, 'idle ttl expired').catch((error) => console.error(error));
      }
    }
  }, config.sweepIntervalMs);
  sweepTimer.unref();
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down session manager.`);
  if (sweepTimer) clearInterval(sweepTimer);
  for (const session of [...sessions.values()]) {
    await cleanupSession(session, 'service shutdown');
  }
  await stopChromeIfIdle();
  process.exit(0);
}

const server = http.createServer(handleHttp);
server.on('upgrade', (req, socket) => {
  handleUpgrade(req, socket).catch((error) => {
    console.error(error);
    socket.destroy();
  });
});
server.listen(config.port, config.bindHost, () => {
  console.log(`Session manager listening on ${config.bindHost}:${config.port}`);
});
startSweep();
process.on('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error(error);
  process.exit(1);
}));
process.on('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error(error);
  process.exit(1);
}));
