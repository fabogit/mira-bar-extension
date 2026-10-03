import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlatformLogger } from '../interface.js';

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
    swapTotalBytes: number;
    swapUsedBytes: number;
    swapFreeBytes: number;
    pressurePercent: number;
    pressureLevel: number;
  } | null;

  /**
   * Queries IOKit power source and AppleSmartBattery registry for capacity, health, and cycles.
   *
   * `currentCapacity` / `maxCapacity` are the remaining and full-charge capacity (their ratio matches `percent`);
   * `nominalCapacity` is the nominal full-charge capacity used for `healthPercent` when available.
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
    nominalCapacity?: number;
    designCapacity?: number;
    healthPercent?: number;
    cycleCount?: number;
    capacityUnit?: 'mAh' | 'mWh';
  };

  /**
   * Returns the latest SoC die, NAND SSD and battery temperatures from IOHIDEventSystemClient.
   *
   * Sensors are read on a native background thread (~16 ms per pass on an M4): a new pass starts when
   * the latest reading is older than `maxAgeMs`, and its result is returned by a later call (a value can
   * be up to `maxAgeMs` + one call interval old). Only the first call with a non-zero `maxAgeMs` waits,
   * up to 250 ms, for the first pass; every other call returns at once (`null` until a pass completes).
   *
   * @param maxAgeMs - Maximum age of the returned reading before a background refresh is requested
   *   (0: request a pass now, never wait).
   * @returns Synthesized thermal metrics in degrees Celsius, or `null` if sensors are inaccessible.
   * @throws TypeError if `maxAgeMs` is not a number.
   */
  getDieTemperature(maxAgeMs: number): {
    tempCelsius: number;
    peakCelsius: number;
    /** Number of die sensors averaged (smoke test only). */
    dieCount: number;
    nandCelsius?: number;
    batteryCelsius?: number;
    /** Number of the background pass that produced this reading (1, 2, ...): changes with every new reading. */
    sampleSeq: number;
    /** Age of the reading in ms when returned. */
    ageMs: number;
    /** Wall time of that pass in ms (HID IPC included). */
    passWallMs: number;
    /** CPU time of the worker thread for that pass in ms (the HID server's share is not included). */
    passCpuMs: number;
  } | null;
}

/** Functions the addon must export: a build missing any of them is not used. */
const ADDON_FUNCTIONS = [
  'getCpuTicks',
  'getCpuTopology',
  'getMemoryStats',
  'getBatteryStats',
  'getDieTemperature',
] as const satisfies readonly (keyof DarwinNativeAddon)[];

/** Whether a loaded module exports every addon function (their signatures cannot be checked). */
function isDarwinNativeAddon(value: unknown): value is DarwinNativeAddon {
  return typeof value === 'object' && value !== null &&
    ADDON_FUNCTIONS.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

let cachedAddon: DarwinNativeAddon | null = null;
let loadAttempted = false;

/**
 * Attempts to dynamically load the compiled darwin_telemetry.node N-API addon from `native/` next to the
 * bundle (`dist/native/`: __dirname is `dist/`, both in the extension and in the bundled tests), never
 * from process.cwd(), which would load a `.node` from whatever workspace is open.
 * Loaded once per process: later calls return the same result.
 *
 * @param log - Where a missing or unusable addon is reported (the MiraBar output channel).
 * @returns An instance of DarwinNativeAddon if binary is resolved and loaded, otherwise `null`.
 */
export function loadDarwinNativeAddon(log: PlatformLogger): DarwinNativeAddon | null {
  if (loadAttempted) {
    return cachedAddon;
  }
  loadAttempted = true;

  const addonPath = path.join(__dirname, 'native/darwin_telemetry.node');
  if (!fs.existsSync(addonPath)) {
    log.warn(`Native addon not found at ${addonPath}; using the Node.js fallback (no temperature, no battery).`);
    return null;
  }
  try {
    // Use non-sandboxed require to load compiled .node dynamic library
    const addon: unknown = require(addonPath);
    if (!isDarwinNativeAddon(addon)) {
      log.warn(`Native addon at ${addonPath} does not export ${ADDON_FUNCTIONS.join(', ')}; using the Node.js fallback.`);
      return null;
    }
    cachedAddon = addon;
    return cachedAddon;
  } catch (err) {
    log.warn(`Failed to load the native addon at ${addonPath}; using the Node.js fallback: ${describeError(err)}`);
    return null;
  }
}

/** Message of a thrown value, for the log. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
