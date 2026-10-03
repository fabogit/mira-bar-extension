import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BatteryInfo } from '../../types.js';

/**
 * Internal descriptor storing paths to a battery's sysfs nodes.
 */
interface BatteryPath {
  /** Path to the integer percentage capacity file (e.g. `.../capacity`). */
  capacityPath: string;
  /** Path to the string charging state file (e.g. `.../status`), if present. */
  statusPath?: string;
  /** Path to energy_now or charge_now (if present for weighted capacity). */
  energyNowPath?: string;
  /** Path to energy_full or charge_full (if present for weighted capacity). */
  energyFullPath?: string;
  /** Path to energy_full_design or charge_full_design. */
  energyDesignPath?: string;
  /** Path to cycle_count file if present. */
  cycleCountPath?: string;
  /** Unit indicator ('mAh' for charge_*, 'mWh' for energy_*). */
  unit?: 'mAh' | 'mWh';
  /** Path to power_now (µW, with energy_*) or current_now (µA, with charge_*), matching `unit`. */
  ratePath?: string;
  /** Path to time_to_empty_now (seconds), if the driver estimates it. */
  timeToEmptyPath?: string;
  /** Path to time_to_full_now (seconds), if the driver estimates it. */
  timeToFullPath?: string;
}

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
 * Reads an integer sysfs attribute.
 *
 * @returns The value, or `NaN` if the file is unreadable (some drivers fail reads with ENODATA) or not a number.
 */
function readInt(file: string): number {
  try {
    return parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    return NaN;
  }
}

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
 * Scans `/sys/class/power_supply` for any device named `BAT*` (e.g. `BAT0`, `BAT1`).
 *
 * Performance optimization:
 * - On desktop workstations and servers without battery hardware, it permanently
 *   disables itself on startup, resulting in zero polling calls and zero CPU overhead.
 * - On laptops with multiple batteries, it calculates weighted capacity using
 *   energy or charge nodes to prevent asymmetric battery calculation errors.
 * - Which files exist is decided once at discovery; samples only read them.
 *
 * Time remaining, in order: the driver's `time_to_empty_now` / `time_to_full_now` (single battery),
 * else remaining energy over `power_now` or remaining charge over `current_now` (summed over batteries).
 */
export class BatteryProvider {
  private batteries: BatteryPath[] = [];

  /**
   * Indicates whether at least one battery device is present on this host.
   */
  public isAvailable = false;
  private discoveryAttempted = false;

  /**
   * Initializes the provider and checks for power supply hardware.
   *
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   */
  constructor(private readonly sysRoot = '/sys') {
    this.discoverBatteries();
  }

  /**
   * Discovers battery nodes under `/sys/class/power_supply/`.
   */
  private discoverBatteries(): void {
    this.discoveryAttempted = true;
    const basePath = path.join(this.sysRoot, 'class', 'power_supply');

    try {
      if (!fs.existsSync(basePath)) {
        this.isAvailable = false;
        return;
      }

      const entries = fs.readdirSync(basePath);
      const found: BatteryPath[] = [];

      for (const entry of entries) {
        if (/^BAT\d*$/i.test(entry)) {
          const batDir = path.join(basePath, entry);
          const capacityPath = path.join(batDir, 'capacity');
          const statusPath = path.join(batDir, 'status');

          if (fs.existsSync(capacityPath)) {
            const bat: BatteryPath = { capacityPath };
            if (fs.existsSync(statusPath)) {
              bat.statusPath = statusPath;
            }
            if (fs.existsSync(path.join(batDir, 'energy_now')) && fs.existsSync(path.join(batDir, 'energy_full'))) {
              bat.energyNowPath = path.join(batDir, 'energy_now');
              bat.energyFullPath = path.join(batDir, 'energy_full');
              bat.unit = 'mWh';
              if (fs.existsSync(path.join(batDir, 'energy_full_design'))) {
                bat.energyDesignPath = path.join(batDir, 'energy_full_design');
              }
              if (fs.existsSync(path.join(batDir, 'power_now'))) {
                bat.ratePath = path.join(batDir, 'power_now');
              }
            } else if (fs.existsSync(path.join(batDir, 'charge_now')) && fs.existsSync(path.join(batDir, 'charge_full'))) {
              bat.energyNowPath = path.join(batDir, 'charge_now');
              bat.energyFullPath = path.join(batDir, 'charge_full');
              bat.unit = 'mAh';
              if (fs.existsSync(path.join(batDir, 'charge_full_design'))) {
                bat.energyDesignPath = path.join(batDir, 'charge_full_design');
              }
              if (fs.existsSync(path.join(batDir, 'current_now'))) {
                bat.ratePath = path.join(batDir, 'current_now');
              }
            }
            if (fs.existsSync(path.join(batDir, 'cycle_count'))) {
              bat.cycleCountPath = path.join(batDir, 'cycle_count');
            }
            if (fs.existsSync(path.join(batDir, 'time_to_empty_now'))) {
              bat.timeToEmptyPath = path.join(batDir, 'time_to_empty_now');
            }
            if (fs.existsSync(path.join(batDir, 'time_to_full_now'))) {
              bat.timeToFullPath = path.join(batDir, 'time_to_full_now');
            }
            found.push(bat);
          }
        }
      }

      this.batteries = found;
      this.isAvailable = found.length > 0;
    } catch {
      this.isAvailable = false;
    }
  }

