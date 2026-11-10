import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Test-only fault injection: fail after the real Chromium context and proxy
// relay have been created, without adding failure switches to production code.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/session-manager/server.mjs')) return result;
    const source = result.source.toString();
    const marker = "    const { targetId } = await controlCommand('Target.createTarget', {";
    assert.ok(source.includes(marker), 'session creation fault injection point must exist');
    return { ...result, source: source.replace(marker, `    throw new Error('Test target creation failure');\n${marker}`) };
  },
});
