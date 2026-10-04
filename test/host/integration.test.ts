// The platform provider this machine gets (createPlatformProvider) and the disk provider, as the extension
// uses them: CPU from the first read, a second round of every section a second later, values logged.
//
// Usage (Linux, or macOS after `pnpm run compile:native`):  pnpm run test:host
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlatformProvider } from '../../src/platform/factory.js';
import { DiskProvider } from '../../src/disk/disk_provider.js';

const GB = 1024 ** 3;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('platform and disk providers on this machine', async () => {
  const provider = createPlatformProvider(console);
  console.log(`Platform: ${provider.platformName}, topology: ${provider.getTopologyDescription?.() ?? 'Standard SMP'}, battery: ${provider.isBatteryAvailable()}`);

  // Tick 0 (cold start): every core present from the first read, with its type on macOS.
  const tick0 = provider.sampleCpu();
  assert.ok(tick0 && tick0.perCorePercent.length > 0, 'Tick 0 CPU has every core');
  if (provider.platformName === 'darwin') {
    assert.ok(tick0.coreTypes, 'darwin Tick 0 CPU carries coreTypes');
  }

  await sleep(1000);

  const cpu = provider.sampleCpu();
  const freqOrLoad = provider.sampleFreqOrLoad();
  const temp = provider.sampleTemp(5000); // first call: a fresh reading (macOS waits for the first pass)
  const mem = provider.sampleMemory();
  const bat = provider.sampleBattery();
  const disks = await new DiskProvider().sample([]);

  assert.ok(cpu, 'CPU usage');
  // System load is always there on macOS; cpufreq may be missing on Linux VMs (no cpufreq in cloud VMs).
  if (provider.platformName === 'darwin') {
    assert.ok(freqOrLoad, 'darwin system load');
  }
  assert.ok(mem, 'memory');
  assert.ok(disks.length > 0, 'at least one volume');

  const cores = cpu.perCorePercent.map((p, i) => `C${i}${cpu.coreTypes ? `(${cpu.coreTypes[i]})` : ''}: ${p.toFixed(1)}%`).join(' ');
  console.log(`CPU: ${cpu.overallPercent.toFixed(2)}% over ${cpu.perCorePercent.length} cores; ${cores}`);
  if (freqOrLoad?.kind === 'load') {
    console.log(`Load average: ${freqOrLoad.data.load1.toFixed(2)} / ${freqOrLoad.data.load5.toFixed(2)} / ${freqOrLoad.data.load15.toFixed(2)}`);
  } else if (freqOrLoad?.kind === 'freq') {
    console.log(`Frequency: avg ${(freqOrLoad.data.avgHz / 1e9).toFixed(2)} GHz, peak ${(freqOrLoad.data.maxHz / 1e9).toFixed(2)} GHz over ${freqOrLoad.data.perCoreHz.length} cores`);
  } else {
    console.log('Frequency/load: not available');
  }
  const sensor = temp?.sensorName ? ` [${temp.sensorName}: ${temp.sensorLabel}]` : '';
  console.log('Temperature:', temp ? `${temp.tempCelsius.toFixed(2)} °C${sensor}` : 'not available');
  console.log(`Memory: ${(mem.usedBytes / GB).toFixed(2)} of ${(mem.totalBytes / GB).toFixed(2)} GB (${mem.usedPercent.toFixed(1)}%), compressed ${((mem.compressedBytes ?? 0) / GB).toFixed(2)} GB`);
  if (bat) {
    console.log(`Battery: ${bat.percent}% (${bat.status}), health ${bat.healthPercent?.toFixed(1)}%, ${bat.currentCapacity}/${bat.maxCapacity} ${bat.capacityUnit}, design ${bat.designCapacity}, cycles ${bat.cycleCount}`);
  } else {
    console.log('Battery: none');
  }
  for (const disk of disks) {
    console.log(`Disk ${disk.mountPath}: ${(disk.usedBytes / 1e9).toFixed(2)} of ${(disk.totalBytes / 1e9).toFixed(2)} GB (${disk.usedPercent.toFixed(1)}%)`);
  }
  provider.dispose?.();
});
