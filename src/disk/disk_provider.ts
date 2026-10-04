import type { StatsFs } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { DiskDriveInfo } from '../types.js';

/** The filesystem query: `fs.promises.statfs`, or a stub in tests. */
export type StatFs = (path: string) => Promise<Pick<StatsFs, 'bsize' | 'blocks' | 'bavail'>>;

/**
 * Asynchronous disk storage utilization provider.
 *
 * Uses Node.js `fs.promises.statfs` to query filesystem statistics without invoking
 * external shell commands (`df`). Pure POSIX implementation with zero dependency on VS Code APIs.
 */
export class DiskProvider {
  /**
   * @param statfs - Filesystem query (tests pass a stub).
   */
  constructor(private readonly statfs: StatFs = fs.statfs) {}

  /**
   * Queries filesystem metrics for the specified mount points or defaults to the fallback path or '/'.
   *
   * @param configuredDrives - Array of custom paths configured by the user, if any.
   * @param defaultPath - Optional fallback directory path (e.g. active workspace root or system root).
   * @returns Array of disk statistics for each reachable mount point.
   */
  public async sample(configuredDrives: string[], defaultPath?: string): Promise<DiskDriveInfo[]> {
    const targetPaths: string[] = [];

    if (configuredDrives && configuredDrives.length > 0) {
      targetPaths.push(...configuredDrives);
    } else if (defaultPath) {
      targetPaths.push(defaultPath);
    } else {
      targetPaths.push('/');
    }

    const results: DiskDriveInfo[] = [];

    for (const mountPath of targetPaths) {
      try {
        const stat = await this.statfs(mountPath);
        const bsize = stat.bsize;
        const totalBytes = stat.blocks * bsize;
        const freeBytes = stat.bavail * bsize;
        const usedBytes = Math.max(0, totalBytes - freeBytes);

        const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
        const freePercent = Math.max(0, 100 - usedPercent);

        results.push({
          mountPath,
          totalBytes,
          freeBytes,
          usedBytes,
          usedPercent,
          freePercent,
        });
      } catch {
        // Path inaccessible, unmounted, or permission denied; skip gracefully
      }
    }

    return results;
  }
}
