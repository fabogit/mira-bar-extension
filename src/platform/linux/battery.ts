import * as path from 'node:path';
import type { BatteryInfo } from '../../types.js';
import { attribute, isSystemBattery, listDir, SysfsAttribute } from './sysfs.js';

/**
 * Internal descriptor of a battery's sysfs attributes (those found at discovery).
 */
interface BatteryFiles {
  /** Integer percentage capacity (`capacity`). */
  readonly capacity: SysfsAttribute;
  /** String charging state (`status`), if present. */
  readonly status?: SysfsAttribute;
  /** energy_now or charge_now (if present for weighted capacity). */
  readonly energyNow?: SysfsAttribute;
  /** energy_full or charge_full (if present for weighted capacity). */
  readonly energyFull?: SysfsAttribute;
  /** energy_full_design or charge_full_design. */
  readonly energyDesign?: SysfsAttribute;
  /** cycle_count, if present. */
  readonly cycleCount?: SysfsAttribute;
  /** Unit indicator ('mAh' for charge_*, 'mWh' for energy_*). */
  readonly unit?: 'mAh' | 'mWh';
  /** power_now (µW, with energy_*) or current_now (µA, with charge_*), matching `unit`. */
  readonly rate?: SysfsAttribute;
  /** time_to_empty_now (seconds), if the driver estimates it. */
  readonly timeToEmpty?: SysfsAttribute;
  /** time_to_full_now (seconds), if the driver estimates it. */
  readonly timeToFull?: SysfsAttribute;
}

/** Interval between battery scans while none was found (battery inserted or driver loaded after activation). */
const REDISCOVERY_INTERVAL_MS = 60_000;

/** Estimates above this are discarded: the rate is too low to mean anything (e.g. right after unplugging). */
const MAX_ESTIMATE_MINUTES = 48 * 60;

/**
 * Combined state of several batteries: the highest ranked one wins (one charging battery means the
 * system is charging; one discharging battery means it runs on battery). Other states rank 0.
 */
const STATUS_RANK: Record<string, number> = {
  Charging: 4,
  Discharging: 3,
  'Not charging': 2,
  Full: 1,
};

/**
 * Validates an estimate in minutes.
 *
 * @returns Whole minutes (at least 1), or `null` if not positive or above `MAX_ESTIMATE_MINUTES`.
 */
function plausibleMinutes(minutes: number): number | null {
  if (!(minutes > 0) || minutes > MAX_ESTIMATE_MINUTES) {
    return null;
  }
  return Math.max(1, Math.round(minutes));
}

/**
 * Linux power supply and battery status provider.
 *
 * Scans `/sys/class/power_supply` for system batteries (e.g. `BAT0`, `BAT1`): `type` Battery and
 * not a peripheral's battery (`scope` Device), the rule of the battery temperature sensor too.
 *
 * Performance optimization:
 * - On desktop workstations and servers without battery hardware there is nothing to poll: the only
 *   cost is a rescan at most once a minute (a directory listing and each entry's `type`), which picks
 *   up a battery inserted or a driver loaded after activation.
 * - On laptops with multiple batteries, it calculates weighted capacity using
 *   energy or charge nodes to prevent asymmetric battery calculation errors.
 * - Which files exist is decided once at discovery; samples only read them.
 *
 * Time remaining, in order: the driver's `time_to_empty_now` / `time_to_full_now` (single battery),
 * else remaining energy over `power_now` or remaining charge over `current_now` (summed over batteries).
 */
export class BatteryProvider {
  private batteries: readonly BatteryFiles[] = [];
  private lastDiscoveryAt = 0;

  /**
   * Initializes the provider and checks for power supply hardware.
   *
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   * @param now - Clock (ms since epoch).
   */
  constructor(
    private readonly sysRoot = '/sys',
    private readonly now: () => number = Date.now,
  ) {
    this.discoverBatteries();
  }

