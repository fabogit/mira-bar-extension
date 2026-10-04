// Linux providers on this machine: every section read once (CPU twice, for a delta) and logged; CPU and
// battery values checked. Sensors, batteries and cpufreq may be missing (CI VMs): those sections log it.
//
// Usage (Linux):  pnpm run test:host
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { LinuxTelemetryProvider } from '../../src/platform/linux/linux_provider.js';
import { DiskProvider } from '../../src/disk/disk_provider.js';
import type { CpuUsageInfo } from '../../src/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    } else {
      console.log('Frequency: not exposed by the kernel (virtualized?)');
    }
  });

  test('memory (/proc/meminfo)', () => {
    const mem = provider.sampleMemory();
    assert.ok(mem, '/proc/meminfo readable');
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
    for (const s of temp.sensors ?? []) {
      const limits = [s.maxCelsius !== undefined ? `max ${s.maxCelsius} °C` : '', s.critCelsius !== undefined ? `crit ${s.critCelsius} °C` : '']
        .filter(Boolean)
        .join(', ');
      const value = s.celsius !== null ? `${s.celsius.toFixed(1)} °C` : 'asleep (runtime-suspended, not read)';
      console.log(`  - ${s.label}: ${value}${limits ? ` (${limits})` : ''}`);
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
    assert.ok(disks.length > 0, 'at least / reachable');
    for (const d of disks) {
      console.log(`Disk ${d.mountPath}: ${(d.usedBytes / 1e9).toFixed(2)} of ${(d.totalBytes / 1e9).toFixed(2)} GB (${d.usedPercent.toFixed(1)}%)`);
    }
  });
});
