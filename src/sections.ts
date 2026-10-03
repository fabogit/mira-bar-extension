/**
 * Section renderers: turn one reading into the status bar text and, when requested, the tooltip
 * Markdown. Pure functions (no VS Code API, no sampling), so every section renders the same way
 * whatever schedule triggered it.
 */
import { UNIT_DIVISORS, type MiraBarConfig, type TooltipSection } from './config.js';
import {
  formatBytes,
  formatMinutes,
  padNum,
  renderBar,
  renderDynamicAsciiTable,
  renderMonospaceTable,
  type ColumnDef,
} from './format.js';
import type { BatteryInfo, CpuTempInfo, CpuUsageInfo, DiskDriveInfo, FreqOrLoadInfo, MemoryInfo } from './types.js';

/** Output of a section renderer. */
export interface Rendered {
  /** Status bar text. */
  text: string;
  /** Tooltip Markdown, or null when the tooltip was not requested (the current one is kept). */
  tooltip: string | null;
}

/** Inputs shared by the renderers. */
export interface RenderContext {
  config: MiraBarConfig;
  /** Time of the reading shown, already formatted (e.g. '16:15:27' or '16:15:27.4'). */
  updatedAt: string;
  /** Platform topology description (e.g. 'Apple M4 (4P + 6E)'), if any. */
  topology?: string;
}

/** Full section names, as in the settings panel ('freq' is system load on macOS, frequency on Linux). */
export const SECTION_LABELS: Record<TooltipSection, (isDarwin: boolean) => string> = {
  cpu: () => 'CPU usage',
  freq: (isDarwin) => (isDarwin ? 'System load' : 'CPU frequency'),
  temp: () => 'Temperature',
  mem: () => 'Memory',
  battery: () => 'Battery',
  disk: () => 'Disk',
};

/**
 * Common tooltip footer: the time of the reading shown and the settings / refresh links, on two lines.
 *
 * @param updatedAt - Formatted time of the reading.
 */
export function tooltipFooter(updatedAt: string): string[] {
  return [
    '---',
    `*Updated at ${updatedAt}*`,
    '',
    '[$(gear) Settings](command:mirabar.openSettings) · [$(refresh) Refresh](command:mirabar.refresh)',
  ];
}

/** Limit of the CPU row when the kernel exposes no trip point, and bar scale of sensors without limits. */
const DEFAULT_TEMP_LIMIT_C = 100;

/** Bar plus right-aligned percentage, as used in every tooltip table. */
function barCell(pct: number): string {
  return `${renderBar(pct, 6, false)}  ${pct.toFixed(1).padStart(5, ' ')}%`;
}

