import * as os from 'node:os';
import type {
  BatteryInfo,
  CpuTempInfo,
  CpuUsageInfo,
  FreqOrLoadInfo,
  MemoryInfo,
} from '../../types.js';
import type { TelemetryPlatformProvider } from '../interface.js';
import { loadDarwinNativeAddon, type DarwinNativeAddon } from './native_loader.js';

interface CoreTicks {
  user: number;
  system: number;
  idle: number;
  nice: number;
}

/** Counters per core in the native tick buffer: user, system, idle, nice (processor_cpu_load_info order). */
const TICK_STATES = 4;

/**
 * Minimum ticks per core between two CPU samples (~50 ms at the 100 Hz Mach tick rate).
 * Closer samples (activation, forced refresh right after a tick) would read 0% or 100% per core,
 * so they return the previous result and keep accumulating the baseline instead.
 */
const MIN_TICKS_PER_CORE = 5;

/**
 * Default age of a temperature reading. A full HID pass costs ~16 ms of IPC on an M4 and runs on a native
 * background thread: every 5 s it is ~0.3% of one core. The 2 s minimum is enforced by config.ts.
 */
const TEMP_MAX_AGE_MS = 5_000;

/** How often a missing battery is re-probed (desktop Macs never gain one; laptops may fail transiently). */
const BATTERY_RECHECK_MS = 60_000;

const PRESSURE_LEVELS: Record<number, MemoryInfo['pressureLevel']> = {
  1: 'Normal',
  2: 'Warning',
  4: 'Critical',
};

/**
 * macOS Apple Silicon (M-Series) telemetry provider.
 *
 * Utilizes the native C++ N-API addon (Mach, sysctl, IOKit, IOHID) for zero-subprocess
 * hardware sampling, with graceful fallback to standard Node.js runtime APIs.
 */
export class DarwinTelemetryProvider implements TelemetryPlatformProvider {
  public readonly platformName = 'darwin' as const;

  private nativeAddon: DarwinNativeAddon | null;
  private topology: { model: string; totalCores: number; pCores: number; eCores: number };
  private lastCpuResult: CpuUsageInfo = { overallPercent: 0, perCorePercent: [] };

  /** Core architecture per logical core, computed once (E-cores are indexed first on Apple Silicon). */
  private readonly coreTypes: ('P' | 'E')[] | undefined;

  /** Double-buffered native tick counters: swapped every sample, never reallocated unless cores change. */
  private curTicks = new Uint32Array(0);
  private prevTicks = new Uint32Array(0);
  private prevCoreCount = 0;

  /** Previous os.cpus() sample, used only when the native addon is unavailable. */
  private prevFallbackTicks: CoreTicks[] | null = null;

  private batteryPresent = false;
  private batteryRecheckAt = 0;

  constructor() {
    this.nativeAddon = loadDarwinNativeAddon();
    if (this.nativeAddon) {
      this.topology = this.nativeAddon.getCpuTopology();
      const coreTypes: ('P' | 'E')[] = [];
      for (let i = 0; i < this.topology.totalCores; i++) {
        if (this.topology.eCores > 0 && i < this.topology.eCores) {
          coreTypes.push('E');
        } else if (this.topology.pCores > 0) {
          coreTypes.push('P');
        }
      }
      this.coreTypes = coreTypes.length > 0 ? coreTypes : undefined;
      this.lastCpuResult = {
        overallPercent: 0,
        perCorePercent: new Array<number>(this.topology.totalCores).fill(0),
        coreTypes: this.coreTypes,
      };
      // Prime the tick baseline so the first real sample already has a delta.
      const cores = this.readNativeTicks(this.nativeAddon);
      if (cores > 0) {
        this.swapTickBuffers(cores);
      }
      this.batteryPresent = this.nativeAddon.getBatteryStats().isAvailable;
      this.batteryRecheckAt = Date.now() + BATTERY_RECHECK_MS;
    } else {
      const cpus = os.cpus();
      this.topology = {
        model: cpus[0]?.model || 'Apple Silicon',
        totalCores: cpus.length,
        pCores: 0,
        eCores: 0,
      };
      this.coreTypes = undefined;
      this.prevFallbackTicks = cpus.map((c) => ({
        user: c.times.user,
        system: c.times.sys,
        idle: c.times.idle,
        nice: c.times.nice,
      }));
      this.lastCpuResult = {
        overallPercent: 0,
        perCorePercent: new Array<number>(this.topology.totalCores).fill(0),
      };
    }
  }

  /**
   * Reads native tick counters into `curTicks`, growing both buffers if the core count exceeds them.
   *
   * @returns Logical core count, or 0 if the kernel query failed.
   */
  private readNativeTicks(addon: DarwinNativeAddon): number {
    let cores = addon.getCpuTicks(this.curTicks);
    if (cores * TICK_STATES > this.curTicks.length) {
      this.curTicks = new Uint32Array(cores * TICK_STATES);
      this.prevTicks = new Uint32Array(cores * TICK_STATES);
      this.prevCoreCount = 0;
      cores = addon.getCpuTicks(this.curTicks);
    }
    return cores;
  }

