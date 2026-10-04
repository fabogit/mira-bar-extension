// ResourceMonitor schedule against a fake provider and mocked timers (setTimeout and Date): per-section
// intervals, the second CPU read, Static and Live tooltips, hidden sections, error isolation, battery
// availability, temperature and battery refreshed ahead, the age of a temperature reading, hung disk
// samples and dispose. Reads are counted at exact times instead of measured as rates (#53).
//
// Usage (any OS):  pnpm test (bundled with the vscode mock: monitor.ts creates the status bar items)
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import * as vscode from 'vscode';
import { getConfig, type MiraBarConfig, type TooltipSection } from '../../src/config.js';
import { ResourceMonitor } from '../../src/monitor.js';
import type { DiskProvider } from '../../src/disk/disk_provider.js';
import type { TelemetryPlatformProvider } from '../../src/platform/interface.js';
import type { CpuTempInfo, DiskDriveInfo, MemoryInfo } from '../../src/types.js';

/** What the vscode mock records per status bar item (test/harness/vscode-mock.cjs). */
interface MockItem {
  name: string;
  text: string;
  tooltip: vscode.MarkdownString | undefined;
  visible: boolean;
  disposed: boolean;
  tooltipSetCount: number;
}
const mockState = (vscode as unknown as { __state: { items: MockItem[]; errors: string[] } }).__state;

/** Start of the mocked clock: 12:00:00 local time, so the tooltips show predictable update times. */
const T0 = new Date(2026, 9, 4, 12, 0, 0).getTime();

const errors: string[] = [];
const log = { error: (m: string) => errors.push(m) } as unknown as vscode.LogOutputChannel;
const monitors: ResourceMonitor[] = [];

beforeEach(() => {
  errors.length = 0;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.dispose();
  }
  mock.timers.reset();
});

/**
 * Advances the mocked clock 1 ms at a time: tick() runs every timer due by its end with Date.now() at
 * that end, so a timer armed by one of them would see the wrong time, or not run.
 */
function advance(ms: number): void {
  for (let i = 0; i < ms; i++) {
    mock.timers.tick(1);
  }
}

/** Lets settled promises run their callbacks (setImmediate is not mocked). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Times from `from` to `to`, `step` apart. */
const times = (from: number, to: number, step: number): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/** The live status bar item of a section. */
function item(label: string): MockItem {
  const found = mockState.items.filter((i) => !i.disposed && i.name === `MiraBar: ${label}`).at(-1);
  assert.ok(found, `no ${label} item`);
  return found;
}

type ReadSection = Exclude<TooltipSection, 'disk'>;

const memory = (n: number): MemoryInfo => ({
  totalBytes: 16e9,
  availableBytes: 16e9 - n * 1e8,
  usedBytes: n * 1e8,
  usedPercent: n / 1.6,
  swapTotalBytes: 0,
  swapFreeBytes: 0,
  swapUsedBytes: 0,
  swapUsedPercent: 0,
});

/**
 * A provider that records the time of every read (from its creation: `elapsed`) and whose readings
 * change with each read, so every rebuilt tooltip differs from the previous one (the mock counts
 * tooltip writes).
 */
function fakeProvider(overrides: Partial<TelemetryPlatformProvider> = {}) {
  const origin = Date.now();
  const elapsed = (): number => Date.now() - origin;
  const reads: Record<ReadSection, number[]> = { cpu: [], freq: [], temp: [], mem: [], battery: [] };
  const read = (section: ReadSection): number => reads[section].push(elapsed());
  const provider: TelemetryPlatformProvider = {
    platformName: 'linux',
    sampleCpu: () => ({ overallPercent: read('cpu'), perCorePercent: [] }),
    sampleFreqOrLoad: () => {
      const hz = read('freq') * 1e8;
      return { kind: 'freq', data: { avgHz: hz, maxHz: hz, perCoreHz: [] } };
    },
    sampleTemp: () => ({ tempCelsius: 40 + read('temp') }),
    sampleMemory: () => memory(read('mem')),
    sampleBattery: () => ({ percent: read('battery'), status: 'Discharging' }),
    isBatteryAvailable: () => true,
    ...overrides,
  };
  return { provider, reads, elapsed };
}

