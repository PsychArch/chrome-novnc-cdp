import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { connectCdp, delay, origin, pageClient, socksProxy, upstreamProxy } from './helpers.mjs';

const base = process.env.MANAGED_CDP_TEST_URL;

test('managed Chromium session proxies', { skip: !base, timeout: 120000 }, async (t) => {
  const request = (path, options) => fetch(`${base}${path}`, options);
  const create = async (t, options) => {
    const response = await request('/sessions', {
      method: 'POST',
      ...(options === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const session = await response.json();
    t.after(() => request(`/sessions/${session.id}`, { method: 'DELETE' }));
    return session;
  };
  const page = async (t, session) => {
    const client = await pageClient(session);
    t.after(() => client.cdp.close());
    return client;
  };
  const fixture = async (t, promise) => {
    const value = await promise;
    t.after(() => value.close());
    return value;
  };

  await t.test('health, noVNC, API version, empty body, and compatibility endpoint', async (t) => {
    assert.equal((await request('/healthz')).status, 200);
    const noVnc = await fetch('http://127.0.0.1:6080/');
    assert.equal(noVnc.status, 200);
    assert.match(await noVnc.text(), /noVNC/);
    const spec = await (await request('/openapi.json')).json();
    assert.equal(spec.info.version, '2026.11.10');
    assert.ok(spec.paths['/sessions'].post.requestBody);
    const session = await create(t);
    assert.equal(session.proxy, null);
    const version = await (await request(`/sessions/${session.id}/json/version`)).json();
    assert.match(version.Browser, /Chrome\/156\./);
    const compatibility = await (await request('/json/version')).json();
    const cdp = await connectCdp(compatibility.webSocketDebuggerUrl);
    await cdp.command('Browser.getVersion');
    const all = await (await request('/sessions')).json();
    const compat = all.find((entry) => entry.id !== session.id);
    assert.ok(compat);
    assert.equal(compat.proxy, null);
    t.after(() => request(`/sessions/${compat.id}`, { method: 'DELETE' }));
    cdp.close();
  });

  await t.test('invalid options fail before creating a session or exposing credentials', async () => {
    const before = await (await request('/sessions')).json();
    for (const [body, contentType, expected] of [
      ['{"proxy":{"server":"http://user:secret@example.com"}}', 'application/json', 400],
      ['{"proxy":{"server":"ftp://example.com"}}', 'application/json', 400],
      ['{secret', 'application/json', 400],
      ['{}', 'text/plain', 415],
      [' '.repeat(16385), 'application/json', 413],
    ]) {
      const response = await request('/sessions', { method: 'POST', headers: { 'content-type': contentType }, body });
      assert.equal(response.status, expected);
      assert.ok(!(await response.text()).includes('secret'));
    }
    assert.equal((await (await request('/sessions')).json()).length, before.length);
  });

  await t.test('concurrent sessions route independently and preserve CDP isolation', async (t) => {
    const a = await fixture(t, upstreamProxy('proxy-A'));
    const b = await fixture(t, upstreamProxy('proxy-B'));
    const sa = await create(t, { proxy: { server: `http://127.0.0.1:${a.port}` } });
    const sb = await create(t, { proxy: { server: `http://127.0.0.1:${b.port}` } });
    const ca = await page(t, sa);
    const cb = await page(t, sb);
    const results = await Promise.all([
      ca.navigate('http://routing-probe.invalid/a', 'proxy-A'),
      cb.navigate('http://routing-probe.invalid/b', 'proxy-B'),
    ]);
    assert.deepEqual(results, [{ text: 'proxy-A' }, { text: 'proxy-B' }]);
    const { targetInfos } = await cb.cdp.command('Target.getTargets');
    await assert.rejects(ca.cdp.command('Target.attachToTarget', { targetId: targetInfos[0].targetId, flatten: true }), /outside/);
    await assert.rejects(ca.cdp.command('Target.createBrowserContext'), /blocked/);
    assert.ok(a.requests.some((req) => req.url.endsWith('/a')));
    assert.ok(!b.requests.some((req) => req.url.endsWith('/a')));
    assert.ok(a.requests.some((req) => req.url === 'http://startup-probe.invalid/'));
    assert.ok(b.requests.some((req) => req.url === 'http://startup-probe.invalid/'));
  });

  await t.test('HTTP authentication handles reserved characters and response redaction', async (t) => {
    const username = 'test-user@tenant';
    const password = 'p:a/s%word@value';
    const upstream = await fixture(t, upstreamProxy('authenticated', { username, password }));
    const session = await create(t, { proxy: { server: `http://127.0.0.1:${upstream.port}`, username, password } });
    assert.equal(session.proxy.hasAuthentication, true);
    assert.ok(!JSON.stringify(session).includes(username));
    assert.ok(!JSON.stringify(session).includes(password));
    const client = await page(t, session);
    assert.deepEqual(await client.navigate('http://auth-probe.invalid/', 'authenticated'), { text: 'authenticated' });
    for (const path of ['/sessions', `/sessions/${session.id}`]) {
      const response = await (await request(path)).text();
      assert.ok(!response.includes(username) && !response.includes(password));
    }
    assert.ok(upstream.requests.some((req) => req.headers['proxy-authorization'] === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`));
  });

  await t.test('HTTPS upstream proxy and HTTPS destination CONNECT retain authentication', async (t) => {
    const upstream = await fixture(t, upstreamProxy('secure-proxy', { secure: true, username: 'secure-user', password: 'secure-password' }));
    const destination = await fixture(t, origin(true));
    const session = await create(t, { proxy: { server: `https://localhost:${upstream.port}`, username: 'secure-user', password: 'secure-password' } });
    const client = await page(t, session);
    assert.deepEqual(await client.navigate('http://secure-proxy-test.invalid/', 'secure-proxy'), { text: 'secure-proxy' });
    assert.deepEqual(await client.navigate(`https://secure-probe.invalid:${destination.port}/`, 'direct-origin'), { text: 'direct-origin' });
    assert.ok(upstream.requests.some((req) => req.connect));
    assert.ok(destination.requests.every((req) => !req.headers['proxy-authorization']));
  });

  for (const authenticate of [false, true]) {
    await t.test(`SOCKS5 ${authenticate ? 'with' : 'without'} authentication uses remote DNS for HTTP and HTTPS`, async (t) => {
      const credentials = authenticate ? { username: 'socks-user@tenant', password: 'socks:p%ass' } : {};
      const upstream = await fixture(t, socksProxy(credentials));
      const plain = await fixture(t, origin());
      const secure = await fixture(t, origin(true));
      const session = await create(t, { proxy: { server: `socks5://127.0.0.1:${upstream.port}`, ...credentials } });
      const client = await page(t, session);
      assert.deepEqual(await client.navigate(`http://remote-dns-probe.invalid:${plain.port}/`, 'direct-origin'), { text: 'direct-origin' });
      assert.deepEqual(await client.navigate(`https://secure-probe.invalid:${secure.port}/`, 'direct-origin'), { text: 'direct-origin' });
      assert.ok(upstream.requests.some((req) => req.hostname === 'remote-dns-probe.invalid' && req.atyp === 3));
      assert.ok(upstream.requests.some((req) => req.hostname === 'secure-probe.invalid' && req.atyp === 3));
    });
  }

  await t.test('bypass rules connect directly and loopback exemption can be removed', async (t) => {
    const upstream = await fixture(t, upstreamProxy('proxied-loopback'));
    const destination = await fixture(t, origin());
    const session = await create(t, { proxy: { server: `http://127.0.0.1:${upstream.port}`, bypass: ['<-loopback>', 'localhost'] } });
    const client = await page(t, session);
    assert.deepEqual(await client.navigate(`http://localhost:${destination.port}/direct`, 'direct-origin'), { text: 'direct-origin' });
    assert.deepEqual(await client.navigate(`http://127.0.0.1:${destination.port}/proxied`, 'proxied-loopback'), { text: 'proxied-loopback' });
    assert.ok(!destination.requests.some((req) => req.url === '/proxied'));
  });

  await t.test('unreachable proxy and rejected credentials never fall back to a direct request', async (t) => {
    const destination = await fixture(t, origin());
    const protectedProxy = await fixture(t, upstreamProxy('must-not-load', { username: 'expected', password: 'expected' }));
    for (const proxy of [
      { server: 'http://127.0.0.1:1', bypass: ['<-loopback>'] },
      { server: `http://127.0.0.1:${protectedProxy.port}`, username: 'wrong', password: 'wrong', bypass: ['<-loopback>'] },
    ]) {
      const session = await create(t, { proxy });
      const client = await page(t, session);
      const result = await client.cdp.command('Page.navigate', { url: `http://127.0.0.1:${destination.port}/must-not-load` }, client.sessionId);
      await delay(150);
      const body = await client.cdp.command('Runtime.evaluate', { expression: 'document.body?.innerText', returnByValue: true }, client.sessionId);
      assert.ok(result.errorText || body.result?.value !== 'must-not-load');
    }
    assert.equal(destination.requests.length, 0);
  });

  await t.test('deleting a session closes its proxy listener and upstream connections', async (t) => {
    const upstream = await fixture(t, upstreamProxy('cleanup'));
    const keeper = await create(t);
    await page(t, keeper);
    const listeners = () => fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)
      .filter((line) => line.trim().split(/\s+/)[3] === '0A').map((line) => line.trim().split(/\s+/)[1]);
    const before = new Set(listeners());
    const session = await create(t, { proxy: { server: `http://127.0.0.1:${upstream.port}` } });
    const client = await page(t, session);
    assert.deepEqual(await client.navigate('http://cleanup-probe.invalid/', 'cleanup'), { text: 'cleanup' });
    const added = listeners().filter((entry) => !before.has(entry));
    assert.equal(added.length, 1, 'session should own one relay listener');
    const response = await request(`/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    for (let i = 0; i < 30 && upstream.sockets.size; i += 1) await delay(100);
    assert.equal(upstream.sockets.size, 0);
    assert.ok(!listeners().some((entry) => added.includes(entry)), 'deletion must release the relay listener');
    assert.equal((await request(`/sessions/${session.id}`)).status, 404);
  });

  await t.test('idle sessions expire and release their proxy connections', async (t) => {
    const upstream = await fixture(t, upstreamProxy('idle-cleanup'));
    const session = await create(t, { proxy: { server: `http://127.0.0.1:${upstream.port}` } });
    const client = await page(t, session);
    await client.navigate('http://idle-probe.invalid/', 'idle-cleanup');
    client.cdp.close();
    let expired = false;
    for (let i = 0; i < 80; i += 1) {
      const list = await (await request('/sessions')).json();
      if (!list.some((entry) => entry.id === session.id)) { expired = true; break; }
      await delay(100);
    }
    assert.ok(expired, 'test container should use SESSION_IDLE_TIMEOUT=3s and SESSION_SWEEP_INTERVAL=250ms');
    for (let i = 0; i < 30 && upstream.sockets.size; i += 1) await delay(100);
    assert.equal(upstream.sockets.size, 0);
  });

  await t.test('capacity limits remain enforced for proxied sessions', async (t) => {
    for (let i = 0; i < 4; i += 1) {
      const session = await create(t);
      await page(t, session);
    }
    const response = await request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proxy: { server: 'http://127.0.0.1:1' } }),
    });
    assert.equal(response.status, 429);
  });

  await t.test('Chromium crashes release proxy listeners and the manager recovers', async (t) => {
    const upstream = await fixture(t, upstreamProxy('crash-cleanup'));
    const session = await create(t, { proxy: { server: `http://127.0.0.1:${upstream.port}` } });
    const client = await page(t, session);
    await client.navigate('http://crash-probe.invalid/', 'crash-cleanup');
    const before = new Set(fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).filter((line) => line.trim().split(/\s+/)[3] === '0A').map((line) => line.trim().split(/\s+/)[1]));
    // The raw browser endpoint is reachable only from the shared test namespace.
    const raw = await (await fetch('http://127.0.0.1:9223/json/version')).json();
    const control = await connectCdp(raw.webSocketDebuggerUrl);
    await control.command('Browser.crash').catch(() => {});
    control.close();
    for (let i = 0; i < 50; i += 1) {
      if (!(await (await request('/sessions')).json()).length && !upstream.sockets.size) break;
      await delay(100);
    }
    assert.equal((await (await request('/sessions')).json()).length, 0);
    assert.equal(upstream.sockets.size, 0);
    const after = new Set(fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).filter((line) => line.trim().split(/\s+/)[3] === '0A').map((line) => line.trim().split(/\s+/)[1]));
    assert.ok([...before].some((port) => !after.has(port)), 'crash must release the context relay listener');
    const recovered = await create(t);
    const recoveredPage = await page(t, recovered);
    assert.deepEqual(await recoveredPage.cdp.command('Browser.getVersion').then((value) => Boolean(value.product)), true);
  });
});
