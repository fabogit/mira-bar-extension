import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { TempSensorReading } from '../../types.js';

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
  maxCelsius?: number;
  critCelsius?: number;
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
 */
export class ComponentTempProvider {
  private sensors: ComponentSensor[] = [];
  private scannedAt = 0;
  private inFlight: Promise<void> | null = null;
  private last: ComponentReadings | null = null;

  /**
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   * @param now - Clock (ms since epoch).
   */
  constructor(
    private readonly sysRoot = '/sys',
    private readonly now: () => number = Date.now,
  ) {}

  /** Latest completed pass, or `null` before the first one completes. */
  public latest(): ComponentReadings | null {
    return this.last;
  }

  /** Whether a pass is running. */
  public get busy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Starts a pass unless one is already running.
   *
   * @returns The running pass, which never rejects.
   */
  public refresh(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.pass().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    const at = this.now();
    try {
      if (this.scannedAt === 0 || at - this.scannedAt >= RESCAN_MS) {
        this.sensors = await this.scan();
        this.scannedAt = at;
      }
    } catch {
      // keep the previous sensor list
    }
    const sensors: TempSensorReading[] = [];
    for (const s of this.sensors) {
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
    this.last = { at, sensors };
  }

  /** Finds the component sensors and their limits (limits are static, read once per scan). */
  private async scan(): Promise<ComponentSensor[]> {
    const found: Array<Omit<ComponentSensor, 'label'> & { id: string }> = [];

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
      const inputPath = path.join(dirPath, 'temp1_input');
      if ((await readNumber(inputPath)) === null) {
        continue;
      }
      found.push({
        kind,
        id: device !== null ? path.basename(device) : dir,
        inputPath,
        divisor: 1000,
        maxCelsius: validLimit(await readNumber(path.join(dirPath, 'temp1_max')), 1000),
        critCelsius: validLimit(await readNumber(path.join(dirPath, 'temp1_crit')), 1000),
      });
    }

    const psBase = path.join(this.sysRoot, 'class', 'power_supply');
    for (const dir of await readDirSafe(psBase)) {
      const dirPath = path.join(psBase, dir);
      if ((await readText(path.join(dirPath, 'type'))) !== 'Battery') {
        continue;
      }
      const inputPath = path.join(dirPath, 'temp');
      if ((await readNumber(inputPath)) === null) {
        continue;
      }
      found.push({ kind: 'battery', id: dir, inputPath, divisor: 10 });
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
