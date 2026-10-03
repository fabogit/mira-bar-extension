// Measurement bench for the refresh floors (Linux), the counterpart of test/bench-darwin.mjs.
//
// For every data source the extension reads, through the real providers (src/platform/linux, bundled
// with esbuild as in test:linux), it measures:
//   - cost per read, reads back to back: wall µs per call on the calling thread (performance.now, median /
//     p95 / max), process CPU (process.cpuUsage, which also counts the libuv pool threads that serve the
//     async reads; its kernel part is the work the kernel does inside our syscalls) and system CPU: busy
//     ticks of the whole machine from /proc/stat while reading, minus the idle windows before and after.
//     The system figure catches kernel work outside this process (other cores, interrupts, kworkers);
//     the spread of the idle windows is printed as its noise.
//   - the same reads paced like the extension: every 200 ms (issue #5: on-thread latency against the
//     250 µs target) and every 2 s (the regime of the defaults), where kernel caches have expired (ACPI
//     battery: `battery.cache_time`, 1 s) and the NVMe drive may be in a low power state.
//   - V8 heap behaviour: bytes allocated per read, GC count and pause time (v8.GCProfiler), heap retained
//     after a full GC (allocation stability), and the GC load of the paced runs.
// It then prints, per source, the interval at which its cost alone would use the whole budget (0.5% of
// one core): the rule for the minimum status bar intervals (docs/ARCHITECTURE.md, "Refresh Floors").
// With dist/bench-extension.json from a Linux run (`pnpm run bench:extension` first) it adds the
// extension's own cost per read, proposes the minimums and prints the total cost at the default intervals.
//
// Usage (on Linux; close heavy apps for a stable baseline):
//   pnpm run bench:linux                              # ~3 min
//   node --expose-gc test/bench-linux.mjs --quick     # ~1.5 min (shorter windows and paced runs)
//   node --expose-gc test/bench-linux.mjs --json      # also prints the raw results as JSON
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'linux') {
  console.log(`bench-linux: Linux only (this is ${process.platform}); on macOS use \`pnpm run bench:darwin\`.`);
  process.exit(0);
}
if (typeof globalThis.gc !== 'function') {
  console.log('bench-linux: run with --expose-gc (`pnpm run bench:linux` does).');
  process.exit(1);
}

