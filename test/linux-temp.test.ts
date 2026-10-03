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

/** Writes files under base (values as in sysfs, newline-terminated). */
function write(dir: string, files: Record<string, string | number>, base = root): void {
  fs.mkdirSync(path.join(base, dir), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(base, dir, name), `${value}\n`);
  }
}

/** hwmon<n> with a `device` link to a fake device directory. */
function hwmon(n: number, name: string, devicePath: string, files: Record<string, string | number>, base = root): void {
  const dir = `class/hwmon/hwmon${n}`;
  write(dir, { name, ...files }, base);
  fs.mkdirSync(path.join(base, devicePath), { recursive: true });
  fs.symlinkSync(path.join(base, devicePath), path.join(base, dir, 'device'));
}

/** Records the files and directories the component provider opens through fs.promises. */
const opened: string[] = [];
for (const method of ['readFile', 'readdir'] as const) {
  const real = fs.promises[method] as (...args: unknown[]) => Promise<unknown>;
  Object.assign(fs.promises, {
    [method]: (target: unknown, ...rest: unknown[]) => {
      opened.push(String(target));
      return real.call(fs.promises, target, ...rest);
    },
  });
}
/** Sensor files (input and limits) opened since the last call, relative to `base`. */
function sensorReads(base: string): string[] {
  const files = opened.splice(0).filter((f) => /\/(temp1_input|temp1_max|temp1_crit|temp)$/.test(f));
  return files.map((f) => path.relative(base, f));
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

  await runtimePmModes(config);

  console.log('\nAll Linux temperature tests passed.');
}

/**
 * mirabar.temperature.componentSensors: 'awake' skips runtime-suspended devices (and reads them again
 * once active), 'always' reads them, 'off' neither scans nor reads. Layout of the test laptop: NVMe
 * behind a PCI function and its PCIe port, a DDR5 module on the SMBus controller, an ACPI battery.
 */
