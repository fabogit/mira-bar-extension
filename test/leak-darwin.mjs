// Leak & cost probe for the native darwin_telemetry.node addon.
//
// Calls every exported native function in a tight loop and reports, per function:
//   - average cost per call (µs)             -> how much each tick blocks the Extension Host thread
//   - RSS growth across batches (after GC)   -> steady growth after the first (warm-up) batch = native leak
//   - Mach port refs of this process (lsmp)   -> growth of the "host" send right = mach_host_self() leak
//
// Usage (on macOS, after `pnpm run compile:native`):
//   node --expose-gc test/leak-darwin.mjs            # default: up to 10000 calls / function
//   node --expose-gc test/leak-darwin.mjs 50000      # custom iteration count
//   node --expose-gc test/leak-darwin.mjs --pause    # waits at the end so you can run:
//                                                    #   sudo lsmp -p <pid>   /   sudo leaks <pid>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addonPath = path.resolve(__dirname, '../dist/native/darwin_telemetry.node');
const addon = require(addonPath);

const args = process.argv.slice(2);
const ITERATIONS = Number(args.find((a) => /^\d+$/.test(a)) ?? 10000);
const PAUSE = args.includes('--pause');
const BATCHES = 5;
const TIME_BUDGET_MS = 30_000; // per function, so slow calls don't run forever
const LEAK_THRESHOLD_BYTES_PER_CALL = 32;

if (typeof globalThis.gc !== 'function') {
  console.warn('WARN: run with `node --expose-gc` for reliable RSS numbers.\n');
}
const gc = () => {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
};

/** Returns lsmp lines mentioning the host port, or null if lsmp is not usable without sudo. */
function hostPortLines() {
  try {
    const out = execFileSync('lsmp', ['-p', String(process.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter((l) => /host/i.test(l));
  } catch {
    return null;
  }
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1);
}

const functions = ['getCpuTicks', 'getCpuTopology', 'getMemoryStats', 'getBatteryStats', 'getDieTemperature'];
// getCpuTicks(out) fills a caller-owned buffer (4 counters per core); 256 cores is plenty.
const argsFor = { getCpuTicks: [new Uint32Array(256 * 4)] };

console.log(`Addon: ${addonPath}`);
console.log(`PID:   ${process.pid}`);
console.log(`Iterations/function: ${ITERATIONS} (budget ${TIME_BUDGET_MS / 1000}s each)\n`);

const portsBefore = hostPortLines();
const results = [];

for (const name of functions) {
  if (typeof addon[name] !== 'function') {
    console.log(`- ${name}: not exported, skipped`);
    continue;
  }
  const args = argsFor[name] ?? [];
  const fn = () => addon[name](...args);

  // Warm-up: lets malloc zones / CF caches settle before measuring.
  for (let i = 0; i < 200; i++) fn();
  gc();

  const rssSamples = [process.memoryUsage().rss];
  let calls = 0;
  let callsInFirstBatch = 0;
  const perBatch = Math.ceil(ITERATIONS / BATCHES);
  const t0 = process.hrtime.bigint();

  for (let b = 0; b < BATCHES; b++) {
    const batchStart = Date.now();
    for (let i = 0; i < perBatch; i++) {
      fn();
      calls++;
      if ((i & 63) === 0 && Date.now() - batchStart > TIME_BUDGET_MS / BATCHES) break;
    }
    gc();
    rssSamples.push(process.memoryUsage().rss);
    if (b === 0) callsInFirstBatch = calls;
  }

  const elapsedUs = Number(process.hrtime.bigint() - t0) / 1000;
  const growth = rssSamples[rssSamples.length - 1] - rssSamples[0];
  // The first batch absorbs one-off V8/JIT/malloc warm-up (a step, then flat): judge only the
  // growth after it. A real leak keeps growing batch after batch.
  const steady = rssSamples.slice(1);
  const steadyGrowth = steady[steady.length - 1] - steady[0];
  const steadyCalls = calls - callsInFirstBatch;
  const growing = steady.every((v, i) => i === 0 || v >= steady[i - 1]) && steadyGrowth > 0;
  const bytesPerCall = steadyCalls > 0 ? steadyGrowth / steadyCalls : 0;
  const suspicious = growing && bytesPerCall > LEAK_THRESHOLD_BYTES_PER_CALL;

  results.push({
    function: name,
    calls,
    'µs/call': (elapsedUs / calls).toFixed(1),
    'RSS Δ (KB)': kb(growth),
    'B/call (steady)': bytesPerCall.toFixed(1),
    trend: rssSamples.map((v) => kb(v - rssSamples[0])).join(' → '),
    verdict: suspicious ? 'LEAK?' : 'ok',
  });
}

console.table(results);

const portsAfter = hostPortLines();
if (portsBefore && portsAfter) {
  console.log('\nHost port (lsmp) BEFORE:\n' + (portsBefore.join('\n') || '(no match)'));
  console.log('Host port (lsmp) AFTER:\n' + (portsAfter.join('\n') || '(no match)'));
  console.log('If the "send" urefs column grew by roughly the number of getCpuTicks/getMemoryStats calls,');
  console.log('mach_host_self() is leaking a send-right reference on every call.');
} else {
  console.log('\nlsmp not usable without privileges. Re-run with --pause and in another terminal:');
  console.log(`  sudo lsmp -p ${process.pid} | grep -i host`);
}

if (results.some((r) => r.verdict !== 'ok')) {
  console.log('\nAt least one function shows monotonic RSS growth above the threshold: inspect with');
  console.log(`  sudo leaks ${process.pid}   (use --pause)`);
}

if (PAUSE) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(`\nPaused (PID ${process.pid}). Press Enter to exit...`, resolve));
  rl.close();
}
