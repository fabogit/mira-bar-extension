import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ComponentSensorsMode, TempSensorReading } from '../../types.js';

/** Interval between two scans of hwmon and power_supply (hotplug, driver reloads). */
const RESCAN_MS = 60_000;

/** Readings outside this range (°C) are treated as invalid. */
const MIN_VALID_CELSIUS = -40;
const MAX_VALID_CELSIUS = 150;

type ComponentKind = 'ssd' | 'ram' | 'wifi' | 'battery';

/** Row order in the tooltip and labels: the first when a kind has one sensor, the second (+ id) with several. */
const KINDS: Record<ComponentKind, { single: string; multiple: string }> = {
  ssd: { single: 'NVMe SSD', multiple: 'NVMe' },
  ram: { single: 'RAM DIMM', multiple: 'RAM DIMM' },
  wifi: { single: 'Wi-Fi', multiple: 'Wi-Fi' },
  battery: { single: 'Battery Cell', multiple: 'Battery' },
};

/** Wireless drivers whose hwmon device is not under an ieee80211 phy (iwlwifi registers a thermal zone). */
const WIFI_HWMON_NAME = /^(iwlwifi|mt76|mt79|ath\d+k|rtw)/;

interface ComponentSensor {
  kind: ComponentKind;
  label: string;
  inputPath: string;
  /** Divisor from the file's unit to °C: 1000 for hwmon (m°C), 10 for power_supply (tenths). */
  divisor: number;
  /** Directory holding `temp1_max` / `temp1_crit` (hwmon), or null (power_supply: no limits). */
  limitsDir: string | null;
  /** Whether the limits were read: deferred to the first pass that finds the device awake. */
  limitsRead: boolean;
  maxCelsius?: number;
  critCelsius?: number;
  /**
   * `power/runtime_status` files of the device and of its ancestors whose runtime PM was enabled at
   * scan time: the nodes that can be suspended (PCI function and port, SMBus/I2C controller).
   */
  pmStatusFiles: string[];
}

/** Latest pass over the component sensors. */
export interface ComponentReadings {
  /** Time the pass started (ms since epoch). */
  at: number;
  sensors: TempSensorReading[];
}

/**
 * Temperatures of components other than the CPU on Linux: NVMe drives (hwmon `nvme`), memory modules
 * (`spd5118`, `jc42`), wireless adapters and batteries (`power_supply/BAT*\/temp`).
 *
 * These reads go through the device: an NVMe SMART log command (up to ~40 ms when the drive is in a low
 * power state), I2C for the DIMM sensors (~1.5 ms each), a firmware command for the Wi-Fi chip (~2 ms).
 * They are read asynchronously, one file at a time, with at most one pass in flight, so the extension
 * host thread never waits and a stuck device holds at most one libuv pool thread (ADR-0016).
 *
 * In 'awake' mode a sensor whose device is runtime-suspended is not read (the read would resume it):
 * its row is reported asleep (`celsius: null`) until a pass finds the device active again.
 */
export class ComponentTempProvider {
  private sensors: ComponentSensor[] = [];
  private scannedAt = 0;
  private inFlight: Promise<void> | null = null;
  private last: ComponentReadings | null = null;
  private mode: ComponentSensorsMode = 'awake';
  /** Incremented when the mode changes: a pass started before keeps neither its scan nor its readings. */
  private generation = 0;

  /**
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   * @param now - Clock (ms since epoch).
   */
  constructor(
    private readonly sysRoot = '/sys',
    private readonly now: () => number = Date.now,
  ) {}

  /** Latest completed pass, or `null` before the first one completes (always `null` in 'off' mode). */
  public latest(): ComponentReadings | null {
    return this.last;
  }

  /**
   * Applies mirabar.temperature.componentSensors. 'off' drops the sensors and the readings, and turning
   * them back on scans again at the next pass; between 'awake' and 'always' the readings are kept.
   */
  public setMode(mode: ComponentSensorsMode): void {
    if (mode === this.mode) {
      return;
    }
    this.generation++;
    if (mode === 'off' || this.mode === 'off') {
      this.sensors = [];
      this.scannedAt = 0;
      this.last = null;
    }
    this.mode = mode;
  }

