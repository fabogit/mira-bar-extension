// DarwinTelemetryProvider with a fake native addon (#52), so it runs on any OS: Mach tick deltas with
// 32-bit wrap, the min-ticks guard, core count changes, P/E core mapping, memory pressure, the battery
// re-probe, and the Node.js fallback when the addon fails at startup.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { describe, test } from 'node:test';
import { DarwinTelemetryProvider } from '../../src/platform/darwin/darwin_provider.js';
import type { DarwinNativeAddon } from '../../src/platform/darwin/native_loader.js';

/** Cumulative Mach ticks of one core, in processor_cpu_load_info order: user, system, idle, nice. */
type Ticks = [number, number, number, number];
type MemoryStats = NonNullable<ReturnType<DarwinNativeAddon['getMemoryStats']>>;
type BatteryStats = ReturnType<DarwinNativeAddon['getBatteryStats']>;
type DieTemperature = ReturnType<DarwinNativeAddon['getDieTemperature']>;

const GB = 1024 ** 3;

/**
 * The addon's contract (native_loader.ts) over plain fields: tests change the counters, stats and
 * failures between calls, and read back which calls were made.
 */
class FakeAddon implements DarwinNativeAddon {
  /** One entry per logical core; values past 2^32 wrap when copied out, as the 32-bit Mach counters. */
  public ticks: Ticks[];
  /** getCpuTicks reports a kernel failure (0 cores). */
  public ticksFail = false;
  public topology: ReturnType<DarwinNativeAddon['getCpuTopology']>;
  public memory: MemoryStats | null = {
    totalBytes: 16 * GB,
    usedBytes: 12 * GB,
    availableBytes: 4 * GB,
    activeBytes: 5 * GB,
    wiredBytes: 3 * GB,
    compressedBytes: 2 * GB,
    inactiveBytes: 2 * GB,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    swapFreeBytes: 0,
    pressurePercent: 30,
    pressureLevel: 1,
  };
  public battery: BatteryStats = { isAvailable: false, percent: 0, status: 'Unknown', timeRemainingMinutes: -1, isCharging: false };
  public temperature: DieTemperature = null;
  public batteryCalls = 0;
  public temperatureCalls: number[] = [];
  /** Thrown by getCpuTopology (an addon that loads but fails). */
  public topologyError: Error | null = null;

  constructor(cores: number, topology: Partial<ReturnType<DarwinNativeAddon['getCpuTopology']>> = {}) {
    this.ticks = Array.from({ length: cores }, (): Ticks => [1000, 500, 8000, 0]);
    this.topology = { model: 'Apple M4', totalCores: cores, pCores: 0, eCores: 0, ...topology };
  }

  public getCpuTicks(out: Uint32Array): number {
    if (!(out instanceof Uint32Array)) {
      throw new TypeError('Expected a Uint32Array');
    }
    if (this.ticksFail) {
      return 0;
    }
    if (out.length >= this.ticks.length * 4) {
      this.ticks.forEach((core, i) => out.set(core, i * 4));
    }
    return this.ticks.length;
  }

  public getCpuTopology(): ReturnType<DarwinNativeAddon['getCpuTopology']> {
    if (this.topologyError) {
      throw this.topologyError;
    }
    return { ...this.topology };
  }

  public getMemoryStats(): MemoryStats | null {
    return this.memory && { ...this.memory };
  }

  public getBatteryStats(): BatteryStats {
    this.batteryCalls++;
    return { ...this.battery };
  }

  public getDieTemperature(maxAgeMs: number): DieTemperature {
    this.temperatureCalls.push(maxAgeMs);
    return this.temperature && { ...this.temperature };
  }

  /** Adds ticks to one core. */
  public add(core: number, [user, system, idle, nice]: Ticks): void {
    const t = this.ticks[core]!;
    t[0] += user;
    t[1] += system;
    t[2] += idle;
    t[3] += nice;
  }
}

const warnings: string[] = [];
const log = { warn: (message: string): void => void warnings.push(message) };

