// Linux providers against mocked procfs and sysfs trees (#52): CPU usage (min-ticks guard, counters
// going backwards, iowait as idle, hotplug gaps), CPU frequency (parked cores, bad values, rescan),
// memory (missing MemAvailable, no swap), CPU sensor priority (AMD over Intel over generic sensors,
// the test laptop's hwmon layout), and LinuxTelemetryProvider.sampleTemp (cache, stale components).
// Descriptors kept open and cpufreq per policy: linux-sysfs.test.ts; sensor limits, components and
// the CPU sensor rescan and cache: linux-temp.test.ts.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { CpuProvider } from '../../src/platform/linux/cpu.js';
import type { ComponentTempProvider } from '../../src/platform/linux/components.js';
import { CpuFreqProvider } from '../../src/platform/linux/cpufreq.js';
import { CpuTempProvider } from '../../src/platform/linux/cputemp.js';
import { LinuxTelemetryProvider } from '../../src/platform/linux/linux_provider.js';
import { MemoryProvider } from '../../src/platform/linux/memory.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh, empty tree (procfs or sysfs root). */
function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
  roots.push(root);
  return root;
}

/** Writes a file under base (values as in sysfs, newline-terminated), in place if it exists. */
function write(base: string, file: string, value: string | number): void {
  fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
  fs.writeFileSync(path.join(base, file), `${value}\n`);
}

/** Cumulative jiffies of one core, in /proc/stat order: user, nice, system, idle, iowait, irq, softirq, steal. */
type Jiffies = [number, number, number, number, number, number, number, number];

/** Jiffies with only the given counters set. */
function jiffies(counters: Partial<Record<'user' | 'nice' | 'system' | 'idle' | 'iowait' | 'irq' | 'softirq' | 'steal', number>>): Jiffies {
  const { user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0 } = counters;
  return [user, nice, system, idle, iowait, irq, softirq, steal];
}

/**
 * Writes `<root>/stat` as the kernel does: the aggregate line (sum of the online cores), one line per
 * online core (`undefined`: offline, no line), guest columns, and the other lines the parser skips.
 */
function writeStat(root: string, cores: (Jiffies | undefined)[]): void {
  const sum = jiffies({});
  const lines: string[] = [];
  cores.forEach((core, i) => {
    if (core) {
      core.forEach((v, j) => (sum[j] += v));
      lines.push(`cpu${i} ${core.join(' ')} 0 0`);
    }
  });
  fs.writeFileSync(path.join(root, 'stat'), [`cpu  ${sum.join(' ')} 0 0`, ...lines, 'intr 12345 0 0', 'ctxt 67890', 'procs_running 2', ''].join('\n'));
}

/** Adds `delta` to each counter of `core`, in place. */
function add(core: Jiffies, delta: Jiffies): void {
  delta.forEach((v, j) => (core[j] += v));
}