const drive = (mountPath: string, freePercent: number): DiskDriveInfo => ({
  mountPath,
  totalBytes: 100e9,
  freeBytes: freePercent * 1e9,
  usedBytes: (100 - freePercent) * 1e9,
  usedPercent: 100 - freePercent,
  freePercent,
});

/** A disk provider whose samples stay pending until the test settles them. */
function fakeDisk() {
  const requests: { drives: string[]; resolve: (disks: DiskDriveInfo[]) => void }[] = [];
  const disk = {
    sample: (drives: string[]) => new Promise<DiskDriveInfo[]>((resolve) => requests.push({ drives, resolve })),
  } as unknown as DiskProvider;
  return { disk, requests };
}

type Intervals = Partial<Record<TooltipSection, number>>;

/** The default configuration with only the `show` sections visible, no gear widget, and the given intervals. */
function cfg(
  show: TooltipSection[],
  { statusBarMs = {}, tooltipMs = {}, ...rest }: Omit<Partial<MiraBarConfig>, 'statusBarMs' | 'tooltipMs'> & { statusBarMs?: Intervals; tooltipMs?: Intervals } = {}
): MiraBarConfig {
  const base = getConfig();
  return {
    ...base,
    showCpuUsage: show.includes('cpu'),
    showCpuFreq: show.includes('freq'),
    showCpuTemp: show.includes('temp'),
    showMem: show.includes('mem'),
    showBattery: show.includes('battery'),
    showDisk: show.includes('disk'),
    showSettings: false,
    statusBarMs: { ...base.statusBarMs, ...statusBarMs },
    tooltipMs: { ...base.tooltipMs, ...tooltipMs },
    ...rest,
  };
}

function start(provider: TelemetryPlatformProvider, config: MiraBarConfig, disk = fakeDisk().disk): ResourceMonitor {
  const monitor = new ResourceMonitor(provider, disk, log, config);
  monitors.push(monitor);
  return monitor;
}

test('per-section status bar intervals, Live tooltips with every read', () => {
  const { provider, reads } = fakeProvider();
  start(provider, cfg(['cpu', 'mem'], { tooltipMode: 'Live', statusBarMs: { cpu: 200, mem: 1000 } }));
  const cpu = item('CPU usage');
  const mem = item('Memory');
  const [cpu0, mem0] = [cpu.tooltipSetCount, mem.tooltipSetCount];
  advance(3000);
  assert.deepEqual(reads.cpu, times(0, 3000, 200), 'cpu every 200 ms');
  assert.deepEqual(reads.mem, times(0, 3000, 1000), 'memory every 1000 ms');
  assert.equal(cpu.tooltipSetCount - cpu0, 15, 'Live: one cpu tooltip per read');
  assert.equal(mem.tooltipSetCount - mem0, 3, 'Live: one memory tooltip per read');
  assert.match(cpu.tooltip!.value, /\*Updated at 12:00:03\.0\*/, 'tenths below 1000 ms');
  assert.match(mem.tooltip!.value, /\*Updated at 12:00:03\*/, 'no tenths at 1000 ms');
  assert.deepEqual([reads.freq, reads.temp, reads.battery], [[], [], []], 'hidden sections not read');
});

test('second CPU read 500 ms after construction', () => {
  const slow = fakeProvider();
  start(slow.provider, cfg(['cpu'], { statusBarMs: { cpu: 2000 } }));
  advance(4500);
  assert.deepEqual(slow.reads.cpu, [0, 500, 2500, 4500], 'the first delta 500 ms after the baseline, then every 2 s');

  const fast = fakeProvider();
  start(fast.provider, cfg(['cpu'], { statusBarMs: { cpu: 400 } }));
  advance(800);
  assert.deepEqual(fast.reads.cpu, [0, 400, 800], 'at 500 ms or less: the interval');
});

