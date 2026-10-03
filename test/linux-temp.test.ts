// Linux temperature sensors against a mocked sysfs tree: CPU limits (#4), NVMe (#33), RAM (#34),
// Wi-Fi (#35), battery (#36), labels, invalid values, rescan, and the tooltip rows (ADR-0016).
//
// Usage (any OS):  pnpm run test:linux-temp (bundled with the vscode mock: sections.ts imports config.ts)
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ComponentTempProvider } from '../src/platform/linux/components.js';
import { CpuTempProvider } from '../src/platform/linux/cputemp.js';
import { renderTemp } from '../src/sections.js';
import type { MiraBarConfig } from '../src/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
const step = (name: string): void => console.log(`ok - ${name}`);

/** Writes files under root (values as in sysfs, newline-terminated). */
function write(dir: string, files: Record<string, string | number>): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, dir, name), `${value}\n`);
  }
}

/** hwmon<n> with a `device` link to a fake device directory. */
function hwmon(n: number, name: string, devicePath: string, files: Record<string, string | number>): void {
  const dir = `class/hwmon/hwmon${n}`;
  write(dir, { name, ...files });
  fs.mkdirSync(path.join(root, devicePath), { recursive: true });
  fs.symlinkSync(path.join(root, devicePath), path.join(root, dir, 'device'));
}

