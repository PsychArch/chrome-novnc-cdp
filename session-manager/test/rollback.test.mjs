import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { delay } from './helpers.mjs';

const base = process.env.MANAGED_CDP_ROLLBACK_URL;
const servicePorts = new Set([5900, 6080, 9222]);
const listeners = () => fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)
  .filter((line) => line.trim().split(/\s+/)[3] === '0A')
  .map((line) => line.trim().split(/\s+/)[1])
  // x11vnc may restart after Xvfb becomes ready. Its fixed service port is
  // unrelated to the ephemeral session relay and private Chromium listeners.
  .filter((address) => !servicePorts.has(Number.parseInt(address.split(':')[1], 16))).sort();

test('failed initial target creation disposes its context, relay, and capacity', { skip: !base, timeout: 30000 }, async () => {
  const before = listeners();
  // This separate container preloads inject-target-failure.mjs to fail the
  // initial target creation after the real relay and browser context exist.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${base}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proxy: { server: 'http://127.0.0.1:1', username: 'rollback-user', password: 'rollback-secret' } }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
    assert.deepEqual(await (await fetch(`${base}/sessions`)).json(), []);
    await delay(100);
    assert.deepEqual(listeners(), before, 'failed creation must not retain relay or Chromium listeners');
    assert.equal((await (await fetch(`${base}/readyz`)).json()).chrome, false);
  }
});