describe('CpuProvider (/proc/stat)', () => {
  test('primed at construction; iowait idle, irq, softirq and steal busy', () => {
    const proc = tree();
    const cores = [jiffies({ user: 1000, idle: 9000 }), jiffies({ user: 2000, idle: 8000 })];
    writeStat(proc, cores);
    const cpu = new CpuProvider(proc);
    assert.deepEqual(cpu.sample(), { overallPercent: 0, perCorePercent: [0, 0] }, 'no new ticks: the primed result, every core at 0%');
    // 100 ticks per core: 25 user + 75 iowait (I/O wait is idle, not busy), and 10 irq + 10 softirq + 20 steal + 60 idle.
    add(cores[0]!, jiffies({ user: 25, iowait: 75 }));
    add(cores[1]!, jiffies({ irq: 10, softirq: 10, steal: 20, idle: 60 }));
    writeStat(proc, cores);
    assert.deepEqual(cpu.sample(), { overallPercent: 32.5, perCorePercent: [25, 40] });
  });

  test('samples closer than 5 ticks per core: previous result, baseline kept', () => {
    const proc = tree();
    const cores = [0, 1, 2, 3].map(() => jiffies({ idle: 1000 }));
    writeStat(proc, cores);
    const cpu = new CpuProvider(proc);
    const primed = cpu.sample();
    // 15 ticks over 4 cores (minimum 20): too close, the previous result object and no new baseline.
    add(cores[0]!, jiffies({ user: 15 }));
    writeStat(proc, cores);
    assert.equal(cpu.sample(), primed);
    // The next sample measures from the kept baseline: 25 busy of 100 on core 0.
    add(cores[0]!, jiffies({ user: 10, idle: 75 }));
    writeStat(proc, cores);
    assert.deepEqual(cpu.sample(), { overallPercent: 25, perCorePercent: [25, 0, 0, 0] });
  });

  test('counters going backwards: last overall kept, baseline reset', () => {
    const proc = tree();
    const cores = [jiffies({ user: 5000, idle: 5000 })];
    writeStat(proc, cores);
    const cpu = new CpuProvider(proc);
    add(cores[0]!, jiffies({ user: 50, idle: 50 }));
    writeStat(proc, cores);
    assert.deepEqual(cpu.sample(), { overallPercent: 50, perCorePercent: [50] });
    // Counters reset (smaller than the baseline): no percentage from a negative delta.
    const reset = [jiffies({ user: 100, idle: 900 })];
    writeStat(proc, reset);
    assert.deepEqual(cpu.sample(), { overallPercent: 50, perCorePercent: [0] }, 'overall kept, the core reads 0%');
    // Measured again from the reset counters.
    add(reset[0]!, jiffies({ user: 10, idle: 90 }));
    writeStat(proc, reset);
    assert.deepEqual(cpu.sample(), { overallPercent: 10, perCorePercent: [10] });
  });

  test('offline core: 0% without a hole; onlined core: 0% until it has a baseline', () => {
    const proc = tree();
    const cores: (Jiffies | undefined)[] = [0, 1, 2, 3].map(() => jiffies({ idle: 1000 }));
    cores[2] = undefined; // cpu2 offline: no line in /proc/stat
    writeStat(proc, cores);
    const cpu = new CpuProvider(proc);
    for (const i of [0, 1, 3]) {
      add(cores[i]!, jiffies({ user: 50, idle: 50 }));
    }
    writeStat(proc, cores);
    const sparse = cpu.sample()!;
    assert.deepEqual(sparse.perCorePercent, [50, 50, 0, 50]);
    assert.ok(2 in sparse.perCorePercent, 'dense array: the offline core is a 0, not a hole');
    // cpu2 comes back with its cumulative counters: no baseline yet, 0% for this sample.
    cores[2] = jiffies({ user: 700, idle: 300 });
    for (const i of [0, 1, 3]) {
      add(cores[i]!, jiffies({ idle: 100 }));
    }
    writeStat(proc, cores);
    assert.deepEqual(cpu.sample()!.perCorePercent, [0, 0, 0, 0]);
    add(cores[2]!, jiffies({ user: 80, idle: 20 }));
    writeStat(proc, cores);
    assert.deepEqual(cpu.sample()!.perCorePercent, [0, 0, 80, 0]);
  });

  test('unreadable file or no aggregate line: null', () => {
    const proc = tree();
    assert.equal(new CpuProvider(proc).sample(), null, 'no /proc/stat');
    fs.writeFileSync(path.join(proc, 'stat'), 'cpu0 1 0 1 10 0 0 0 0 0 0\nintr 1\n');
    assert.equal(new CpuProvider(proc).sample(), null, 'per-core lines only');
  });
});

/** cpu<n>/cpufreq linked to a policy of its own (policy<n>), with `scaling_cur_freq` in kHz. */
function cpufreqCore(sys: string, core: number, khz: string | number): void {
  const policyDir = path.join(sys, 'devices/system/cpu/cpufreq', `policy${core}`);
  write(sys, `devices/system/cpu/cpufreq/policy${core}/scaling_cur_freq`, khz);
  fs.mkdirSync(path.join(sys, 'devices/system/cpu', `cpu${core}`), { recursive: true });
  fs.symlinkSync(policyDir, path.join(sys, 'devices/system/cpu', `cpu${core}`, 'cpufreq'));
}