  /** Makes the sample just read the baseline for the next one, without copying. */
  private swapTickBuffers(cores: number): void {
    const previous = this.prevTicks;
    this.prevTicks = this.curTicks;
    this.curTicks = previous;
    this.prevCoreCount = cores;
  }

  /**
   * Generates a descriptive string of the hardware chip and core topology.
   *
   * @returns Formatted topology string (e.g. 'Apple M4 (4P + 6E)').
   */
  public getTopologyDescription(): string {
    if (this.topology.pCores > 0 || this.topology.eCores > 0) {
      return `${this.topology.model} (${this.topology.pCores}P + ${this.topology.eCores}E)`;
    }
    return `${this.topology.model} (${this.topology.totalCores} cores)`;
  }

  /**
   * Samples active CPU utilization across all cores using Mach processor tick counters.
   *
   * @returns Comprehensive CPU load and per-core breakdown, or `null` if sampling fails.
   */
  public sampleCpu(): CpuUsageInfo | null {
    if (this.nativeAddon) {
      const cores = this.readNativeTicks(this.nativeAddon);
      if (cores === 0) {
        // Transient kernel failure: keep the last native result (with core types) rather than
        // mixing in an os.cpus() delta against a stale baseline.
        return this.lastCpuResult;
      }

      if (cores !== this.prevCoreCount) {
        this.swapTickBuffers(cores);
        return this.lastCpuResult;
      }

      const cur = this.curTicks;
      const prev = this.prevTicks;
      let totalActiveDelta = 0;
      let totalAllDelta = 0;
      const perCorePercent = new Array<number>(cores);

      for (let i = 0; i < cores; i++) {
        const base = i * TICK_STATES;
        // Mach counters are 32-bit and wrap: `>>> 0` yields the correct modular delta.
        const uDelta = (cur[base]! - prev[base]!) >>> 0;
        const sDelta = (cur[base + 1]! - prev[base + 1]!) >>> 0;
        const iDelta = (cur[base + 2]! - prev[base + 2]!) >>> 0;
        const nDelta = (cur[base + 3]! - prev[base + 3]!) >>> 0;

        const activeDelta = uDelta + sDelta + nDelta;
        const coreTotalDelta = activeDelta + iDelta;

        totalActiveDelta += activeDelta;
        totalAllDelta += coreTotalDelta;

        perCorePercent[i] = coreTotalDelta > 0
          ? Math.max(0, Math.min(100, (activeDelta / coreTotalDelta) * 100))
          : 0;
      }

      if (totalAllDelta < cores * MIN_TICKS_PER_CORE) {
        // Too close to the previous sample: keep the baseline, do not swap.
        return this.lastCpuResult;
      }

      this.swapTickBuffers(cores);

      // totalAllDelta > 0 is guaranteed by the minimum-ticks guard above.
      const overallPercent = Math.max(0, Math.min(100, (totalActiveDelta / totalAllDelta) * 100));

      this.lastCpuResult = {
        overallPercent,
        perCorePercent,
        coreTypes: this.coreTypes,
      };

      return this.lastCpuResult;
    }

    return this.sampleCpuFallback();
  }

  /**
   * Fallback CPU utilization sampling using Node.js os.cpus() when native addon is unavailable.
   *
   * @returns CPU utilization metrics calculated from os.cpus() tick deltas, or `null` if unreadable.
   */
  private sampleCpuFallback(): CpuUsageInfo | null {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) {
      return null;
    }

    const currentTicks: CoreTicks[] = cpus.map((c) => ({
      user: c.times.user,
      system: c.times.sys,
      idle: c.times.idle,
      nice: c.times.nice,
    }));

    if (!this.prevFallbackTicks || this.prevFallbackTicks.length !== currentTicks.length) {
      this.prevFallbackTicks = currentTicks;
      return this.lastCpuResult;
    }

    let totalActiveDelta = 0;
    let totalAllDelta = 0;
    const perCorePercent: number[] = [];

    for (let i = 0; i < currentTicks.length; i++) {
      const cur = currentTicks[i]!;
      const prev = this.prevFallbackTicks[i]!;

      const activeDelta = Math.max(0, (cur.user - prev.user) + (cur.system - prev.system) + (cur.nice - prev.nice));
      const idleDelta = Math.max(0, cur.idle - prev.idle);
      const coreTotal = activeDelta + idleDelta;

      totalActiveDelta += activeDelta;
      totalAllDelta += coreTotal;

      const coreUsage = coreTotal > 0 ? Math.max(0, Math.min(100, (activeDelta / coreTotal) * 100)) : 0;
      perCorePercent.push(coreUsage);
    }

    this.prevFallbackTicks = currentTicks;

    let overallPercent = this.lastCpuResult.overallPercent;
    if (totalAllDelta > 0) {
      overallPercent = Math.max(0, Math.min(100, (totalActiveDelta / totalAllDelta) * 100));
    }

