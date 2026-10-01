import { createPlatformProvider } from '../src/platform/factory.js';
import { DiskProvider } from '../src/disk/disk_provider.js';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const provider = createPlatformProvider();
  console.log(`=== MIRABAR - INTEGRATION TEST (${provider.platformName.toUpperCase()}) ===\n`);

  console.log('Platform:', provider.platformName);
  console.log('Topology:', provider.getTopologyDescription ? provider.getTopologyDescription() : 'Standard SMP');
  console.log('Battery Available:', provider.isBatteryAvailable());

  console.log('\nTick 0 Instantaneous Sampling (Cold Start)...');
  const tick0Cpu = provider.sampleCpu();
  console.log('Tick 0 Cores count:', tick0Cpu?.perCorePercent.length, 'CoreTypes:', tick0Cpu?.coreTypes ? tick0Cpu.coreTypes.join('') : 'Uniform SMP');
  if (!tick0Cpu || tick0Cpu.perCorePercent.length === 0) {
    console.error('TEST FAILED: Tick 0 CPU returned empty cores!');
    process.exit(1);
  }
  if (provider.platformName === 'darwin' && !tick0Cpu.coreTypes) {
    console.error('TEST FAILED: Darwin Tick 0 CPU missing coreTypes!');
    process.exit(1);
  }

  await sleep(1000);

  console.log('Tick 2 Sampling...');
  const cpu = provider.sampleCpu();
  const freqOrLoad = provider.sampleFreqOrLoad();
  const temp = provider.sampleTemp();
  const mem = provider.sampleMemory();
  const bat = provider.sampleBattery();

  const diskProvider = new DiskProvider();
  const disks = await diskProvider.sample([]);

  console.log('\n--- VERIFICATION RESULTS ---');
  console.log('CPU Usage:', cpu ? `${cpu.overallPercent.toFixed(2)}% across ${cpu.perCorePercent.length} cores` : 'FAILED');
  if (cpu?.coreTypes) {
    const pCount = cpu.coreTypes.filter((t) => t === 'P').length;
    const eCount = cpu.coreTypes.filter((t) => t === 'E').length;
    console.log(`Core Distribution: ${pCount} Performance Cores, ${eCount} Efficiency Cores`);
    console.log('Per Core Loads:', cpu.perCorePercent.map((p, i) => `C${i}(${cpu.coreTypes![i]}): ${p.toFixed(1)}%`).join(' '));
  } else if (cpu) {
    console.log('Per Core Loads:', cpu.perCorePercent.map((p, i) => `C${i}: ${p.toFixed(1)}%`).join(' '));
  }

  if (freqOrLoad?.kind === 'load') {
    console.log(`System Load Average: 1m: ${freqOrLoad.data.load1.toFixed(2)}, 5m: ${freqOrLoad.data.load5.toFixed(2)}, 15m: ${freqOrLoad.data.load15.toFixed(2)}`);
  } else if (freqOrLoad?.kind === 'freq') {
    console.log(`CPU Frequency: Avg: ${(freqOrLoad.data.avgHz / 1e9).toFixed(2)} GHz, Peak: ${(freqOrLoad.data.maxHz / 1e9).toFixed(2)} GHz across ${freqOrLoad.data.perCoreHz.length} cores`);
  } else {
    console.log('Frequency/Load:', freqOrLoad);
  }

  console.log('Temperature:', temp ? `${temp.tempCelsius.toFixed(2)} °C [${temp.sensorName}: ${temp.sensorLabel}]` : 'N/A or Not Accessible');
  console.log('Memory:', mem ? `Used: ${(mem.usedBytes / 1024**3).toFixed(2)} GB / ${(mem.totalBytes / 1024**3).toFixed(2)} GB (${mem.usedPercent.toFixed(1)}%) | Compressed: ${((mem.compressedBytes || 0) / 1024**3).toFixed(2)} GB` : 'FAILED');
  if (bat) {
    console.log(`Battery: ${bat.percent}% (${bat.status}) | Health: ${bat.healthPercent?.toFixed(1)}% | Current: ${bat.currentCapacity}/${bat.maxCapacity} ${bat.capacityUnit} | Design: ${bat.designCapacity} ${bat.capacityUnit} | Cycles: ${bat.cycleCount}`);
  } else {
    console.log('Battery: Desktop or Not Accessible');
  }

  console.log(`Storage: Monitored ${disks.length} volumes:`);
  for (const disk of disks) {
    console.log(`  - ${disk.mountPath}: ${(disk.usedBytes / 1e9).toFixed(2)} GB used / ${(disk.totalBytes / 1e9).toFixed(2)} GB total (${disk.usedPercent.toFixed(1)}%)`);
  }

  // Freq/Load is required on Darwin (system load) but optional on virtualized Linux (no cpufreq in cloud VMs)
  const isFreqRequired = provider.platformName === 'darwin';
  if (!cpu || (isFreqRequired && !freqOrLoad) || !mem || disks.length === 0) {
    console.error('\nTEST FAILED: Critical telemetry providers failed!');
    process.exit(1);
  }

  console.log('\nALL INTEGRATION CHECKS PASSED SUCCESSFULLY!');
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
