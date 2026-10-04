// DiskProvider with a stubbed statfs (#52): free space from bavail, zero-block filesystems, unreachable
// paths skipped, and which paths are queried (configured drives, else the default path, else /).
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { describe, test } from 'node:test';
import { DiskProvider, type StatFs } from '../../src/disk/disk_provider.js';

/** Volumes by path, as statfs reports them; any other path fails as unreachable. */
const volumes: Record<string, Awaited<ReturnType<StatFs>>> = {
  // 1000 blocks of 4 KiB, 300 free of which 50 reserved for root: 250 available to the user.
  '/': { bsize: 4096, blocks: 1000, bavail: 250 },
  '/home': { bsize: 4096, blocks: 2000, bavail: 1500 },
  '/workspace': { bsize: 1024, blocks: 100, bavail: 10 },
  // A pseudo filesystem without blocks (proc, sysfs).
  '/proc': { bsize: 4096, blocks: 0, bavail: 0 },
};

/** A provider whose statfs serves `volumes`, and the paths it was asked for. */
function stubbed(): { disk: DiskProvider; queried: string[] } {
  const queried: string[] = [];
  const statfs: StatFs = async (target) => {
    queried.push(target);
    const volume = volumes[target];
    if (!volume) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${target}'`), { code: 'ENOENT' });
    }
    return volume;
  };
  return { disk: new DiskProvider(statfs), queried };
}

describe('DiskProvider', () => {
  test('free space from bavail: blocks reserved for root count as used', async () => {
    const [root] = await stubbed().disk.sample(['/']);
    assert.deepEqual(root, {
      mountPath: '/',
      totalBytes: 4_096_000,
      freeBytes: 1_024_000,
      usedBytes: 3_072_000,
      usedPercent: 75,
      freePercent: 25,
    });
  });

  test('filesystem without blocks: 0% used, not NaN', async () => {
    const [proc] = await stubbed().disk.sample(['/proc']);
    assert.deepEqual([proc?.totalBytes, proc?.usedPercent, proc?.freePercent], [0, 0, 100]);
  });

  test('unreachable paths skipped, the others in the configured order', async () => {
    const { disk } = stubbed();
    const drives = await disk.sample(['/home', '/media/usb', '/']);
    assert.deepEqual(drives.map((d) => [d.mountPath, d.usedPercent]), [['/home', 25], ['/', 75]]);
    assert.deepEqual(await disk.sample(['/media/usb']), [], 'none reachable');
  });

  test('configured drives, else the default path, else /', async () => {
    const cases: [string[], string | undefined, string[]][] = [
      [['/home', '/workspace'], '/workspace', ['/home', '/workspace']],
      [[], '/workspace', ['/workspace']],
      [[], undefined, ['/']],
      [[], '', ['/']],
    ];
    for (const [configured, defaultPath, expected] of cases) {
      const { disk, queried } = stubbed();
      await disk.sample(configured, defaultPath);
      assert.deepEqual(queried, expected, `configured ${JSON.stringify(configured)}, default ${JSON.stringify(defaultPath)}`);
    }
  });

  test('default statfs: fs.promises.statfs', async () => {
    const [tmp] = await new DiskProvider().sample([os.tmpdir()]);
    assert.ok(tmp && tmp.totalBytes > 0 && tmp.freeBytes <= tmp.totalBytes, `statfs of ${os.tmpdir()}`);
  });
});