test('Static tooltips at their own interval, never faster than the status bar; auto-refresh off: click only', () => {
  const { provider, reads } = fakeProvider();
  const config = cfg(['cpu', 'mem'], { tooltipMode: 'Static', statusBarMs: { cpu: 200, mem: 1000 }, tooltipMs: { cpu: 1000, mem: 200 } });
  const monitor = start(provider, config);
  const cpu = item('CPU usage');
  const mem = item('Memory');
  const [cpu0, mem0] = [cpu.tooltipSetCount, mem.tooltipSetCount];
  advance(4000);
  assert.equal(reads.cpu.length, 21);
  assert.equal(cpu.tooltipSetCount - cpu0, 4, 'cpu tooltip every 1000 ms, status bar every 200 ms');
  assert.match(cpu.tooltip!.value, /\*Updated at 12:00:04\.0\*/, 'the tooltip shows the time of its reading');
  assert.equal(mem.tooltipSetCount - mem0, 4, 'memory tooltip at 200 ms follows its 1000 ms status bar');

  monitor.applyConfig({ ...config, tooltipAutoRefresh: false });
  const frozen = cpu.tooltip!.value;
  const text = cpu.text;
  advance(3000);
  assert.equal(cpu.tooltip!.value, frozen, 'no auto-refresh when off');
  assert.notEqual(cpu.text, text, 'the status bar keeps updating');
  monitor.refresh();
  assert.notEqual(cpu.tooltip!.value, frozen, 'click rebuilds the tooltip');
  assert.match(cpu.tooltip!.value, /\*Updated at 12:00:07\.0\*/);
});

test('hidden sections are not read; with every section hidden no timer runs', () => {
  const { provider, reads } = fakeProvider();
  const monitor = start(provider, cfg(['cpu', 'mem'], { statusBarMs: { cpu: 200, mem: 200 } }));
  monitor.applyConfig(cfg(['cpu'], { statusBarMs: { cpu: 200, mem: 200 } }));
  assert.equal(item('Memory').visible, false, 'memory hidden');
  const memReads = reads.mem.length;
  advance(1000);
  assert.equal(reads.mem.length, memReads, 'hidden memory not read');
  assert.equal(reads.cpu.length, 7, 'cpu still read');

  monitor.applyConfig(cfg([]));
  const cpuReads = reads.cpu.length;
  advance(5000);
  assert.equal(reads.cpu.length, cpuReads, 'nothing read with every section hidden');
});

test('a failing section keeps its last display and logs each distinct error once in a row', () => {
  let failure: Error | null = null;
  const { provider, reads } = fakeProvider({
    sampleMemory: () => {
      if (failure) {
        throw failure;
      }
      return memory(1);
    },
  });
  start(provider, cfg(['cpu', 'mem'], { tooltipMode: 'Live', statusBarMs: { cpu: 200, mem: 200 } }));
  const mem = item('Memory');
  const text = mem.text;
  failure = new Error('meminfo unreadable');
  advance(1000);
  assert.equal(reads.cpu.length, 6, 'cpu read on schedule');
  assert.equal(errors.length, 1, `logged once over five reads: ${errors.length}`);
  assert.ok(errors[0]!.startsWith('Memory: Error: meminfo unreadable'), errors[0]);
  assert.ok(mem.visible && mem.text === text, 'previous memory display kept');

  const first = failure;
  failure = new Error('another error');
  advance(400);
  assert.equal(errors.length, 2, 'a different error logged');
  failure = null;
  advance(200);
  failure = first;
  advance(400);
  assert.equal(errors.length, 3, 'the same error logged again after a successful read');
});

