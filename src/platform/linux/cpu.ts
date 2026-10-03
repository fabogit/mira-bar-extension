import * as fs from 'node:fs';
import type { CpuUsageInfo } from '../../types.js';

/**
 * Internal snapshot of cumulative ticks used for computing delta load.
 */
interface CoreStat {
  /** Sum of all ticks (user + nice + system + idle + iowait + irq + softirq + steal). */
  total: number;
  /** Inactive ticks (idle + iowait). */
  idle: number;
}

/**
 * Minimum jiffies per core between two samples (~50 ms at USER_HZ 100), as on darwin.
 * Closer samples (activation right after priming, forced refresh right after a tick) would read
 * 0% or 100% per core, so they return the previous result and keep the baseline instead.
 */
const MIN_TICKS_PER_CORE = 5;

/**
 * High-performance, zero-subprocess Linux CPU usage provider.
 *
 * Reads cumulative jiffies directly from `/proc/stat` and calculates the delta
 * between successive samples. Handles edge cases including:
 * - `iowait` inclusion in idle time to prevent artificial 100% spikes during I/O.
 * - Cold start: the constructor primes the counters, so the first sample already has a delta.
 * - Samples too close together (fewer than `MIN_TICKS_PER_CORE` jiffies per core) or counters
 *   going backwards.
 * - Per-core logical breakdown for multi-threading profiling.
 * - Sparse array hole protection against CPU core parking / hotplugging.
 */
export class CpuProvider {
  private prevOverall: CoreStat | null = null;
  private prevCores: Map<number, CoreStat> = new Map();
  private lastResult: CpuUsageInfo = { overallPercent: 0, perCorePercent: [] };

  /**
   * Primes the tick baseline so the first sample after activation already has a delta, and the
   * result before that delta carries the core count (all cores at 0%) rather than an empty array.
   *
   * @param statPath - Path of the kernel CPU statistics file (tests pass a mocked file).
   */
  constructor(private readonly statPath = '/proc/stat') {
    this.sample();
  }

  /**
   * Samples `/proc/stat` and calculates active utilization percentages since the previous sample.
   *
   * @returns Current overall and per-core CPU usage percentages, or `null` if the virtual file is unreadable.
   */
  public sample(): CpuUsageInfo | null {
    try {
      const content = fs.readFileSync(this.statPath, 'utf8');
      const lines = content.split('\n');

      let overall: CoreStat | null = null;
      const cores: CoreStat[] = [];
      let maxCoreIndex = -1;

      for (const line of lines) {
        if (!line.startsWith('cpu')) {
          continue;
        }

        const parts = line.trim().split(/\s+/);
        const name = parts[0];
        if (!name) {
          continue;
        }

        // Parts: [cpu, user, nice, system, idle, iowait, irq, softirq, steal]
        const user = Number(parts[1]) || 0;
        const nice = Number(parts[2]) || 0;
        const system = Number(parts[3]) || 0;
        const idle = Number(parts[4]) || 0;
        const iowait = Number(parts[5]) || 0;
        const irq = Number(parts[6]) || 0;
        const softirq = Number(parts[7]) || 0;
        const steal = Number(parts[8]) || 0;

        const stat: CoreStat = {
          total: user + nice + system + idle + iowait + irq + softirq + steal,
          idle: idle + iowait,
        };

        if (name === 'cpu') {
          overall = stat;
        } else {
          // Individual core (cpu0, cpu1, ...)
          const coreIndex = parseInt(name.slice(3), 10);
          if (!isNaN(coreIndex)) {
            cores[coreIndex] = stat;
            if (coreIndex > maxCoreIndex) {
              maxCoreIndex = coreIndex;
            }
          }
        }
      }

      if (!overall) {
        return null;
      }

      let overallPercent = this.lastResult.overallPercent;
      if (this.prevOverall !== null) {
        // The aggregate line sums every core, so the minimum scales with the core count.
        const totalDelta = overall.total - this.prevOverall.total;
        if (totalDelta >= 0 && totalDelta < Math.max(1, maxCoreIndex + 1) * MIN_TICKS_PER_CORE) {
          // Too close to the previous sample: keep the baseline (counters going backwards reset it below).
          return this.lastResult;
        }
        if (totalDelta > 0) {
          const activeDelta = totalDelta - (overall.idle - this.prevOverall.idle);
          overallPercent = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
        }
      }
      this.prevOverall = overall;

      // Dense array (no holes when cores are parked); a core without a baseline (priming, hotplug) reads 0%.
      const perCorePercent = new Array<number>(maxCoreIndex + 1).fill(0);
      for (let i = 0; i <= maxCoreIndex; i++) {
        const cur = cores[i];
        if (cur === undefined) {
          continue;
        }
        const prevCore = this.prevCores.get(i);
        if (prevCore) {
          const totalDelta = cur.total - prevCore.total;
          if (totalDelta > 0) {
            const activeDelta = totalDelta - (cur.idle - prevCore.idle);
            perCorePercent[i] = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
          }
        }
        this.prevCores.set(i, cur);
      }

      this.lastResult = { overallPercent, perCorePercent };
      return this.lastResult;
    } catch {
      return null;
    }
  }
}