  /** Whether a pass is running. */
  public get busy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Starts a pass unless one is already running (none in 'off' mode).
   *
   * @returns The running pass, which never rejects.
   */
  public refresh(): Promise<void> {
    if (this.mode === 'off') {
      return this.inFlight ?? Promise.resolve();
    }
    if (!this.inFlight) {
      this.inFlight = this.pass().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    const generation = this.generation;
    const skipAsleep = this.mode === 'awake';
    const at = this.now();
    try {
      if (this.scannedAt === 0 || at - this.scannedAt >= RESCAN_MS) {
        const found = await this.scan(skipAsleep);
        if (generation !== this.generation) {
          return;
        }
        this.sensors = found;
        this.scannedAt = at;
      }
    } catch {
      // keep the previous sensor list
    }
    const sensors: TempSensorReading[] = [];
    for (const s of this.sensors) {
      if (generation !== this.generation) {
        return; // mode changed during the pass (e.g. 'off'): no further reads
      }
      // Checked right before the read: the device may have suspended since the previous sensor.
      if (skipAsleep && isAsleep(s.pmStatusFiles)) {
        sensors.push({ label: s.label, celsius: null, maxCelsius: s.maxCelsius, critCelsius: s.critCelsius });
        continue;
      }
      if (!s.limitsRead) {
        await readLimits(s);
      }
      const value = await readNumber(s.inputPath);
      if (value === null) {
        continue; // device gone or busy: skipped until the next pass (or rescan)
      }
      const celsius = value / s.divisor;
      if (celsius <= MIN_VALID_CELSIUS || celsius > MAX_VALID_CELSIUS) {
        continue;
      }
      sensors.push({ label: s.label, celsius, maxCelsius: s.maxCelsius, critCelsius: s.critCelsius });
    }
    if (generation === this.generation) {
      this.last = { at, sensors };
    }
  }

  /**
   * Finds the component sensors and their limits (limits are static, read once per scan). With
   * `skipAsleep`, a runtime-suspended device is not read: its input file only has to exist, and its
   * limits are kept from the previous scan or read by the first pass that finds it awake.
   */
  private async scan(skipAsleep: boolean): Promise<ComponentSensor[]> {
    const found: Array<Omit<ComponentSensor, 'label'> & { id: string }> = [];
    const devicesRoot = await realpathSafe(path.join(this.sysRoot, 'devices'));
    const previous = new Map(this.sensors.map((s) => [s.inputPath, s]));

    const add = async (
      sensor: Omit<ComponentSensor, 'label' | 'limitsRead' | 'pmStatusFiles'> & { id: string },
      device: string | null,
    ): Promise<void> => {
      const entry = { ...sensor, limitsRead: false, pmStatusFiles: await runtimePmFiles(device, devicesRoot) };
      if (skipAsleep && isAsleep(entry.pmStatusFiles)) {
        if (!(await exists(entry.inputPath))) {
          return;
        }
        const before = previous.get(entry.inputPath);
        if (before?.limitsRead) {
          Object.assign(entry, { limitsRead: true, maxCelsius: before.maxCelsius, critCelsius: before.critCelsius });
        }
      } else {
        if ((await readNumber(entry.inputPath)) === null) {
          return;
        }
        await readLimits(entry);
      }
      found.push(entry);
    };

    const hwmonBase = path.join(this.sysRoot, 'class', 'hwmon');
    for (const dir of await readDirSafe(hwmonBase)) {
      const dirPath = path.join(hwmonBase, dir);
      const name = (await readText(path.join(dirPath, 'name')))?.toLowerCase();
      if (!name) {
        continue;
      }
      const device = await realpathSafe(path.join(dirPath, 'device'));
      let kind: ComponentKind | null = null;
      if (name === 'nvme') {
        kind = 'ssd';
      } else if (name === 'spd5118' || name === 'jc42') {
        kind = 'ram';
      } else if (WIFI_HWMON_NAME.test(name) || (device !== null && device.includes(`${path.sep}ieee80211${path.sep}`))) {
        kind = 'wifi';
      }
      if (!kind) {
        continue;
      }
      await add(
        { kind, id: device !== null ? path.basename(device) : dir, inputPath: path.join(dirPath, 'temp1_input'), divisor: 1000, limitsDir: dirPath },
        device ?? (await realpathSafe(dirPath)),
      );
    }

    const psBase = path.join(this.sysRoot, 'class', 'power_supply');
    for (const dir of await readDirSafe(psBase)) {
      const dirPath = path.join(psBase, dir);
      if ((await readText(path.join(dirPath, 'type'))) !== 'Battery') {
        continue;
      }
      // Same rule as the other sensors: an ACPI battery has no runtime PM in its chain (always read), a
      // fuel gauge on I2C/SMBus (sbs-battery, bq27xxx) sits behind a controller that can be suspended.
      await add({ kind: 'battery', id: dir, inputPath: path.join(dirPath, 'temp'), divisor: 10, limitsDir: null }, await realpathSafe(dirPath));
    }

    const order = Object.keys(KINDS) as ComponentKind[];
    found.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id, 'en', { numeric: true }));
    return found.map(({ id, ...s }, _i, all) => {
      const sameKind = all.filter((o) => o.kind === s.kind);
      const names = KINDS[s.kind];
      if (sameKind.length === 1) {
        return { ...s, label: names.single };
      }
      // DIMMs are numbered in bus order; the others keep their device name (nvme1, phy0, BAT1).
      const suffix = s.kind === 'ram' ? String(sameKind.findIndex((o) => o.id === id)) : id;
      return { ...s, label: `${names.multiple} ${suffix}` };
    });
  }
}

