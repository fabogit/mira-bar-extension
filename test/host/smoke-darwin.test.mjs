// The darwin native addon on this machine: every export called directly and its values checked.
//
// Usage (macOS after `pnpm run compile:native`):  pnpm run test:host
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const addonPath = path.resolve(__dirname, '../../dist/native/darwin_telemetry.node');

describe('darwin native addon on this machine', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  let addon;
  let topo;
  before(() => {
    console.log('Loading addon from:', addonPath);
    addon = require(addonPath);
  });

  test('CPU topology', () => {
    topo = addon.getCpuTopology();
    console.log(topo);
    assert.ok(topo.model && topo.totalCores > 0, `invalid CPU topology: ${JSON.stringify(topo)}`);
  });

  test('CPU ticks: core count, short buffer, wrong type, deltas', async () => {
    // getCpuTicks(out) fills out[core * 4 + state] (user, system, idle, nice) and returns the core count.
    const TICK_STATES = 4;
    const ticks1 = new Uint32Array(topo.totalCores * TICK_STATES);
    const cores = addon.getCpuTicks(ticks1);
    console.log(`Core count: ${cores}`, Array.from(ticks1.subarray(0, TICK_STATES)));
    assert.equal(cores, topo.totalCores);
    assert.equal(addon.getCpuTicks(new Uint32Array(TICK_STATES)), cores, 'core count reported when the buffer is too small');
    assert.throws(() => addon.getCpuTicks([]), TypeError, 'out must be a Uint32Array');

    await new Promise((r) => setTimeout(r, 500));

    const ticks2 = new Uint32Array(ticks1.length);
    addon.getCpuTicks(ticks2);
    const loads = [];
    for (let i = 0; i < cores; i++) {
      const b = i * TICK_STATES;
      const uDelta = (ticks2[b] - ticks1[b]) >>> 0;
      const sDelta = (ticks2[b + 1] - ticks1[b + 1]) >>> 0;
      const iDelta = (ticks2[b + 2] - ticks1[b + 2]) >>> 0;
      const total = uDelta + sDelta + iDelta;
      const pct = total > 0 ? ((uDelta + sDelta) / total) * 100 : 0;
      assert.ok(pct >= 0 && pct <= 100, `core ${i}: ${pct}%`);
      loads.push(`C${i}(${i >= topo.totalCores - topo.pCores ? 'P' : 'E'}): ${pct.toFixed(1)}%`);
    }
    console.log(loads.join(' '));
  });

  test('memory stats', () => {
    const mem = addon.getMemoryStats();
    assert.ok(mem && mem.totalBytes > 0 && mem.usedBytes > 0, `invalid memory stats: ${JSON.stringify(mem)}`);
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
    assert.ok(mem.pressurePercent >= -1 && mem.pressurePercent <= 100, `memory pressure percent: ${mem.pressurePercent}`);
    assert.ok([0, 1, 2, 4].includes(mem.pressureLevel), `memory pressure level: ${mem.pressureLevel}`);
  });

  test('battery stats', () => {
    const batt = addon.getBatteryStats();
    console.log(batt);
    if (!batt.isAvailable) return;
    assert.ok(batt.percent >= 0 && batt.percent <= 100, `battery percent: ${batt.percent}`);
    assert.ok(batt.status, 'battery status');
    assert.ok(batt.designCapacity === undefined || batt.designCapacity > 0, `design capacity: ${batt.designCapacity}`);
    assert.ok(batt.maxCapacity === undefined || batt.maxCapacity > 0, `max capacity: ${batt.maxCapacity}`);
    assert.ok(batt.healthPercent === undefined || (batt.healthPercent > 0 && batt.healthPercent <= 100), `health percent: ${batt.healthPercent}`);
    assert.ok(batt.cycleCount === undefined || batt.cycleCount >= 0, `cycle count: ${batt.cycleCount}`);
  });

  test('die temperature', () => {
    const temp = addon.getDieTemperature(5000); // the first call with a non-zero max age waits for the first pass
    console.log(temp);
    if (!temp) return;
    assert.ok(temp.tempCelsius > 0 && temp.tempCelsius <= 120, `abnormal die temperature: ${temp.tempCelsius}`);
    assert.ok(temp.dieCount > 0, `die sensor count: ${temp.dieCount}`);
  });
});
