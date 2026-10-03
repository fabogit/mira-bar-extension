import type {
  BatteryInfo,
  ComponentSensorsMode,
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
   * Optional: starts a background temperature reading without waiting for it, so that the next
   * sampleTemp() returns a fresh value (macOS, where a sensor pass takes ~16-18 ms; Linux, where the
   * SSD, RAM and Wi-Fi sensors take up to ~40 ms and are read asynchronously).
   */
  requestTempRefresh?(): void;

  /**
   * Optional: which component temperature sensors to read (mirabar.temperature.componentSensors).
   * Linux only; on macOS the NAND and battery readings come with the SoC sensor pass and the setting
   * has no effect.
   */
  setComponentSensors?(mode: ComponentSensorsMode): void;

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
