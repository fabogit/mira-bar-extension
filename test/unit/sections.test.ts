// Section renderers (src/sections.ts): status bar texts and tooltip tables of every section, with the
// shapes of both platforms (P/E clusters, system load, memory pressure and RAM breakdown, SoC/NAND rows
// on macOS; frequency and swap on Linux) checked on any OS, since the renderers are pure. The private
// column split (splitColumns) is checked through the per-core tables it lays out.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderBattery, renderCpu, renderDisk, renderFreqOrLoad, renderMemory, renderTemp, type RenderContext } from '../../src/sections.js';
import type { MiraBarConfig } from '../../src/config.js';
import type { BatteryInfo, CpuUsageInfo, DiskDriveInfo, MemoryInfo } from '../../src/types.js';

/** U+2007 figure space, the padding of numbers in status bar texts. */
const FS = '\u2007';
const GiB = 1024 ** 3;

/** Defaults of the settings the renderers read; the others are not used here. */
const BASE = {
  cpuTooltipLayout: 'Table',
  loadFormat: 'Percent',
  freqUnit: 'GHz',
  memUnit: 'GB',
  diskFormat: 'PercentRemaining',
  diskMultiDisplay: 'All',
} as MiraBarConfig;

function ctx(config: Partial<MiraBarConfig> = {}, topology?: string): RenderContext {
  return { config: { ...BASE, ...config }, updatedAt: '12:00:00', topology };
}

/** Tooltip lines (the renderer was asked for a tooltip). */
function lines(tooltip: string | null): string[] {
  assert.ok(tooltip !== null, 'tooltip rendered');
  return tooltip.split('\n');
}

/** The lines of the code block that starts right after the line `heading` (fences excluded). */
function blockAfter(tooltip: string | null, heading: string): string[] {
  const all = lines(tooltip);
  const start = all.indexOf(heading);
  assert.ok(start >= 0 && all[start + 1] === '```text', `code block after ${JSON.stringify(heading)}`);
  return all.slice(start + 2, all.indexOf('```', start + 2));
}

/** The two-line footer every tooltip ends with. */
const FOOTER = ['---', '*Updated at 12:00:00*', '', '[$(gear) Settings](command:mirabar.openSettings) · [$(refresh) Refresh](command:mirabar.refresh)'];

/** Core labels of the left and right columns of a monospace per-core table (renderMonospaceTable). */
function columns(table: string[]): [string[], string[]] {
  const left: string[] = [];
  const right: string[] = [];
  for (const row of table.slice(2)) {
    const [l, r] = row.split(' │ ');
    const label = (cell: string | undefined): string | undefined => cell?.match(/^(\w+)\s*:/)?.[1];
    if (label(l)) left.push(label(l)!);
    if (label(r)) right.push(label(r)!);
  }
  return [left, right];
}

/** C0..C(n-1). */
const coreLabels = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `C${from + i}`);

