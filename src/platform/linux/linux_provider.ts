import type {
  BatteryInfo,
  CpuTempInfo,
  CpuUsageInfo,
  FreqOrLoadInfo,
  MemoryInfo,
} from '../../types.js';
import type { TelemetryPlatformProvider } from '../interface.js';
import { BatteryProvider } from './battery.js';
import { CpuProvider } from './cpu.js';
import { CpuFreqProvider } from './cpufreq.js';
import { CpuTempProvider } from './cputemp.js';
import { MemoryProvider } from './memory.js';

/**
 * Linux platform telemetry implementation reading from /proc and /sys pseudo-filesystems.
 */
export class LinuxTelemetryProvider implements TelemetryPlatformProvider {
  public readonly platformName = 'linux' as const;

  private cpu = new CpuProvider();
  private freq = new CpuFreqProvider();
  private temp = new CpuTempProvider();
  private lastTemp: CpuTempInfo | null = null;
  private lastTempAt = 0;
  private tempSeq = 0;
  private mem = new MemoryProvider();
  private batt = new BatteryProvider();

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
   * Samples CPU package temperature in degrees Celsius from /sys/class/hwmon/ or thermal zones.
   * Readings younger than `maxAgeMs` are served from cache (the monitor passes half the temperature
   * status bar interval, resmon.statusBarMs.temp), with their age in `ageMs`.
   *
   * @param maxAgeMs - Maximum age of a cached reading (default 0: always read).
   * @returns CpuTempInfo reading and driver name, or `null` if no hwmon sensors exist.
   */
  public sampleTemp(maxAgeMs = 0): CpuTempInfo | null {
    const now = Date.now();
    if (this.lastTempAt !== 0 && now - this.lastTempAt < maxAgeMs) {
      return this.lastTemp ? { ...this.lastTemp, ageMs: now - this.lastTempAt } : null;
    }
    const reading = this.temp.sample();
    this.lastTemp = reading ? { ...reading, sampleSeq: ++this.tempSeq } : null;
    this.lastTempAt = now;
    return this.lastTemp;
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
}