describe('CpuFreqProvider (cpufreq)', () => {
  test('parked cores and bad values read 0 Hz, left out of average and peak', () => {
    const sys = tree();
    const khz = [2_000_000, 3_000_000, 0, 'garbage', -400_000, '<unknown>'];
    khz.forEach((value, core) => cpufreqCore(sys, core, value));
    cpufreqCore(sys, 6, 1_000_000);
    const freq = new CpuFreqProvider(sys);
    // Removed after discovery, before the first read (core parked: ENOENT).
    fs.rmSync(path.join(sys, 'devices/system/cpu/cpufreq/policy6/scaling_cur_freq'));
    assert.deepEqual(freq.sample(), { avgHz: 2.5e9, maxHz: 3e9, perCoreHz: [2e9, 3e9, 0, 0, 0, 0, 0] });
    // Every core parked: no reading at all.
    write(sys, 'devices/system/cpu/cpufreq/policy0/scaling_cur_freq', 0);
    write(sys, 'devices/system/cpu/cpufreq/policy1/scaling_cur_freq', 0);
    assert.equal(freq.sample(), null);
    freq.dispose();
  });

  test('core without cpufreq between two with it: 0 Hz, no hole', () => {
    const sys = tree();
    cpufreqCore(sys, 0, 1_500_000);
    fs.mkdirSync(path.join(sys, 'devices/system/cpu/cpu1'), { recursive: true }); // offline: no cpufreq link
    cpufreqCore(sys, 2, 2_500_000);
    fs.mkdirSync(path.join(sys, 'devices/system/cpu/cpuidle'), { recursive: true }); // not a core
    const freq = new CpuFreqProvider(sys);
    const sample = freq.sample()!;
    assert.deepEqual(sample.perCoreHz, [1.5e9, 0, 2.5e9]);
    assert.ok(1 in sample.perCoreHz, 'dense array');
    assert.equal(sample.avgHz, 2e9);
    freq.dispose();
  });

  test('rescan once a minute: cpufreq appearing after activation, an onlined core', () => {
    const sys = tree();
    let now = 1_000_000;
    // No cpufreq at activation (VM, driver loaded later): null, rescanned after 60 s.
    const freq = new CpuFreqProvider(sys, () => now);
    assert.equal(freq.sample(), null);
    cpufreqCore(sys, 0, 1_200_000);
    now += 59_999;
    assert.equal(freq.sample(), null, 'no rescan before 60 s');
    now += 1;
    assert.deepEqual(freq.sample()!.perCoreHz, [1.2e9]);
    // A core brought online is read from the next rescan on.
    cpufreqCore(sys, 1, 3_600_000);
    now += 30_000;
    assert.deepEqual(freq.sample()!.perCoreHz, [1.2e9]);
    now += 30_000;
    assert.deepEqual(freq.sample(), { avgHz: 2.4e9, maxHz: 3.6e9, perCoreHz: [1.2e9, 3.6e9] });
    freq.dispose();
  });
});

/** Writes `<root>/meminfo` from `key: kB` pairs, laid out as the kernel does. */
function writeMeminfo(root: string, fields: Record<string, number>): void {
  const lines = Object.entries(fields).map(([key, kb]) => `${`${key}:`.padEnd(16)}${String(kb).padStart(8)} kB`);
  fs.writeFileSync(path.join(root, 'meminfo'), [...lines, 'HugePages_Total:       0', ''].join('\n'));
}