/** CPU usage: overall percentage; tooltip with cluster summary and per-core breakdown. */
export function renderCpu(cpu: CpuUsageInfo, ctx: RenderContext, withTooltip: boolean): Rendered {
  const text = `$(pulse) ${padNum(cpu.overallPercent.toFixed(2), 5)}%`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const coreCount = cpu.perCorePercent.length;
  const lines = ['### CPU Utilization'];
  const context: string[] = [];
  if (ctx.topology) {
    context.push(ctx.topology);
  }
  if (coreCount > 0) {
    context.push(`${coreCount} logical cores`);
  }
  if (context.length > 0) {
    lines.push(context.join(' · '));
  }
  lines.push('');

  // Summary table in the same style as the other sections: overall load, then per cluster.
  const summaryRows: string[][] = [['Overall', barCell(cpu.overallPercent)]];
  const hasCoreTypes = Boolean(cpu.coreTypes && cpu.coreTypes.length === coreCount);
  if (hasCoreTypes) {
    for (const [type, label] of [['P', 'Performance'], ['E', 'Efficiency']] as const) {
      const values = cpu.perCorePercent.filter((_, idx) => cpu.coreTypes![idx] === type);
      if (values.length > 0) {
        summaryRows.push([label, barCell(values.reduce((a, b) => a + b, 0) / values.length)]);
      }
    }
  }
  lines.push(...renderDynamicAsciiTable([{ header: 'Cluster', align: 'left' }, { header: 'Load', align: 'left' }], summaryRows));
  lines.push('');

  const isTable = ctx.config.cpuTooltipLayout === 'Table';
  if (hasCoreTypes) {
    const pCores: { label: string; pct: number }[] = [];
    const eCores: { label: string; pct: number }[] = [];
    cpu.perCorePercent.forEach((pct, idx) => {
      if (cpu.coreTypes![idx] === 'P') {
        pCores.push({ label: `P${idx}`, pct });
      } else {
        eCores.push({ label: `E${idx}`, pct });
      }
    });
    if (isTable) {
      lines.push(...renderMonospaceTable('Performance Cores', 'Efficiency Cores', pCores, eCores));
    } else {
      if (pCores.length > 0) {
        lines.push('#### Performance Cores');
        for (const p of pCores) {
          lines.push(`- **Core ${p.label}**: ${renderBar(p.pct, 6)} ${padNum(p.pct.toFixed(1), 5)}%`);
        }
      }
      if (eCores.length > 0) {
        lines.push('#### Efficiency Cores');
        for (const e of eCores) {
          lines.push(`- **Core ${e.label}**: ${renderBar(e.pct, 6)} ${padNum(e.pct.toFixed(1), 5)}%`);
        }
      }
    }
  } else if (coreCount > 0) {
    if (isTable && coreCount >= 4) {
      const mid = Math.ceil(coreCount / 2);
      const left: { label: string; pct: number }[] = [];
      const right: { label: string; pct: number }[] = [];
      for (let idx = 0; idx < coreCount; idx++) {
        (idx < mid ? left : right).push({ label: `C${idx}`, pct: cpu.perCorePercent[idx]! });
      }
      lines.push(...renderMonospaceTable('Cluster 0', 'Cluster 1', left, right));
    } else {
      lines.push('*Per-Core Utilization:*');
      for (let idx = 0; idx < coreCount; idx++) {
        const pct = cpu.perCorePercent[idx]!;
        lines.push(`- **Core ${idx}**: ${renderBar(pct, 6)} ${padNum(pct.toFixed(1), 5)}%`);
      }
    }
  }
  lines.push(...tooltipFooter(ctx.updatedAt));
  return { text, tooltip: lines.join('\n') };
}

