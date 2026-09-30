// Measurement bench for the refresh floors (macOS, Apple Silicon).
//
// For every data source the extension reads, it measures:
//   - cost per read on the calling thread (wall µs) and for the whole system (CPU µs), where "system"
//     also counts the daemons that serve the request (powerd for the battery, the HID server for
//     temperature). System CPU is measured with host CPU ticks: busy ticks while reading in a loop,
//     minus the idle baseline of the same duration.
//   - how often the source itself refreshes (temperature sensors, battery driver), because reading
//     faster than that returns the same value.
// It then prints, per source, the interval at which its system cost reaches the budget share, which
// is the rule used for the minimum refresh intervals (docs/ARCHITECTURE.md, "Refresh floors").
//
// Usage (on macOS, after `pnpm run compile:native`; close heavy apps for a stable baseline):
//   node test/bench-darwin.mjs            # ~3.5 min (battery driver observed for 120 s)
//   node test/bench-darwin.mjs --quick    # ~1.5 min (battery driver observed for 30 s)
//   node test/bench-darwin.mjs --json     # also prints the raw results as JSON
//
// The battery driver refresh is read with `ioreg` (a subprocess): acceptable in this dev tool, never
// in the extension.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addon = require(path.resolve(__dirname, '../dist/native/darwin_telemetry.node'));

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const JSON_OUT = args.includes('--json');
const LOOP_MS = 3000; // per source
const TEMP_MS = 10_000;
const BATTERY_OBSERVE_MS = QUICK ? 30_000 : 120_000;

/** Project budget (docs/ROADMAP.md): total extension overhead below 0.5% of one core. */
const SLA_CORE_FRACTION = 0.005;
/** Six sections share the budget: at their floors, all six together stay within it. */
const SECTIONS = 6;
const SHARE = SLA_CORE_FRACTION / SECTIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ticksBuf = new Uint32Array(256 * 4);

/** Host CPU ticks summed over all cores: busy (user + system + nice) and total. */
function hostTicks() {
  const cores = addon.getCpuTicks(ticksBuf);
  let busy = 0;
  let total = 0;
  for (let c = 0; c < cores; c++) {
    const u = ticksBuf[c * 4], s = ticksBuf[c * 4 + 1], i = ticksBuf[c * 4 + 2], n = ticksBuf[c * 4 + 3];
    busy += u + s + n;
    total += u + s + i + n;
  }
  return { busy, total, cores };
}

/** Busy CPU time of the whole machine (ms) over a window, from host ticks. */
function machineBusyMs(before, after, elapsedMs) {
  const totalTicks = (after.total - before.total) >>> 0;
  const busyTicks = (after.busy - before.busy) >>> 0;
  // total ticks = cores × elapsed × hz: derive the tick length instead of assuming 100 Hz.
  const msPerTick = (after.cores * elapsedMs) / Math.max(1, totalTicks);
  return busyTicks * msPerTick;
}

/** Idle baseline: machine busy ms per ms of wall time while this process sleeps. */
async function baselineRate(ms = LOOP_MS) {
  const t0 = performance.now();
  const a = hostTicks();
  await sleep(ms);
  const b = hostTicks();
  const elapsed = performance.now() - t0;
  return machineBusyMs(a, b, elapsed) / elapsed;
}

/** Runs `fn` in a loop for LOOP_MS and returns per-call wall, process CPU and system CPU (µs). */
async function measureLoop(name, fn, isAsync = false) {
  const idle = await baselineRate();
  const cpu0 = process.cpuUsage();
  const a = hostTicks();
  const t0 = performance.now();
  let calls = 0;
  while (performance.now() - t0 < LOOP_MS) {
    if (isAsync) {
      await fn();
    } else {
      fn();
    }
    calls++;
  }
  const elapsed = performance.now() - t0;
  const b = hostTicks();
  const cpu = process.cpuUsage(cpu0);
  const systemMs = Math.max(0, machineBusyMs(a, b, elapsed) - idle * elapsed);
  return {
    name,
    calls,
    wallUs: (elapsed * 1000) / calls,
    processCpuUs: (cpu.user + cpu.system) / calls,
    systemCpuUs: (systemMs * 1000) / calls,
  };
}