describe('CPU usage from Mach ticks', () => {
  test('primed at construction: every core at 0% with its type, E-cores first', () => {
    const addon = new FakeAddon(10, { pCores: 4, eCores: 6 });
    const darwin = new DarwinTelemetryProvider(log, addon);
    assert.deepEqual(darwin.sampleCpu(), {
      overallPercent: 0,
      perCorePercent: new Array(10).fill(0),
      coreTypes: ['E', 'E', 'E', 'E', 'E', 'E', 'P', 'P', 'P', 'P'],
    });
    assert.equal(darwin.getTopologyDescription(), 'Apple M4 (4P + 6E)');
  });

  test('P/E split unknown: no core types; P-cores only: all P', () => {
    const unknown = new DarwinTelemetryProvider(log, new FakeAddon(8, { model: 'Apple Silicon' }));
    assert.equal(unknown.sampleCpu()!.coreTypes, undefined);
    assert.equal(unknown.getTopologyDescription(), 'Apple Silicon (8 cores)');
    const pOnly = new DarwinTelemetryProvider(log, new FakeAddon(4, { pCores: 4 }));
    assert.deepEqual(pOnly.sampleCpu()!.coreTypes, ['P', 'P', 'P', 'P']);
  });

  test('user, system and nice busy, idle not', () => {
    const addon = new FakeAddon(2);
    const darwin = new DarwinTelemetryProvider(log, addon);
    addon.add(0, [30, 10, 50, 10]);
    addon.add(1, [0, 0, 100, 0]);
    assert.deepEqual(darwin.sampleCpu(), { overallPercent: 25, perCorePercent: [50, 0], coreTypes: undefined });
  });

  test('32-bit counters wrapping between two samples', () => {
    const addon = new FakeAddon(1);
    addon.ticks[0] = [2 ** 32 - 10, 2 ** 32 - 1, 1000, 0];
    const darwin = new DarwinTelemetryProvider(log, addon);
    addon.add(0, [30, 10, 60, 0]); // user and system wrap, idle stays below 2^32
    assert.deepEqual(darwin.sampleCpu()!.perCorePercent, [40]);
  });

  test('samples closer than 5 ticks per core: previous result, baseline kept', () => {
    const addon = new FakeAddon(2);
    const darwin = new DarwinTelemetryProvider(log, addon);
    const primed = darwin.sampleCpu();
    addon.add(0, [9, 0, 0, 0]); // 9 ticks over 2 cores (minimum 10)
    assert.equal(darwin.sampleCpu(), primed);
    addon.add(0, [16, 0, 75, 0]); // measured from the kept baseline: 25 busy of 100
    assert.deepEqual(darwin.sampleCpu()!.perCorePercent, [25, 0]);
  });

  test('core count change: one sample to take a new baseline, buffers grown when needed', () => {
    const addon = new FakeAddon(2);
    const darwin = new DarwinTelemetryProvider(log, addon);
    addon.add(0, [50, 0, 50, 0]);
    addon.add(1, [50, 0, 50, 0]);
    const before = darwin.sampleCpu()!;
    assert.deepEqual(before.perCorePercent, [50, 50]);
    // Two more cores (buffers too small, reallocated): the previous result while the new baseline is taken.
    addon.ticks.push([7000, 3000, 90_000, 0], [7000, 3000, 90_000, 0]);
    for (let i = 0; i < 4; i++) {
      addon.add(i, [10, 0, 90, 0]);
    }
    assert.equal(darwin.sampleCpu(), before);
    for (let i = 0; i < 4; i++) {
      addon.add(i, [i * 20, 0, 100 - i * 20, 0]);
    }
    assert.deepEqual(darwin.sampleCpu()!.perCorePercent, [0, 20, 40, 60]);
    // Back to three cores (buffers large enough): again one sample to take the baseline.
    const four = darwin.sampleCpu();
    addon.ticks.pop();
    assert.equal(darwin.sampleCpu(), four);
    addon.add(2, [100, 0, 0, 0]);
    assert.deepEqual(darwin.sampleCpu()!.perCorePercent, [0, 0, 100]);
  });

  test('kernel query failing (0 cores): previous result, measured again afterwards', () => {
    const addon = new FakeAddon(1);
    const darwin = new DarwinTelemetryProvider(log, addon);
    addon.add(0, [20, 0, 80, 0]);
    const last = darwin.sampleCpu();
    addon.ticksFail = true;
    addon.add(0, [100, 0, 0, 0]);
    assert.equal(darwin.sampleCpu(), last);
    addon.ticksFail = false;
    assert.deepEqual(darwin.sampleCpu()!.perCorePercent, [100]);
  });
});

