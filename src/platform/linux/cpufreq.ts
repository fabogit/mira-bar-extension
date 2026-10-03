import * as path from 'node:path';
import type { CpuFreqInfo } from '../../types.js';
import { attribute, listDir, type SysfsAttribute } from './sysfs.js';

/** Interval between core scans (only cores exposing cpufreq are read on each tick). */
const REDISCOVERY_INTERVAL_MS = 60_000;

/**
 * Linux CPU frequency scaling provider.
 *
 * Scans `/sys/devices/system/cpu/cpu*` to discover available processor cores and reads
 * their instantaneous clock frequencies from `cpufreq/scaling_cur_freq`.
 * Handles core parking and hotplugging by ignoring offline cores dynamically without sparse holes.
 */
export class CpuFreqProvider {
  private cores: { coreIndex: number; freq: SysfsAttribute }[] = [];
  /** Last discovery time: cores are rescanned once a minute (hotplug; no cpufreq on VMs and containers). */
  private lastDiscoveryAt = 0;

  /**
   * Initializes the provider and performs initial core discovery.
   *
   * @param sysRoot - Root of the sysfs tree (tests pass a mocked tree).
   * @param now - Clock (ms since epoch).
   */
  constructor(
    private readonly sysRoot = '/sys',
    private readonly now: () => number = Date.now,
  ) {
    this.discoverCores();
  }

  /**
   * Scans sysfs to identify logical CPU directories and their frequency control endpoints.
   */
  private discoverCores(): void {
    const basePath = path.join(this.sysRoot, 'devices', 'system', 'cpu');
    this.lastDiscoveryAt = this.now();
    const cores: { coreIndex: number; freq: SysfsAttribute }[] = [];
    for (const entry of listDir(basePath)) {
      const match = /^cpu(\d+)$/.exec(entry);
      if (match && match[1]) {
        // Only cores that expose cpufreq: otherwise every tick would pay a failing read per core.
        const freq = attribute(path.join(basePath, entry, 'cpufreq'), 'scaling_cur_freq');
        if (freq) {
          cores.push({ coreIndex: parseInt(match[1], 10), freq });
        }
      }
    }

    // Sort by core index ascending
    cores.sort((a, b) => a.coreIndex - b.coreIndex);
    this.cores = cores;
  }

  /**
   * Samples current clock frequencies across all active cores.
   *
   * @returns Average, maximum, and per-core clock frequencies in Hertz, or `null` if no cores could be sampled.
   */
  public sample(): CpuFreqInfo | null {
    if (this.now() - this.lastDiscoveryAt >= REDISCOVERY_INTERVAL_MS) {
      this.discoverCores(); // picks up cores brought online since the last scan
    }
    if (this.cores.length === 0) {
      return null;
    }

    const perCoreHz: number[] = [];
    let sumHz = 0;
    let maxHz = 0;
    let activeCoreCount = 0;
    let maxCoreIndex = -1;

    for (const { coreIndex, freq } of this.cores) {
      if (coreIndex > maxCoreIndex) {
        maxCoreIndex = coreIndex;
      }
      // NaN when the core is offline, sleeping, or parked (ENOENT): ignored for this tick
      const khz = freq.readInt();
      if (!isNaN(khz) && khz > 0) {
        const hz = khz * 1000;
        perCoreHz[coreIndex] = hz;
        sumHz += hz;
        if (hz > maxHz) {
          maxHz = hz;
        }
        activeCoreCount++;
      }
    }

    if (activeCoreCount === 0) {
      return null;
    }

    const avgHz = sumHz / activeCoreCount;

    // Default missing or parked cores to 0 Hz to avoid sparse holes
    for (let i = 0; i <= maxCoreIndex; i++) {
      if (perCoreHz[i] === undefined) {
        perCoreHz[i] = 0;
      }
    }

    return {
      avgHz,
      maxHz,
      perCoreHz,
    };
  }
}
