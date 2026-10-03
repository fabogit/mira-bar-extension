import type {
  BatteryInfo,
  ComponentSensorsMode,
  CpuTempInfo,
  CpuUsageInfo,
  FreqOrLoadInfo,
  MemoryInfo,
} from '../../types.js';
import type { TelemetryPlatformProvider } from '../interface.js';
import { BatteryProvider } from './battery.js';
import { ComponentTempProvider } from './components.js';
import { CpuProvider } from './cpu.js';
import { CpuFreqProvider } from './cpufreq.js';
import { CpuTempProvider } from './cputemp.js';
import { MemoryProvider } from './memory.js';

/** Component readings older than this many temperature intervals are not shown (stuck device). */
const COMPONENT_STALE_INTERVALS = 3;
const COMPONENT_STALE_MIN_MS = 5000;

/** Where the Linux provider reads from (tests pass mocked trees and a driven clock). */
export interface LinuxProviderOptions {
  /** Root of the sysfs tree (default `/sys`). */
  sysRoot?: string;
  /** Root of the procfs tree (default `/proc`). */
  procRoot?: string;
  /** Clock (ms since epoch, default `Date.now`). */
  now?: () => number;
}

/**
 * Linux platform telemetry implementation reading from /proc and /sys pseudo-filesystems.
 */
export class LinuxTelemetryProvider implements TelemetryPlatformProvider {
  public readonly platformName = 'linux' as const;

  private readonly now: () => number;
  private readonly cpu: CpuProvider;
  private readonly freq: CpuFreqProvider;
  private readonly temp: CpuTempProvider;
  private readonly components: ComponentTempProvider;
  private readonly mem: MemoryProvider;
  private readonly batt: BatteryProvider;

  constructor({ sysRoot = '/sys', procRoot = '/proc', now = Date.now }: LinuxProviderOptions = {}) {
    this.now = now;
    this.cpu = new CpuProvider(procRoot);
    this.freq = new CpuFreqProvider(sysRoot, now);
    this.temp = new CpuTempProvider(sysRoot, now);
    this.components = new ComponentTempProvider(sysRoot, now);
    this.mem = new MemoryProvider(procRoot);
    this.batt = new BatteryProvider(sysRoot, now);
  }

  /**
   * Samples active CPU utilization across overall system and individual logical cores from /proc/stat.
   *
   * @returns Comprehensive CPU usage percentages, or `null` if /proc/stat is unreadable.
   */
  public sampleCpu(): CpuUsageInfo | null {
    return this.cpu.sample();
  }

  /**
   * Samples dynamic CPU clock frequency scaling from /sys/devices/system/cpu/cpu* endpoints.
   *
   * @returns FreqOrLoadInfo with kind 'freq', or `null` if cpufreq nodes are unavailable.
   */
  public sampleFreqOrLoad(): FreqOrLoadInfo | null {
    const freq = this.freq.sample();
    if (!freq) {
      return null;
    }
    return { kind: 'freq', data: freq };
  }

  /**
   * Starts an asynchronous pass over the component sensors (SSD, RAM, Wi-Fi, battery) without waiting
   * for it. The monitor calls it shortly before a temperature read, so that read shows fresh values.
   */
  public requestTempRefresh(): void {
    void this.components.refresh();
  }

  /**
   * Applies mirabar.temperature.componentSensors: 'awake' skips runtime-suspended devices, 'always'
   * reads every sensor, 'off' reads none (the CPU sensor only). Takes effect at the next pass.
   */
  public setComponentSensors(mode: ComponentSensorsMode): void {
    this.components.setMode(mode);
  }

  /**
   * Samples CPU package temperature in degrees Celsius from /sys/class/hwmon/ or thermal zones, with
   * the latest component readings (read asynchronously by requestTempRefresh) in `sensors`.
   * CPU readings younger than `maxAgeMs` are served from cache (the monitor passes half the temperature
   * status bar interval, mirabar.statusBarMs.temp), with their age in `ageMs`.
   *
   * @param maxAgeMs - Maximum age of a cached reading (0: always read).
   * @returns CpuTempInfo reading and driver name, or `null` if no hwmon sensors exist.
   */
  public sampleTemp(maxAgeMs: number): CpuTempInfo | null {
    const now = this.now();
    const result = this.temp.cached(maxAgeMs, now);
    if (!result) {
      return null;
    }
    const components = this.components.latest();
    if (!this.components.busy && (!components || now - components.at > maxAgeMs)) {
      void this.components.refresh(); // not requested ahead (first read, click, short interval): next read
    }
    const staleMs = Math.max(COMPONENT_STALE_MIN_MS, COMPONENT_STALE_INTERVALS * 2 * maxAgeMs);
    if (components && components.sensors.length > 0 && now - components.at <= staleMs) {
      result.sensors = components.sensors;
    }
    return result;
  }

  /**
   * Samples RAM and swap utilization statistics from /proc/meminfo.
   *
   * @returns MemoryInfo containing total, available, and used memory in bytes and percentages.
   */
  public sampleMemory(): MemoryInfo | null {
    return this.mem.sample();
  }

  /**
   * Samples battery state, capacity, and cycles from /sys/class/power_supply/BAT*.
   *
   * @returns BatteryInfo telemetry object, or `null` if host has no battery hardware.
   */
  public sampleBattery(): BatteryInfo | null {
    return this.batt.sample();
  }

  /**
   * Checks whether at least one power supply battery node exists on this system.
   *
   * @returns `true` if laptop battery exists, `false` on desktop workstations and servers.
   */
  public isBatteryAvailable(): boolean {
    return this.batt.isAvailable;
  }

  /** Closes the sysfs files kept open between reads (cpufreq, CPU sensor, battery). */
  public dispose(): void {
    this.freq.dispose();
    this.temp.dispose();
    this.batt.dispose();
  }
}