describe('memory, temperature, battery', () => {
  test('memory pressure: -1 undefined, levels 1, 2, 4 named', () => {
    const addon = new FakeAddon(1);
    const darwin = new DarwinTelemetryProvider(log, addon);
    const mem = darwin.sampleMemory()!;
    assert.deepEqual(
      [mem.usedPercent, mem.swapUsedPercent, mem.compressedBytes, mem.pressurePercent, mem.pressureLevel],
      [75, 0, 2 * GB, 30, 'Normal'],
    );
    addon.memory = { ...addon.memory!, pressurePercent: -1, pressureLevel: 0 };
    assert.deepEqual([darwin.sampleMemory()!.pressurePercent, darwin.sampleMemory()!.pressureLevel], [undefined, undefined]);
    const levels = [0, 2, 3, 4].map((pressureLevel) => {
      addon.memory = { ...addon.memory!, pressurePercent: 0, pressureLevel };
      return [darwin.sampleMemory()!.pressurePercent, darwin.sampleMemory()!.pressureLevel];
    });
    assert.deepEqual(levels, [[0, undefined], [0, 'Warning'], [0, undefined], [0, 'Critical']]);
    addon.memory = { ...addon.memory!, swapTotalBytes: 4 * GB, swapUsedBytes: GB, swapFreeBytes: 3 * GB };
    assert.equal(darwin.sampleMemory()!.swapUsedPercent, 25);
  });

  test('memory query failing: os.totalmem / os.freemem', () => {
    const addon = new FakeAddon(1);
    const darwin = new DarwinTelemetryProvider(log, addon);
    addon.memory = null;
    assert.deepEqual([darwin.sampleMemory()!.totalBytes, darwin.sampleMemory()!.pressureLevel], [os.totalmem(), undefined]);
    addon.memory = { ...new FakeAddon(1).memory!, totalBytes: 0 };
    assert.equal(darwin.sampleMemory()!.totalBytes, os.totalmem(), 'zero total');
  });

  test('temperature: maxAgeMs passed on, refresh requests a pass (0)', () => {
    const addon = new FakeAddon(1);
    addon.temperature = { tempCelsius: 48.5, peakCelsius: 55, dieCount: 8, sampleSeq: 3, ageMs: 120, passWallMs: 16, passCpuMs: 2 };
    const darwin = new DarwinTelemetryProvider(log, addon);
    assert.equal(darwin.sampleTemp(2500)?.tempCelsius, 48.5);
    darwin.requestTempRefresh();
    assert.deepEqual(addon.temperatureCalls, [2500, 0]);
  });

  test('missing battery re-probed at most once a minute; present, not probed again', () => {
    let now = 1_000_000;
    const addon = new FakeAddon(1);
    const darwin = new DarwinTelemetryProvider(log, addon, () => now);
    assert.equal(addon.batteryCalls, 1, 'probed at construction');
    assert.equal(darwin.isBatteryAvailable(), false);
    now += 59_999;
    assert.equal(darwin.isBatteryAvailable(), false);
    assert.equal(addon.batteryCalls, 1, 'not probed before 60 s');
    now += 1;
    assert.equal(darwin.isBatteryAvailable(), false);
    assert.equal(addon.batteryCalls, 2, 're-probed at 60 s');
    // The battery shows up (transient IOKit failure on a laptop): seen at the next re-probe.
    addon.battery = { isAvailable: true, percent: 80, status: 'Discharging', timeRemainingMinutes: 240, isCharging: false, cycleCount: 120 };
    now += 59_999;
    assert.equal(darwin.isBatteryAvailable(), false);
    now += 1;
    assert.equal(darwin.isBatteryAvailable(), true);
    assert.equal(darwin.isBatteryAvailable(), true);
    assert.equal(addon.batteryCalls, 3, 'present: cached, no further probe');
    assert.deepEqual([darwin.sampleBattery()?.percent, darwin.sampleBattery()?.cycleCount], [80, 120]);
    // A read finding it gone: missing again, re-probed only once the interval has passed.
    addon.battery = { ...addon.battery, isAvailable: false };
    assert.equal(darwin.sampleBattery(), null);
    const calls = addon.batteryCalls;
    assert.equal(darwin.isBatteryAvailable(), false);
    assert.equal(addon.batteryCalls, calls);
  });

  test('addon failing at startup: Node.js fallback, warning logged', () => {
    const addon = new FakeAddon(4, { pCores: 4 });
    addon.topologyError = new Error('host_processor_info failed');
    warnings.length = 0;
    const darwin = new DarwinTelemetryProvider(log, addon);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Native addon failed at startup; using the Node\.js fallback: host_processor_info failed/);
    const cpu = darwin.sampleCpu()!;
    assert.equal(cpu.perCorePercent.length, os.cpus().length, 'os.cpus() cores');
    assert.equal(cpu.coreTypes, undefined);
    assert.equal(darwin.sampleTemp(1000), null);
    assert.equal(darwin.isBatteryAvailable(), false);
    assert.equal(darwin.sampleBattery(), null);
    assert.equal(darwin.sampleMemory()!.totalBytes, os.totalmem());
    assert.deepEqual([addon.temperatureCalls, addon.batteryCalls], [[], 0], 'the failed addon is not called again');
  });
});