describe('renderCpu', () => {
  /** Two P cores then four E cores, as Apple lists a 2P + 4E chip. */
  const appleCpu: CpuUsageInfo = { overallPercent: 35, perCorePercent: [10, 20, 30, 40, 50, 60], coreTypes: ['P', 'P', 'E', 'E', 'E', 'E'] };

  test('status bar text, no tooltip unless asked', () => {
    // Two decimals padded with figure spaces to a fixed width.
    assert.deepEqual(renderCpu({ overallPercent: 5, perCorePercent: [] }, ctx(), false), { text: `$(pulse) ${FS}5.00%`, tooltip: null });
    assert.equal(renderCpu({ overallPercent: 100, perCorePercent: [] }, ctx(), false).text, '$(pulse) 100.00%');
  });

  test('P/E clusters, Table layout', () => {
    // Topology and core count under the title, a summary row per cluster (average of its cores), then
    // P and E cores side by side, labelled with their index among all cores.
    const tooltip = renderCpu(appleCpu, ctx({}, 'Apple M4 (2P + 4E)'), true).tooltip;
    assert.deepEqual(lines(tooltip).slice(0, 2), ['### CPU Utilization', 'Apple M4 (2P + 4E) · 6 logical cores']);
    assert.deepEqual(blockAfter(tooltip, ''), [
      'Cluster     │ Load            ',
      '────────────┼─────────────────',
      'Overall     │ [██░░░░]   35.0%',
      'Performance │ [█░░░░░]   15.0%',
      'Efficiency  │ [███░░░]   45.0%',
    ]);
    const all = lines(tooltip);
    assert.deepEqual(all.slice(all.indexOf('Performance Cores       │ Efficiency Cores       ')), [
      'Performance Cores       │ Efficiency Cores       ',
      '────────────────────────┼────────────────────────',
      'P0 : [█░░░░░]  10.0%    │ E2 : [██░░░░]  30.0%',
      'P1 : [█░░░░░]  20.0%    │ E3 : [██░░░░]  40.0%',
      '                        │ E4 : [███░░░]  50.0%',
      '                        │ E5 : [████░░]  60.0%',
      '```',
      ...FOOTER,
    ]);
  });

  test('P/E clusters, List layout', () => {
    // One Markdown list per cluster, under its own heading.
    const all = lines(renderCpu(appleCpu, ctx({ cpuTooltipLayout: 'List' }), true).tooltip);
    assert.deepEqual(all.slice(all.indexOf('#### Performance Cores')), [
      '#### Performance Cores',
      `- **Core P0**: [\`█░░░░░\`] ${FS}10.0%`,
      `- **Core P1**: [\`█░░░░░\`] ${FS}20.0%`,
      '#### Efficiency Cores',
      `- **Core E2**: [\`██░░░░\`] ${FS}30.0%`,
      `- **Core E3**: [\`██░░░░\`] ${FS}40.0%`,
      `- **Core E4**: [\`███░░░\`] ${FS}50.0%`,
      `- **Core E5**: [\`████░░\`] ${FS}60.0%`,
      ...FOOTER,
    ]);
  });

  test('one cluster only: no empty cluster row or heading', () => {
    const cpu: CpuUsageInfo = { overallPercent: 50, perCorePercent: [40, 60], coreTypes: ['P', 'P'] };
    const table = renderCpu(cpu, ctx(), true).tooltip!;
    assert.ok(table.includes('Performance │') && !table.includes('Efficiency  │'), 'no Efficiency summary row');
    const list = renderCpu(cpu, ctx({ cpuTooltipLayout: 'List' }), true).tooltip!;
    assert.ok(list.includes('#### Performance Cores') && !list.includes('#### Efficiency Cores'));
  });

  test('core types not matching the core count: treated as unknown', () => {
    // A partial coreTypes list would mislabel cores: the plain per-core layout is used instead.
    const tooltip = renderCpu({ overallPercent: 50, perCorePercent: [10, 20, 30, 40], coreTypes: ['P', 'E'] }, ctx(), true).tooltip!;
    assert.ok(!tooltip.includes('Performance') && tooltip.includes('Cluster 0'), tooltip);
  });

  test('no core types, Table: two columns from 4 cores (splitColumns)', () => {
    // 0-3 cores stay in one column (shown as a list), 4 -> 2 + 2, 5 -> 3 + 2, 33 -> 17 + 16.
    const render = (n: number): string => renderCpu({ overallPercent: 1, perCorePercent: Array.from({ length: n }, (_, i) => i) }, ctx(), true).tooltip!;
    for (const n of [1, 2, 3]) {
      const tooltip = render(n);
      assert.ok(!tooltip.includes('Cluster 0'), `${n} cores: one column`);
      assert.equal(lines(tooltip).filter((l) => l.startsWith('- **Core ')).length, n, `${n} cores listed`);
    }
    for (const [n, left] of [[4, 2], [5, 3], [33, 17]] as const) {
      const all = lines(render(n));
      const table = all.slice(all.indexOf('Cluster 0               │ Cluster 1              '), all.lastIndexOf('```'));
      assert.deepEqual(columns(table), [coreLabels(0, left), coreLabels(left, n)], `${n} cores: ${left} + ${n - left}`);
    }
  });

  test('no core types, fewer than 4 cores or List: plain per-core list', () => {
    // Numbered from 0 without a cluster prefix, whatever the layout.
    const cpu: CpuUsageInfo = { overallPercent: 5, perCorePercent: [1, 2, 3] };
    for (const layout of ['Table', 'List'] as const) {
      const all = lines(renderCpu(cpu, ctx({ cpuTooltipLayout: layout }), true).tooltip);
      assert.deepEqual(all.slice(all.indexOf('*Per-Core Utilization:*')), [
        '*Per-Core Utilization:*',
        `- **Core 0**: [\`░░░░░░\`] ${FS}${FS}1.0%`,
        `- **Core 1**: [\`░░░░░░\`] ${FS}${FS}2.0%`,
        `- **Core 2**: [\`░░░░░░\`] ${FS}${FS}3.0%`,
        ...FOOTER,
      ], layout);
    }
    const eight = renderCpu({ overallPercent: 5, perCorePercent: Array(8).fill(5) }, ctx({ cpuTooltipLayout: 'List' }), true).tooltip!;
    assert.ok(eight.includes('- **Core 7**') && !eight.includes('Cluster 0'), '8 cores, List');
  });

  test('no per-core values: summary only, no core count', () => {
    assert.deepEqual(lines(renderCpu({ overallPercent: 5, perCorePercent: [] }, ctx(), true).tooltip), [
      '### CPU Utilization',
      '',
      '```text',
      'Cluster │ Load            ',
      '────────┼─────────────────',
      'Overall │ [░░░░░░]    5.0%',
      '```',
      '',
      ...FOOTER,
    ]);
  });
});

