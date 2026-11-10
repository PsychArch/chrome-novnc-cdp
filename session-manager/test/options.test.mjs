import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { readSessionOptions, proxySummary, startProxyRelay, validateSessionOptions } from '../proxy.mjs';
import { buildOpenApiDocument } from '../openapi.mjs';

test('session proxy validation rejects malformed and credential-bearing input without echoing it', () => {
  for (const value of [
    null, [], 'bad', { unknown: true }, { proxy: [] }, { proxy: { server: 'ftp://example.com' } },
    { proxy: { server: 'http://user:secret@example.com' } }, { proxy: { server: 'http://@example.com' } },
    { proxy: { server: 'http://example.com/path' } }, { proxy: { server: 'http://example.com?secret=1' } },
    { proxy: { server: 'http://example.com#secret' } }, { proxy: { server: 'http://example.com:99999' } },
    { proxy: { server: 'http://example.com', password: 'secret' } },
    { proxy: { server: 'http://example.com', username: 'bad:user' } },
    { proxy: { server: 'http://example.com', username: 'user', password: '\nsecret' } },
    { proxy: { server: 'http://example.com', bypass: ['a;b'] } },
    { proxy: { server: 'http://example.com', bypass: ['a,b'] } },
    { proxy: { server: 'http://example.com', bypass: [''] } },
    { proxy: { server: 'http://example.com', bypass: 'localhost' } },
    { proxy: { server: 'http://example.com', unknown: true } },
  ]) assert.throws(() => validateSessionOptions(value), (error) => error.status === 400 && !error.message.includes('secret'));
});

test('proxy summaries never include either credential and defaults remain compatible', () => {
  assert.deepEqual(validateSessionOptions({}), { proxy: null });
  assert.deepEqual(validateSessionOptions({ proxy: null }), { proxy: null });
  assert.equal(proxySummary(null), null);
  assert.equal(validateSessionOptions({ proxy: { server: 'socks5://example.com' } }).proxy.server, 'socks5://example.com:1080');
  for (const scheme of ['http', 'https', 'socks5', 'socks5h']) {
    const { proxy } = validateSessionOptions({ proxy: {
      server: `${scheme}://[::1]:1080`, username: 'user@tenant', password: 's:e/c%ret', bypass: ['<-loopback>', '*.internal'],
    } });
    assert.deepEqual(proxySummary(proxy), {
      server: `${scheme}://[::1]:1080`, bypass: ['<-loopback>', '*.internal'], hasAuthentication: true,
    });
  }
});

test('session body parsing accepts old requests and returns useful bounded errors', async (t) => {
  const server = http.createServer(async (req, res) => {
    try { res.end(JSON.stringify(await readSessionOptions(req))); }
    catch (error) { res.writeHead(error.status); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(url, { method: 'POST' })).json(), { proxy: null });
  for (const [body, type, status] of [
    ['{}', 'application/json; charset=utf-8', 200],
    ['{bad secret', 'application/json', 400],
    ['[]', 'application/json', 400],
    ['{}', 'text/plain', 415],
    [' '.repeat(16385), 'application/json', 413],
  ]) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': type }, body });
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes('secret'));
  }
});

test('relay binds only loopback and closes its listener and connections', async () => {
  const relay = await startProxyRelay(validateSessionOptions({ proxy: { server: 'http://127.0.0.1:1' } }).proxy);
  assert.match(relay.server, /^http:\/\/127\.0\.0\.1:/);
  const response = await fetch(relay.server);
  await response.text();
  await relay.close();
  await assert.rejects(fetch(relay.server));
});

test('OpenAPI describes optional proxy requests, redacted responses, and errors', () => {
  const spec = buildOpenApiDocument();
  assert.equal(spec.info.version, '2026.11.10');
  assert.equal(spec.paths['/sessions'].post.requestBody.required, false);
  for (const status of [400, 401, 413, 415, 429, 500]) assert.ok(spec.paths['/sessions'].post.responses[status]);
  assert.equal(spec.components.schemas.ProxyOptions.properties.password.writeOnly, true);
  assert.ok(!('password' in spec.components.schemas.ProxySummary.properties));
  assert.ok(!('username' in spec.components.schemas.ProxySummary.properties));
});
