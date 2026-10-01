import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const addonPath = path.resolve(__dirname, '../dist/native/darwin_telemetry.node');
console.log('Loading addon from:', addonPath);
const addon = require(addonPath);

console.log('--- CPU Topology ---');
const topo = addon.getCpuTopology();
console.log(topo);
if (!topo.model || topo.totalCores <= 0) {
  throw new Error(`Invalid CPU topology: ${JSON.stringify(topo)}`);
}

console.log('\n--- CPU Ticks (Sample 1) ---');
// getCpuTicks(out) fills out[core * 4 + state] (user, system, idle, nice) and returns the core count.
const TICK_STATES = 4;
const ticks1 = new Uint32Array(topo.totalCores * TICK_STATES);
const cores = addon.getCpuTicks(ticks1);
console.log(`Core count: ${cores}`, Array.from(ticks1.subarray(0, TICK_STATES)));
if (cores !== topo.totalCores) {
  throw new Error(`Expected ${topo.totalCores} cores, got ${cores}`);
}
if (addon.getCpuTicks(new Uint32Array(TICK_STATES)) !== cores) {
  throw new Error('getCpuTicks must report the core count when the buffer is too small');
}
let threw = false;
try {
  addon.getCpuTicks([]);
} catch {
  threw = true;
}
if (!threw) {
  throw new Error('getCpuTicks must throw a TypeError when out is not a Uint32Array');
}

await new Promise((r) => setTimeout(r, 500));

console.log('\n--- CPU Ticks (Sample 2) ---');
const ticks2 = new Uint32Array(ticks1.length);
addon.getCpuTicks(ticks2);
for (let i = 0; i < cores; i++) {
  const b = i * TICK_STATES;
  const uDelta = (ticks2[b] - ticks1[b]) >>> 0;
  const sDelta = (ticks2[b + 1] - ticks1[b + 1]) >>> 0;
  const iDelta = (ticks2[b + 2] - ticks1[b + 2]) >>> 0;
  const total = uDelta + sDelta + iDelta;
  const pct = total > 0 ? ((uDelta + sDelta) / total) * 100 : 0;
  const isP = i >= (topo.totalCores - topo.pCores);
  console.log(`Core ${i} (${isP ? 'P' : 'E'}): ${pct.toFixed(1)}%`);
}

console.log('\n--- Memory Stats ---');
const mem = addon.getMemoryStats();
if (!mem || mem.totalBytes <= 0 || mem.usedBytes <= 0) {
  throw new Error(`Invalid memory stats: ${JSON.stringify(mem)}`);
}
console.log({
  totalGB: (mem.totalBytes / 1e9).toFixed(2),
  usedGB: (mem.usedBytes / 1e9).toFixed(2),
  availableGB: (mem.availableBytes / 1e9).toFixed(2),
  activeGB: (mem.activeBytes / 1e9).toFixed(2),
  wiredGB: (mem.wiredBytes / 1e9).toFixed(2),
  compressedGB: (mem.compressedBytes / 1e9).toFixed(2),
  swapTotalMB: (mem.swapTotalBytes / 1e6).toFixed(2),
  swapUsedMB: (mem.swapUsedBytes / 1e6).toFixed(2),
  pressurePercent: `${mem.pressurePercent}%`,
  pressureLevel: mem.pressureLevel,
});
if (mem.pressurePercent < -1 || mem.pressurePercent > 100) {
  throw new Error(`Invalid memory pressure percent: ${mem.pressurePercent}`);
}
if (![0, 1, 2, 4].includes(mem.pressureLevel)) {
  throw new Error(`Invalid memory pressure level: ${mem.pressureLevel}`);
}

console.log('\n--- Battery Stats ---');
const batt = addon.getBatteryStats();
console.log(batt);
if (batt.isAvailable) {
  if (batt.percent < 0 || batt.percent > 100) {
    throw new Error(`Invalid battery percent: ${batt.percent}`);
  }
  if (!batt.status) {
    throw new Error(`Missing battery status`);
  }
  if (batt.designCapacity !== undefined && batt.designCapacity <= 0) {
    throw new Error(`Invalid design capacity: ${batt.designCapacity}`);
  }
  if (batt.maxCapacity !== undefined && batt.maxCapacity <= 0) {
    throw new Error(`Invalid max capacity: ${batt.maxCapacity}`);
  }
  if (batt.healthPercent !== undefined && (batt.healthPercent <= 0 || batt.healthPercent > 100)) {
    throw new Error(`Invalid health percent: ${batt.healthPercent}`);
  }
  if (batt.cycleCount !== undefined && batt.cycleCount < 0) {
    throw new Error(`Invalid cycle count: ${batt.cycleCount}`);
  }
}

console.log('\n--- Die Temperature ---');
const temp = addon.getDieTemperature();
console.log(temp);
if (temp) {
  if (temp.tempCelsius <= 0 || temp.tempCelsius > 120) {
    throw new Error(`Abnormal die temperature: ${temp.tempCelsius}`);
  }
  if (temp.dieCount <= 0) {
    throw new Error(`Invalid die sensor count: ${temp.dieCount}`);
  }
}

console.log('\nSUCCESS: All native Apple Silicon telemetry hooks verified with strict assertions!');