describe('renderFreqOrLoad: system load (macOS)', () => {
  const load = (load1: number, load5: number, load15: number, totalCores: number) =>
    ({ kind: 'load', data: { load1, load5, load15, totalCores } }) as const;

  test('Percent and Value formats', () => {
    // Percent: the 1-minute load over the core count, capped at 100%; Value: the raw queue depth.
    assert.equal(renderFreqOrLoad(load(2, 1, 0.5, 8), ctx(), false).text, `$(dashboard) ${FS}25.0% L`);
    assert.equal(renderFreqOrLoad(load(16, 1, 0.5, 8), ctx(), false).text, '$(dashboard) 100.0% L');
    assert.equal(renderFreqOrLoad(load(2, 1, 0.5, 8), ctx({ loadFormat: 'Value' }), false).text, '$(dashboard) 2.00 L');
    assert.equal(renderFreqOrLoad(load(12.345, 1, 0.5, 8), ctx({ loadFormat: 'Value' }), false).text, '$(dashboard) 12.35 L');
  });

  test('tooltip: one row per period', () => {
    const tooltip = renderFreqOrLoad(load(5, 2.5, 20, 10), ctx(), true).tooltip;
    assert.deepEqual(lines(tooltip).slice(0, 2), ['### System Load Average', 'Normalized capacity across **10 logical cores**:']);
    assert.deepEqual(blockAfter(tooltip, ''), [
      'Period │ Load Capacity    │ Queue Depth',
      '───────┼──────────────────┼────────────',
      ' 1 min │ [███░░░]   50.0% │    5.00 thr',
      ' 5 min │ [██░░░░]   25.0% │    2.50 thr',
      '15 min │ [██████]  100.0% │   20.00 thr',
    ]);
  });

  test('no core count: 0%, not NaN (#47)', () => {
    // Loads 0 / 1.5 / 0 with totalCores 0 (the os.cpus() fallback can be empty): the status bar was
    // 'NaN% L' and the rows NaN% / 100.0% / NaN%.
    const rendered = renderFreqOrLoad(load(0, 1.5, 0, 0), ctx(), true);
    assert.equal(rendered.text, `$(dashboard) ${FS}${FS}0.0% L`);
    assert.deepEqual(blockAfter(rendered.tooltip, '').slice(2), [
      ' 1 min │ [░░░░░░]    0.0% │    0.00 thr',
      ' 5 min │ [░░░░░░]    0.0% │    1.50 thr',
      '15 min │ [░░░░░░]    0.0% │    0.00 thr',
    ]);
  });
});

