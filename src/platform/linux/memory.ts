import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryInfo } from '../../types.js';

/**
 * High-performance, single-pass Linux RAM and Swap usage provider.
 *
 * Reads directly from `/proc/meminfo` and parses MemTotal, MemAvailable, SwapTotal,
 * and SwapFree (MemFree, Buffers and Cached stand in for a missing MemAvailable).
 * Calculates actual memory consumption taking into account modern Linux kernel memory
 * management heuristics (where buffers and reclaimable page cache are accounted for in
 * `MemAvailable`).
 */
export class MemoryProvider {
  private readonly meminfoPath: string;

  /**
   * @param procRoot - Root of the procfs tree (tests pass a mocked tree).
   */
  constructor(procRoot = '/proc') {
    this.meminfoPath = path.join(procRoot, 'meminfo');
  }

  /**
   * Samples `/proc/meminfo` and computes memory and swap utilization metrics.
   *
   * @returns Comprehensive RAM and Swap metrics in bytes and percentages, or `null` if the virtual file is unreadable.
   */
  public sample(): MemoryInfo | null {
    try {
      const content = fs.readFileSync(this.meminfoPath, 'utf8');

      let memTotalKb = 0;
      let memAvailableKb: number | null = null;
      // Kernels before 3.14 (and some container views of meminfo) have no MemAvailable.
      let memFreeKb = 0;
      let buffersKb = 0;
      let cachedKb = 0;
      let swapTotalKb = 0;
      let swapFreeKb = 0;

      // Lines are `Key:   value kB`: the value starts after the colon, whatever the key's length.
      for (const line of content.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) {
          continue;
        }
        switch (line.slice(0, colon)) {
          case 'MemTotal':
            memTotalKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'MemAvailable':
            memAvailableKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'MemFree':
            memFreeKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'Buffers':
            buffersKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'Cached':
            cachedKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'SwapTotal':
            swapTotalKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
          case 'SwapFree':
            swapFreeKb = parseInt(line.slice(colon + 1), 10) || 0;
            break;
        }
      }

      if (memTotalKb === 0) {
        return null;
      }

      const totalBytes = memTotalKb * 1024;
      // Without MemAvailable, free plus buffers and page cache (what `free` showed before it): used
      // would otherwise read 100%.
      const availableBytes = (memAvailableKb ?? Math.min(memTotalKb, memFreeKb + buffersKb + cachedKb)) * 1024;
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
