// Linux providers on this machine: every section read once (CPU twice, for a delta), logged, and checked
// against ranges any Linux machine falls in. Sensors, batteries and cpufreq may be missing (CI VMs):
// those sections log it and pass.
//
// Usage (Linux):  pnpm run test:host
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { LinuxTelemetryProvider } from '../../src/platform/linux/linux_provider.js';
import { DiskProvider } from '../../src/disk/disk_provider.js';
import type { CpuUsageInfo } from '../../src/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A percentage: finite, within 0-100. */
const assertPercent = (value: number, label: string): void =>
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${label} out of range: ${value}`);

describe('Linux telemetry on this machine', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  let provider: LinuxTelemetryProvider;
  before(() => {
    provider = new LinuxTelemetryProvider();
    console.log('Battery detected:', provider.isBatteryAvailable());
  });

  test('CPU usage (/proc/stat): primed at construction, valid after a delta', async () => {
    /** Valid percentages, one per core: no NaN, no holes, within 0-100. */
    const checkCpu = (cpu: CpuUsageInfo | null, label: string): CpuUsageInfo => {
      assert.ok(cpu, `${label}: /proc/stat readable`);
      assert.ok(cpu.perCorePercent.length > 0, `${label}: per-core array not empty (counters primed in the constructor)`);
      for (const p of [cpu.overallPercent, ...cpu.perCorePercent]) {
        assert.ok(Number.isFinite(p) && p >= 0 && p <= 100, `${label}: percentage out of range: ${p}`);
      }
      return cpu;
    };
    const cpu1 = checkCpu(provider.sampleCpu(), 'Tick 0');
    await sleep(500);
    const cpu2 = checkCpu(provider.sampleCpu(), 'Sample 2');
    assert.equal(cpu2.perCorePercent.length, cpu1.perCorePercent.length, 'same core count at Tick 0 and after');
    console.log(`CPU: ${cpu2.overallPercent.toFixed(2)}% over ${cpu2.perCorePercent.length} cores;`,
      cpu2.perCorePercent.slice(0, 4).map((p, i) => `C${i}: ${p.toFixed(1)}%`).join(' '));
  });

  test('CPU frequency (/sys/devices/system/cpu)', () => {
    const freq = provider.sampleFreqOrLoad();
    if (freq && freq.kind === 'freq') {
      console.log(`Frequency: avg ${(freq.data.avgHz / 1e9).toFixed(3)} GHz, max ${(freq.data.maxHz / 1e9).toFixed(3)} GHz, ${freq.data.perCoreHz.length} cores`);
      // Every core 0 (parked) or within 10 MHz-10 GHz (not kHz read as Hz), no holes; the average among the cores read.
      const { avgHz, maxHz, perCoreHz } = freq.data;
      assert.ok(perCoreHz.length > 0 && perCoreHz.length === Object.keys(perCoreHz).length, 'one entry per core, no holes');
      for (const hz of perCoreHz) {
        assert.ok(hz === 0 || (hz >= 1e7 && hz <= 1e10), `core frequency implausible: ${hz} Hz`);
      }
      assert.equal(maxHz, Math.max(...perCoreHz));
      const read = perCoreHz.filter((hz) => hz > 0);
      assert.ok(avgHz >= Math.min(...read) && avgHz <= maxHz, `average ${avgHz} Hz outside the cores read`);
    } else {
      assert.equal(freq, null, 'Linux reports frequency, not load');
      console.log('Frequency: not exposed by the kernel (virtualized?)');
    }
  });

  test('memory (/proc/meminfo)', () => {
    const mem = provider.sampleMemory();
    assert.ok(mem, '/proc/meminfo readable');
    // At least 128 MB; used + available = total, as computed from MemAvailable; swap within its total.
    assert.ok(mem.totalBytes >= 128 * 1024 ** 2, `total memory implausible: ${mem.totalBytes}`);
    assert.ok(mem.availableBytes >= 0 && mem.availableBytes <= mem.totalBytes, `available memory: ${mem.availableBytes}`);
    assert.equal(mem.usedBytes + mem.availableBytes, mem.totalBytes);
    assertPercent(mem.usedPercent, 'used memory');
    assert.ok(mem.swapUsedBytes >= 0 && mem.swapUsedBytes <= mem.swapTotalBytes, `swap used: ${mem.swapUsedBytes} of ${mem.swapTotalBytes}`);
    assertPercent(mem.swapUsedPercent, 'used swap');
    if (mem.swapTotalBytes === 0) {
      assert.equal(mem.swapUsedPercent, 0, 'no swap: 0%');
    }
    console.log(`Memory: ${(mem.usedBytes / 1e9).toFixed(2)} of ${(mem.totalBytes / 1e9).toFixed(2)} GB (${mem.usedPercent.toFixed(1)}%),`,
      `available ${(mem.availableBytes / 1e9).toFixed(2)} GB, swap ${(mem.swapUsedBytes / 1e6).toFixed(2)} of ${(mem.swapTotalBytes / 1e6).toFixed(2)} MB`);
  });

  test('temperatures (/sys/class/hwmon, components read asynchronously)', async () => {
    // Component sensors (SSD, RAM, Wi-Fi, battery) are read asynchronously: request a pass, then read.
    provider.requestTempRefresh();
    await sleep(200);
    const temp = provider.sampleTemp(0);
    if (!temp) {
      console.log('Temperature: no supported hwmon sensor');
      return;
    }
    const crit = temp.critCelsius !== undefined ? `${temp.critCelsius} °C` : 'not exposed (100 °C shown)';
    console.log(`Temperature: ${temp.tempCelsius.toFixed(1)} °C [${temp.sensorName}: ${temp.sensorLabel}], limit ${crit}`);
    // A running CPU: above 0 °C (the provider drops 0 and below) and at most 150 °C; limits up to 200 °C.
    assert.ok(temp.tempCelsius > 0 && temp.tempCelsius <= 150, `CPU temperature implausible: ${temp.tempCelsius}`);
    assert.ok(temp.sensorName && temp.sensorLabel, 'sensor name and label');
    assert.ok(temp.critCelsius === undefined || (temp.critCelsius > 0 && temp.critCelsius <= 200), `CPU limit: ${temp.critCelsius}`);
    assert.ok(Number.isInteger(temp.sampleSeq) && temp.sampleSeq! >= 1, `sampleSeq: ${temp.sampleSeq}`);
    for (const s of temp.sensors ?? []) {
      const limits = [s.maxCelsius !== undefined ? `max ${s.maxCelsius} °C` : '', s.critCelsius !== undefined ? `crit ${s.critCelsius} °C` : '']
        .filter(Boolean)
        .join(', ');
      const value = s.celsius !== null ? `${s.celsius.toFixed(1)} °C` : 'asleep (runtime-suspended, not read)';
      console.log(`  - ${s.label}: ${value}${limits ? ` (${limits})` : ''}`);
      assert.ok(s.celsius === null || (s.celsius > -40 && s.celsius <= 150), `${s.label}: ${s.celsius}`);
      for (const limit of [s.maxCelsius, s.critCelsius]) {
        assert.ok(limit === undefined || (limit > 0 && limit <= 200), `${s.label} limit: ${limit}`);
      }
    }
    if (!temp.sensors?.length) {
      console.log('  No component sensors (NVMe, RAM, Wi-Fi, battery) exposed.');
    }
  });

  test('battery (/sys/class/power_supply)', () => {
    const batt = provider.sampleBattery();
    if (!batt) {
      console.log('Battery: none');
      return;
    }
    console.log(`Battery: ${batt.percent}% ${batt.status}, ${batt.currentCapacity ?? 'N/A'} / ${batt.maxCapacity ?? 'N/A'} ${batt.capacityUnit ?? ''}`,
      `(design ${batt.designCapacity ?? 'N/A'}), health ${batt.healthPercent?.toFixed(1) ?? 'N/A'}%, cycles ${batt.cycleCount ?? 'N/A'},`,
      `time ${batt.timeRemainingMinutes ?? 'none'}`);
    // No time (idle states), -1 (discharging, no estimate yet) or a plausible estimate (at most 48 h).
    assertPercent(batt.percent, 'battery charge');
    assert.ok(batt.healthPercent === undefined || (batt.healthPercent > 0 && batt.healthPercent <= 150), `battery health: ${batt.healthPercent}`);
    const t = batt.timeRemainingMinutes;
    assert.ok(t === undefined || t === -1 || (Number.isInteger(t) && t > 0 && t <= 48 * 60), `battery time implausible: ${t}`);
    if (batt.status === 'Charging' || batt.status === 'Discharging') {
      assert.ok(t !== undefined || batt.isCharging, 'discharging always carries a time or -1');
    } else {
      assert.equal(t, undefined, `no time while ${batt.status}`);
    }
  });

  test('disks (statfs)', async () => {
    const disks = await new DiskProvider().sample([]);
    assert.deepEqual(disks.map((d) => d.mountPath), ['/'], 'nothing configured, no default path: /');
    for (const d of disks) {
      console.log(`Disk ${d.mountPath}: ${(d.usedBytes / 1e9).toFixed(2)} of ${(d.totalBytes / 1e9).toFixed(2)} GB (${d.usedPercent.toFixed(1)}%)`);
      // A real filesystem: blocks, free within total, used + free = total, percentages adding up to 100.
      assert.ok(d.totalBytes > 0, `${d.mountPath}: no blocks`);
      assert.ok(d.freeBytes >= 0 && d.freeBytes <= d.totalBytes, `${d.mountPath}: free ${d.freeBytes} of ${d.totalBytes}`);
      assert.equal(d.usedBytes + d.freeBytes, d.totalBytes);
      assertPercent(d.usedPercent, `${d.mountPath} used`);
      assert.ok(Math.abs(d.usedPercent + d.freePercent - 100) < 1e-9, `${d.mountPath}: used + free = 100%`);
    }
  });
});