// The providers as the extension runs them: the TypeScript sources bundled for Node.
const bundle = path.join(root, 'dist', 'bench-linux-providers.cjs');
require('esbuild').buildSync({
  stdin: {
    contents: [
      "export { CpuProvider } from './src/platform/linux/cpu.ts';",
      "export { CpuFreqProvider } from './src/platform/linux/cpufreq.ts';",
      "export { MemoryProvider } from './src/platform/linux/memory.ts';",
      "export { CpuTempProvider } from './src/platform/linux/cputemp.ts';",
      "export { ComponentTempProvider } from './src/platform/linux/components.ts';",
      "export { BatteryProvider } from './src/platform/linux/battery.ts';",
      "export { DiskProvider } from './src/disk/disk_provider.ts';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'warning',
});
const P = require(bundle);
fs.rmSync(bundle, { force: true });

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const JSON_OUT = args.includes('--json');
const WINDOW_MS = QUICK ? 500 : 1000; // one busy or idle window of the per-read loops
const ROUNDS = 3; // busy windows per source, each between two idle windows
const PASS_WINDOW_MS = QUICK ? 1500 : 3000; // component passes back to back, per window
const PACED_MS = QUICK ? 10_000 : 30_000; // reads every 200 ms
const PACED_INTERVAL_MS = 200;
const SPACED_MS = QUICK ? 12_000 : 40_000; // reads every 2 s
const SPACED_INTERVAL_MS = 2000;
/** Issue #5: on-thread latency target of one read at 200 ms polling. */
const SLA_US = 250;
/** Component sensors are rescanned once a minute (src/platform/linux/components.ts, RESCAN_MS). */
const RESCAN_MS = 60_000;

/** Project budget (docs/ROADMAP.md): total extension overhead below 0.5% of one core. */
const SLA_CORE_FRACTION = 0.005;
/**
 * Rule for the minimums: a section's reads alone may use at most the whole budget. The defaults keep
 * the whole extension within it (the total at the defaults is printed at the end).
 */
const SHARE = SLA_CORE_FRACTION;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuUs = (u) => u.user + u.system;

/** Host CPU ticks summed over all cores from the aggregate `cpu` line of /proc/stat: busy and total. */
function hostTicks() {
  const line = fs.readFileSync('/proc/stat', 'utf8').slice(0, 256).split('\n')[0];
  // cpu user nice system idle iowait irq softirq steal (guest time is already in user / nice)
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line.trim().split(/\s+/).slice(1, 9).map(Number);
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait, cores: os.cpus().length };
}

/** Busy CPU time of the whole machine (ms) over a window, from host ticks. */
function machineBusyMs(before, after, elapsedMs) {
  const totalTicks = after.total - before.total;
  const busyTicks = after.busy - before.busy;
  // total ticks = cores × elapsed × USER_HZ: derive the tick length instead of assuming 100 Hz.
  const msPerTick = (after.cores * elapsedMs) / Math.max(1, totalTicks);
  return busyTicks * msPerTick;
}

/** Idle window: machine busy ms per ms of wall time while this process sleeps. */
async function idleRate(ms) {
  const t0 = performance.now();
  const a = hostTicks();
  await sleep(ms);
  const b = hostTicks();
  const elapsed = performance.now() - t0;
  return machineBusyMs(a, b, elapsed) / elapsed;
}

/** Median, p95 and max of the first `n` µs values of a buffer. */
function dist(buf, n = buf.length) {
  if (n === 0) {
    return { median: NaN, p95: NaN, max: NaN };
  }
  const s = Float64Array.from(buf.subarray(0, n)).sort();
  return { median: s[Math.floor(n / 2)], p95: s[Math.min(n - 1, Math.floor(n * 0.95))], max: s[n - 1] };
}

/**
 * Heap activity over a window: bytes allocated (heap growth plus what each GC freed), GC count and pause
 * time (µs, from v8.GCProfiler), and heap retained after a full GC compared with the start.
 */
function heapWindow() {
  globalThis.gc();
  const used0 = v8.getHeapStatistics().used_heap_size;
  const profiler = new v8.GCProfiler();
  profiler.start();
  return () => {
    const used1 = v8.getHeapStatistics().used_heap_size;
    let statistics = profiler.stop().statistics;
    const gcs = statistics.length;
    let freed = 0;
    let pauseUs = 0;
    for (const g of statistics) {
      freed += g.beforeGC.heapStatistics.usedHeapSize - g.afterGC.heapStatistics.usedHeapSize;
      pauseUs += g.cost;
    }
    statistics = null; // ~3 KB per GC: not part of what the reads retain
    globalThis.gc();
    return {
      allocatedBytes: used1 - used0 + freed,
      gcs,
      gcPauseUs: pauseUs,
      retainedBytes: v8.getHeapStatistics().used_heap_size - used0,
    };
  };
}

/** Per-call wall times (µs), off the V8 heap so that recording them does not count as allocation. */
const wallBuf = new Float64Array(1 << 21);

/**
 * Runs `fn` in a loop and returns per-call wall (distribution), process CPU (and its kernel part),
 * system CPU (µs) and the heap activity per call.
 *
 * System CPU: ROUNDS busy windows, each compared with the mean of the idle windows around it; the
 * spread of the idle windows (other processes) gives the noise of the figure, per call.
 */
async function measureLoop(name, fn, isAsync = false, windowMs = WINDOW_MS) {
  // Warm-up for one window: V8 compiles and optimizes the read path, so the retained heap below shows
  // what the reads keep, not the one-off code and type feedback.
  for (const t0 = performance.now(); performance.now() - t0 < windowMs;) {
    await (isAsync ? fn() : Promise.resolve(fn()));
  }
  const endHeap = heapWindow();
  const cpu0 = process.cpuUsage();
  const idles = [await idleRate(windowMs)];
  let calls = 0;
  let busyElapsed = 0;
  let systemMs = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const a = hostTicks();
    const cpuRound = process.cpuUsage();
    const t0 = performance.now();
    while (performance.now() - t0 < windowMs) {
      const s = performance.now();
      if (isAsync) {
        await fn();
      } else {
        fn();
      }
      wallBuf[calls % wallBuf.length] = (performance.now() - s) * 1000;
      calls++;
    }
    const elapsed = performance.now() - t0;
    const b = hostTicks();
    const roundCpuMs = cpuUs(process.cpuUsage(cpuRound)) / 1000;
    busyElapsed += elapsed;
    idles.push(await idleRate(windowMs));
    const idle = (idles[round] + idles[round + 1]) / 2;
    // Never below our own CPU: a quieter neighbour during the busy window is not a negative cost.
    systemMs += Math.max(roundCpuMs, machineBusyMs(a, b, elapsed) - idle * elapsed);
  }
  const cpu = process.cpuUsage(cpu0);
  const heap = endHeap();
  return {
    name,
    calls,
    wall: dist(wallBuf, Math.min(calls, wallBuf.length)),
    // The idle windows only run timers here: their CPU is negligible next to the busy windows.
    processCpuUs: cpuUs(cpu) / calls,
    processKernelUs: cpu.system / calls,
    systemCpuUs: (systemMs * 1000) / calls,
    systemNoiseUs: ((Math.max(...idles) - Math.min(...idles)) * busyElapsed * 1000) / calls,
    allocatedBytesPerCall: heap.allocatedBytes / calls,
    gcs: heap.gcs,
    gcPauseUsPerCall: heap.gcPauseUs / calls,
    retainedBytes: heap.retainedBytes,
  };
}