/** System load average (macOS) or CPU frequency (Linux). */
export function renderFreqOrLoad(info: FreqOrLoadInfo, ctx: RenderContext, withTooltip: boolean): Rendered {
  const config = ctx.config;
  if (info.kind === 'load') {
    const load = info.data;
    const pct = (v: number): number => Math.min(100, Math.max(0, (v / load.totalCores) * 100));
    const pct1 = pct(load.load1);
    const text =
      config.loadFormat === 'Percent' ? `$(dashboard) ${padNum(pct1.toFixed(1), 5)}% L` : `$(dashboard) ${padNum(load.load1.toFixed(2), 4)} L`;
    if (!withTooltip) {
      return { text, tooltip: null };
    }
    const columns: ColumnDef[] = [
      { header: 'Period', align: 'right' },
      { header: 'Load Capacity', align: 'left' },
      { header: 'Queue Depth', align: 'right' },
    ];
    const rows: string[][] = [
      ['1 min', barCell(pct1), `${load.load1.toFixed(2)} thr`],
      ['5 min', barCell(pct(load.load5)), `${load.load5.toFixed(2)} thr`],
      ['15 min', barCell(pct(load.load15)), `${load.load15.toFixed(2)} thr`],
    ];
    const tooltip = [
      '### System Load Average',
      `Normalized capacity across **${load.totalCores} logical cores**:`,
      '',
      ...renderDynamicAsciiTable(columns, rows),
      ...tooltipFooter(ctx.updatedAt),
    ].join('\n');
    return { text, tooltip };
  }

  const freq = info.data;
  const divisor = UNIT_DIVISORS[config.freqUnit] || UNIT_DIVISORS['GHz']!;
  const text = `$(dashboard) ${padNum((freq.avgHz / divisor).toFixed(2), config.freqUnit === 'MHz' ? 7 : 4)} ${config.freqUnit}`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const fmt = (hz: number): string => `${(hz / divisor).toFixed(2)} ${config.freqUnit}`;
  const lines = [
    '### CPU Clock Frequency',
    '',
    ...renderDynamicAsciiTable(
      [
        { header: 'Clock', align: 'left' },
        { header: 'Frequency', align: 'right' },
      ],
      [
        ['Average', fmt(freq.avgHz)],
        ['Peak', fmt(freq.maxHz)],
      ]
    ),
  ];
  if (freq.perCoreHz.length > 0) {
    const cores = freq.perCoreHz;
    const split = cores.length >= 4;
    const mid = split ? Math.ceil(cores.length / 2) : cores.length;
    const cols: ColumnDef[] = [
      { header: 'Core', align: 'left' },
      { header: 'Clock', align: 'right' },
    ];
    const rows: string[][] = [];
    for (let i = 0; i < mid; i++) {
      const row = [`C${i}`, fmt(cores[i]!)];
      if (split) {
        const j = i + mid;
        row.push(j < cores.length ? `C${j}` : '', j < cores.length ? fmt(cores[j]!) : '');
      }
      rows.push(row);
    }
    if (split) {
      cols.push({ header: 'Core', align: 'left' }, { header: 'Clock', align: 'right' });
    }
    lines.push('', '*Per-Core Clock:*', ...renderDynamicAsciiTable(cols, rows));
  }
  lines.push(...tooltipFooter(ctx.updatedAt));
  return { text, tooltip: lines.join('\n') };
}

/** Temperature: SoC die average/peak, NAND and battery cell on macOS; CPU package on Linux. */
export function renderTemp(temp: CpuTempInfo, ctx: RenderContext, withTooltip: boolean): Rendered {
  const text = `$(flame) ${padNum(temp.tempCelsius.toFixed(2), 5)} C`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const columns: ColumnDef[] = [
    { header: 'Component', align: 'left' },
    { header: 'Heat Saturation', align: 'left' },
    { header: 'Temp', align: 'right' },
    { header: 'Limit', align: 'right' },
  ];
  // Without a limit the bar is drawn against 100 °C and the Limit column shows a dash.
  const row = (label: string, celsius: number, limit: number | undefined): string[] => [
    label,
    barCell(Math.min(100, Math.max(0, (celsius / (limit ?? DEFAULT_TEMP_LIMIT_C)) * 100))),
    `${celsius.toFixed(1)} °C`,
    limit !== undefined ? `${Math.round(limit)} °C` : '—',
  ];
  const rows: string[][] = [];
  const aboveMax: string[] = [];
  if (temp.peakCelsius !== undefined) {
    rows.push(row('SoC Die Peak', temp.peakCelsius, 100), row('SoC Die Average', temp.tempCelsius, 100));
    if (temp.nandCelsius !== undefined && temp.nandCelsius > 0) {
      rows.push(row('NAND Flash SSD', temp.nandCelsius, 75));
    }
    if (temp.batteryCelsius !== undefined && temp.batteryCelsius > 0) {
      rows.push(row('Battery Cell', temp.batteryCelsius, 45));
    }
  } else {
    rows.push(row('CPU Package', temp.tempCelsius, temp.critCelsius ?? DEFAULT_TEMP_LIMIT_C));
    for (const s of temp.sensors ?? []) {
      rows.push(row(s.label, s.celsius, s.critCelsius ?? s.maxCelsius));
      if (s.maxCelsius !== undefined && s.celsius >= s.maxCelsius) {
        aboveMax.push(`${s.label} (max ${Math.round(s.maxCelsius)} °C)`);
      }
    }
  }
  const lines = ['### CPU & System Temperature', '', ...renderDynamicAsciiTable(columns, rows)];
  if (aboveMax.length > 0) {
    lines.push('', `*Above the operating maximum: ${aboveMax.join(', ')}.*`);
  }
  const tooltip = [...lines, ...tooltipFooter(ctx.updatedAt)].join('\n');
  return { text, tooltip };
}