/** Temperature: back-to-back background passes; pass cost and how often the readings change. */
async function measureTemperature() {
  const first = addon.getDieTemperature(0);
  if (!first) {
    return null;
  }
  const idle = await baselineRate();
  const a = hostTicks();
  const t0 = performance.now();
  const seen = new Map(); // sampleSeq -> reading
  while (performance.now() - t0 < TEMP_MS) {
    const r = addon.getDieTemperature(0); // requests a new pass whenever the worker is idle
    if (r && !seen.has(r.sampleSeq)) {
      seen.set(r.sampleSeq, { at: performance.now(), r });
    }
    await sleep(2);
  }
  const elapsed = performance.now() - t0;
  const b = hostTicks();
  const passes = [...seen.values()].slice(1); // the first one may predate the window
  const n = passes.length;
  const avg = (f) => passes.reduce((s, p) => s + f(p.r), 0) / Math.max(1, n);
  const systemMs = Math.max(0, machineBusyMs(a, b, elapsed) - idle * elapsed);

  // Sensor refresh: time between readings whose values differ (any tdie average/peak, NAND, battery).
  const key = (r) => `${r.tempCelsius}|${r.peakCelsius}|${r.nandCelsius}|${r.batteryCelsius}`;
  const changes = [];
  let last = null;
  for (const p of passes) {
    const k = key(p.r);
    if (last && k !== last.k) {
      changes.push(p.at - last.at);
    }
    if (!last || k !== last.k) {
      last = { k, at: p.at };
    }
  }
  const median = (xs) => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    passes: n,
    passWallMs: avg((r) => r.passWallMs),
    passWorkerCpuMs: avg((r) => r.passCpuMs),
    passSystemCpuMs: systemMs / Math.max(1, n),
    passesPerSecond: (n * 1000) / elapsed,
    valueChangeMedianMs: median(changes),
    valueChanges: changes.length,
  };
}

