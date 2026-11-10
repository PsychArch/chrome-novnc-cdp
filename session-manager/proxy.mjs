import { Server } from 'proxy-chain';
import http from 'node:http';
import https from 'node:https';
import { ManagedError } from './errors.mjs';

const maxBodyBytes = 16 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, message) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ManagedError(400, message);
  }
}

export function validateSessionOptions(value) {
  if (!isObject(value)) throw new ManagedError(400, 'Session options must be an object');
  rejectUnknownKeys(value, ['proxy'], 'Unknown session option');
  if (value.proxy === undefined || value.proxy === null) return { proxy: null };
  const proxy = value.proxy;
  if (!isObject(proxy)) throw new ManagedError(400, 'proxy must be an object or null');
  rejectUnknownKeys(proxy, ['server', 'username', 'password', 'bypass'], 'Unknown proxy option');
  let server;
  try {
    if (typeof proxy.server !== 'string' || proxy.server.length > 2048 || /\s/.test(proxy.server)) throw new Error();
    if (!/^(https?|socks5h?):\/\//.test(proxy.server)) throw new Error();
    server = new URL(proxy.server);
    if (!server.hostname || server.username || server.password || proxy.server.split('/')[2].includes('@')) throw new Error();
    if ((server.pathname && server.pathname !== '/') || server.search || server.hash) throw new Error();
  } catch {
    throw new ManagedError(400, 'proxy.server must be an HTTP, HTTPS, SOCKS5, or SOCKS5H URL without credentials, path, query, or fragment');
  }
  const hasAuthentication = proxy.username !== undefined;
  if (hasAuthentication && (
    typeof proxy.username !== 'string' || !proxy.username || proxy.username.length > 255
    || /[\x00-\x1f\x7f:]/.test(proxy.username)
  )) throw new ManagedError(400, 'proxy.username must be a non-empty string without control characters or colons (maximum 255 characters)');
  if (proxy.password !== undefined && (
    !hasAuthentication || typeof proxy.password !== 'string' || proxy.password.length > 255
    || /[\x00-\x1f\x7f]/.test(proxy.password)
  )) throw new ManagedError(400, 'proxy.password must be a string with a username and no control characters (maximum 255 characters)');
  const bypass = proxy.bypass ?? [];
  if (!Array.isArray(bypass) || bypass.length > 64 || bypass.some((rule) => (
    typeof rule !== 'string' || !rule || rule.length > 256 || /[\s;,\x00-\x1f\x7f]/.test(rule)
  ))) throw new ManagedError(400, 'proxy.bypass must be an array of up to 64 non-empty Chromium bypass rules without whitespace, commas, or semicolons');
  // Keep credentials separate from the public server URL and all error messages.
  server.pathname = '';
  if (server.protocol.startsWith('socks5') && !server.port) server.port = '1080';
  return {
    proxy: {
      server: server.href.replace(/\/$/, ''),
      bypass: [...bypass],
      ...(hasAuthentication ? { username: proxy.username, password: proxy.password ?? '' } : {}),
    },
  };
}

export async function readSessionOptions(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = Number(req.headers['content-length']) > maxBodyBytes;
  // Drain oversized requests without retaining their bodies so the error response
  // can be delivered and the connection can be reused safely.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw new ManagedError(413, 'Session options exceed 16 KiB');
  if (size === 0) return { proxy: null };
  if (req.headers['content-encoding'] || req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ManagedError(415, 'Session options require uncompressed application/json');
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ManagedError(400, 'Session options must be valid JSON');
  }
  return validateSessionOptions(value);
}

export function proxySummary(proxy) {
  return proxy ? {
    server: proxy.server,
    bypass: [...proxy.bypass],
    hasAuthentication: proxy.username !== undefined,
  } : null;
}

export async function startProxyRelay(proxy) {
  if (!proxy) return null;
  const upstream = new URL(proxy.server);
  // Remote DNS matches Chromium's native SOCKS5 behavior and prevents local
  // resolution of destination hostnames when using a SOCKS proxy.
  if (upstream.protocol === 'socks5:') upstream.protocol = 'socks5h:';
  if (proxy.username !== undefined) {
    upstream.username = encodeURIComponent(proxy.username);
    upstream.password = encodeURIComponent(proxy.password);
  }
  // Separate pools prevent a completed upstream request from leaving a socket
  // in Node's process-wide agent after its managed session has been deleted.
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const relay = new Server({
    host: '127.0.0.1',
    port: 0,
    verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.href, httpAgent, httpsAgent }),
  });
  // Never log library errors containing an upstream URL or credentials.
  relay.on('requestFailed', () => {});
  try {
    await relay.listen();
  } catch {
    await relay.close(true).catch(() => {});
    httpAgent.destroy();
    httpsAgent.destroy();
    throw new ManagedError(500, 'Unable to start session proxy relay');
  }
  return {
    server: `http://127.0.0.1:${relay.port}`,
    close: async () => {
      try { await relay.close(true); }
      finally { httpAgent.destroy(); httpsAgent.destroy(); }
    },
  };
}