/** Memory and swap, with memory pressure and RAM breakdown on macOS. */
export function renderMemory(mem: MemoryInfo, ctx: RenderContext, withTooltip: boolean): Rendered {
  const config = ctx.config;
  const divisor = UNIT_DIVISORS[config.memUnit] || UNIT_DIVISORS['GB']!;
  const used = padNum((mem.usedBytes / divisor).toFixed(2), 5);
  const total = padNum((mem.totalBytes / divisor).toFixed(2), 5);
  const text = `$(ellipsis) ${used}/${total} ${config.memUnit}`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const lines = ['### Memory Usage', ''];
  const statusCols: ColumnDef[] = [
    { header: 'Subsystem', align: 'left' },
    { header: 'Usage', align: 'left' },
    { header: 'Capacity / State', align: 'left' },
  ];
  const statusRows: string[][] = [
    ['Physical RAM', barCell(mem.usedPercent), `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}`],
    [
      mem.pressurePercent !== undefined ? 'Dynamic VM' : 'Swap Space',
      barCell(mem.swapUsedPercent),
      `${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`,
    ],
  ];
  if (mem.pressurePercent !== undefined) {
    const pressureLabel = mem.pressureLevel ?? (mem.pressurePercent < 60 ? 'Normal' : mem.pressurePercent < 80 ? 'Warning' : 'Critical');
    statusRows.push(['Pressure', barCell(mem.pressurePercent), pressureLabel]);
  }
  lines.push(...renderDynamicAsciiTable(statusCols, statusRows));

  if (mem.activeBytes !== undefined || mem.wiredBytes !== undefined || mem.compressedBytes !== undefined) {
    lines.push('', '*RAM Allocation Breakdown:*');
    const totalBytes = mem.totalBytes > 0 ? mem.totalBytes : 1;
    const allocCols: ColumnDef[] = [
      { header: 'Segment', align: 'left' },
      { header: 'Allocation', align: 'left' },
      { header: 'Size', align: 'right' },
    ];
    const allocRows: string[][] = [];
    for (const [label, bytes] of [
      ['Active', mem.activeBytes],
      ['Wired', mem.wiredBytes],
      ['Compressed', mem.compressedBytes],
      ['Inactive', mem.inactiveBytes],
    ] as const) {
      if (bytes !== undefined) {
        allocRows.push([label, barCell((bytes / totalBytes) * 100), formatBytes(bytes)]);
      }
    }
    lines.push(...renderDynamicAsciiTable(allocCols, allocRows));
  }
  lines.push(...tooltipFooter(ctx.updatedAt));
  return { text, tooltip: lines.join('\n') };
}

