import * as fs from 'node:fs';
import type { MemoryInfo } from '../../types.js';

/**
 * High-performance, single-pass Linux RAM and Swap usage provider.
 *
 * Reads directly from `/proc/meminfo` and parses MemTotal, MemAvailable, SwapTotal,
 * and SwapFree. Calculates actual memory consumption taking into account modern Linux
 * kernel memory management heuristics (where buffers and reclaimable page cache are
 * accounted for in `MemAvailable`).
 */
export class MemoryProvider {
  /**
   * Samples `/proc/meminfo` and computes memory and swap utilization metrics.
   *
   * @returns Comprehensive RAM and Swap metrics in bytes and percentages, or `null` if the virtual file is unreadable.
   */
  public sample(): MemoryInfo | null {
    try {
      const content = fs.readFileSync('/proc/meminfo', 'utf8');

      let memTotalKb = 0;
      let memAvailableKb = 0;
      let swapTotalKb = 0;
      let swapFreeKb = 0;

      const lines = content.split('\n');
      for (const line of lines) {
        if (line.startsWith('MemTotal:')) {
          memTotalKb = parseInt(line.slice(9), 10) || 0;
        } else if (line.startsWith('MemAvailable:')) {
          memAvailableKb = parseInt(line.slice(13), 10) || 0;
        } else if (line.startsWith('SwapTotal:')) {
          swapTotalKb = parseInt(line.slice(10), 10) || 0;
        } else if (line.startsWith('SwapFree:')) {
          swapFreeKb = parseInt(line.slice(9), 10) || 0;
        }
      }

      if (memTotalKb === 0) {
        return null;
      }

      const totalBytes = memTotalKb * 1024;
      const availableBytes = memAvailableKb * 1024;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const usedPercent = (usedBytes / totalBytes) * 100;

      const swapTotalBytes = swapTotalKb * 1024;
      const swapFreeBytes = swapFreeKb * 1024;
      const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);
      const swapUsedPercent = swapTotalBytes > 0 ? (swapUsedBytes / swapTotalBytes) * 100 : 0;

      return {
        totalBytes,
        availableBytes,
        usedBytes,
        usedPercent,
        swapTotalBytes,
        swapFreeBytes,
        swapUsedBytes,
        swapUsedPercent,
      };
    } catch {
      return null;
    }
  }
}