/** Battery driver: how often AppleSmartBattery publishes new data (its UpdateTime key). */
async function measureBatteryDriver() {
  const read = () => {
    try {
      const out = execFileSync('ioreg', ['-r', '-c', 'AppleSmartBattery', '-d', '1'], { encoding: 'utf8' });
      const m = /"UpdateTime"\s*=\s*(\d+)/.exec(out);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };
  if (read() === null) {
    return null;
  }
  const updates = [];
  let last = read();
  const t0 = Date.now();
  while (Date.now() - t0 < BATTERY_OBSERVE_MS) {
    await sleep(1000);
    const v = read();
    if (v !== null && v !== last) {
      updates.push(v - last); // UpdateTime is in seconds
      last = v;
    }
  }
  return {
    observedS: BATTERY_OBSERVE_MS / 1000,
    updates: updates.length,
    intervalsS: updates,
  };
}

/** Interval at which a per-read system cost (µs) uses the budget share (or, for comparison, the whole budget). */
const floorMs = (costUs, fraction = SHARE) => costUs / 1000 / fraction;

console.log(`bench-darwin: ${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} cores, node ${process.version}`);
console.log(`Budget: ${(SLA_CORE_FRACTION * 100).toFixed(1)}% of one core shared by ${SECTIONS} sections = ${(SHARE * 100).toFixed(3)}% each\n`);

const diskPath = process.cwd();
const results = [];
console.log('1/3 Per-read cost (3 s loop each, after a 3 s idle baseline)...');
results.push(await measureLoop('cpu: getCpuTicks', () => addon.getCpuTicks(ticksBuf)));
results.push(await measureLoop('load: os.loadavg', () => os.loadavg()));
results.push(await measureLoop('memory: getMemoryStats', () => addon.getMemoryStats()));
results.push(await measureLoop('battery: getBatteryStats', () => addon.getBatteryStats()));
results.push(await measureLoop('disk: fs.promises.statfs', () => fs.promises.statfs(diskPath), true));

console.log('2/3 Temperature passes (10 s back to back)...');
const temp = await measureTemperature();

console.log(`3/3 Battery driver refresh (observed for ${BATTERY_OBSERVE_MS / 1000} s)...\n`);
const battery = await measureBatteryDriver();

console.table(
  results.map((r) => ({
    source: r.name,
    'wall µs/read': r.wallUs.toFixed(1),
    'process CPU µs': r.processCpuUs.toFixed(1),
    'system CPU µs': r.systemCpuUs.toFixed(1),
    'floor at 1/6 budget (ms)': floorMs(Math.max(r.systemCpuUs, r.processCpuUs)).toFixed(1),
    'floor at whole budget (ms)': floorMs(Math.max(r.systemCpuUs, r.processCpuUs), SLA_CORE_FRACTION).toFixed(1),
  }))
);

if (temp) {
  const passCost = Math.max(temp.passSystemCpuMs, temp.passWorkerCpuMs);
  console.log('Temperature (background thread, one pass = all sensors):');
  console.table([
    {
      passes: temp.passes,
      'wall ms/pass': temp.passWallMs.toFixed(2),
      'worker CPU ms/pass': temp.passWorkerCpuMs.toFixed(2),
      'system CPU ms/pass': temp.passSystemCpuMs.toFixed(2),
      'value change median (ms)': Number.isFinite(temp.valueChangeMedianMs) ? temp.valueChangeMedianMs.toFixed(0) : 'n/a',
      'floor at 1/6 budget (ms)': floorMs(passCost * 1000).toFixed(0),
      'floor at whole budget (ms)': floorMs(passCost * 1000, SLA_CORE_FRACTION).toFixed(0),
    },
  ]);
} else {
  console.log('Temperature: sensors not available.');
}

if (battery) {
  const s = [...battery.intervalsS].sort((x, y) => x - y);
  const median = s.length ? s[Math.floor(s.length / 2)] : NaN;
  console.log(
    `Battery driver: ${battery.updates} updates in ${battery.observedS} s` +
      (s.length ? `, interval median ${median} s (min ${s[0]} s, max ${s[s.length - 1]} s)` : ' (no update observed: interval longer than the window)')
  );
} else {
  console.log('Battery driver: no AppleSmartBattery (desktop Mac).');
}

// Proposed minimums: native cost per read + extension-host cost per read (from `pnpm run bench:extension`,
// run it first), divided by the section's budget share, rounded up to 100 ms, at least 200 ms.
const extFile = path.resolve(__dirname, '../dist/bench-extension.json');
if (fs.existsSync(extFile)) {
  const ext = JSON.parse(fs.readFileSync(extFile, 'utf8')).perReadUs ?? {};
  const nativeUs = {
    cpu: results[0], freq: results[1], mem: results[2], battery: results[3], disk: results[4],
  };
  const cost = (r) => Math.max(r.systemCpuUs, r.processCpuUs);
  const rows = [];
  for (const section of ['cpu', 'freq', 'temp', 'mem', 'battery', 'disk']) {
    const native = section === 'temp'
      ? (temp ? Math.max(temp.passSystemCpuMs, temp.passWorkerCpuMs) * 1000 : NaN)
      : cost(nativeUs[section]);
    const extension = ext[section];
    if (!Number.isFinite(native) || extension === undefined) {
      rows.push({ section, 'native µs/read': Number.isFinite(native) ? native.toFixed(1) : 'n/a', 'extension µs/read': extension?.toFixed(0) ?? 'n/a', 'proposed minimum (ms)': 'n/a' });
      continue;
    }
    const raw = floorMs(native + extension);
    rows.push({
      section,
      'native µs/read': native.toFixed(1),
      'extension µs/read': extension.toFixed(0),
      'exact (ms)': raw.toFixed(0),
      'proposed minimum (ms)': Math.max(200, Math.ceil(raw / 100) * 100),
    });
  }
  console.log('\nProposed minimums (rule: docs/ARCHITECTURE.md, "Refresh Floors"):');
  console.table(rows);
} else {
  console.log('\nRun `pnpm run bench:extension` first to get the proposed minimums (it writes dist/bench-extension.json).');
}

if (JSON_OUT) {
  console.log('\n' + JSON.stringify({ share: SHARE, results, temp, battery }, null, 2));
}