/**
 * Reads every source once per tick, `intervalMs` apart, as the extension does: wall and process CPU per
 * read, and the heap behaviour of the whole run (GC load, heap range, retained heap).
 */
async function measurePaced(sources, durationMs, intervalMs) {
  const capacity = Math.ceil(durationMs / intervalMs) + 2;
  const per = sources.map(() => ({ walls: new Float64Array(capacity), cpuUs: 0, n: 0 }));
  const heapUsed = new Float64Array(capacity);
  const endHeap = heapWindow();
  const t0 = performance.now();
  let ticks = 0;
  while (performance.now() - t0 < durationMs && ticks < capacity) {
    for (let i = 0; i < sources.length; i++) {
      const [, fn, isAsync] = sources[i];
      const c0 = process.cpuUsage();
      const s = performance.now();
      if (isAsync) {
        await fn();
      } else {
        fn();
      }
      const r = per[i];
      r.walls[r.n++] = (performance.now() - s) * 1000;
      r.cpuUs += cpuUs(process.cpuUsage(c0));
    }
    heapUsed[ticks++] = v8.getHeapStatistics().used_heap_size;
    await sleep(Math.max(0, t0 + ticks * intervalMs - performance.now()));
  }
  const elapsedS = (performance.now() - t0) / 1000;
  const heap = endHeap();
  const used = heapUsed.subarray(0, ticks);
  return {
    intervalMs,
    ticks,
    sources: Object.fromEntries(sources.map(([key], i) => [key, { wall: dist(per[i].walls, per[i].n), processCpuUs: per[i].cpuUs / per[i].n }])),
    heap: {
      allocatedBytesPerTick: heap.allocatedBytes / ticks,
      gcsPerMinute: (heap.gcs * 60) / elapsedS,
      gcPauseMsPerMinute: (heap.gcPauseUs / 1000 * 60) / elapsedS,
      gcLoadPercentOfCore: (heap.gcPauseUs / 1000 / (elapsedS * 1000)) * 100,
      heapMinMB: Math.min(...used) / 1048576,
      heapMaxMB: Math.max(...used) / 1048576,
      retainedBytes: heap.retainedBytes,
    },
  };
}

/**
 * Component sensors (async, libuv pool): the scan (once a minute), passes back to back, and each file
 * on its own. The provider's clock is driven here, so rescans happen only when asked for.
 */
