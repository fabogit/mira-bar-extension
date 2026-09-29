import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Contract describing native C++ functions exposed by the darwin_telemetry.node N-API module.
 */
export interface DarwinNativeAddon {
  /**
   * Copies cumulative 32-bit Mach tick counters of every logical core into `out`, laid out as
   * `out[core * 4 + state]` with state = user (0), system (1), idle (2), nice (3).
   * Allocates nothing on the JS heap.
   *
   * @param out - Destination buffer. If shorter than `cores * 4`, nothing is written.
   * @returns Logical core count (also when `out` is too small), or `0` if the kernel query fails.
   * @throws TypeError if `out` is not a Uint32Array.
   */
  getCpuTicks(out: Uint32Array): number;

  /**
   * Discovers CPU hardware chip model and core topology (P-cores vs E-cores).
   *
   * @returns Hardware model name, total core count, and asymmetric core breakdown.
   */
  getCpuTopology(): { model: string; totalCores: number; pCores: number; eCores: number };

  /**
   * Queries 64-bit Mach VM memory statistics and system swap usage.
   *
   * `pressurePercent` is `100 - kern.memorystatus_level` (-1 if unavailable);
   * `pressureLevel` is `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical (0 if unavailable).
   *
   * @returns Comprehensive RAM page metrics and swap allocations in bytes, or `null` if query fails.
   */
  getMemoryStats(): {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    activeBytes: number;
    wiredBytes: number;
    compressedBytes: number;
    inactiveBytes: number;
    freeBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
    swapFreeBytes: number;
    pressurePercent: number;
    pressureLevel: number;
  } | null;

  /**
   * Queries IOKit power source and AppleSmartBattery registry for capacity, health, and cycles.
   *
   * @returns Battery state, real-time and nominal capacity in mAh, cycle count, and health percentage.
   */
  getBatteryStats(): {
    isAvailable: boolean;
    percent: number;
    status: string;
    timeRemainingMinutes: number;
    isCharging: boolean;
    currentCapacity?: number;
    maxCapacity?: number;
    designCapacity?: number;
    healthPercent?: number;
    cycleCount?: number;
    capacityUnit?: 'mAh' | 'mWh';
  };

  /**
   * Queries unprivileged IOHIDEventSystemClient for SoC die, NAND SSD, and battery temperatures.
   *
   * @returns Synthesized thermal metrics in degrees Celsius, or `null` if sensors are inaccessible.
   */
  getDieTemperature(): {
    tempCelsius: number;
    peakCelsius: number;
    peakSensor: string;
    dieCount: number;
    sensorName: string;
    sensorLabel: string;
    nandCelsius?: number;
    batteryCelsius?: number;
  } | null;
}

let cachedAddon: DarwinNativeAddon | null = null;
let loadAttempted = false;

/**
 * Attempts to dynamically load the compiled darwin_telemetry.node N-API addon.
 * Searches typical installation and distribution directories relative to __dirname only
 * (never process.cwd(), which would load a `.node` from whatever workspace is open).
 *
 * @returns An instance of DarwinNativeAddon if binary is resolved and loaded, otherwise `null`.
 */
export function loadDarwinNativeAddon(): DarwinNativeAddon | null {
  if (loadAttempted) {
    return cachedAddon;
  }
  loadAttempted = true;

  const candidatePaths = [
    path.join(__dirname, 'native/darwin_telemetry.node'),
    path.join(__dirname, '../native/darwin_telemetry.node'),
    path.join(__dirname, '../../dist/native/darwin_telemetry.node'),
    path.join(__dirname, '../../../dist/native/darwin_telemetry.node'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        // Use non-sandboxed require to load compiled .node dynamic library
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        cachedAddon = require(candidate) as DarwinNativeAddon;
        return cachedAddon;
      } catch (err) {
        console.warn(`[Resource Monitor NG] Failed to load native addon at ${candidate}:`, err);
      }
    }
  }

  console.warn('[Resource Monitor NG] darwin_telemetry.node not found; using Node.js fallback providers.');
  return null;
}
