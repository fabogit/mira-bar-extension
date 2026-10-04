import * as path from 'node:path';
import type { CpuFreqInfo } from '../../types.js';
import { attribute, closeDropped, listDir, realpath, type SysfsAttribute } from './sysfs.js';

/** Interval between core scans (only cores exposing cpufreq are read on each tick). */
const REDISCOVERY_INTERVAL_MS = 60_000;

/**
 * Linux CPU frequency scaling provider.
 *
 * Scans `/sys/devices/system/cpu/cpu*` to discover available processor cores and reads
 * their instantaneous clock frequencies from `scaling_cur_freq` of their cpufreq policy.
 * Handles core parking and hotplugging by ignoring offline cores dynamically without sparse holes.
 */
export class CpuFreqProvider {
  /** One entry per cpufreq policy, with the cores it drives. */
  private policies: { coreIndexes: number[]; freq: SysfsAttribute }[] = [];
  private maxCoreIndex = -1;
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
   * Scans sysfs to identify logical CPU directories and their frequency policies. `cpuN/cpufreq` links
   * to the core's policy (`cpufreq/policyM`); cores sharing a policy (clusters) share one reading, so
   * `scaling_cur_freq` is read once per policy.
   */
  private discoverCores(): void {
    const basePath = path.join(this.sysRoot, 'devices', 'system', 'cpu');
    this.lastDiscoveryAt = this.now();
    const previous = this.policies;
    const reuse = new Map(previous.map((p) => [p.freq.file, p.freq]));
    const byPolicy = new Map<string, { coreIndexes: number[]; freq: SysfsAttribute }>();
    let maxCoreIndex = -1;
    for (const entry of listDir(basePath)) {
      const match = /^cpu(\d+)$/.exec(entry);
      if (match && match[1]) {
        const policyDir = realpath(path.join(basePath, entry, 'cpufreq'));
        if (policyDir === null) {
          continue;
        }
        const coreIndex = parseInt(match[1], 10);
        const policy = byPolicy.get(policyDir);
        if (policy) {
          policy.coreIndexes.push(coreIndex);
        } else {
          // Only cores that expose cpufreq: otherwise every tick would pay a failing read per core.
          const freq = attribute(policyDir, 'scaling_cur_freq', reuse);
          if (!freq) {
            continue;
          }
          byPolicy.set(policyDir, { coreIndexes: [coreIndex], freq });
        }
        maxCoreIndex = Math.max(maxCoreIndex, coreIndex);
      }
    }

    this.policies = [...byPolicy.values()];
    this.maxCoreIndex = maxCoreIndex;
    closeDropped(previous.map((p) => p.freq), this.policies.map((p) => p.freq));
  }

  /** Closes the open cpufreq files. */
  public dispose(): void {
    closeDropped(this.policies.map((p) => p.freq), []);
    this.policies = [];
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
    if (this.policies.length === 0) {
      return null;
    }

    const perCoreHz: number[] = [];
    let sumHz = 0;
    let maxHz = 0;
    let activeCoreCount = 0;
    const maxCoreIndex = this.maxCoreIndex;

    for (const { coreIndexes, freq } of this.policies) {
      // NaN when the cores are offline, sleeping, or parked (ENOENT): ignored for this tick
      const khz = freq.readInt();
      if (!isNaN(khz) && khz > 0) {
        const hz = khz * 1000;
        for (const coreIndex of coreIndexes) {
          perCoreHz[coreIndex] = hz;
        }
        sumHz += hz * coreIndexes.length;
        if (hz > maxHz) {
          maxHz = hz;
        }
        activeCoreCount += coreIndexes.length;
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