describe('MemoryProvider (/proc/meminfo)', () => {
  const GiB = 1024 * 1024; // in kB

  test('used from MemAvailable, swap in use', () => {
    const proc = tree();
    writeMeminfo(proc, { MemTotal: 16 * GiB, MemFree: 2 * GiB, MemAvailable: 4 * GiB, Buffers: GiB, Cached: 3 * GiB, SwapTotal: 8 * GiB, SwapFree: 6 * GiB });
    const mem = new MemoryProvider(proc).sample()!;
    assert.deepEqual(
      [mem.totalBytes, mem.availableBytes, mem.usedBytes, mem.usedPercent],
      [16 * GiB * 1024, 4 * GiB * 1024, 12 * GiB * 1024, 75],
    );
    assert.deepEqual([mem.swapTotalBytes, mem.swapFreeBytes, mem.swapUsedBytes, mem.swapUsedPercent], [8 * GiB * 1024, 6 * GiB * 1024, 2 * GiB * 1024, 25]);
  });

  test('no MemAvailable: free + buffers + cache, not 100% used', () => {
    const proc = tree();
    writeMeminfo(proc, { MemTotal: 16 * GiB, MemFree: 2 * GiB, Buffers: GiB, Cached: 5 * GiB, SwapTotal: 0, SwapFree: 0 });
    const mem = new MemoryProvider(proc).sample()!;
    assert.deepEqual([mem.availableBytes, mem.usedPercent], [8 * GiB * 1024, 50]);
    // MemAvailable present and 0 (memory exhausted) is taken as it is.
    writeMeminfo(proc, { MemTotal: 16 * GiB, MemFree: 2 * GiB, MemAvailable: 0, Buffers: GiB, Cached: 5 * GiB });
    assert.equal(new MemoryProvider(proc).sample()!.usedPercent, 100);
  });

  test('no swap: 0%, not NaN', () => {
    const proc = tree();
    writeMeminfo(proc, { MemTotal: 8 * GiB, MemAvailable: 6 * GiB, SwapTotal: 0, SwapFree: 0 });
    const mem = new MemoryProvider(proc).sample()!;
    assert.deepEqual([mem.swapTotalBytes, mem.swapUsedBytes, mem.swapUsedPercent], [0, 0, 0]);
  });

  test('unreadable file or no MemTotal: null', () => {
    const proc = tree();
    assert.equal(new MemoryProvider(proc).sample(), null, 'no /proc/meminfo');
    writeMeminfo(proc, { MemFree: GiB, MemAvailable: GiB });
    assert.equal(new MemoryProvider(proc).sample(), null, 'no MemTotal');
  });
});

/** hwmon<n> named `name`, with its files (values in m°C). */
function hwmon(sys: string, n: number, name: string, files: Record<string, string | number> = {}): void {
  write(sys, `class/hwmon/hwmon${n}/name`, name);
  for (const [file, value] of Object.entries(files)) {
    write(sys, `class/hwmon/hwmon${n}/${file}`, value);
  }
}

/** Sensor chosen by a fresh CpuTempProvider: `name: label`, or null. */
function cpuSensor(sys: string): string | null {
  const temp = new CpuTempProvider(sys);
  const sample = temp.sample();
  temp.dispose();
  return sample ? `${sample.sensorName}: ${sample.sensorLabel}` : null;
}

