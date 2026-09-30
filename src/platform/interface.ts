import type {
  BatteryInfo,
  CpuTempInfo,
  CpuUsageInfo,
  FreqOrLoadInfo,
  MemoryInfo,
} from '../types.js';

/**
 * Universal contract for operating-system and architecture-specific telemetry providers.
 */
export interface TelemetryPlatformProvider {
  /** Identifier of the active platform target (e.g. 'darwin' or 'linux'). */
  readonly platformName: 'darwin' | 'linux' | 'win32';

  /**
   * Samples active CPU utilization percentages across overall processor and logical cores.
   */
  sampleCpu(): CpuUsageInfo | null;

  /**
   * Samples either dynamic CPU clock frequency (Linux) or system load average (Darwin Apple Silicon).
   */
  sampleFreqOrLoad(): FreqOrLoadInfo | null;

  /**
   * Samples CPU / SoC die temperature in degrees Celsius.
   */
  sampleTemp(maxAgeMs?: number): CpuTempInfo | null;

  /**
   * Samples system physical memory (RAM) and swap metrics.
   */
  sampleMemory(): MemoryInfo | null;

  /**
   * Samples battery charge status and remaining percentage.
   */
  sampleBattery(): BatteryInfo | null;

  /**
   * Returns whether battery hardware exists and is available for polling.
   */
  isBatteryAvailable(): boolean;

  /**
   * Optional platform-specific architecture topology description (e.g. 'Apple M4 (4P + 6E)').
   */
  getTopologyDescription?(): string;
}
