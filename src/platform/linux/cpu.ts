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
 * High-performance, zero-subprocess Linux CPU usage provider.
 *
 * Reads cumulative jiffies directly from `/proc/stat` and calculates the delta
 * between successive samples. Handles edge cases including:
 * - `iowait` inclusion in idle time to prevent artificial 100% spikes during I/O.
 * - Clock skew or identical timestamps ($\Delta \text{total} \le 0$).
 * - Per-core logical breakdown for multi-threading profiling.
 * - Sparse array hole protection against CPU core parking / hotplugging.
 */
export class CpuProvider {
  private prevOverall: CoreStat | null = null;
  private prevCores: Map<number, CoreStat> = new Map();
  private lastResult: CpuUsageInfo = { overallPercent: 0, perCorePercent: [] };

  /**
   * Samples `/proc/stat` and calculates active utilization percentages since the previous sample.
   *
   * @returns Current overall and per-core CPU usage percentages, or `null` if the virtual file is unreadable.
   */
  public sample(): CpuUsageInfo | null {
    try {
      const content = fs.readFileSync('/proc/stat', 'utf8');
      const lines = content.split('\n');

      let overallPercent = this.lastResult.overallPercent;
      const perCorePercent: number[] = [];
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

        const total = user + nice + system + idle + iowait + irq + softirq + steal;
        const idleAll = idle + iowait;

        if (name === 'cpu') {
          if (this.prevOverall !== null) {
            const totalDelta = total - this.prevOverall.total;
            const idleDelta = idleAll - this.prevOverall.idle;

            if (totalDelta > 0) {
              const activeDelta = totalDelta - idleDelta;
              overallPercent = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
            }
          }
          this.prevOverall = { total, idle: idleAll };
        } else {
          // Individual core (cpu0, cpu1, ...)
          const coreIndex = parseInt(name.slice(3), 10);
          if (!isNaN(coreIndex)) {
            if (coreIndex > maxCoreIndex) {
              maxCoreIndex = coreIndex;
            }
            const prevCore = this.prevCores.get(coreIndex);
            let coreUsage = 0;

            if (prevCore) {
              const totalDelta = total - prevCore.total;
              const idleDelta = idleAll - prevCore.idle;

              if (totalDelta > 0) {
                const activeDelta = totalDelta - idleDelta;
                coreUsage = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
              }
            }

            perCorePercent[coreIndex] = coreUsage;
            this.prevCores.set(coreIndex, { total, idle: idleAll });
          }
        }
      }

      // Densify array to prevent sparse holes / undefined indexing when cores are parked
      for (let i = 0; i <= maxCoreIndex; i++) {
        if (perCorePercent[i] === undefined) {
          perCorePercent[i] = 0;
        }
      }

      this.lastResult = { overallPercent, perCorePercent };
      return this.lastResult;
    } catch {
      return null;
    }
  }
}