async function runtimePmModes(config: MiraBarConfig): Promise<void> {
  const base = path.join(root, 'pm');
  const nvmeFn = 'devices/pci0000:00/0000:00:02.4/0000:02:00.0';
  const nvmePort = 'devices/pci0000:00/0000:00:02.4';
  const smbus = 'devices/pci0000:00/0000:00:14.0';
  const status = (dev: string, value: string): void => write(`${dev}/power`, { runtime_status: value }, base);
  hwmon(0, 'nvme', `${nvmeFn}/nvme/nvme0`, { temp1_input: 35850, temp1_max: 74850, temp1_crit: 79850 }, base);
  hwmon(1, 'spd5118', `${smbus}/i2c-21/21-0050`, { temp1_input: 40250, temp1_max: 55000, temp1_crit: 85000 }, base);
  // Runtime PM disabled ('unsupported'): the class device, the I2C client, the root complex, the battery chain.
  for (const dev of [`${nvmeFn}/nvme/nvme0`, `${smbus}/i2c-21/21-0050`, 'devices/pci0000:00', 'devices/LNXSYSTM:00/PNP0C0A:00']) {
    status(dev, 'unsupported');
  }
  status(nvmeFn, 'active');
  status(nvmePort, 'active');
  status(smbus, 'active');
  // power_supply entries are links into the device tree, as in sysfs.
  const bat = 'devices/LNXSYSTM:00/PNP0C0A:00/power_supply/BAT0';
  write(bat, { type: 'Battery', temp: 305 }, base);
  status(bat, 'unsupported');
  fs.mkdirSync(path.join(base, 'class/power_supply'), { recursive: true });
  fs.symlinkSync(path.join(base, bat), path.join(base, 'class/power_supply/BAT0'));

  const rows = (p: ComponentTempProvider): Array<[string, number | null]> =>
    p.latest()!.sensors.map((s) => [s.label, s.celsius]);
  let now = 5_000_000;
  const p = new ComponentTempProvider(base, () => now);

  // Default 'awake', everything active: read as before.
  opened.length = 0;
  await p.refresh();
  assert.deepEqual(rows(p), [['NVMe SSD', 35.85], ['RAM DIMM', 40.25], ['Battery Cell', 30.5]]);
  sensorReads(base);
  step('awake (default): active devices read');

  // The NVMe PCI function suspends: not read (neither input nor limits), row asleep with the scanned limits.
  status(nvmeFn, 'suspended');
  await p.refresh();
  const asleep = p.latest()!.sensors[0]!;
  assert.deepEqual([asleep.label, asleep.celsius, asleep.maxCelsius, asleep.critCelsius], ['NVMe SSD', null, 74.85, 79.85]);
  assert.deepEqual(sensorReads(base), ['class/hwmon/hwmon1/temp1_input', 'class/power_supply/BAT0/temp']);
  const tooltip = renderTemp({ tempCelsius: 50, sensorName: 'k10temp', sensorLabel: 'Tctl', sensors: p.latest()!.sensors }, { config, updatedAt: '12:00:00' }, true).tooltip!;
  assert.match(tooltip.split('\n').find((l) => l.startsWith('NVMe SSD '))!, /│\s+asleep │\s+80 °C$/);
  assert.match(tooltip, /\*Asleep \(runtime-suspended\), not read so as not to wake it: NVMe SSD\.\*/);
  step('awake: suspended device skipped, row asleep with its limits');

  // A rescan while it sleeps keeps the sensor and its limits without touching the drive.
  now += 60_000;
  await p.refresh();
  assert.equal(p.latest()!.sensors[0]!.celsius, null);
  assert.equal(p.latest()!.sensors[0]!.critCelsius, 79.85, 'limits kept from the previous scan');
  assert.ok(!sensorReads(base).some((f) => f.startsWith('class/hwmon/hwmon0/')), 'rescan does not read the sleeping drive');

  // 'suspending' anywhere up the chain (here the PCIe port) also counts as asleep.
  status(nvmeFn, 'active');
  status(nvmePort, 'suspending');
  await p.refresh();
  assert.equal(p.latest()!.sensors[0]!.celsius, null, 'suspending port');
  // Awake again: read again.
  status(nvmePort, 'active');
  write('class/hwmon/hwmon0', { temp1_input: 36850 }, base);
  await p.refresh();
  assert.deepEqual(rows(p)[0], ['NVMe SSD', 36.85]);
  assert.ok(sensorReads(base).includes('class/hwmon/hwmon0/temp1_input'));
  step('awake: suspended/suspending up the chain skipped, read again once active');

  // A device asleep at the first scan: listed without limits, which are read by the first awake pass.
  status(smbus, 'suspended');
  const fresh = new ComponentTempProvider(base, () => now);
  await fresh.refresh();
  const dimm = fresh.latest()!.sensors[1]!;
  assert.deepEqual([dimm.label, dimm.celsius, dimm.maxCelsius], ['RAM DIMM', null, undefined]);
  assert.ok(!sensorReads(base).some((f) => f.startsWith('class/hwmon/hwmon1/')), 'DIMM not read at scan');
  status(smbus, 'active');
  await fresh.refresh();
  const dimmAwake = fresh.latest()!.sensors[1]!;
  assert.deepEqual([dimmAwake.celsius, dimmAwake.maxCelsius, dimmAwake.critCelsius], [40.25, 55, 85]);
  step('awake: asleep at scan, limits read once awake');

  // 'always': the suspended drive is read anyway.
  status(nvmeFn, 'suspended');
  p.setMode('always');
  assert.equal(p.latest()!.sensors[0]!.celsius, 36.85, 'readings kept when switching awake -> always');
  await p.refresh();
  assert.deepEqual(rows(p)[0], ['NVMe SSD', 36.85]);
  assert.ok(sensorReads(base).includes('class/hwmon/hwmon0/temp1_input'));
  step('always: suspended device read');

  // 'off': no readings, no scan, no reads; a pass running when it is set is dropped.
  const running = p.refresh();
  p.setMode('off');
  await running;
  assert.equal(p.latest(), null, 'pass started before off is dropped');
  opened.length = 0;
  now += 60_000;
  await p.refresh();
  assert.equal(p.latest(), null);
  assert.equal(p.busy, false);
  assert.deepEqual(opened, [], 'off: nothing opened (no scan, no reads)');
  // Back on: scanned again at the next pass.
  p.setMode('awake');
  await p.refresh();
  assert.deepEqual(rows(p), [['NVMe SSD', null], ['RAM DIMM', 40.25], ['Battery Cell', 30.5]]);
  step('off: no scan, no reads, no rows; back on rescans');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