describe('CpuTempProvider: which sensor is the CPU', () => {
  test("the test laptop's hwmon layout: k10temp Tctl, not acpitz listed before it", () => {
    // /sys/class/hwmon on the reference laptop (Ryzen AI, cros_ec, MediaTek Wi-Fi), in kernel order.
    const sys = tree();
    hwmon(sys, 0, 'ACAD');
    hwmon(sys, 1, 'acpitz', { temp1_input: 56000, temp2_input: 45000, temp3_input: 47000, temp4_input: 44000 });
    hwmon(sys, 2, 'BAT1');
    hwmon(sys, 3, 'nvme', { temp1_input: 38850, temp1_label: 'Composite', temp1_max: 81850, temp1_crit: 84850 });
    hwmon(sys, 4, 'amdgpu', { temp1_input: 49000, temp1_label: 'edge' });
    hwmon(sys, 5, 'k10temp', { temp1_input: 52375, temp1_label: 'Tctl' });
    hwmon(sys, 6, 'spd5118', { temp1_input: 41250, temp1_max: 55000, temp1_crit: 85000 });
    hwmon(sys, 7, 'spd5118', { temp1_input: 42000, temp1_max: 55000, temp1_crit: 85000 });
    hwmon(sys, 8, 'cros_ec', { temp1_input: 47000, temp1_label: 'cpu@4c', temp1_crit: 105000 });
    hwmon(sys, 9, 'ucsi_source_psy_USBC000:001');
    hwmon(sys, 13, 'mt7921_phy0', { temp1_input: 43000 });
    const sample = new CpuTempProvider(sys).sample();
    assert.deepEqual(sample, { tempCelsius: 52.375, sensorName: 'k10temp', sensorLabel: 'Tctl', critCelsius: undefined });
  });

  test('AMD (k10temp, zenpower) over coretemp over generic sensors, whatever the order', () => {
    const sys = tree();
    hwmon(sys, 0, 'acpitz', { temp1_input: 40000 });
    hwmon(sys, 1, 'coretemp', { temp1_input: 50000, temp1_label: 'Package id 0' });
    hwmon(sys, 2, 'zenpower', { temp1_input: 60000, temp1_label: 'Tdie' });
    assert.equal(cpuSensor(sys), 'zenpower: Tdie');
    fs.rmSync(path.join(sys, 'class/hwmon/hwmon2'), { recursive: true });
    assert.equal(cpuSensor(sys), 'coretemp: Package id 0');
    // An AMD sensor without temperature inputs is skipped.
    hwmon(sys, 3, 'k10temp');
    assert.equal(cpuSensor(sys), 'coretemp: Package id 0');
  });

  test('generic sensors: acpitz or a name with "cpu"; GPU, NVMe and EC never; then thermal_zone0', () => {
    const sys = tree();
    hwmon(sys, 0, 'amdgpu', { temp1_input: 49000 });
    hwmon(sys, 1, 'nvme', { temp1_input: 38000 });
    hwmon(sys, 2, 'cros_ec', { temp1_input: 47000 });
    write(sys, 'class/thermal/thermal_zone0/temp', 45000);
    assert.equal(cpuSensor(sys), 'acpi: thermal_zone0', 'no CPU hwmon sensor: the thermal zone');
    hwmon(sys, 3, 'cpu_thermal', { temp1_input: 51000 });
    assert.equal(cpuSensor(sys), 'cpu_thermal: temp1_input', 'name with "cpu", no label: the file name');
  });

  test('temp1_input first, else the first input; invalid readings null', () => {
    const sys = tree();
    hwmon(sys, 0, 'k10temp', { temp3_input: 61000, temp3_label: 'Tccd1', temp5_input: 58000, temp5_label: 'Tccd3' });
    assert.equal(cpuSensor(sys), 'k10temp: Tccd1', 'no temp1: the first input in name order');
    hwmon(sys, 0, 'k10temp', { temp1_input: 63000, temp1_label: 'Tctl' });
    assert.equal(cpuSensor(sys), 'k10temp: Tctl');
    const temp = new CpuTempProvider(sys);
    for (const invalid of [0, -5000, 'garbage']) {
      write(sys, 'class/hwmon/hwmon0/temp1_input', invalid);
      assert.equal(temp.sample(), null, `reading ${invalid}`);
    }
    temp.dispose();
  });
});

