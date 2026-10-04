// Heap stability of the running extension outside VS Code (test/harness/vscode-mock.cjs): every section
// on at 200 ms, Live tooltips, heap growth over 15 s after a warm-up. Opt-in: it takes ~20 s of wall time.
//
// Usage (macOS after `pnpm run compile:native`, or Linux):  pnpm run test:soak
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { loadExtension } from '../harness/load-extension.mjs';

const { vscode, ext, cleanup } = loadExtension('test-soak');
const s = vscode.__state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the extension timer is unref()'d
after(() => {
  clearInterval(keepAlive);
  ext.deactivate();
  cleanup();
});

test('heap stability', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, async (t) => {
  s.cfg = {
    'show.disk': true,
    allowFastRefresh: true,
    'tooltip.mode': 'Live',
    statusBarMs: { cpu: 200, freq: 200, temp: 200, mem: 200, battery: 200, disk: 200 },
  };
  ext.activate({ subscriptions: [] });
  await sleep(3000);
  globalThis.gc();
  const h0 = process.memoryUsage().heapUsed;
  await sleep(15000);
  globalThis.gc();
  const growthKb = (process.memoryUsage().heapUsed - h0) / 1024;
  assert.ok(growthKb < 512, `heap growth over 15 s: ${growthKb.toFixed(0)} KB`);
  assert.deepEqual(s.errors, [], 'no errors logged, no writes to disposed items');
  t.diagnostic(`heap growth over 15 s at 200 ms Live: ${growthKb.toFixed(0)} KB`);
});
