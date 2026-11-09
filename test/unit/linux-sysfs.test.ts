// Linux sysfs reads kept open (#40) against a mocked sysfs tree: an attribute keeps one descriptor and
// reads the current value at offset 0, reopens after a failed read, releases it on close, refreshes off
// the thread (battery ahead of the read) without closing a descriptor still in use; cpufreq reads
// once per policy and fans the value out to the policy's cores, keeps its descriptors across the
// rescan, and closes them on dispose.
//
// Usage (counts the open descriptors in /proc/self/fd, skipped without it):  pnpm test
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { CpuFreqProvider } from '../../src/platform/linux/cpufreq.js';
import { SysfsAttribute } from '../../src/platform/linux/sysfs.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const skip = fs.existsSync('/proc/self/fd') ? false : 'needs /proc/self/fd (Linux)';

/** Files open in this process under the mocked tree. */
function openUnderRoot(): string[] {
  const dir = '/proc/self/fd';
  const files: string[] = [];
  for (const fd of fs.readdirSync(dir)) {
    try {
      const target = fs.readlinkSync(path.join(dir, fd));
      if (target.startsWith(root)) {
        files.push(target);
      }
    } catch {
      // closed while listing (the readdir descriptor itself)
    }
  }
  return files.sort();
}

/** Writes a sysfs value in place (same file, as the kernel changes it), newline-terminated. */
function write(file: string, value: string | number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`);
}

/**
 * cpu0..cpu<n-1>, each `cpufreq` a link to the policy of its cluster, as the kernel lays them out:
 * `clusters` lists the cores per policy (policy named after its first core).
 */
function cpufreqTree(base: string, clusters: number[][], khz: (policy: number) => number): void {
  for (const cores of clusters) {
    const policy = cores[0]!;
    const policyDir = path.join(base, 'devices/system/cpu/cpufreq', `policy${policy}`);
    write(path.join(policyDir, 'scaling_cur_freq'), khz(policy));
    for (const core of cores) {
      const coreDir = path.join(base, 'devices/system/cpu', `cpu${core}`);
      fs.mkdirSync(coreDir, { recursive: true });
      fs.symlinkSync(policyDir, path.join(coreDir, 'cpufreq'));
    }
  }
}

test('one descriptor per attribute, current value at each read, close', { skip }, () => {
  const file = path.join(root, 'attr/value');
  write(file, 1200);
  const attr = new SysfsAttribute(file);
  assert.equal(attr.readInt(), 1200);
  assert.deepEqual(openUnderRoot(), [file], 'opened at the first read and kept open');
  write(file, 3400);
  assert.equal(attr.readInt(), 3400, 'read again at offset 0: the current value');
  write(file, ' Discharging ');
  assert.equal(attr.readText(), 'Discharging');
  assert.deepEqual(openUnderRoot(), [file], 'still one descriptor');
  attr.close();
  assert.deepEqual(openUnderRoot(), [], 'closed');
  assert.equal(attr.readText(), 'Discharging', 'a read after close opens it again');
  attr.close();
});

test('missing file, failed read: unreadable, retried, nothing left open', { skip }, () => {
  const missing = new SysfsAttribute(path.join(root, 'attr/missing'));
  assert.ok(Number.isNaN(missing.readInt()));
  assert.equal(missing.readText(), null);
  write(missing.file, 7);
  assert.equal(missing.readInt(), 7, 'opened once the file exists');
  missing.close();
  // A read failing on an open descriptor (here a directory: EISDIR; in sysfs a removed device: ENODEV)
  // closes it and retries with a fresh one; failing again, the attribute reads as unreadable, nothing open.
  const failing = new SysfsAttribute(path.join(root, 'attr'));
  assert.ok(Number.isNaN(failing.readInt()));
  assert.deepEqual(openUnderRoot(), [], 'no descriptor left after a failed read');
});

test('refresh off the thread, close deferred while it reads', { skip }, async () => {
  // refreshAsync (battery ahead of the read): nothing before the first read, one read in flight at a
  // time, and a close during it releases the descriptor once that read completes.
  const refreshed = new SysfsAttribute(path.join(root, 'attr/refreshed'));
  write(refreshed.file, 42);
  refreshed.refreshAsync();
  assert.deepEqual(openUnderRoot(), [], 'no descriptor opened by a refresh');
  assert.equal(refreshed.readInt(), 42);
  refreshed.refreshAsync();
  refreshed.refreshAsync(); // ignored: one in flight
  refreshed.close();
  assert.deepEqual(openUnderRoot(), [refreshed.file], 'kept open while the refresh reads it');
  // Polled, not a fixed sleep: under load the libuv pool can take well over 50 ms to run the read.
  for (const deadline = Date.now() + 2000; openUnderRoot().length > 0 && Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(openUnderRoot(), [], 'closed once the refresh completed');
  assert.equal(refreshed.readInt(), 42, 'reads again after close');
  refreshed.close();
});

describe('cpufreq', { skip }, () => {
  // Two clusters of 4 cores (shared policies) and two cores with a policy each.
  const tree = path.join(root, 'clusters');
  const policyFiles = [0, 4, 8, 9].map((p) => path.join(tree, `devices/system/cpu/cpufreq/policy${p}/scaling_cur_freq`));
  let now = 1_000_000;
  let freq: CpuFreqProvider;

  test('read once per policy, value on each of its cores', () => {
    cpufreqTree(tree, [[0, 1, 2, 3], [4, 5, 6, 7], [8], [9]], (policy) => 1_000_000 + policy * 100_000);
    freq = new CpuFreqProvider(tree, () => now);
    const first = freq.sample()!;
    assert.deepEqual(first.perCoreHz, [1e9, 1e9, 1e9, 1e9, 1.4e9, 1.4e9, 1.4e9, 1.4e9, 1.8e9, 1.9e9]);
    assert.equal(first.maxHz, 1.9e9);
    assert.equal(first.avgHz, (4 * 1e9 + 4 * 1.4e9 + 1.8e9 + 1.9e9) / 10, 'average over cores, not policies');
    assert.deepEqual(openUnderRoot(), [...policyFiles].sort(), 'one descriptor per policy, not per core');
  });

  test('descriptors kept across rescans, closed when dropped and on dispose', () => {
    write(policyFiles[1]!, 2_500_000);
    now += 60_000; // rescan
    const second = freq.sample()!;
    assert.deepEqual(second.perCoreHz.slice(4, 8), [2.5e9, 2.5e9, 2.5e9, 2.5e9]);
    assert.deepEqual(openUnderRoot(), [...policyFiles].sort(), 'descriptors kept across the rescan');
    // Policy 9 goes away (core unplugged): its descriptor is closed by the rescan, the core reads 0 Hz.
    fs.rmSync(path.join(tree, 'devices/system/cpu/cpu9'), { recursive: true });
    fs.rmSync(path.join(tree, 'devices/system/cpu/cpufreq/policy9'), { recursive: true });
    now += 60_000;
    const third = freq.sample()!;
    assert.equal(third.perCoreHz.length, 9);
    assert.deepEqual(openUnderRoot(), policyFiles.slice(0, 3).sort(), 'dropped policy closed');
    freq.dispose();
    assert.deepEqual(openUnderRoot(), [], 'dispose closes every descriptor');
  });
});
