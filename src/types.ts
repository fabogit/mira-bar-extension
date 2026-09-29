/**
 * Supported CPU frequency units for display.
 */
export type FreqUnit = 'GHz' | 'MHz' | 'KHz' | 'Hz';

/**
 * Supported memory units for display.
 */
export type MemUnit = 'GB' | 'MB' | 'KB' | 'B';

/**
 * Supported formatting styles for disk space reporting.
 */
export type DiskSpaceFormat = 'PercentRemaining' | 'PercentUsed' | 'Remaining' | 'UsedOutOfTotal';

/**
 * Represents CPU usage percentage statistics across the entire processor and individual cores.
 */
export interface CpuUsageInfo {
  /**
   * Aggregate CPU load across all active cores, ranging from 0.0 to 100.0.
   */
  overallPercent: number;

  /**
   * Per-core utilization percentages indexed by logical core ID (e.g. core 0 at index 0).
   */
  perCorePercent: number[];

  /**
   * Optional classification for each core (e.g. 'P' for Performance or 'E' for Efficiency).
   */
  coreTypes?: ('P' | 'E')[];
}

/**
 * Represents CPU clock frequency measurements in Hertz.
 */
export interface CpuFreqInfo {
  /**
   * Mean frequency across all active online cores in Hz.
   */
  avgHz: number;

  /**
   * Highest clock frequency recorded among active cores in Hz.
   */
  maxHz: number;

  /**
   * Individual frequency measurements for each core indexed by logical core ID.
   */
  perCoreHz: number[];
}

/**
 * Represents system load average statistics (1m, 5m, 15m) and CPU architecture metadata.
 */
export interface CpuLoadInfo {
  /** 1-minute exponential system load average. */
  load1: number;
  /** 5-minute exponential system load average. */
  load5: number;
  /** 15-minute exponential system load average. */
  load15: number;
  /** Hardware model or brand description (e.g. 'Apple M4'). */
  modelName: string;
  /** Total number of logical cores. */
  totalCores: number;
  /** Number of Performance cores if asymmetric architecture, otherwise 0. */
  pCores: number;
  /** Number of Efficiency cores if asymmetric architecture, otherwise 0. */
  eCores: number;
}

/**
 * Unified representation for either CPU dynamic frequency or system load average.
 */
export type FreqOrLoadInfo =
  | { kind: 'freq'; data: CpuFreqInfo }
  | { kind: 'load'; data: CpuLoadInfo };


/**
 * Represents CPU temperature measurements and hardware sensor identification.
 */
export interface CpuTempInfo {
  /**
   * Temperature reading in degrees Celsius (°C) (die average on multi-sensor SoC).
   */
  tempCelsius: number;

  /**
   * Kernel driver or subsystem name (e.g. 'k10temp', 'coretemp', 'acpi', 'Apple Silicon Die').
   */
  sensorName: string;

  /**
   * Label descriptor associated with the reading (e.g. 'Tctl', 'Tccd1', 'Package id 0').
   */
  sensorLabel: string;

  /** Peak die temperature recorded across all die thermal sensors in °C. */
  peakCelsius?: number;

  /** Identifier of the hottest die sensor (e.g. 'PMU tdie6'). */
  peakSensor?: string;

  /** Total number of silicon die thermal zones aggregated. */
  dieCount?: number;

  /** Temperature of the NAND flash storage controller in °C (if available). */
  nandCelsius?: number;

  /** Temperature of the battery cell in °C (if available). */
  batteryCelsius?: number;
}

/**
 * Represents system physical memory (RAM) and swap space metrics in bytes.
 */
export interface MemoryInfo {
  /**
   * Total physical RAM installed in bytes.
   */
  totalBytes: number;

  /**
   * Estimated memory available for starting new applications without swapping, in bytes.
   */
  availableBytes: number;

  /**
   * Memory actively used by applications and kernel allocations in bytes.
   */
  usedBytes: number;

  /**
   * Memory utilization percentage relative to totalBytes, ranging from 0.0 to 100.0.
   */
  usedPercent: number;

  /**
   * Total swap partition/file capacity in bytes.
   */
  swapTotalBytes: number;

  /**
   * Unused swap space in bytes.
   */
  swapFreeBytes: number;

  /**
   * Actively consumed swap space in bytes.
   */
  swapUsedBytes: number;

  /**
   * Swap utilization percentage relative to swapTotalBytes, ranging from 0.0 to 100.0.
   */
  swapUsedPercent: number;

  /**
   * Memory occupied by active application processes (optional, platform-specific).
   */
  activeBytes?: number;

  /**
   * Wired memory that cannot be paged out to disk (e.g. kernel, drivers; optional).
   */
  wiredBytes?: number;

  /**
   * Memory compressed by the kernel virtual memory compressor (optional).
   */
  compressedBytes?: number;

  /**
   * Inactive/cached memory reclaimable by the system (optional).
   */
  inactiveBytes?: number;

  /**
   * Memory pressure in percent (0..100; Darwin: 100 - kern.memorystatus_level; optional).
   */
  pressurePercent?: number;

  /**
   * Kernel memory pressure state (optional; Darwin: kern.memorystatus_vm_pressure_level).
   */
  pressureLevel?: 'Normal' | 'Warning' | 'Critical';
}

/**
 * Represents storage capacity and utilization metrics for a mounted filesystem.
 */
export interface DiskDriveInfo {
  /**
   * Filesystem mount point path (e.g. '/', '/home').
   */
  mountPath: string;

  /**
   * Total storage capacity in bytes.
   */
  totalBytes: number;

  /**
   * Storage space available to unprivileged processes in bytes.
   */
  freeBytes: number;

  /**
   * Storage space currently occupied in bytes.
   */
  usedBytes: number;

  /**
   * Percentage of storage space used, ranging from 0.0 to 100.0.
   */
  usedPercent: number;

  /**
   * Percentage of storage space free, ranging from 0.0 to 100.0.
   */
  freePercent: number;
}

/**
 * Represents battery charge state and status information.
 */
export interface BatteryInfo {
  /**
   * Remaining charge level expressed as an integer percentage from 0 to 100.
   */
  percent: number;

  /**
   * Power supply state reported by kernel (e.g. 'Charging', 'Discharging', 'Full').
   */
  status: string;

  /**
   * Estimated minutes until empty (when discharging) or full (when charging). -1 if calculating.
   */
  timeRemainingMinutes?: number;

  /**
   * Whether the battery is currently drawing charging current.
   */
  isCharging?: boolean;

  /**
   * Current residual capacity in mAh or mWh.
   */
  currentCapacity?: number;

  /**
   * Maximum full charge capacity in mAh or mWh.
   */
  maxCapacity?: number;

  /**
   * Factory nominal design capacity in mAh or mWh.
   */
  designCapacity?: number;

  /**
   * Battery health percentage: min(100, (maxCapacity / designCapacity) * 100).
   */
  healthPercent?: number;

  /**
   * Number of completed full charge/discharge cycles.
   */
  cycleCount?: number;

  /**
   * Capacity measurement unit ('mAh' or 'mWh').
   */
  capacityUnit?: 'mAh' | 'mWh';
}