describe('renderFreqOrLoad: CPU frequency (Linux)', () => {
  const freq = (perCoreHz: number[], avgHz = 3e9, maxHz = 4.5e9) => ({ kind: 'freq', data: { avgHz, maxHz, perCoreHz } }) as const;

  test('status bar text per unit', () => {
    // Two decimals in the chosen unit (decimal divisors).
    assert.equal(renderFreqOrLoad(freq([]), ctx(), false).text, '$(dashboard) 3.00 GHz');
    assert.equal(renderFreqOrLoad(freq([]), ctx({ freqUnit: 'MHz' }), false).text, '$(dashboard) 3000.00 MHz');
    assert.equal(renderFreqOrLoad(freq([], 4e8), ctx(), false).text, '$(dashboard) 0.40 GHz');
  });

  test('average and peak, no per-core table without per-core values', () => {
    const tooltip = renderFreqOrLoad(freq([]), ctx(), true).tooltip;
    assert.deepEqual(lines(tooltip), [
      '### CPU Clock Frequency',
      '',
      '```text',
      'Clock   │ Frequency',
      '────────┼──────────',
      'Average │  3.00 GHz',
      'Peak    │  4.50 GHz',
      '```',
      ...FOOTER,
    ]);
  });

  test('per-core table split into two column pairs from 4 cores (splitColumns)', () => {
    // 5 cores: 3 rows, the right pair blank on the last one.
    assert.deepEqual(blockAfter(renderFreqOrLoad(freq([1e9, 2e9, 3e9, 4e9, 4.5e9]), ctx(), true).tooltip, '*Per-Core Clock:*'), [
      'Core │    Clock │ Core │    Clock',
      '─────┼──────────┼──────┼─────────',
      'C0   │ 1.00 GHz │ C3   │ 4.00 GHz',
      'C1   │ 2.00 GHz │ C4   │ 4.50 GHz',
      'C2   │ 3.00 GHz │      │         ',
    ]);
    // Below 4 cores one pair; 4 -> 2 + 2; 33 -> 17 + 16.
    const table = (n: number): string[] => blockAfter(renderFreqOrLoad(freq(Array(n).fill(2e9)), ctx(), true).tooltip, '*Per-Core Clock:*');
    assert.deepEqual(table(3), ['Core │    Clock', '─────┼─────────', 'C0   │ 2.00 GHz', 'C1   │ 2.00 GHz', 'C2   │ 2.00 GHz']);
    assert.deepEqual(table(1).length, 3, 'one core, one row');
    for (const [n, left] of [[4, 2], [33, 17]] as const) {
      const rows = table(n).slice(2).map((row) => row.split(' │ ').map((cell) => cell.trim()));
      assert.deepEqual(rows.map((r) => r[0]), coreLabels(0, left), `${n} cores: left`);
      assert.deepEqual(rows.map((r) => r[2]).filter(Boolean), coreLabels(left, n), `${n} cores: right`);
    }
  });
});