  /**
   * Reads battery capacity percentage and charging status.
   *
   * @returns Aggregated battery state, or `null` if no battery exists or reading fails.
   */
  public sample(): BatteryInfo | null {
    if (!this.discoveryAttempted) {
      this.discoverBatteries();
    }

    if (!this.isAvailable || this.batteries.length === 0) {
      return null;
    }

    try {
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

      for (const bat of this.batteries) {
        try {
          if (bat.unit) {
            detectedUnit = bat.unit;
          }
          if (bat.energyNowPath && bat.energyFullPath) {
            const now = parseInt(fs.readFileSync(bat.energyNowPath, 'utf8').trim(), 10);
            const full = parseInt(fs.readFileSync(bat.energyFullPath, 'utf8').trim(), 10);
            if (!isNaN(now) && !isNaN(full) && full > 0) {
              totalEnergyNow += now;
              totalEnergyFull += full;
              hasEnergyData = true;
            }
          }
          if (bat.energyDesignPath) {
            const design = parseInt(fs.readFileSync(bat.energyDesignPath, 'utf8').trim(), 10);
            if (!isNaN(design) && design > 0) {
              totalEnergyDesign += design;
              hasDesignData = true;
            }
          }
          if (bat.cycleCountPath) {
            const cycles = parseInt(fs.readFileSync(bat.cycleCountPath, 'utf8').trim(), 10);
            if (!isNaN(cycles) && cycles >= 0) {
              totalCycles += cycles;
              hasCycleData = true;
            }
          }

          const rawCap = fs.readFileSync(bat.capacityPath, 'utf8').trim();
          const cap = parseInt(rawCap, 10);
          if (!isNaN(cap)) {
            fallbackPercentSum += cap;
            fallbackCount++;
          }

          if (bat.statusPath) {
            const rawStatus = fs.readFileSync(bat.statusPath, 'utf8').trim();
            if (combinedStatus === '' || (STATUS_RANK[rawStatus] ?? 0) > (STATUS_RANK[combinedStatus] ?? 0)) {
              combinedStatus = rawStatus;
            }
          }
        } catch {
          // Skip unreadable battery node
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
    } catch {
      return null;
    }
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
    const timePath = charging ? single?.timeToFullPath : single?.timeToEmptyPath;
    if (timePath) {
      const minutes = plausibleMinutes(readInt(timePath) / 60);
      if (minutes !== null) {
        return minutes;
      }
    }

    if (!hasEnergyData) {
      return null;
    }
    let rate = 0;
    for (const bat of this.batteries) {
      if (bat.ratePath) {
        // Some drivers sign current_now (negative while discharging); the direction comes from status.
        const value = readInt(bat.ratePath);
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