/** Battery: charge, power state and time remaining; capacities and cycles when available. */
export function renderBattery(bat: BatteryInfo, ctx: RenderContext, withTooltip: boolean): Rendered {
  let icon = '$(plug)';
  if (bat.isCharging) {
    icon = '$(zap)';
  } else if (bat.status === 'Discharging') {
    icon = '🔋';
  }
  const text = `${icon} ${padNum(String(bat.percent), 3)}%`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const cols: ColumnDef[] = [
    { header: 'Metric', align: 'left' },
    { header: 'Level / State', align: 'left' },
    { header: 'Details / Capacity', align: 'left' },
  ];
  const rows: string[][] = [];
  const unit = bat.capacityUnit ?? 'mAh';
  const chargeDetail =
    bat.currentCapacity && bat.maxCapacity ? `${bat.currentCapacity} / ${bat.maxCapacity} ${unit}` : `${bat.percent.toFixed(1)}%`;
  rows.push(['Charge Level', barCell(bat.percent), chargeDetail]);

  if (bat.healthPercent !== undefined && bat.healthPercent > 0) {
    const healthCapacity = bat.nominalCapacity ?? bat.maxCapacity;
    const healthDetail =
      bat.designCapacity && healthCapacity ? `${healthCapacity} / ${bat.designCapacity} ${unit}` : `${bat.healthPercent.toFixed(1)}%`;
    // Nominal full-charge capacity vs design capacity. macOS "Maximum Capacity" uses an internal
    // calculation that is not exposed to apps, so the label says what this is.
    rows.push(['Nominal vs Design', barCell(bat.healthPercent), healthDetail]);
  }

  let timeStr: string;
  if (bat.timeRemainingMinutes !== undefined && bat.timeRemainingMinutes > 0) {
    timeStr = `${formatMinutes(bat.timeRemainingMinutes)} (${bat.isCharging ? 'until full' : 'remaining'})`;
  } else if (bat.timeRemainingMinutes === -1 && bat.status === 'Discharging') {
    timeStr = 'Estimating...';
  } else {
    timeStr = bat.status === 'Full' ? 'Fully charged' : 'AC Connected';
  }
  rows.push(['Power State', bat.status, timeStr]);

  if (bat.cycleCount !== undefined && bat.cycleCount >= 0) {
    rows.push(['Cycle Count', `${bat.cycleCount} cycles`, 'Condition: Normal']);
  }
  const tooltip = ['### Battery Status & Health', '', ...renderDynamicAsciiTable(cols, rows), ...tooltipFooter(ctx.updatedAt)].join('\n');
  return { text, tooltip };
}

/** Last path segment of a mount point, for compact multi-disk texts. */
function shortDiskName(mountPath: string): string {
  if (mountPath === '/' || mountPath === '') {
    return '/';
  }
  const clean = mountPath.endsWith('/') ? mountPath.slice(0, -1) : mountPath;
  const parts = clean.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? mountPath;
}

/** Disk space of one or more mount points (non-empty list). */
export function renderDisk(disks: DiskDriveInfo[], ctx: RenderContext, withTooltip: boolean): Rendered {
  const config = ctx.config;
  const metric = (d: DiskDriveInfo): string => {
    switch (config.diskFormat) {
      case 'PercentRemaining':
        return `${padNum(d.freePercent.toFixed(1), 5)}% free`;
      case 'PercentUsed':
        return `${padNum(d.usedPercent.toFixed(1), 5)}% used`;
      case 'Remaining':
        return `${formatBytes(d.freeBytes)} free`;
      case 'UsedOutOfTotal':
        return `${formatBytes(d.usedBytes)}/${formatBytes(d.totalBytes)}`;
    }
  };
  let display: string;
  if (disks.length === 1) {
    display = metric(disks[0]!);
  } else if (config.diskMultiDisplay === 'MostFull') {
    const worst = disks.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    display = `${shortDiskName(worst.mountPath)}: ${metric(worst)}`;
  } else {
    display = disks.map((d) => `${shortDiskName(d.mountPath)}: ${metric(d)}`).join(' | ');
  }
  const text = `$(database) ${display}`;
  if (!withTooltip) {
    return { text, tooltip: null };
  }
  const cols: ColumnDef[] = [
    { header: 'Mount', align: 'left', minWidth: 5, maxWidth: 28, truncatePath: true },
    { header: 'Used Space', align: 'left' },
    { header: 'Available Space', align: 'left' },
  ];
  const rows = disks.map((d) => [d.mountPath, barCell(d.usedPercent), `${formatBytes(d.freeBytes)} of ${formatBytes(d.totalBytes)}`]);
  const tooltip = ['### Storage Utilization', '', ...renderDynamicAsciiTable(cols, rows), ...tooltipFooter(ctx.updatedAt)].join('\n');
  return { text, tooltip };
}