describe('renderMemory', () => {
  /** 8 of 16 GiB used, 1 of 2 GiB swap. */
  const linux: MemoryInfo = {
    totalBytes: 16 * GiB,
    availableBytes: 8 * GiB,
    usedBytes: 8 * GiB,
    usedPercent: 50,
    swapTotalBytes: 2 * GiB,
    swapFreeBytes: GiB,
    swapUsedBytes: GiB,
    swapUsedPercent: 50,
  };
  /** macOS adds memory pressure and the RAM breakdown. */
  const darwin: MemoryInfo = { ...linux, activeBytes: 4 * GiB, wiredBytes: 2 * GiB, compressedBytes: GiB, pressurePercent: 45 };

  test('status bar text per unit', () => {
    assert.equal(renderMemory(linux, ctx(), false).text, `$(ellipsis) ${FS}8.00/16.00 GB`);
    assert.equal(renderMemory(linux, ctx({ memUnit: 'MB' }), false).text, '$(ellipsis) 8192.00/16384.00 MB');
  });

  test('Linux shape: RAM and swap, no pressure, no breakdown', () => {
    const tooltip = renderMemory(linux, ctx(), true).tooltip;
    assert.deepEqual(blockAfter(tooltip, ''), [
      'Subsystem    │ Usage            │ Capacity / State  ',
      '─────────────┼──────────────────┼───────────────────',
      'Physical RAM │ [███░░░]   50.0% │ 8.00 GB / 16.00 GB',
      'Swap Space   │ [███░░░]   50.0% │ 1.00 GB / 2.00 GB ',
    ]);
    assert.ok(!tooltip!.includes('Breakdown'));
  });

  test('macOS shape: dynamic VM, pressure row and RAM breakdown', () => {
    const tooltip = renderMemory(darwin, ctx(), true).tooltip;
    assert.deepEqual(blockAfter(tooltip, '').slice(2), [
      'Physical RAM │ [███░░░]   50.0% │ 8.00 GB / 16.00 GB',
      'Dynamic VM   │ [███░░░]   50.0% │ 1.00 GB / 2.00 GB ',
      'Pressure     │ [███░░░]   45.0% │ Normal            ',
    ]);
    // Segments as shares of the total, a missing one (inactive here) left out.
    assert.deepEqual(blockAfter(tooltip, '*RAM Allocation Breakdown:*'), [
      'Segment    │ Allocation       │    Size',
      '───────────┼──────────────────┼────────',
      'Active     │ [██░░░░]   25.0% │ 4.00 GB',
      'Wired      │ [█░░░░░]   12.5% │ 2.00 GB',
      'Compressed │ [░░░░░░]    6.3% │ 1.00 GB',
    ]);
  });

  test('pressure level: from the system, else from the percentage', () => {
    const level = (mem: MemoryInfo): string | undefined =>
      lines(renderMemory(mem, ctx(), true).tooltip).find((l) => l.startsWith('Pressure '))?.split(' │ ')[2]?.trim();
    assert.equal(level({ ...darwin, pressurePercent: 59.9 }), 'Normal');
    assert.equal(level({ ...darwin, pressurePercent: 60 }), 'Warning');
    assert.equal(level({ ...darwin, pressurePercent: 80 }), 'Critical');
    assert.equal(level({ ...darwin, pressurePercent: 10, pressureLevel: 'Warning' }), 'Warning', 'the reported level wins');
  });

  test('breakdown: a segment of 0 bytes listed, a zero total not divided by', () => {
    const breakdown = blockAfter(renderMemory({ ...darwin, inactiveBytes: 0 }, ctx(), true).tooltip, '*RAM Allocation Breakdown:*');
    assert.equal(breakdown.at(-1), 'Inactive   │ [░░░░░░]    0.0% │  0.00 B');
    const tooltip = renderMemory({ ...darwin, totalBytes: 0 }, ctx(), true).tooltip!;
    assert.ok(!/NaN|Infinity/.test(tooltip), tooltip);
  });
});