test('battery hidden while isBatteryAvailable throws', () => {
  let available: () => boolean = () => {
    throw new Error('EACCES');
  };
  let refreshes = 0;
  const { provider, reads } = fakeProvider({
    isBatteryAvailable: () => available(),
    requestBatteryRefresh: () => refreshes++,
  });
  start(provider, cfg(['cpu', 'battery'], { statusBarMs: { cpu: 200, battery: 1000 } }));
  advance(2000);
  assert.equal(item('Battery').visible, false, 'battery hidden');
  assert.deepEqual([reads.battery.length, refreshes, errors.length], [0, 0, 0], 'not read, not refreshed, nothing logged');
  assert.equal(reads.cpu.length, 11, 'the schedule goes on');

  available = () => true;
  advance(200);
  assert.ok(item('Battery').visible, 'shown once available');
  available = () => {
    throw new Error('EACCES');
  };
  advance(200);
  assert.equal(item('Battery').visible, false, 'hidden again');
  assert.equal(errors.length, 0);
});

test('battery refreshed ahead of each read from 1 s, not below; dispose reaches the provider', () => {
  const run = (batteryMs: number, ms: number) => {
    const refreshes: number[] = [];
    let disposed = false;
    const { provider, reads, elapsed } = fakeProvider({ dispose: () => (disposed = true) });
    provider.requestBatteryRefresh = () => refreshes.push(elapsed());
    const monitor = start(provider, cfg(['battery'], { statusBarMs: { battery: batteryMs } }));
    advance(ms);
    monitor.dispose();
    assert.ok(disposed, 'provider disposed with the monitor');
    return { reads: reads.battery, refreshes };
  };
  assert.deepEqual(run(1000, 2400), { reads: [0, 1000, 2000], refreshes: [900, 1900] }, 'one refresh 100 ms before each read');
  assert.deepEqual(run(500, 1200).refreshes, [], 'no refresh below 1 s');
});

test('temperature refreshed ahead of each read, not after a forced read nor below 400 ms', () => {
  const run = (config: MiraBarConfig, steps: (monitor: ResourceMonitor) => void) => {
    const refreshes: number[] = [];
    const maxAges: number[] = [];
    const { provider, reads, elapsed } = fakeProvider();
    provider.requestTempRefresh = () => refreshes.push(elapsed());
    const sampleTemp = provider.sampleTemp;
    provider.sampleTemp = (maxAgeMs) => (maxAges.push(maxAgeMs), sampleTemp(maxAgeMs));
    steps(start(provider, config));
    return { reads: reads.temp, refreshes, maxAges: [...new Set(maxAges)] };
  };
  const refreshed = run(cfg(['temp'], { statusBarMs: { temp: 2000 } }), (monitor) => {
    advance(500);
    monitor.refresh(); // a click reads at once, without a refresh ahead
    advance(4000);
  });
  assert.deepEqual(refreshed, { reads: [0, 500, 2500, 4500], refreshes: [2400, 4400], maxAges: [1000] },
    'one refresh 100 ms before each scheduled read; cached readings up to half the interval');
  assert.deepEqual(run(cfg(['temp'], { statusBarMs: { temp: 300 } }), () => advance(1200)).refreshes, [], 'none below 400 ms');
  assert.deepEqual(run(cfg(['cpu'], { statusBarMs: { temp: 2000 } }), () => advance(4000)).refreshes, [], 'none while hidden');
});

test('Live temperature tooltip rebuilt only with a new reading', () => {
  let reading: CpuTempInfo = { tempCelsius: 50, sampleSeq: 1 };
  const { provider } = fakeProvider({ sampleTemp: () => reading });
  const monitor = start(provider, cfg(['temp'], { tooltipMode: 'Live', statusBarMs: { temp: 1000 } }));
  const temp = item('Temperature');
  const n0 = temp.tooltipSetCount;
  advance(2000);
  assert.equal(temp.tooltipSetCount, n0, 'same reading: tooltip kept');
  reading = { tempCelsius: 51, sampleSeq: 2 };
  advance(1000);
  assert.equal(temp.tooltipSetCount, n0 + 1, 'new reading: tooltip rebuilt');
  advance(1000);
  assert.equal(temp.tooltipSetCount, n0 + 1, 'kept again');
  monitor.refresh();
  assert.equal(temp.tooltipSetCount, n0 + 2, 'a click rebuilds it with the same reading');
  reading = { tempCelsius: 51 };
  advance(2000);
  assert.equal(temp.tooltipSetCount, n0 + 4, 'without a sequence number: with every read');
});