async function run(): Promise<void> {
  // CPU: Intel coretemp with crit; ACPI zone fallback with a critical trip point.
  hwmon(0, 'coretemp', 'devices/platform/coretemp.0', { temp1_input: 52000, temp1_label: 'Package id 0', temp1_crit: 105000, temp1_max: 85000 });
  // Two NVMe drives, two DDR5 modules (one above max), a Wi-Fi chip without limits, a GPU (ignored).
  hwmon(1, 'nvme', 'devices/pci0000:00/0000:02:00.0/nvme/nvme1', { temp1_input: 41850, temp1_label: 'Composite', temp1_max: 74850, temp1_crit: 79850 });
  hwmon(2, 'nvme', 'devices/pci0000:00/0000:01:00.0/nvme/nvme0', { temp1_input: 27850, temp1_max: 74850, temp1_crit: 79850 });
  hwmon(3, 'spd5118', 'devices/i2c-21/21-0051', { temp1_input: 42250, temp1_max: 55000, temp1_crit: 85000 });
  hwmon(4, 'spd5118', 'devices/i2c-21/21-0050', { temp1_input: 56500, temp1_max: 55000, temp1_crit: 85000 });
  hwmon(5, 'mt7921_phy0', 'devices/pci0000:00/0000:03:00.0/ieee80211/phy0', { temp1_input: 44000 });
  hwmon(6, 'amdgpu', 'devices/pci0000:00/0000:c1:00.0', { temp1_input: 45000 });
  // Battery with temp in tenths of °C; mains supply ignored.
  write('class/power_supply/BAT1', { type: 'Battery', temp: 312 });
  write('class/power_supply/ACAD', { type: 'Mains' });

  const cpu = new CpuTempProvider(root).sample();
  assert.equal(cpu?.sensorName, 'coretemp');
  assert.equal(cpu?.tempCelsius, 52);
  assert.equal(cpu?.critCelsius, 105, 'temp1_crit preferred over temp1_max');
  step('CPU limit from temp1_crit (#4)');

  let now = 1_000_000;
  const components = new ComponentTempProvider(root, () => now);
  assert.equal(components.latest(), null);
  await components.refresh();
  const first = components.latest()!;
  assert.deepEqual(
    first.sensors.map((s) => [s.label, s.celsius, s.maxCelsius, s.critCelsius]),
    [
      ['NVMe nvme0', 27.85, 74.85, 79.85],
      ['NVMe nvme1', 41.85, 74.85, 79.85],
      ['RAM DIMM 0', 56.5, 55, 85],
      ['RAM DIMM 1', 42.25, 55, 85],
      ['Wi-Fi', 44, undefined, undefined],
      ['Battery Cell', 31.2, undefined, undefined],
    ],
  );
  step('NVMe, RAM, Wi-Fi and battery found, labelled and ordered (#33-#36)');

  // One pass at a time.
  const a = components.refresh();
  const b = components.refresh();
  assert.equal(a, b, 'a running pass is reused');
  await a;
  step('at most one pass in flight');

  // Invalid and missing values: the row disappears, the others stay; limits are read at scan time.
  write('class/hwmon/hwmon5', { temp1_input: 'garbage' });
  write('class/hwmon/hwmon1', { temp1_input: 999000 });
  await components.refresh();
  assert.deepEqual(components.latest()!.sensors.map((s) => s.label), ['NVMe nvme0', 'RAM DIMM 0', 'RAM DIMM 1', 'Battery Cell']);
  step('invalid readings skipped');

  // Rescan after 60 s picks up a new sensor and drops removed ones.
  write('class/hwmon/hwmon5', { temp1_input: 44000 });
  write('class/hwmon/hwmon1', { temp1_input: 41850 });
  fs.rmSync(path.join(root, 'class/power_supply/BAT1'), { recursive: true });
  hwmon(7, 'nvme', 'devices/pci0000:00/0000:04:00.0/nvme/nvme2', { temp1_input: 30000 });
  await components.refresh();
  assert.equal(components.latest()!.sensors.length, 5, 'no rescan before 60 s: new drive not read, removed battery skipped');
  now += 60_000;
  await components.refresh();
  assert.deepEqual(
    components.latest()!.sensors.map((s) => s.label),
    ['NVMe nvme0', 'NVMe nvme1', 'NVMe nvme2', 'RAM DIMM 0', 'RAM DIMM 1', 'Wi-Fi'],
  );
  step('rescan every 60 s');

  // Tooltip: CPU limit, a dash for sensors without limits, the note for readings above max.
  const config = {} as MiraBarConfig;
  const tooltip = renderTemp({ ...cpu!, sensors: components.latest()!.sensors }, { config, updatedAt: '12:00:00' }, true).tooltip!;
  const line = (label: string): string => tooltip.split('\n').find((l) => l.startsWith(label + ' '))!;
  assert.match(line('CPU Package'), /52\.0 °C │ 105 °C$/);
  assert.match(line('NVMe nvme0'), /27\.9 °C │\s+80 °C$/);
  assert.match(line('Wi-Fi'), /44\.0 °C │\s+—$/);
  assert.match(tooltip, /\*Above the operating maximum: RAM DIMM 0 \(max 55 °C\)\.\*/);
  step('tooltip rows, limits and above-max note');

  // Fallbacks: thermal zone with a critical trip point; no limit at all → 100 °C.
  const zoneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
  fs.mkdirSync(path.join(zoneRoot, 'class/thermal/thermal_zone0'), { recursive: true });
  for (const [f, v] of Object.entries({ temp: 48000, trip_point_0_type: 'passive', trip_point_0_temp: 90000, trip_point_1_type: 'critical', trip_point_1_temp: 110000 })) {
    fs.writeFileSync(path.join(zoneRoot, 'class/thermal/thermal_zone0', f), `${v}\n`);
  }
  assert.equal(new CpuTempProvider(zoneRoot).sample()?.critCelsius, 110);
  fs.rmSync(path.join(zoneRoot, 'class/thermal/thermal_zone0/trip_point_1_type'));
  const noLimit = new CpuTempProvider(zoneRoot).sample()!;
  assert.equal(noLimit.critCelsius, undefined);
  assert.match(renderTemp(noLimit, { config, updatedAt: '12:00:00' }, true).tooltip!, /48\.0 °C │ 100 °C/);
  fs.rmSync(zoneRoot, { recursive: true, force: true });
  step('thermal zone critical trip point, 100 °C fallback');

  console.log('\nAll Linux temperature tests passed.');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