/**
 * `power/runtime_status` files of `device` and its ancestors below /sys/devices, keeping the nodes whose
 * runtime PM is enabled ('unsupported' means disabled, which changes when a driver binds or unbinds:
 * the next scan picks that up). For an NVMe drive this is the PCI function (the `nvme` class device is
 * 'unsupported') and its PCIe port; for a DIMM sensor, the SMBus/I2C controller (the I2C client is
 * 'unsupported' and the adapter has no runtime attributes); for a Wi-Fi chip, its PCI function and port.
 */
async function runtimePmFiles(device: string | null, devicesRoot: string | null): Promise<string[]> {
  const files: string[] = [];
  if (device === null || devicesRoot === null) {
    return files;
  }
  for (let dir = device; dir.startsWith(devicesRoot + path.sep); dir = path.dirname(dir)) {
    const file = path.join(dir, 'power', 'runtime_status');
    const status = await readText(file);
    if (status !== null && status !== 'unsupported') {
      files.push(file);
    }
  }
  return files;
}

/**
 * Whether a device is runtime-suspended: one of its runtime_status files reads 'suspended' or
 * 'suspending' ('active', 'resuming', 'error' or a missing file: the sensor is read). The attribute is
 * served from the kernel's runtime PM bookkeeping without touching the device, so it is read
 * synchronously like the CPU sensor: ~25 µs per file, against ~200 µs of CPU through fs.promises.
 */
function isAsleep(statusFiles: readonly string[]): boolean {
  for (const file of statusFiles) {
    let status: string;
    try {
      status = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue; // device gone: its sensor read fails and the next scan drops it
    }
    if (status === 'suspended' || status === 'suspending') {
      return true;
    }
  }
  return false;
}

/** Reads a sensor's `temp1_max` / `temp1_crit` (for NVMe, `temp1_max` is a command to the drive). */
async function readLimits(s: Omit<ComponentSensor, 'label'>): Promise<void> {
  if (s.limitsDir !== null) {
    s.maxCelsius = validLimit(await readNumber(path.join(s.limitsDir, 'temp1_max')), 1000);
    s.critCelsius = validLimit(await readNumber(path.join(s.limitsDir, 'temp1_crit')), 1000);
  }
  s.limitsRead = true;
}

/** Whether a file exists: a stat, which neither reads the attribute nor reaches the device. */
async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return [];
  }
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return (await fsp.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readNumber(file: string): Promise<number | null> {
  const text = await readText(file);
  if (text === null || text === '') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A limit in °C, or undefined when missing or implausible (some drivers report 0 or garbage). */
function validLimit(raw: number | null, divisor: number): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const celsius = raw / divisor;
  return celsius > 0 && celsius <= MAX_VALID_CELSIUS + 50 ? celsius : undefined;
}