describe('renderDisk', () => {
  const disk = (mountPath: string, totalGiB: number, freeGiB: number): DiskDriveInfo => ({
    mountPath,
    totalBytes: totalGiB * GiB,
    freeBytes: freeGiB * GiB,
    usedBytes: (totalGiB - freeGiB) * GiB,
    usedPercent: ((totalGiB - freeGiB) / totalGiB) * 100,
    freePercent: (freeGiB / totalGiB) * 100,
  });
  const root = disk('/', 500, 200);
  const data = disk('/Volumes/Data/', 1000, 100);
  const win = disk('D:\\', 100, 50);

  test('four formats, one disk', () => {
    const text = (diskFormat: MiraBarConfig['diskFormat']): string => renderDisk([root], ctx({ diskFormat }), false).text;
    assert.equal(text('PercentRemaining'), `$(database) ${FS}40.0% free`);
    assert.equal(text('PercentUsed'), `$(database) ${FS}60.0% used`);
    assert.equal(text('Remaining'), '$(database) 200.00 GB free');
    assert.equal(text('UsedOutOfTotal'), '$(database) 300.00 GB/500.00 GB');
  });

  test('several disks: All or MostFull, short names', () => {
    // Every disk by its last path segment (a trailing separator ignored), or only the most used one.
    assert.equal(renderDisk([root, data, win], ctx(), false).text, `$(database) /: ${FS}40.0% free | Data: ${FS}10.0% free | D:: ${FS}50.0% free`);
    assert.equal(renderDisk([root, data, win], ctx({ diskMultiDisplay: 'MostFull' }), false).text, `$(database) Data: ${FS}10.0% free`);
    assert.equal(renderDisk([root, win], ctx({ diskMultiDisplay: 'MostFull', diskFormat: 'PercentUsed' }), false).text, `$(database) /: ${FS}60.0% used`);
    // A single disk is shown without its name, whatever the mode.
    assert.equal(renderDisk([data], ctx({ diskMultiDisplay: 'MostFull' }), false).text, `$(database) ${FS}10.0% free`);
  });

  test('tooltip: one row per disk, long mount points truncated', () => {
    // Mount column 5 to 28 characters; a longer path keeps its trailing segments.
    const long = disk('/home/user/projects/very-long-mount-point-name', 1024, 256);
    const tooltip = renderDisk([root, long], ctx({ diskMultiDisplay: 'MostFull' }), true).tooltip;
    assert.deepEqual(lines(tooltip).slice(0, 2), ['### Storage Utilization', '']);
    assert.deepEqual(blockAfter(tooltip, ''), [
      'Mount                        │ Used Space       │ Available Space       ',
      '─────────────────────────────┼──────────────────┼───────────────────────',
      '/                            │ [████░░]   60.0% │ 200.00 GB of 500.00 GB',
      '.../ry-long-mount-point-name │ [█████░]   75.0% │ 256.00 GB of 1.00 TB  ',
    ]);
    assert.equal(blockAfter(renderDisk([root], ctx(), true).tooltip, '')[0], 'Mount │ Used Space       │ Available Space       ', 'Mount at its minimum width');
  });
});