  /**
   * Indicates whether at least one battery device is present on this host. While none was found,
   * checking rescans at most once a minute (the monitor checks before each battery read).
   */
  public get isAvailable(): boolean {
    if (this.batteries.length === 0 && this.now() - this.lastDiscoveryAt >= REDISCOVERY_INTERVAL_MS) {
      this.discoverBatteries();
    }
    return this.batteries.length > 0;
  }

  /**
   * Discovers battery nodes under `/sys/class/power_supply/`.
   */
  private discoverBatteries(): void {
    this.lastDiscoveryAt = this.now();
    const basePath = path.join(this.sysRoot, 'class', 'power_supply');
    const found: BatteryFiles[] = [];

    for (const entry of listDir(basePath)) {
      const batDir = path.join(basePath, entry);
      if (!isSystemBattery(batDir)) {
        continue;
      }
      const capacity = attribute(batDir, 'capacity');
      if (!capacity) {
        continue;
      }
      found.push({
        capacity,
        status: attribute(batDir, 'status'),
        ...(energyFiles(batDir, 'energy', 'power_now', 'mWh') ?? energyFiles(batDir, 'charge', 'current_now', 'mAh')),
        cycleCount: attribute(batDir, 'cycle_count'),
        timeToEmpty: attribute(batDir, 'time_to_empty_now'),
        timeToFull: attribute(batDir, 'time_to_full_now'),
      });
    }

    this.batteries = found;
  }

  /**
   * Makes the battery driver refresh its cached state off the extension host thread, ahead of the next
   * sample (the monitor calls it shortly before the read): one read of `capacity` per battery on the
   * libuv pool, which pays the ACPI embedded controller query there (issue #40).
   */
  public requestRefresh(): void {
    for (const bat of this.batteries) {
      bat.capacity.refreshAsync();
    }
  }

  /** Closes the open battery files. */
  public dispose(): void {
    for (const bat of this.batteries) {
      for (const attr of Object.values(bat)) {
        if (attr instanceof SysfsAttribute) {
          attr.close();
        }
      }
    }
    this.batteries = [];
  }

  /**
   * Reads battery capacity percentage and charging status.
   *
   * @returns Aggregated battery state, or `null` if no battery exists or reading fails.
   */
  public sample(): BatteryInfo | null {
    if (!this.isAvailable) {
      return null;
    }

    let totalEnergyNow = 0;
    let totalEnergyFull = 0;
    let totalEnergyDesign = 0;
    let hasEnergyData = false;
    let hasDesignData = false;
    let detectedUnit: 'mAh' | 'mWh' = 'mAh';
    let totalCycles = 0;
    let hasCycleData = false;

    let fallbackPercentSum = 0;
    let fallbackCount = 0;
    let combinedStatus = '';

    // An unreadable attribute (NaN, null: battery removed, ENODATA) is skipped; the others still count.
    for (const bat of this.batteries) {
      if (bat.unit) {
        detectedUnit = bat.unit;
      }
      if (bat.energyNow && bat.energyFull) {
        const now = bat.energyNow.readInt();
        const full = bat.energyFull.readInt();
        if (!isNaN(now) && !isNaN(full) && full > 0) {
          totalEnergyNow += now;
          totalEnergyFull += full;
          hasEnergyData = true;
        }
      }
      if (bat.energyDesign) {
        const design = bat.energyDesign.readInt();
        if (!isNaN(design) && design > 0) {
          totalEnergyDesign += design;
          hasDesignData = true;
        }
      }
      if (bat.cycleCount) {
        const cycles = bat.cycleCount.readInt();
        if (!isNaN(cycles) && cycles >= 0) {
          totalCycles += cycles;
          hasCycleData = true;
        }
      }

      const cap = bat.capacity.readInt();
      if (!isNaN(cap)) {
        fallbackPercentSum += cap;
        fallbackCount++;
      }

      const rawStatus = bat.status?.readText() ?? null;
      if (rawStatus !== null && (combinedStatus === '' || (STATUS_RANK[rawStatus] ?? 0) > (STATUS_RANK[combinedStatus] ?? 0))) {
        combinedStatus = rawStatus;
      }
    }

    let percent = 0;
    if (hasEnergyData && totalEnergyFull > 0) {
      percent = Math.min(100, Math.max(0, Math.round((totalEnergyNow / totalEnergyFull) * 100)));
    } else if (fallbackCount > 0) {
      percent = Math.min(100, Math.max(0, Math.round(fallbackPercentSum / fallbackCount)));
    } else {
      return null;
    }

    if (combinedStatus === '') {
      combinedStatus = 'Unknown';
    }
    const isCharging = combinedStatus === 'Charging';
    const result: BatteryInfo = {
      percent,
      status: combinedStatus,
      isCharging,
    };

    // Full, Not charging, Unknown: no time. Discharging without an estimate: -1 (as macOS, "Estimating...").
    if (isCharging || combinedStatus === 'Discharging') {
      const minutes = this.timeRemaining(isCharging, hasEnergyData, totalEnergyNow, totalEnergyFull);
      if (minutes !== null) {
        result.timeRemainingMinutes = minutes;
      } else if (!isCharging) {
        result.timeRemainingMinutes = -1;
      }
    }

    if (hasEnergyData && totalEnergyFull > 0) {
      // Sysfs values are in µAh or µWh, convert to mAh or mWh
      result.currentCapacity = Math.round(totalEnergyNow / 1000);
      result.maxCapacity = Math.round(totalEnergyFull / 1000);
      result.capacityUnit = detectedUnit;

      if (hasDesignData && totalEnergyDesign > 0) {
        result.designCapacity = Math.round(totalEnergyDesign / 1000);
        result.healthPercent = Math.min(100, Math.max(0, (totalEnergyFull / totalEnergyDesign) * 100));
      }
    }

    if (hasCycleData) {
      result.cycleCount = totalCycles;
    }

    return result;
  }

