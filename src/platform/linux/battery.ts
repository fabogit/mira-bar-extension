import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BatteryInfo } from '../../types.js';

/**
 * Internal descriptor storing paths to a battery's sysfs nodes.
 */
interface BatteryPath {
  /** Path to the integer percentage capacity file (e.g. `.../capacity`). */
  capacityPath: string;
  /** Path to the string charging state file (e.g. `.../status`). */
  statusPath: string;
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
   */
  constructor() {
    this.discoverBatteries();
  }

  /**
   * Discovers battery nodes under `/sys/class/power_supply/`.
   */
  private discoverBatteries(): void {
    this.discoveryAttempted = true;
    const basePath = '/sys/class/power_supply';

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
            const bat: BatteryPath = { capacityPath, statusPath };
            if (fs.existsSync(path.join(batDir, 'energy_now')) && fs.existsSync(path.join(batDir, 'energy_full'))) {
              bat.energyNowPath = path.join(batDir, 'energy_now');
              bat.energyFullPath = path.join(batDir, 'energy_full');
              bat.unit = 'mWh';
              if (fs.existsSync(path.join(batDir, 'energy_full_design'))) {
                bat.energyDesignPath = path.join(batDir, 'energy_full_design');
              }
            } else if (fs.existsSync(path.join(batDir, 'charge_now')) && fs.existsSync(path.join(batDir, 'charge_full'))) {
              bat.energyNowPath = path.join(batDir, 'charge_now');
              bat.energyFullPath = path.join(batDir, 'charge_full');
              bat.unit = 'mAh';
              if (fs.existsSync(path.join(batDir, 'charge_full_design'))) {
                bat.energyDesignPath = path.join(batDir, 'charge_full_design');
              }
            }
            if (fs.existsSync(path.join(batDir, 'cycle_count'))) {
              bat.cycleCountPath = path.join(batDir, 'cycle_count');
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
      let combinedStatus = 'Discharging';

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

          if (fs.existsSync(bat.statusPath)) {
            const rawStatus = fs.readFileSync(bat.statusPath, 'utf8').trim();
            if (rawStatus === 'Charging') {
              combinedStatus = 'Charging';
            } else if (rawStatus === 'Full' && combinedStatus !== 'Charging') {
              combinedStatus = 'Full';
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

      const isCharging = combinedStatus === 'Charging';
      const result: BatteryInfo = {
        percent,
        status: combinedStatus,
        isCharging,
      };

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
}