describe('LinuxTelemetryProvider.sampleTemp', () => {
  const sys = tree();
  hwmon(sys, 0, 'k10temp', { temp1_input: 50000, temp1_label: 'Tctl' });
  hwmon(sys, 1, 'nvme', { temp1_input: 40000 });
  let now = 1_000_000;
  const provider = new LinuxTelemetryProvider({ sysRoot: sys, procRoot: tree(), now: () => now });
  const components = (provider as unknown as { components: ComponentTempProvider }).components;
  /** Waits for the component pass sampleTemp started, if any (the provider keeps no handle on it). */
  const pass = async (): Promise<void> => {
    if (components.busy) {
      await components.refresh();
    }
  };
  const nvme = (temp: ReturnType<LinuxTelemetryProvider['sampleTemp']>): number | null | undefined =>
    temp?.sensors?.find((s) => s.label === 'NVMe SSD')?.celsius;
  after(() => provider.dispose());

  test('CPU reading cached for maxAgeMs; components refreshed by the read that finds them older', async () => {
    const first = provider.sampleTemp(1000)!;
    assert.deepEqual([first.tempCelsius, first.sensors], [50, undefined], 'components not read yet');
    assert.ok(components.busy, 'the first read starts a component pass');
    await pass();
    const cached = provider.sampleTemp(1000)!;
    assert.deepEqual([cached.sampleSeq, cached.ageMs, nvme(cached)], [first.sampleSeq, undefined, 40]);
    assert.equal(components.busy, false, 'components fresh: no pass');
    now += 400;
    write(sys, 'class/hwmon/hwmon0/temp1_input', 55000);
    write(sys, 'class/hwmon/hwmon1/temp1_input', 42000);
    const young = provider.sampleTemp(1000)!;
    assert.deepEqual([young.tempCelsius, young.sampleSeq, young.ageMs, nvme(young)], [50, first.sampleSeq, 400, 40]);
    assert.equal(components.busy, false);
    // Older than maxAgeMs: the CPU is read again and a component pass starts; until it completes the
    // previous component readings are shown.
    now += 1100;
    const reread = provider.sampleTemp(1000)!;
    assert.deepEqual([reread.tempCelsius, reread.sampleSeq, reread.ageMs, nvme(reread)], [55, first.sampleSeq! + 1, undefined, 40]);
    assert.ok(components.busy);
    await pass();
    assert.equal(nvme(provider.sampleTemp(1000)), 42);
  });

  test('component readings older than 3 intervals (at least 5 s) not shown', async () => {
    // maxAgeMs 1000 (half a 2 s interval): stale after 3 × 2 s. The pass started by the read is still
    // running (a slow device), so the readings shown are those of the previous pass.
    now += 6000;
    assert.equal(nvme(provider.sampleTemp(1000)), 42, '6 s old: shown');
    await pass();
    now += 6001;
    const stale = provider.sampleTemp(1000)!;
    assert.deepEqual([stale.tempCelsius, stale.sensors], [55, undefined], '6.001 s old: CPU only');
    const pending = components.refresh();
    assert.equal(provider.sampleTemp(1000)?.sensors, undefined);
    assert.equal(components.refresh(), pending, 'one pass in flight');
    await pass();
    assert.equal(nvme(provider.sampleTemp(1000)), 42);
    // Short intervals: never stale before 5 s.
    now += 5000;
    assert.equal(nvme(provider.sampleTemp(500)), 42, '5 s old with maxAgeMs 500: shown');
    now += 1;
    assert.equal(provider.sampleTemp(500)?.sensors, undefined, '5.001 s old: not shown');
    await pass();
  });

  test("componentSensors 'off': CPU only, no pass", async () => {
    provider.setComponentSensors('off');
    now += 2000;
    const cpuOnly = provider.sampleTemp(1000)!;
    assert.deepEqual([cpuOnly.tempCelsius, cpuOnly.sensors, components.busy], [55, undefined, false]);
    provider.setComponentSensors('awake');
    provider.requestTempRefresh();
    await pass();
    assert.equal(nvme(provider.sampleTemp(1000)), 42);
  });

  test('no CPU sensor: null', () => {
    const noCpu = tree();
    hwmon(noCpu, 0, 'nvme', { temp1_input: 40000 });
    const p = new LinuxTelemetryProvider({ sysRoot: noCpu, procRoot: tree(), now: () => now });
    assert.equal(p.sampleTemp(1000), null);
    p.dispose();
  });
});