test('temperature tooltip shows the time of the reading (ageMs)', () => {
  let ageMs: number | undefined = 3000;
  const { provider } = fakeProvider({ sampleTemp: () => ({ tempCelsius: 50, ageMs }) });
  const monitor = start(provider, cfg(['temp'], { statusBarMs: { temp: 10000 } }));
  assert.match(item('Temperature').tooltip!.value, /\*Updated at 11:59:57\*/, 'read 3 s before');
  ageMs = undefined;
  monitor.refresh();
  assert.match(item('Temperature').tooltip!.value, /\*Updated at 12:00:00\*/, 'no age: the time of the read');
  ageMs = 250;
  monitor.applyConfig(cfg(['temp'], { statusBarMs: { temp: 500 } }));
  assert.match(item('Temperature').tooltip!.value, /\*Updated at 11:59:59\.7\*/, 'with tenths below 1000 ms');
});

test('disk: a hung sample neither blocks the other sections nor piles up; new paths recover; stale results dropped', async () => {
  const { provider, reads } = fakeProvider();
  const { disk, requests } = fakeDisk();
  const config = cfg(['cpu', 'disk'], { tooltipMode: 'Live', statusBarMs: { cpu: 200, disk: 200 } });
  const monitor = start(provider, config, disk);
  requests[0]!.resolve([drive('/', 40)]);
  await settle();
  const diskItem = item('Disk');
  assert.ok(diskItem.visible && diskItem.text.includes('40.0% free'), diskItem.text);

  advance(1400); // the request at 200 ms hangs
  assert.deepEqual(reads.cpu, times(0, 1400, 200), 'cpu read on schedule');
  assert.equal(requests.length, 2, 'one pending request serves the later reads');
  assert.ok(diskItem.visible && diskItem.text.includes('40.0% free'), 'last disk value kept');

  monitor.applyConfig({ ...config, diskDrives: ['/data'] });
  assert.deepEqual(requests.map((r) => r.drives), [[], [], ['/data']], 'new paths sampled while the old request hangs');
  monitor.applyConfig({ ...config, diskDrives: ['/backup'] });
  assert.equal(requests.length, 3, 'two requests in flight: no third one');

  requests[1]!.resolve([]);
  await settle();
  assert.ok(diskItem.visible && diskItem.text.includes('40.0% free'), 'stale result dropped');
  advance(200);
  assert.deepEqual(requests.at(-1)!.drives, ['/backup'], 'a slot freed: the current paths are sampled');
  requests[2]!.resolve([drive('/data', 10)]);
  requests[3]!.resolve([drive('/backup', 70)]);
  await settle();
  assert.ok(diskItem.text.includes('70.0% free'), `current paths shown: ${diskItem.text}`);
});

test('dispose stops the schedule and drops a pending disk result; a new monitor runs alone', async () => {
  const errors0 = mockState.errors.length;
  const first = fakeProvider();
  const { disk, requests } = fakeDisk();
  const monitor = start(first.provider, cfg(['cpu', 'disk'], { tooltipMode: 'Live', statusBarMs: { cpu: 200, disk: 200 } }), disk);
  advance(400);
  monitor.dispose();
  const cpuReads = first.reads.cpu.length;
  advance(1000);
  requests[0]!.resolve([drive('/', 40)]);
  await settle();
  assert.equal(first.reads.cpu.length, cpuReads, 'nothing read after dispose');
  assert.deepEqual(mockState.errors.slice(errors0), [], 'no writes to disposed items');

  const second = fakeProvider();
  start(second.provider, cfg(['cpu'], { tooltipMode: 'Live', statusBarMs: { cpu: 200 } }));
  advance(1000);
  assert.equal(second.reads.cpu.length, 6, 'one schedule');
  assert.equal(first.reads.cpu.length, cpuReads, 'the disposed monitor stays idle');
});
