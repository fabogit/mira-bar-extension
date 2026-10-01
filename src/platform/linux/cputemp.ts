import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CpuTempInfo } from '../../types.js';

/**
 * Internal metadata descriptor for an identified hardware thermal sensor.
 */
interface DiscoveredSensor {
  /** Absolute sysfs path to the temperature input file (e.g. `.../temp1_input`). */
  tempFilePath: string;
  /** Driver or subsystem identifier (e.g. `k10temp`, `coretemp`, `acpi`). */
  sensorName: string;
  /** Descriptive label associated with the sensor node (e.g. `Tctl`, `Tccd1`). */
  sensorLabel: string;
}

/**
 * Hardware-adaptive thermal sensor provider for Linux systems.
 *
 * Implements a heuristic startup discovery mechanism that checks `/sys/class/hwmon`
 * with prioritized support for AMD Zen/Ryzen architectures (`k10temp`, `zenpower`)
 * and Intel platforms (`coretemp`), with fallback to generic ACPI thermal zones.
 */
export class CpuTempProvider {
  private sensor: DiscoveredSensor | null = null;
  private discoveryAttempted = false;

  /**
   * Initializes the provider and triggers initial sensor discovery.
   */
  constructor() {
    this.discoverSensor();
  }

  /**
   * Scans hwmon and thermal zone directories to locate the primary CPU die sensor.
   */
  private discoverSensor(): void {
    this.discoveryAttempted = true;
    const hwmonBase = '/sys/class/hwmon';

    try {
      if (fs.existsSync(hwmonBase)) {
        const hwmonDirs = fs.readdirSync(hwmonBase);

        let amdSensor: DiscoveredSensor | null = null;
        let intelSensor: DiscoveredSensor | null = null;
        let genericHwmonSensor: DiscoveredSensor | null = null;

        for (const dir of hwmonDirs) {
          const dirPath = path.join(hwmonBase, dir);
          const nameFile = path.join(dirPath, 'name');

          let name = '';
          try {
            name = fs.readFileSync(nameFile, 'utf8').trim().toLowerCase();
          } catch {
            continue;
          }

          const found = this.findTempInHwmon(dirPath, name);
          if (!found) {
            continue;
          }

          if (name === 'k10temp' || name === 'zenpower') {
            amdSensor = found;
            break; // AMD high-priority match found!
          } else if (name === 'coretemp') {
            intelSensor = found;
          } else if (!genericHwmonSensor && (name.includes('cpu') || name === 'acpitz')) {
            genericHwmonSensor = found;
          }
        }

        this.sensor = amdSensor ?? intelSensor ?? genericHwmonSensor;
        if (this.sensor) {
          return;
        }
      }

      // Fallback: /sys/class/thermal/thermal_zone0/temp
      const thermalZonePath = '/sys/class/thermal/thermal_zone0/temp';
      if (fs.existsSync(thermalZonePath)) {
        this.sensor = {
          tempFilePath: thermalZonePath,
          sensorName: 'acpi',
          sensorLabel: 'thermal_zone0',
        };
      }
    } catch {
      this.sensor = null;
    }
  }

  /**
   * Evaluates a single hwmon directory to find the most appropriate temperature input file.
   *
   * @param dirPath - Path to the `hwmon*` directory.
   * @param sensorName - Cleaned name string from `name` file.
   * @returns Discovered sensor metadata or `null` if no valid input files exist.
   */
  private findTempInHwmon(dirPath: string, sensorName: string): DiscoveredSensor | null {
    try {
      const files = fs.readdirSync(dirPath);
      // Prefer temp1_input (typically Tctl for AMD or Package ID for Intel)
      const inputFiles = files.filter((f: string) => /^temp\d+_input$/.test(f)).sort();

      if (inputFiles.length === 0) {
        return null;
      }

      const targetFile = inputFiles.includes('temp1_input') ? 'temp1_input' : inputFiles[0]!;
      const tempFilePath = path.join(dirPath, targetFile);

      // Read label if present (e.g. temp1_label)
      const labelFile = targetFile.replace('_input', '_label');
      let sensorLabel = targetFile;
      try {
        const rawLabel = fs.readFileSync(path.join(dirPath, labelFile), 'utf8').trim();
        if (rawLabel) {
          sensorLabel = rawLabel;
        }
      } catch {
        // Label file optional
      }

      return {
        tempFilePath,
        sensorName,
        sensorLabel,
      };
    } catch {
      return null;
    }
  }

  /**
   * Reads and parses the current temperature from the discovered sensor file.
   *
   * @returns Temperature metrics including value in °C, sensor name, and label, or `null` if reading fails.
   */
  public sample(): CpuTempInfo | null {
    if (!this.sensor) {
      if (!this.discoveryAttempted) {
        this.discoverSensor();
      }
      if (!this.sensor) {
        return null;
      }
    }

    try {
      const raw = fs.readFileSync(this.sensor.tempFilePath, 'utf8').trim();
      const milliC = parseInt(raw, 10);
      if (isNaN(milliC) || milliC <= 0) {
        return null;
      }

      const tempCelsius = milliC / 1000;
      return {
        tempCelsius,
        sensorName: this.sensor.sensorName,
        sensorLabel: this.sensor.sensorLabel,
      };
    } catch {
      return null;
    }
  }
}
