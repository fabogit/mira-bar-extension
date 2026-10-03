import { LinuxTelemetryProvider } from '../src/platform/linux/linux_provider.js';
import { DiskProvider } from '../src/disk/disk_provider.js';

async function run(): Promise<void> {
  console.log('=== MIRABAR - LINUX TELEMETRY SMOKE TEST ===\n');

  if (process.platform !== 'linux') {
    console.log(`[INFO] Current platform is ${process.platform}, not linux.`);
    console.log('[INFO] Validating module imports and contract compatibility...\n');
  }

  const provider = new LinuxTelemetryProvider();
  console.log('Platform Name:', provider.platformName);
  console.log('Battery Hardware Detected:', provider.isBatteryAvailable());

  console.log('\n--- 1. CPU Usage Sampling (/proc/stat) ---');
  const cpu1 = provider.sampleCpu();
  console.log('Sample 1 (Tick 0):', cpu1);

  await new Promise((r) => setTimeout(r, 500));

  const cpu2 = provider.sampleCpu();
  console.log('Sample 2 (Delta):', {
    overallPercent: cpu2 ? `${cpu2.overallPercent.toFixed(2)}%` : 'null',
    coresSampled: cpu2?.perCorePercent.length ?? 0,
  });
  if (cpu2 && cpu2.perCorePercent.length > 0) {
    console.log('First 4 Cores:', cpu2.perCorePercent.slice(0, 4).map((p, i) => `C${i}: ${p.toFixed(1)}%`).join(' '));
  }

  console.log('\n--- 2. CPU Frequency (/sys/devices/system/cpu) ---');
  const freq = provider.sampleFreqOrLoad();
  if (freq && freq.kind === 'freq') {
    console.log({
      avgGHz: (freq.data.avgHz / 1e9).toFixed(3),
      maxGHz: (freq.data.maxHz / 1e9).toFixed(3),
      coresCount: freq.data.perCoreHz.length,
    });
  } else {
    console.log('CPU Frequency: Not exposed by kernel or running virtualized.');
  }

  console.log('\n--- 3. Memory Stats (/proc/meminfo) ---');
  const mem = provider.sampleMemory();
  if (mem) {
    console.log({
      totalGB: (mem.totalBytes / 1e9).toFixed(2),
      usedGB: (mem.usedBytes / 1e9).toFixed(2),
      availableGB: (mem.availableBytes / 1e9).toFixed(2),
      usedPercent: `${mem.usedPercent.toFixed(1)}%`,
      swapTotalMB: (mem.swapTotalBytes / 1e6).toFixed(2),
      swapUsedMB: (mem.swapUsedBytes / 1e6).toFixed(2),
    });
  } else {
    console.log('Memory: /proc/meminfo unreadable (expected on non-Linux OS).');
  }

  console.log('\n--- 4. Hardware Thermal Sensors (/sys/class/hwmon) ---');
  // Component sensors (SSD, RAM, Wi-Fi, battery) are read asynchronously: request a pass, then read.
  provider.requestTempRefresh();
  await new Promise((r) => setTimeout(r, 200));
  const temp = provider.sampleTemp();
  if (temp) {
    console.log({
      tempCelsius: `${temp.tempCelsius.toFixed(1)} °C`,
      sensorName: temp.sensorName,
      sensorLabel: temp.sensorLabel,
      critCelsius: temp.critCelsius !== undefined ? `${temp.critCelsius} °C` : 'not exposed (100 °C shown)',
    });
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
  } else {
    console.log('Temperature: No supported hwmon sensors found (expected on non-Linux OS).');
  }

  console.log('\n--- 5. Battery Power Supply (/sys/class/power_supply) ---');
  const batt = provider.sampleBattery();
  if (batt) {
    console.log({
      percent: `${batt.percent}%`,
      status: batt.status,
      isCharging: batt.isCharging,
      capacity: `${batt.currentCapacity ?? 'N/A'} / ${batt.maxCapacity ?? 'N/A'} ${batt.capacityUnit ?? ''}`,
      designCapacity: `${batt.designCapacity ?? 'N/A'} ${batt.capacityUnit ?? ''}`,
      healthPercent: batt.healthPercent ? `${batt.healthPercent.toFixed(1)}%` : 'N/A',
      cycleCount: batt.cycleCount ?? 'N/A',
    });
  } else {
    console.log('Battery: Desktop workstation / server without battery device (zero overhead).');
  }

  console.log('\n--- 6. Storage Filesystem (statfs) ---');
  const diskProvider = new DiskProvider();
  const disks = await diskProvider.sample([]);
  console.log(`Reachable Filesystems: ${disks.length}`);
  for (const d of disks) {
    console.log(`  - ${d.mountPath}: ${(d.usedBytes / 1e9).toFixed(2)} GB / ${(d.totalBytes / 1e9).toFixed(2)} GB (${d.usedPercent.toFixed(1)}%)`);
  }

  console.log('\nSUCCESS: Linux smoke test script executed successfully!');
}

run().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