describe('renderBattery', () => {
  const battery = (extra: Partial<BatteryInfo> = {}): BatteryInfo => ({ percent: 80, status: 'Discharging', ...extra });
  const rows = (bat: BatteryInfo): string[] => blockAfter(renderBattery(bat, ctx(), true).tooltip, '').slice(2);

  test('icon per state, percentage padded', () => {
    assert.equal(renderBattery(battery(), ctx(), false).text, `🔋 ${FS}80%`);
    assert.equal(renderBattery(battery({ status: 'Charging', isCharging: true }), ctx(), false).text, `$(zap) ${FS}80%`);
    assert.equal(renderBattery(battery({ percent: 100, status: 'Full' }), ctx(), false).text, '$(plug) 100%');
    assert.equal(renderBattery(battery({ percent: 5 }), ctx(), false).text, `🔋 ${FS}${FS}5%`);
  });

  test('capacities, nominal vs design, cycles', () => {
    // Charge as capacities when known, health as nominal (else maximum) over design capacity.
    assert.deepEqual(rows(battery({
      timeRemainingMinutes: 90, currentCapacity: 2760, maxCapacity: 3678, nominalCapacity: 3700, designCapacity: 3915, healthPercent: 94.5, cycleCount: 120,
    })), [
      'Charge Level      │ [█████░]   80.0% │ 2760 / 3678 mAh   ',
      'Nominal vs Design │ [██████]   94.5% │ 3700 / 3915 mAh   ',
      'Power State       │ Discharging      │ 1h 30m (remaining)',
      'Cycle Count       │ 120 cycles       │                   ',
    ]);
    const health = (extra: Partial<BatteryInfo>): string | undefined => rows(battery(extra)).find((r) => r.startsWith('Nominal vs Design'));
    assert.match(health({ healthPercent: 94, maxCapacity: 3678, designCapacity: 3915 })!, /│ 3678 \/ 3915 mAh\s*$/, 'maximum capacity without a nominal one');
    assert.match(health({ healthPercent: 94, maxCapacity: 45000, designCapacity: 50000, capacityUnit: 'mWh' })!, /│ 45000 \/ 50000 mWh\s*$/);
    assert.match(health({ healthPercent: 94 })!, /│ 94\.0%\s*$/, 'no design capacity: percentage');
    assert.equal(health({ healthPercent: 0 }), undefined, 'no health row without a health value');
    assert.match(rows(battery()).find((r) => r.startsWith('Charge Level'))!, /│ 80\.0%\s*$/, 'no capacities: percentage');
    // Cycles: 0 is a count, -1 or a missing value is not.
    const cycles = (cycleCount?: number): string | undefined => rows(battery({ cycleCount })).find((r) => r.startsWith('Cycle Count'));
    assert.match(cycles(0)!, /│ 0 cycles /);
    assert.equal(cycles(-1), undefined);
    assert.equal(cycles(), undefined);
  });

  test('power state and time', () => {
    const state = (extra: Partial<BatteryInfo>): string => rows(battery(extra)).find((r) => r.startsWith('Power State'))!.split(' │ ').slice(1).map((c) => c.trim()).join(' / ');
    assert.equal(state({ timeRemainingMinutes: 45 }), 'Discharging / 45m (remaining)');
    assert.equal(state({ status: 'Charging', isCharging: true, timeRemainingMinutes: 30 }), 'Charging / 30m (until full)');
    assert.equal(state({ timeRemainingMinutes: -1 }), 'Discharging / Estimating...');
    assert.equal(state({ status: 'Full', percent: 100 }), 'Full / Fully charged');
    assert.equal(state({ status: 'Charging', isCharging: true, timeRemainingMinutes: -1 }), 'Charging / AC Connected', 'no estimate while charging');
    assert.equal(state({ status: 'Not charging', timeRemainingMinutes: 0 }), 'Not charging / AC Connected');
  });
});

test('renderTemp: macOS rows (SoC die, NAND, battery cell)', () => {
  // Fixed limits per row (100, 75, 45 °C); NAND and battery cell left out when absent or 0.
  const tooltip = renderTemp({ tempCelsius: 45, peakCelsius: 62.5, nandCelsius: 37.5, batteryCelsius: 30 }, ctx(), true).tooltip;
  assert.deepEqual(blockAfter(tooltip, ''), [
    'Component       │ Heat Saturation  │    Temp │  Limit',
    '────────────────┼──────────────────┼─────────┼───────',
    'SoC Die Peak    │ [████░░]   62.5% │ 62.5 °C │ 100 °C',
    'SoC Die Average │ [███░░░]   45.0% │ 45.0 °C │ 100 °C',
    'NAND Flash SSD  │ [███░░░]   50.0% │ 37.5 °C │  75 °C',
    'Battery Cell    │ [████░░]   66.7% │ 30.0 °C │  45 °C',
  ]);
  const bare = blockAfter(renderTemp({ tempCelsius: 45, peakCelsius: 62.5, nandCelsius: 0 }, ctx(), true).tooltip, '');
  assert.deepEqual(bare.slice(2).map((r) => r.split(' │ ')[0]!.trim()), ['SoC Die Peak', 'SoC Die Average']);
  assert.equal(renderTemp({ tempCelsius: 45.678 }, ctx(), false).text, '$(flame) 45.68 C');
});
