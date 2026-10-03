import * as path from 'node:path';
import type { CpuTempInfo } from '../../types.js';
import { exists, listDir, plausibleLimit, readInt, readText, SysfsAttribute } from './sysfs.js';

/** Interval between sensor scans while none was found (hwmon driver loaded after activation). */
const REDISCOVERY_INTERVAL_MS = 60_000;

/**
 * Internal metadata descriptor for an identified hardware thermal sensor.
 */
interface DiscoveredSensor {
  /** The temperature input file (e.g. `.../temp1_input`), in m°C. */
  readonly input: SysfsAttribute;
  /** Driver or subsystem identifier (e.g. `k10temp`, `coretemp`, `acpi`). */
  readonly sensorName: string;
  /** Descriptive label associated with the sensor node (e.g. `Tctl`, `Tccd1`). */
  readonly sensorLabel: string;
  /** Critical trip point in °C (`temp*_crit`, else `temp*_max`; thermal zone `critical` trip), if exposed. */
  readonly critCelsius?: number;
}

/**
 * Hardware-adaptive thermal sensor provider for Linux systems.
 *
 * Implements a heuristic discovery mechanism that checks `/sys/class/hwmon`
 * with prioritized support for AMD Zen/Ryzen architectures (`k10temp`, `zenpower`)
 * and Intel platforms (`coretemp`), with fallback to generic ACPI thermal zones.
 * While no sensor is found, the scan is repeated at most once a minute.
 */
export class CpuTempProvider {
  private sensor: DiscoveredSensor | null = null;
  private lastDiscoveryAt = 0;
  /** Cache of {@link cached}: the latest reading with its sequence number, and when it was read. */
  private last: CpuTempInfo | null = null;
  private lastAt = 0;
  private seq = 0;

  /**
   * Initializes the provider and triggers initial sensor discovery.
   *
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   * @param now - Clock (ms since epoch).
   */
  constructor(
    private readonly sysRoot = '/sys',
    private readonly now: () => number = Date.now,
  ) {
    this.discoverSensor();
  }

  /**
   * Scans hwmon and thermal zone directories to locate the primary CPU die sensor.
   */
  private discoverSensor(): void {
    this.lastDiscoveryAt = this.now();
    const hwmonBase = path.join(this.sysRoot, 'class', 'hwmon');

    let amdSensor: DiscoveredSensor | null = null;
    let intelSensor: DiscoveredSensor | null = null;
    let genericHwmonSensor: DiscoveredSensor | null = null;

    for (const dir of listDir(hwmonBase)) {
      const dirPath = path.join(hwmonBase, dir);
      const name = readText(path.join(dirPath, 'name'))?.toLowerCase();
      if (name === undefined) {
        continue;
      }

      const found = findTempInHwmon(dirPath, name);
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

    // Fallback: /sys/class/thermal/thermal_zone0/temp
    const zoneDir = path.join(this.sysRoot, 'class', 'thermal', 'thermal_zone0');
    const thermalZonePath = path.join(zoneDir, 'temp');
    if (exists(thermalZonePath)) {
      this.sensor = {
        input: new SysfsAttribute(thermalZonePath),
        sensorName: 'acpi',
        sensorLabel: 'thermal_zone0',
        critCelsius: criticalTripPoint(zoneDir),
      };
    }
  }

  /** Closes the open sensor file. */
  public dispose(): void {
    this.sensor?.input.close();
    this.sensor = null;
  }

  /**
   * Reads and parses the current temperature from the discovered sensor file.
   *
   * @returns Temperature metrics including value in °C, sensor name, and label, or `null` if reading fails.
   */
  public sample(): CpuTempInfo | null {
    if (!this.sensor) {
      if (this.now() - this.lastDiscoveryAt >= REDISCOVERY_INTERVAL_MS) {
        this.discoverSensor(); // picks up a driver loaded since the last scan
      }
      if (!this.sensor) {
        return null;
      }
    }

    const milliC = this.sensor.input.readInt();
    if (isNaN(milliC) || milliC <= 0) {
      return null;
    }

    return {
      tempCelsius: milliC / 1000,
      sensorName: this.sensor.sensorName,
      sensorLabel: this.sensor.sensorLabel,
      critCelsius: this.sensor.critCelsius,
    };
  }

  /**
   * The latest reading, read again when it is older than `maxAgeMs`. Each new reading gets the next
   * `sampleSeq`; a reading served from cache carries its age in `ageMs`.
   *
   * @param maxAgeMs - Maximum age of a cached reading (0: always read).
   * @param now - Time of the request (ms since epoch), from this provider's clock by default.
   * @returns A copy of the reading, or `null` if the latest read found no sensor or failed.
   */
  public cached(maxAgeMs: number, now = this.now()): CpuTempInfo | null {
    if (this.lastAt === 0 || now - this.lastAt >= maxAgeMs) {
      const reading = this.sample();
      this.last = reading ? { ...reading, sampleSeq: ++this.seq } : null;
      this.lastAt = now;
    }
    if (!this.last) {
      return null;
    }
    const result: CpuTempInfo = { ...this.last };
    if (now !== this.lastAt) {
      result.ageMs = now - this.lastAt;
    }
    return result;
  }
}

/**
 * Evaluates a single hwmon directory to find the most appropriate temperature input file.
 *
 * @param dirPath - Path to the `hwmon*` directory.
 * @param sensorName - Cleaned name string from `name` file.
 * @returns Discovered sensor metadata or `null` if no valid input files exist.
 */
function findTempInHwmon(dirPath: string, sensorName: string): DiscoveredSensor | null {
  // Prefer temp1_input (typically Tctl for AMD or Package ID for Intel)
  const inputFiles = listDir(dirPath).filter((f: string) => /^temp\d+_input$/.test(f)).sort();

  if (inputFiles.length === 0) {
    return null;
  }

  const targetFile = inputFiles.includes('temp1_input') ? 'temp1_input' : inputFiles[0]!;

  // Read label if present (e.g. temp1_label); the label file is optional
  const rawLabel = readText(path.join(dirPath, targetFile.replace('_input', '_label')));

  return {
    input: new SysfsAttribute(path.join(dirPath, targetFile)),
    sensorName,
    sensorLabel: rawLabel || targetFile,
    critCelsius: readLimit(path.join(dirPath, targetFile.replace('_input', '_crit')))
      ?? readLimit(path.join(dirPath, targetFile.replace('_input', '_max'))),
  };
}

/** A limit file in m°C as °C, or undefined when missing or implausible. */
function readLimit(file: string): number | undefined {
  return plausibleLimit(readInt(file), 1000);
}

/** The `critical` trip point of a thermal zone in °C, if any. */
function criticalTripPoint(zoneDir: string): number | undefined {
  for (const file of listDir(zoneDir)) {
    const match = /^trip_point_(\d+)_type$/.exec(file);
    if (match && readText(path.join(zoneDir, file)) === 'critical') {
      return readLimit(path.join(zoneDir, `trip_point_${match[1]}_temp`));
    }
  }
  return undefined;
}