  /**
   * Estimates minutes until empty (discharging) or full (charging).
   *
   * The driver's own estimate is used with a single battery only: with several, per-battery times
   * cannot be combined (they may discharge one after the other or together).
   *
   * @param charging - Direction of the estimate.
   * @param hasEnergyData - Whether `energyNow` and `energyFull` were read (µWh or µAh, summed).
   * @returns Whole minutes, or `null` without a usable source (no rate, rate 0, implausible result).
   */
  private timeRemaining(charging: boolean, hasEnergyData: boolean, energyNow: number, energyFull: number): number | null {
    const single = this.batteries.length === 1 ? this.batteries[0] : undefined;
    const time = charging ? single?.timeToFull : single?.timeToEmpty;
    if (time) {
      const minutes = plausibleMinutes(time.readInt() / 60);
      if (minutes !== null) {
        return minutes;
      }
    }

    if (!hasEnergyData) {
      return null;
    }
    let rate = 0;
    for (const bat of this.batteries) {
      if (bat.rate) {
        // Some drivers sign current_now (negative while discharging); the direction comes from status.
        const value = bat.rate.readInt();
        if (!isNaN(value)) {
          rate += Math.abs(value);
        }
      }
    }
    if (rate <= 0) {
      return null;
    }
    // µWh / µW or µAh / µA: hours.
    return plausibleMinutes(((charging ? energyFull - energyNow : energyNow) / rate) * 60);
  }
}

/**
 * The `<prefix>_now` / `<prefix>_full` pair of a battery, with its design capacity and rate.
 *
 * @returns The attributes, or `undefined` if the pair is incomplete (the battery reports the other unit).
 */
function energyFiles(
  dir: string,
  prefix: 'energy' | 'charge',
  rate: 'power_now' | 'current_now',
  unit: 'mWh' | 'mAh',
): Pick<BatteryFiles, 'energyNow' | 'energyFull' | 'energyDesign' | 'unit' | 'rate'> | undefined {
  const energyNow = attribute(dir, `${prefix}_now`);
  const energyFull = attribute(dir, `${prefix}_full`);
  if (!energyNow || !energyFull) {
    return undefined;
  }
  return { energyNow, energyFull, unit, energyDesign: attribute(dir, `${prefix}_full_design`), rate: attribute(dir, rate) };
}