async function measureComponents() {
  let now = Date.now();
  const comp = new P.ComponentTempProvider('/sys', () => now);
  await comp.refresh(); // first scan, cold (also compiles the code)
  const scanWalls = new Float64Array(5);
  let scanCpu = 0;
  for (let i = 0; i < scanWalls.length; i++) {
    now += RESCAN_MS;
    const c0 = process.cpuUsage();
    const s = performance.now();
    await comp.refresh(); // rescan + pass
    scanWalls[i] = (performance.now() - s) * 1000;
    scanCpu += cpuUs(process.cpuUsage(c0));
  }
  const sensors = comp.sensors ?? []; // private field of the bundled class: the files a pass reads
  const loop = await measureLoop('temperature: component pass', () => comp.refresh(), true, PASS_WINDOW_MS);
  const scan = { wall: dist(scanWalls), processCpuUs: scanCpu / scanWalls.length - loop.processCpuUs };

  // Each file on its own (async, as the pass reads it): where the pass time goes.
  const files = [];
  const walls = new Float64Array(100);
  for (const sensor of sensors) {
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < walls.length; i++) {
      const s = performance.now();
      await fs.promises.readFile(sensor.inputPath, 'utf8');
      walls[i] = (performance.now() - s) * 1000;
    }
    files.push({
      label: sensor.label,
      file: sensor.inputPath.replace(/^\/sys\/class\//, ''),
      wall: dist(walls),
      processCpuUs: cpuUs(process.cpuUsage(cpu0)) / walls.length,
    });
  }
  return { comp, scan, loop, files, sensors: sensors.length };
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
/** Interval at which a per-read cost (µs) uses the whole budget. */
const floorMs = (costUs) => costUs / 1000 / SHARE;
/**
 * Whole-machine cost of a loop per read: the system figure when the work outside this process stands
 * out of the noise of the idle windows, otherwise the process CPU (which holds the kernel work done in
 * our syscalls).
 */
const loopCostUs = (r) => (r.systemCpuUs - r.processCpuUs > r.systemNoiseUs ? r.systemCpuUs : r.processCpuUs);

console.log(`bench-linux: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} threads, kernel ${os.release()}, node ${process.version}`);
console.log(`Load average ${os.loadavg().map((l) => l.toFixed(2)).join(' ')} (close heavy apps for a stable baseline)`);
console.log(`Budget: ${(SLA_CORE_FRACTION * 100).toFixed(1)}% of one core; minimum = interval at which one section alone uses it\n`);

const cpu = new P.CpuProvider();
const freq = new P.CpuFreqProvider();
const mem = new P.MemoryProvider();
const cpuTemp = new P.CpuTempProvider();
const battery = new P.BatteryProvider();
const disk = new P.DiskProvider();
const diskPath = process.cwd();
const hasFreq = freq.sample() !== null;
const hasTemp = cpuTemp.sample() !== null;
const hasBattery = battery.isAvailable;

/** Sources of the status bar sections [key, read, async, name]; the component pass is measured apart. */
const SOURCES = [
  ['cpu', () => cpu.sample(), false, 'cpu: /proc/stat'],
  ['freq', () => freq.sample(), false, 'freq: cpufreq scaling_cur_freq'],
  ['load', () => os.loadavg(), false, 'load: os.loadavg (macOS section, reference)'],
  ['mem', () => mem.sample(), false, 'memory: /proc/meminfo'],
  ['temp', () => cpuTemp.sample(), false, 'temperature: CPU hwmon'],
  ['battery', () => battery.sample(), false, 'battery: power_supply'],
  ['disk', () => disk.sample([], diskPath), true, 'disk: statfs (async)'],
].filter(([key]) => (key !== 'freq' || hasFreq) && (key !== 'temp' || hasTemp) && (key !== 'battery' || hasBattery));
const NAMES = Object.fromEntries(SOURCES.map(([key, , , name]) => [key, name]));
NAMES.components = 'temperature: component pass (async)';

console.log(`1/4 Per-read cost (${ROUNDS} × ${WINDOW_MS / 1000} s per source, between idle windows)...`);
const hot = {};
for (const [key, fn, isAsync, name] of SOURCES) {
  hot[key] = await measureLoop(name, fn, isAsync);
}

console.log(`2/4 Component temperature sensors (rescans, ${ROUNDS} × ${PASS_WINDOW_MS / 1000} s of passes, each file)...`);
const components = await measureComponents();

console.log(`3/4 Reads every ${PACED_INTERVAL_MS} ms for ${PACED_MS / 1000} s (issue #5: on-thread latency, GC)...`);
const paced = await measurePaced(SOURCES, PACED_MS, PACED_INTERVAL_MS);

console.log(`4/4 Reads every ${SPACED_INTERVAL_MS / 1000} s for ${SPACED_MS / 1000} s (kernel caches expired, devices idle between reads)...\n`);
const spaced = await measurePaced([...SOURCES, ['components', () => components.comp.refresh(), true]], SPACED_MS, SPACED_INTERVAL_MS);

console.log('Per-read cost, reads back to back (wall per call; CPU per call):');
console.table(
  [...SOURCES.map(([key]) => hot[key]), components.loop].map((r) => ({
    source: r.name,
    'wall µs median': fmt(r.wall.median),
    'p95': fmt(r.wall.p95),
    'max': fmt(r.wall.max),
    'process CPU µs': fmt(r.processCpuUs),
    'of which kernel': fmt(r.processKernelUs),
    'system CPU µs': `${fmt(r.systemCpuUs)} ± ${fmt(r.systemNoiseUs)}`,
    'floor (ms)': fmt(floorMs(loopCostUs(r))),
  }))
);

const timing = (title, run) => {
  console.log(title);
  console.table(
    Object.entries(run.sources).map(([key, r]) => ({
      source: NAMES[key],
      'wall µs median': fmt(r.wall.median),
      'p95': fmt(r.wall.p95),
      'max': fmt(r.wall.max),
      'process CPU µs': fmt(r.processCpuUs),
      [`thread blocked < ${SLA_US} µs (p95)`]: key === 'components' || key === 'disk' ? 'off-thread' : r.wall.p95 <= SLA_US ? 'yes' : 'NO',
    }))
  );
};
timing(`Reads every ${PACED_INTERVAL_MS} ms (${paced.ticks} ticks), on the calling thread:`, paced);
timing(`Reads every ${SPACED_INTERVAL_MS / 1000} s (${spaced.ticks} ticks):`, spaced);

const c = components;
const spacedPass = spaced.sources.components;
console.log(`Temperature, component sensors (async, libuv pool, one file after the other): ${c.sensors} sensors`);
console.table([
  {
    run: `rescan (once per ${RESCAN_MS / 1000} s), on top of a pass`,
    'wall ms': `${fmt(c.scan.wall.median / 1000, 2)} median, max ${fmt(c.scan.wall.max / 1000, 2)}`,
    'process CPU ms': fmt(c.scan.processCpuUs / 1000, 2),
  },
  {
    run: `back to back (${c.loop.calls} passes)`,
    'wall ms': `${fmt(c.loop.wall.median / 1000, 2)} median, p95 ${fmt(c.loop.wall.p95 / 1000, 2)}, max ${fmt(c.loop.wall.max / 1000, 2)}`,
    'process CPU ms': fmt(c.loop.processCpuUs / 1000, 2),
  },
  {
    run: `every ${SPACED_INTERVAL_MS / 1000} s (${spaced.ticks} passes)`,
    'wall ms': `${fmt(spacedPass.wall.median / 1000, 2)} median, p95 ${fmt(spacedPass.wall.p95 / 1000, 2)}, max ${fmt(spacedPass.wall.max / 1000, 2)}`,
    'process CPU ms': fmt(spacedPass.processCpuUs / 1000, 2),
  },
]);
if (c.files.length) {
  console.log('Component files, 100 async reads each, back to back:');
  console.table(c.files.map((f) => ({
    sensor: f.label,
    file: f.file,
    'wall µs median': fmt(f.wall.median),
    'p95': fmt(f.wall.p95),
    'max': fmt(f.wall.max),
    'process CPU µs': fmt(f.processCpuUs),
  })));
}

console.log('V8 heap per source (reads back to back; allocated = heap growth + what GC freed, v8.GCProfiler):');
console.table(
  [...SOURCES.map(([key]) => hot[key]), c.loop].map((r) => ({
    source: r.name,
    'bytes allocated/read': fmt(r.allocatedBytesPerCall, 0),
    'GCs': r.gcs,
    'GC pause µs/read': fmt(r.gcPauseUsPerCall, 2),
    'retained after full GC (KB)': fmt(r.retainedBytes / 1024, 1),
  }))
);
const heapRow = (label, h) => ({
  run: label,
  'allocated KB/tick': fmt(h.allocatedBytesPerTick / 1024, 1),
  'GCs/min': fmt(h.gcsPerMinute, 1),
  'GC pause ms/min': fmt(h.gcPauseMsPerMinute, 2),
  'GC % of one core': fmt(h.gcLoadPercentOfCore, 4),
  'heap MB min-max': `${fmt(h.heapMinMB, 2)}-${fmt(h.heapMaxMB, 2)}`,
  'retained after full GC (KB)': fmt(h.retainedBytes / 1024, 1),
});
console.log('V8 heap while reading every source at a fixed interval:');
console.table([heapRow(`every ${PACED_INTERVAL_MS} ms`, paced.heap), heapRow(`every ${SPACED_INTERVAL_MS / 1000} s (+ component pass)`, spaced.heap)]);

// Cost per read of each source: the largest of the back-to-back figure and the paced ones (caches
// expired: e.g. the ACPI battery answers through the embedded controller; slower clock between reads).
// The paced runs only have process CPU: the system figure is too noisy for single reads.
const sourceCostUs = (key) => Math.max(loopCostUs(hot[key]), paced.sources[key].processCpuUs, spaced.sources[key].processCpuUs);
const passCostUs = Math.max(loopCostUs(c.loop), spacedPass.processCpuUs);

// Proposed minimums: source cost per read + extension-host cost per read (from `pnpm run bench:extension`,
// run it first on Linux), divided by the budget, rounded up to 100 ms, at least 200 ms.
const extFile = path.join(root, 'dist', 'bench-extension.json');
const extData = fs.existsSync(extFile) ? JSON.parse(fs.readFileSync(extFile, 'utf8')) : null;
let proposed = null;
if (extData && extData.platform === 'linux') {
  const ext = extData.perReadUs ?? {};
  const rows = [];
  for (const section of ['cpu', 'freq', 'temp', 'mem', 'battery', 'disk']) {
    let source = NaN;
    let extension = ext[section];
    if (section === 'temp' && hot.temp) {
      source = sourceCostUs('temp') + passCostUs;
      // The component pass runs in this process (libuv pool), so bench-extension's figure already holds
      // its process CPU: counted once, in the source figure.
      extension = extension !== undefined ? Math.max(0, extension - c.loop.processCpuUs) : undefined;
    } else if (hot[section]) {
      source = sourceCostUs(section);
    }
    if (!Number.isFinite(source) || extension === undefined) {
      rows.push({ section, 'source µs/read': fmt(source), 'extension µs/read': fmt(extension ?? NaN, 0), 'proposed minimum (ms)': 'n/a' });
      continue;
    }
    const raw = floorMs(source + extension);
    rows.push({
      section,
      'source µs/read': fmt(source),
      'extension µs/read': fmt(extension, 0),
      'exact (ms)': fmt(raw, 0),
      'proposed minimum (ms)': Math.max(200, Math.ceil(raw / 100) * 100),
    });
  }
  console.log('\nProposed minimums (rule: docs/ARCHITECTURE.md, "Refresh Floors"):');
  console.table(rows);
  // Mirror of DEFAULT_STATUS_BAR_MS in src/config.ts.
  const DEFAULTS = { cpu: 2000, freq: 2000, temp: 10000, mem: 2000, battery: 10000, disk: 10000 };
  let total = 0;
  for (const r of rows) {
    if (r['exact (ms)'] !== undefined) {
      total += (Number(r['source µs/read']) + Number(r['extension µs/read'])) / 1000 / DEFAULTS[r.section];
    }
  }
  total += c.scan.processCpuUs / 1000 / RESCAN_MS; // component rescan, once a minute
  console.log(`Cost at the default status bar intervals (sections measured above, rescan included): ${(total * 100).toFixed(3)}% of one core (budget ${(SLA_CORE_FRACTION * 100).toFixed(1)}%)`);
  proposed = rows;
} else {
  console.log('\nRun `pnpm run bench:extension` first on Linux to get the proposed minimums (it writes dist/bench-extension.json).');
}

if (JSON_OUT) {
  delete components.comp;
  console.log('\n' + JSON.stringify({ share: SHARE, hot, components, paced, spaced, proposed }, null, 2));
}