    this.lastCpuResult = {
      overallPercent,
      perCorePercent,
    };

    return this.lastCpuResult;
  }

  /**
   * Samples the System Load Average (1m, 5m, 15m) alongside Apple Silicon hardware core topology.
   *
   * On Apple Silicon, hardware frequency scaling is autonomous and restricted to root;
   * this method provides normalized workload capacity across available CPU cores.
   *
   * @returns System load average statistics and core topology metadata.
   */
  public sampleFreqOrLoad(): FreqOrLoadInfo | null {
    const loads = os.loadavg();
    return {
      kind: 'load',
      data: {
        load1: loads[0] ?? 0,
        load5: loads[1] ?? 0,
        load15: loads[2] ?? 0,
        modelName: this.topology.model,
        totalCores: this.topology.totalCores,
        pCores: this.topology.pCores,
        eCores: this.topology.eCores,
      },
    };
  }

  /**
   * Samples Apple Silicon SoC die, NAND flash, and battery temperatures via IOHIDEventSystemClient.
   * Non-blocking: returns the latest background reading. A stale call starts a new pass and still returns
   * the previous reading, so a value can be up to `maxAgeMs` plus one call interval (one tick) old.
   *
   * @param maxAgeMs - Age after which a background refresh is requested (default 5 s).
   * @returns Synthesized thermal metrics in degrees Celsius, or `null` if unprivileged HID is unavailable.
   */
  public sampleTemp(maxAgeMs = TEMP_MAX_AGE_MS): CpuTempInfo | null {
    if (this.nativeAddon) {
      return this.nativeAddon.getDieTemperature(maxAgeMs);
    }
    return null;
  }

  /**
   * Samples 64-bit Mach VM memory metrics (wired, active, compressed pages) and vm.swapusage.
   *
   * @returns Comprehensive RAM and swap utilization statistics, or `null` if query fails.
   */
  public sampleMemory(): MemoryInfo | null {
    if (this.nativeAddon) {
      const stats = this.nativeAddon.getMemoryStats();
      if (stats && stats.totalBytes > 0) {
        const usedPercent = (stats.usedBytes / stats.totalBytes) * 100;
        const swapUsedPercent = stats.swapTotalBytes > 0
          ? (stats.swapUsedBytes / stats.swapTotalBytes) * 100
          : 0;

        return {
          totalBytes: stats.totalBytes,
          availableBytes: stats.availableBytes,
          usedBytes: stats.usedBytes,
          usedPercent,
          swapTotalBytes: stats.swapTotalBytes,
          swapFreeBytes: stats.swapFreeBytes,
          swapUsedBytes: stats.swapUsedBytes,
          swapUsedPercent,
          activeBytes: stats.activeBytes,
          wiredBytes: stats.wiredBytes,
          compressedBytes: stats.compressedBytes,
          inactiveBytes: stats.inactiveBytes,
          pressurePercent: stats.pressurePercent >= 0 ? stats.pressurePercent : undefined,
          pressureLevel: PRESSURE_LEVELS[stats.pressureLevel],
        };
      }
    }

    // Fallback using os module
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    return {
      totalBytes,
      availableBytes: freeBytes,
      usedBytes,
      usedPercent,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
      swapUsedBytes: 0,
      swapUsedPercent: 0,
    };
  }

  /**
   * Samples battery state, residual charge in mAh, nominal design capacity, cycles, and calibrated health.
   *
   * @returns BatteryInfo telemetry object, or `null` if running on a desktop Mac without a battery.
   */
  public sampleBattery(): BatteryInfo | null {
    if (this.nativeAddon) {
      const batt = this.nativeAddon.getBatteryStats();
      this.batteryPresent = batt.isAvailable;
      if (batt.isAvailable) {
        return {
          percent: batt.percent,
          status: batt.status,
          timeRemainingMinutes: batt.timeRemainingMinutes,
          isCharging: batt.isCharging,
          currentCapacity: batt.currentCapacity,
          maxCapacity: batt.maxCapacity,
          nominalCapacity: batt.nominalCapacity,
          designCapacity: batt.designCapacity,
          healthPercent: batt.healthPercent,
          cycleCount: batt.cycleCount,
          capacityUnit: batt.capacityUnit,
        };
      }
    }
    return null;
  }

  /**
   * Checks whether battery hardware is present, without querying IOKit on every tick.
   *
   * The result is cached; a missing battery is re-probed at most every BATTERY_RECHECK_MS.
   *
   * @returns `true` if battery is detected, `false` on desktop Macs (Mac mini, Mac Studio, Mac Pro).
   */
  public isBatteryAvailable(): boolean {
    if (!this.nativeAddon || this.batteryPresent) {
      return this.batteryPresent;
    }
    const now = Date.now();
    if (now >= this.batteryRecheckAt) {
      this.batteryRecheckAt = now + BATTERY_RECHECK_MS;
      this.batteryPresent = this.nativeAddon.getBatteryStats().isAvailable;
    }
    return this.batteryPresent;
  }
}
