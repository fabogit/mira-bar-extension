import * as vscode from 'vscode';
import { getConfig, UNIT_DIVISORS } from './config.js';
import { createPlatformProvider } from './platform/factory.js';
import { DiskProvider } from './disk/disk_provider.js';
import type { BatteryInfo, DiskDriveInfo } from './types.js';

let updateTimer: NodeJS.Timeout | null = null;
let disposed = false;
let isUpdating = false;
let pendingForceUpdate = false;
let lastUpdateError = '';
/** Slow metrics are sampled on a time basis, independent of the polling interval (a click forces all). */
const BATTERY_REFRESH_MS = 5_000;
const DISK_REFRESH_MS = 10_000;
/** Tooltip regeneration: Static refreshes slowly to limit hover flicker; Live is throttled to 1 s. */
const STATIC_TOOLTIP_REFRESH_MS = 5_000;
const LIVE_TOOLTIP_REFRESH_MS = 1_000;

let lastBatterySampleAt = 0;
let lastDiskSampleAt = 0;
let lastTooltipRefreshAt = 0;
let tooltipUpdatedAt = '';
let cachedBattery: BatteryInfo | null = null;
let cachedDisks: DiskDriveInfo[] = [];

interface StatusBarWidgets {
  cpu: vscode.StatusBarItem;
  freq: vscode.StatusBarItem;
  temp: vscode.StatusBarItem;
  mem: vscode.StatusBarItem;
  battery: vscode.StatusBarItem;
  disk: vscode.StatusBarItem;
}

let widgets: StatusBarWidgets | null = null;

/**
 * Disposes the currently active status bar widgets, if any.
 * Registered once in `context.subscriptions`, so recreated widgets never accumulate there.
 */
function disposeWidgets(): void {
  if (widgets) {
    for (const item of Object.values(widgets)) {
      item.dispose();
    }
    widgets = null;
  }
}
const visibleSet = new WeakSet<vscode.StatusBarItem>();

/**
 * Formats a raw byte count into a human-readable string with dynamic unit scaling (B, KB, MB, GB, TB).
 *
 * @param bytes - The size in bytes to format.
 * @param precision - Number of decimal places to include (default: 2).
 * @returns Formatted size string (e.g. '16.42 GB').
 */
function formatBytes(bytes: number, precision = 2): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let unitIndex = 0;

  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }

  return `${val.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Formats a duration in minutes into a human-readable string (e.g. '1h 24m').
 *
 * @param minutes - Total duration in minutes.
 * @returns Formatted duration string or 'Estimating...'.
 */
function formatMinutes(minutes: number): string {
  if (minutes < 0) {
    return 'Estimating...';
  }
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m`;
}


/**
 * Formats a local wall-clock time as HH:MM:SS (24h), independent of the host locale.
 *
 * @param date - Time to format.
 * @returns Formatted time string (e.g. '16:15:27').
 */
function formatClock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Renders a fixed-width Unicode progress bar (e.g. '[████░░░░]').
 *
 * @param percent - Value between 0 and 100.
 * @param width - Character length of the bar (default: 8).
 * @param codeWrapped - Whether to wrap the inner bar in markdown code ticks (default: true).
 * @returns Formatted progress bar string.
 */
function renderBar(percent: number, width = 8, codeWrapped = true): string {
  const clamped = isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;
  const bar = `${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}`;
  return codeWrapped ? `[\`${bar}\`]` : `[${bar}]`;
}

/**
 * Renders two columns of core utilization in a fixed-width monospace block
 * using box-drawing characters for pixel-perfect vertical alignment without horizontal jitter.
 *
 * @param leftTitle - Header title for the left column.
 * @param rightTitle - Header title for the right column.
 * @param leftCores - List of cores for the left column.
 * @param rightCores - List of cores for the right column.
 * @returns Formatted Markdown code block lines.
 */
function renderMonospaceTable(
  leftTitle: string,
  rightTitle: string,
  leftCores: { label: string; pct: number }[],
  rightCores: { label: string; pct: number }[]
): string[] {
  const colWidth = 23;
  const maxRows = Math.max(leftCores.length, rightCores.length);
  const lines: string[] = ['```text'];

  const leftHeader = leftTitle.padEnd(colWidth, ' ');
  const rightHeader = rightTitle.padEnd(colWidth, ' ');
  lines.push(`${leftHeader} │ ${rightHeader}`);
  lines.push(`${'─'.repeat(colWidth)}─┼─${'─'.repeat(colWidth)}`);

  for (let r = 0; r < maxRows; r++) {
    const left = leftCores[r];
    const right = rightCores[r];

    let leftCell = ''.padEnd(colWidth, ' ');
    if (left) {
      const label = left.label.padEnd(3, ' ');
      const bar = renderBar(left.pct, 6, false);
      const pctStr = left.pct.toFixed(1).padStart(5, ' ');
      leftCell = `${label}: ${bar} ${pctStr}%`.padEnd(colWidth, ' ');
    }

    let rightCell = '';
    if (right) {
      const label = right.label.padEnd(3, ' ');
      const bar = renderBar(right.pct, 6, false);
      const pctStr = right.pct.toFixed(1).padStart(5, ' ');
      rightCell = `${label}: ${bar} ${pctStr}%`;
    }

    lines.push(`${leftCell} │ ${rightCell}`);
  }

  lines.push('```');
  return lines;
}

/**
 * Truncates a filesystem path preserving directory boundaries and at least one leading slash.
 * If space permits, additional parent directory segments are included.
 *
 * @param path - Absolute or relative filesystem path.
 * @param maxLength - Maximum allowed string length.
 * @returns Truncated path string (e.g. '.../kind-newton' or '.../antigravity/kind-newton').
 */
function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }
  if (maxLength <= 4) {
    return path.slice(-maxLength);
  }

  const sep = path.includes('\\') ? '\\' : '/';
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const parts = trimmed.split(sep).filter(Boolean);
  if (parts.length === 0) {
    return path.slice(-maxLength);
  }

  let result = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = sep + parts[i] + result;
    if (3 + candidate.length <= maxLength) {
      result = candidate;
    } else {
      break;
    }
  }

  if (result.length > 0) {
    return '...' + result;
  }

  // If even the leaf directory with .../ exceeds maxLength, truncate inside leaf but keep .../
  const lastPart = parts[parts.length - 1]!;
  const prefix = '...' + sep;
  if (maxLength > prefix.length) {
    return prefix + lastPart.slice(-(maxLength - prefix.length));
  }
  return path.slice(-maxLength);
}

/**
 * Definition of a column for dynamic ASCII table generation.
 */
interface ColumnDef {
  header: string;
  align?: 'left' | 'right';
  minWidth?: number;
  maxWidth?: number;
  truncatePath?: boolean;
}

/**
 * Renders an ASCII table inside a markdown code block with automatically calculated
 * column widths, boundary clamping, and box-drawing characters.
 *
 * @param columns - Array of column definitions.
 * @param rows - 2D array of string cell values.
 * @returns Formatted Markdown code block lines.
 */
function renderDynamicAsciiTable(
  columns: ColumnDef[],
  rows: string[][]
): string[] {
  // 1. Calculate optimal width for each column
  const colWidths = columns.map((col, cIdx) => {
    let maxLen = col.header.length;
    for (const row of rows) {
      let val = row[cIdx] ?? '';
      if (col.maxWidth && val.length > col.maxWidth) {
        val = col.truncatePath
          ? truncatePath(val, col.maxWidth)
          : val.slice(0, Math.max(0, col.maxWidth - 3)) + '...';
      }
      if (val.length > maxLen) {
        maxLen = val.length;
      }
    }
    if (col.minWidth && maxLen < col.minWidth) {
      maxLen = col.minWidth;
    }
    if (col.maxWidth && maxLen > col.maxWidth) {
      maxLen = col.maxWidth;
    }
    return maxLen;
  });

  const lines: string[] = ['```text'];

  // 2. Format header
  const headerCells = columns.map((col, idx) => {
    const w = colWidths[idx]!;
    return col.align === 'right' ? col.header.padStart(w, ' ') : col.header.padEnd(w, ' ');
  });
  lines.push(headerCells.join(' │ '));

  // 3. Format divider line
  const dividerCells = colWidths.map((w) => '─'.repeat(w));
  lines.push(dividerCells.join('─┼─'));

  // 4. Format rows
  for (const row of rows) {
    const rowCells = columns.map((col, idx) => {
      const w = colWidths[idx]!;
      let val = row[idx] ?? '';
      if (val.length > w) {
        val = col.truncatePath
          ? truncatePath(val, w)
          : val.slice(0, Math.max(0, w - 3)) + '...';
      }
      return col.align === 'right' ? val.padStart(w, ' ') : val.padEnd(w, ' ');
    });
    lines.push(rowCells.join(' │ '));
  }

  lines.push('```');
  return lines;
}

/**
 * Pads a numeric string with Unicode Figure Spaces (U+2007) so it maintains fixed tabular width
 * in proportional UI fonts without collapsing or jittering when numbers shift between digits.
 *
 * @param str - The formatted number string (e.g. '8.45').
 * @param targetLength - Desired character count for the numeric part.
 * @returns String padded with figure spaces on the left.
 */
function padNum(str: string, targetLength: number): string {
  return str.padStart(targetLength, '\u2007');
}

/**
 * Updates a StatusBarItem's text, tooltip, and visibility idempotently.
 *
 * Utilizes content diffing to avoid redundant DOM mutations and prevents destroying
 * active HoverWidget popups in VS Code's Chromium UI thread.
 *
 * @param item - Target status bar item.
 * @param text - Display text including Codicons and fixed-width numbers.
 * @param tooltipMd - Markdown-formatted string for the hover tooltip, or null to leave current tooltip unchanged.
 * @param shouldShow - Whether the item should be rendered in the status bar.
 */
function updateWidget(
  item: vscode.StatusBarItem,
  text: string,
  tooltipMd: string | null,
  shouldShow: boolean
): void {
  if (!shouldShow) {
    if (visibleSet.has(item)) {
      item.hide();
      visibleSet.delete(item);
    }
    return;
  }

  if (item.text !== text) {
    item.text = text;
  }

  if (tooltipMd !== null) {
    const currentMd =
      item.tooltip instanceof vscode.MarkdownString
        ? item.tooltip.value
        : typeof item.tooltip === 'string'
        ? item.tooltip
        : '';

    if (currentMd !== tooltipMd) {
      const md = new vscode.MarkdownString(tooltipMd);
      md.isTrusted = true;
      item.tooltip = md;
    }
  }

  if (!visibleSet.has(item)) {
    item.show();
    visibleSet.add(item);
  }
}

/**
 * Generates the common Markdown footer for tooltips, reflecting the active display mode
 * and providing interactive command links to toggle settings.
 *
 * @param mode - The currently active tooltip mode ('Static' | 'Live').
 * @param extraCommand - Optional secondary command toggle (e.g. CPU layout switch or load format).
 * @returns Array of markdown lines for the tooltip footer.
 */
function getTooltipFooter(
  mode: 'Static' | 'Live',
  extraCommand?: { label: string; command: string; prefix?: string }
): string[] {
  const nextMode = mode === 'Static' ? 'Live' : 'Static';
  const lines = [
    '---',
    `- **Tooltip Mode**: \`${mode}\` ([Switch to ${nextMode}](command:resmon.toggleTooltipMode))`,
  ];
  if (extraCommand) {
    const prefix = extraCommand.prefix ?? 'CPU Layout';
    lines.push(`- **${prefix}**: [${extraCommand.label}](command:${extraCommand.command})`);
  }
  const refresh = mode === 'Static'
    ? `refreshes every ${STATIC_TOOLTIP_REFRESH_MS / 1000} s, click widget to refresh now`
    : 'auto-refreshing';
  lines.push('', `*Updated at ${tooltipUpdatedAt} (${refresh})*`);
  return lines;
}

/**
 * Creates individual StatusBarItem widgets with sequential priorities.
 *
 * @param alignment - Status bar alignment side (Left or Right).
 * @param basePriority - Base priority number for positioning.
 * @returns Object holding all 6 StatusBarItem instances.
 */
function createWidgets(
  alignment: 'Left' | 'Right',
  basePriority: number
): StatusBarWidgets {
  const align = alignment === 'Right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
  const isLeft = alignment === 'Left';

  const w: StatusBarWidgets = {
    cpu: vscode.window.createStatusBarItem(align, isLeft ? basePriority : basePriority + 5),
    freq: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 1 : basePriority + 4),
    temp: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 2 : basePriority + 3),
    mem: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 3 : basePriority + 2),
    battery: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 4 : basePriority + 1),
    disk: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 5 : basePriority),
  };

  for (const item of Object.values(w)) {
    item.command = 'resmon.refresh';
  }

  return w;
}

/**
 * Extension entry point invoked by VS Code when the extension is activated.
 *
 * Initializes independent Status Bar widgets for each resource component with focused tooltips,
 * registers commands and configuration listeners, and starts the polling loop.
 *
 * @param context - Extension runtime context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('[Resource Monitor NG] Activated successfully');

  disposed = false;
  pendingForceUpdate = false;
  lastUpdateError = '';
  const log = vscode.window.createOutputChannel('Resource Monitor NG', { log: true });
  context.subscriptions.push(log);
  let currentConfig = getConfig();
  widgets = createWidgets(currentConfig.alignment, currentConfig.priority);
  context.subscriptions.push({ dispose: disposeWidgets });

  const platformProvider = createPlatformProvider();
  const diskProvider = new DiskProvider();

  /**
   * Executes a polling tick across active resource providers and updates individual widgets.
   *
   * Fast in-memory telemetry (CPU, Freq/Load, Temp, RAM) is polled on every tick.
   * Slow or I/O-intensive telemetry (Battery, Disk) is decimated if updateFrequencyMs < 1000.
   * Tooltip Markdown content is refreshed on every tick in 'Live' mode, or on-demand when forceAll is true in 'Static' mode.
   *
   * @param forceAll - When true, bypasses tick decimation and forces all providers and tooltips to refresh.
   */
  async function update(forceAll = false): Promise<void> {
    if (disposed || !widgets) {
      return;
    }
    if (isUpdating) {
      // Do not drop an explicit refresh: run it as soon as the current tick completes.
      if (forceAll) {
        pendingForceUpdate = true;
      }
      return;
    }
    isUpdating = true;

    try {
      const config = getConfig();
      const now = Date.now();
      const tooltipRefreshMs = config.tooltipMode === 'Live' ? LIVE_TOOLTIP_REFRESH_MS : STATIC_TOOLTIP_REFRESH_MS;
      const updateTooltips = forceAll || now - lastTooltipRefreshAt >= tooltipRefreshMs;
      if (updateTooltips) {
        lastTooltipRefreshAt = now;
        tooltipUpdatedAt = formatClock(new Date(now));
      }

      // 1. CPU Usage & 2. CPU Frequency (Linux) or System Load Average (macOS)
      const cpuUsage = platformProvider.sampleCpu();
      const freqOrLoad = platformProvider.sampleFreqOrLoad();

      if (cpuUsage && config.showCpuUsage) {
        const cpuStr = padNum(cpuUsage.overallPercent.toFixed(2), 5);
        let cpuMd: string | null = null;
        if (updateTooltips) {
          const topoDesc = platformProvider.getTopologyDescription ? platformProvider.getTopologyDescription() : '';
          const lines = [
            `### CPU Utilization: ${cpuUsage.overallPercent.toFixed(1)}%`,
            '',
            '**Overall Load**:',
            `${renderBar(cpuUsage.overallPercent, 8)} **${cpuUsage.overallPercent.toFixed(1)}%**`,
          ];
          if (topoDesc) {
            lines.push(`Hardware: \`${topoDesc}\``);
          }
          lines.push('---');

          const hasCoreTypes = Boolean(cpuUsage.coreTypes && cpuUsage.coreTypes.length === cpuUsage.perCorePercent.length);
          const isTable = config.cpuTooltipLayout === 'Table';

          if (hasCoreTypes) {
            const pCores: { label: string; pct: number }[] = [];
            const eCores: { label: string; pct: number }[] = [];
            cpuUsage.perCorePercent.forEach((pct, idx) => {
              if (cpuUsage.coreTypes![idx] === 'P') {
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
          } else if (cpuUsage.perCorePercent.length > 0) {
            if (isTable && cpuUsage.perCorePercent.length >= 4) {
              const mid = Math.ceil(cpuUsage.perCorePercent.length / 2);
              const left: { label: string; pct: number }[] = [];
              const right: { label: string; pct: number }[] = [];
              for (let idx = 0; idx < cpuUsage.perCorePercent.length; idx++) {
                const item = { label: `C${idx}`, pct: cpuUsage.perCorePercent[idx]! };
                if (idx < mid) {
                  left.push(item);
                } else {
                  right.push(item);
                }
              }
              lines.push(...renderMonospaceTable('Cluster 0', 'Cluster 1', left, right));
            } else {
              lines.push('*Per-Core Utilization:*');
              for (let idx = 0; idx < cpuUsage.perCorePercent.length; idx++) {
                const pct = cpuUsage.perCorePercent[idx]!;
                lines.push(`- **Core ${idx}**: ${renderBar(pct, 6)} ${padNum(pct.toFixed(1), 5)}%`);
              }
            }
          }

          const layoutToggle = {
            label: isTable ? 'Switch to Vertical List' : 'Switch to Compact Table',
            command: 'resmon.toggleCpuLayout',
            prefix: 'CPU Layout',
          };
          lines.push(...getTooltipFooter(config.tooltipMode, layoutToggle));
          cpuMd = lines.join('\n');
        }
        updateWidget(widgets.cpu, `$(pulse) ${cpuStr}%`, cpuMd, true);
      } else {
        updateWidget(widgets.cpu, '', '', false);
      }

      // 2. CPU Frequency (Linux) or System Load Average (macOS)
      if (freqOrLoad && config.showCpuFreq) {
        if (freqOrLoad.kind === 'load') {
          const load = freqOrLoad.data;
          const pct1 = Math.min(100, Math.max(0, (load.load1 / load.totalCores) * 100));
          const pct5 = Math.min(100, Math.max(0, (load.load5 / load.totalCores) * 100));
          const pct15 = Math.min(100, Math.max(0, (load.load15 / load.totalCores) * 100));

          const loadStr = config.loadFormat === 'Percent'
            ? `${padNum(pct1.toFixed(1), 5)}% L`
            : `${padNum(load.load1.toFixed(2), 4)} L`;

          let loadMd: string | null = null;
          if (updateTooltips) {
            const formatToggle = {
              label: config.loadFormat === 'Percent' ? 'Switch to Raw Value' : 'Switch to Normalized %',
              command: 'resmon.toggleLoadFormat',
              prefix: 'Load Format',
            };

            const loadColumns: ColumnDef[] = [
              { header: 'Period', align: 'right' },
              { header: 'Load Capacity', align: 'left' },
              { header: 'Queue Depth', align: 'right' },
            ];
            const loadRows: string[][] = [
              ['1 min', `${renderBar(pct1, 6, false)}  ${pct1.toFixed(1).padStart(5, ' ')}%`, `${load.load1.toFixed(2)} thr`],
              ['5 min', `${renderBar(pct5, 6, false)}  ${pct5.toFixed(1).padStart(5, ' ')}%`, `${load.load5.toFixed(2)} thr`],
              ['15 min', `${renderBar(pct15, 6, false)}  ${pct15.toFixed(1).padStart(5, ' ')}%`, `${load.load15.toFixed(2)} thr`],
            ];

            loadMd = [
              '### System Load Average',
              `Normalized capacity across **${load.totalCores} logical cores**:`,
              '',
              ...renderDynamicAsciiTable(loadColumns, loadRows),
              ...getTooltipFooter(config.tooltipMode, formatToggle),
            ].join('\n');
          }
          updateWidget(widgets.freq, `$(dashboard) ${loadStr}`, loadMd, true);
        } else {
          const cpuFreq = freqOrLoad.data;
          const divisor = UNIT_DIVISORS[config.freqUnit] || UNIT_DIVISORS['GHz']!;
          const freqStr = padNum((cpuFreq.avgHz / divisor).toFixed(2), config.freqUnit === 'MHz' ? 7 : 4);
          let freqMd: string | null = null;
          if (updateTooltips) {
            const lines = [
              '### CPU Clock Frequency',
              '',
              '**Average Clock**:',
              `${(cpuFreq.avgHz / divisor).toFixed(2)} ${config.freqUnit}`,
              `Peak Clock: ${(cpuFreq.maxHz / divisor).toFixed(2)} ${config.freqUnit}`,
            ];
            if (cpuFreq.perCoreHz.length > 0) {
              lines.push('---', '*Core Clock Speeds:*');
              const coreFreqs = cpuFreq.perCoreHz.map((hz, idx) => {
                return `- **Core ${idx}**: ${(hz / divisor).toFixed(2)} ${config.freqUnit}`;
              });
              lines.push(...coreFreqs);
            }
            lines.push(...getTooltipFooter(config.tooltipMode));
            freqMd = lines.join('\n');
          }
          updateWidget(widgets.freq, `$(dashboard) ${freqStr} ${config.freqUnit}`, freqMd, true);
        }
      } else {
        updateWidget(widgets.freq, '', '', false);
      }

      // 3. CPU & System Temperature (4-metric synthesis on Darwin)
      const cpuTemp = config.showCpuTemp ? platformProvider.sampleTemp() : null;
      if (cpuTemp) {
        const tempStr = padNum(cpuTemp.tempCelsius.toFixed(2), 5);
        let tempMd: string | null = null;
        if (updateTooltips) {
          const tempColumns: ColumnDef[] = [
            { header: 'Component', align: 'left' },
            { header: 'Heat Saturation', align: 'left' },
            { header: 'Temp', align: 'right' },
            { header: 'Limit', align: 'right' },
          ];
          const tempRows: string[][] = [];

          if (cpuTemp.peakCelsius !== undefined) {
            const diePeakPct = Math.min(100, Math.max(0, (cpuTemp.peakCelsius / 100) * 100));
            const dieAvgPct = Math.min(100, Math.max(0, (cpuTemp.tempCelsius / 100) * 100));

            tempRows.push([
              'SoC Die Peak',
              `${renderBar(diePeakPct, 6, false)}  ${diePeakPct.toFixed(1).padStart(5, ' ')}%`,
              `${cpuTemp.peakCelsius.toFixed(1)} °C`,
              '100 °C',
            ]);
            tempRows.push([
              'SoC Die Average',
              `${renderBar(dieAvgPct, 6, false)}  ${dieAvgPct.toFixed(1).padStart(5, ' ')}%`,
              `${cpuTemp.tempCelsius.toFixed(1)} °C`,
              '100 °C',
            ]);

            if (cpuTemp.nandCelsius !== undefined && cpuTemp.nandCelsius > 0) {
              const nandPct = Math.min(100, Math.max(0, (cpuTemp.nandCelsius / 75) * 100));
              tempRows.push([
                'NAND Flash SSD',
                `${renderBar(nandPct, 6, false)}  ${nandPct.toFixed(1).padStart(5, ' ')}%`,
                `${cpuTemp.nandCelsius.toFixed(1)} °C`,
                '75 °C',
              ]);
            }

            if (cpuTemp.batteryCelsius !== undefined && cpuTemp.batteryCelsius > 0) {
              const batPct = Math.min(100, Math.max(0, (cpuTemp.batteryCelsius / 45) * 100));
              tempRows.push([
                'Battery Cell',
                `${renderBar(batPct, 6, false)}  ${batPct.toFixed(1).padStart(5, ' ')}%`,
                `${cpuTemp.batteryCelsius.toFixed(1)} °C`,
                '45 °C',
              ]);
            }
          } else {
            const tempPct = Math.min(100, Math.max(0, (cpuTemp.tempCelsius / 100) * 100));
            tempRows.push([
              'CPU Package',
              `${renderBar(tempPct, 6, false)}  ${tempPct.toFixed(1).padStart(5, ' ')}%`,
              `${cpuTemp.tempCelsius.toFixed(1)} °C`,
              '100 °C',
            ]);
          }

          const tempLines = [
            '### CPU & System Temperature',
            '',
            ...renderDynamicAsciiTable(tempColumns, tempRows),
            ...getTooltipFooter(config.tooltipMode),
          ];
          tempMd = tempLines.join('\n');
        }
        updateWidget(widgets.temp, `$(flame) ${tempStr} C`, tempMd, true);
      } else {
        updateWidget(widgets.temp, '', '', false);
      }

      // 4. Memory & Swap (with Memory Pressure on macOS)
      const mem = platformProvider.sampleMemory();
      if (mem && config.showMem) {
        const divisor = UNIT_DIVISORS[config.memUnit] || UNIT_DIVISORS['GB']!;
        const usedStr = padNum((mem.usedBytes / divisor).toFixed(2), 5);
        const totalStr = padNum((mem.totalBytes / divisor).toFixed(2), 5);
        let memMd: string | null = null;
        if (updateTooltips) {
          const swapType = mem.pressurePercent !== undefined ? 'Dynamic VM' : 'Swap Space';
          const memLines = [
            '### Memory Usage',
            '',
          ];

          // Table 1: Global System Memory Status
          const statusCols: ColumnDef[] = [
            { header: 'Subsystem', align: 'left' },
            { header: 'Usage', align: 'left' },
            { header: 'Capacity / State', align: 'left' },
          ];
          const statusRows: string[][] = [
            [
              'Physical RAM',
              `${renderBar(mem.usedPercent, 6, false)}  ${mem.usedPercent.toFixed(1).padStart(5, ' ')}%`,
              `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)}`,
            ],
            [
              swapType,
              `${renderBar(mem.swapUsedPercent, 6, false)}  ${mem.swapUsedPercent.toFixed(1).padStart(5, ' ')}%`,
              `${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`,
            ],
          ];

          if (mem.pressurePercent !== undefined) {
            const pressureLabel = mem.pressureLevel
              ?? (mem.pressurePercent < 60 ? 'Normal' : mem.pressurePercent < 80 ? 'Warning' : 'Critical');
            statusRows.push([
              'Pressure',
              `${renderBar(mem.pressurePercent, 6, false)}  ${mem.pressurePercent.toFixed(1).padStart(5, ' ')}%`,
              pressureLabel,
            ]);
          }

          memLines.push(...renderDynamicAsciiTable(statusCols, statusRows));

          // Table 2: RAM Allocation Breakdown
          if (mem.activeBytes !== undefined || mem.wiredBytes !== undefined || mem.compressedBytes !== undefined) {
            memLines.push('', '*RAM Allocation Breakdown:*');
            const total = mem.totalBytes > 0 ? mem.totalBytes : 1;
            const allocCols: ColumnDef[] = [
              { header: 'Segment', align: 'left' },
              { header: 'Allocation', align: 'left' },
              { header: 'Size', align: 'right' },
            ];
            const allocRows: string[][] = [];
            if (mem.activeBytes !== undefined) {
              const p = (mem.activeBytes / total) * 100;
              allocRows.push(['Active', `${renderBar(p, 6, false)}  ${p.toFixed(1).padStart(5, ' ')}%`, formatBytes(mem.activeBytes)]);
            }
            if (mem.wiredBytes !== undefined) {
              const p = (mem.wiredBytes / total) * 100;
              allocRows.push(['Wired', `${renderBar(p, 6, false)}  ${p.toFixed(1).padStart(5, ' ')}%`, formatBytes(mem.wiredBytes)]);
            }
            if (mem.compressedBytes !== undefined) {
              const p = (mem.compressedBytes / total) * 100;
              allocRows.push(['Compressed', `${renderBar(p, 6, false)}  ${p.toFixed(1).padStart(5, ' ')}%`, formatBytes(mem.compressedBytes)]);
            }
            if (mem.inactiveBytes !== undefined) {
              const p = (mem.inactiveBytes / total) * 100;
              allocRows.push(['Inactive', `${renderBar(p, 6, false)}  ${p.toFixed(1).padStart(5, ' ')}%`, formatBytes(mem.inactiveBytes)]);
            }
            memLines.push(...renderDynamicAsciiTable(allocCols, allocRows));
          }

          memLines.push(...getTooltipFooter(config.tooltipMode));
          memMd = memLines.join('\n');
        }
        updateWidget(widgets.mem, `$(ellipsis) ${usedStr}/${totalStr} ${config.memUnit}`, memMd, true);
      } else {
        updateWidget(widgets.mem, '', '', false);
      }

      // 5. Battery (with Time Remaining estimation)
      if (config.showBattery && platformProvider.isBatteryAvailable()) {
        if (forceAll || cachedBattery === null || now - lastBatterySampleAt >= BATTERY_REFRESH_MS) {
          cachedBattery = platformProvider.sampleBattery();
          lastBatterySampleAt = now;
        }
        if (cachedBattery) {
          const batStr = padNum(String(cachedBattery.percent), 3);
          let batMd: string | null = null;
          if (updateTooltips) {
            const batCols: ColumnDef[] = [
              { header: 'Metric', align: 'left' },
              { header: 'Level / State', align: 'left' },
              { header: 'Details / Capacity', align: 'left' },
            ];

            const batRows: string[][] = [];
            const unit = cachedBattery.capacityUnit ?? 'mAh';

            // 1. Current Charge Level
            const chargeDetail = cachedBattery.currentCapacity && cachedBattery.maxCapacity
              ? `${cachedBattery.currentCapacity} / ${cachedBattery.maxCapacity} ${unit}`
              : `${cachedBattery.percent.toFixed(1)}%`;
            batRows.push([
              'Charge Level',
              `${renderBar(cachedBattery.percent, 6, false)}  ${cachedBattery.percent.toFixed(1).padStart(5, ' ')}%`,
              chargeDetail,
            ]);

            // 2. Battery Health (if available)
            if (cachedBattery.healthPercent !== undefined && cachedBattery.healthPercent > 0) {
              const healthDetail = cachedBattery.designCapacity && cachedBattery.maxCapacity
                ? `${cachedBattery.maxCapacity} / ${cachedBattery.designCapacity} ${unit}`
                : `${cachedBattery.healthPercent.toFixed(1)}%`;
              batRows.push([
                'Battery Health',
                `${renderBar(cachedBattery.healthPercent, 6, false)}  ${cachedBattery.healthPercent.toFixed(1).padStart(5, ' ')}%`,
                healthDetail,
              ]);
            }

            // 3. Power State / Time Remaining
            let timeStr = '';
            if (cachedBattery.timeRemainingMinutes !== undefined && cachedBattery.timeRemainingMinutes > 0) {
              const suffix = cachedBattery.isCharging ? 'until full' : 'remaining';
              timeStr = `${formatMinutes(cachedBattery.timeRemainingMinutes)} (${suffix})`;
            } else if (cachedBattery.timeRemainingMinutes === -1 && cachedBattery.status === 'Discharging') {
              timeStr = 'Estimating...';
            } else {
              timeStr = cachedBattery.status === 'Charged' || cachedBattery.status === 'Full' ? 'Fully charged' : 'AC Connected';
            }
            batRows.push([
              'Power State',
              cachedBattery.status,
              timeStr,
            ]);

            // 4. Cycle Count (if available)
            if (cachedBattery.cycleCount !== undefined && cachedBattery.cycleCount >= 0) {
              batRows.push([
                'Cycle Count',
                `${cachedBattery.cycleCount} cycles`,
                'Condition: Normal',
              ]);
            }

            const batLines = [
              '### Battery Status & Health',
              '',
              ...renderDynamicAsciiTable(batCols, batRows),
              ...getTooltipFooter(config.tooltipMode),
            ];
            batMd = batLines.join('\n');
          }
          let icon = '$(plug)';
          if (cachedBattery.isCharging) {
            icon = '$(zap)';
          } else if (cachedBattery.status === 'Discharging') {
            icon = '🔋';
          }
          updateWidget(widgets.battery, `${icon} ${batStr}%`, batMd, true);
        } else {
          updateWidget(widgets.battery, '', '', false);
        }
      } else {
        updateWidget(widgets.battery, '', '', false);
      }

      // 6. Disk Space (asynchronous statfs with tick decimation)
      if (config.showDisk) {
        if (forceAll || cachedDisks.length === 0 || now - lastDiskSampleAt >= DISK_REFRESH_MS) {
          lastDiskSampleAt = now;
          const defaultWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/';
          cachedDisks = await diskProvider.sample(config.diskDrives, defaultWorkspace);
          // deactivate() may have disposed the widgets while statfs was pending.
          if (disposed || !widgets) {
            return;
          }
        }
        if (cachedDisks.length > 0) {
          const formatMetric = (d: { freePercent: number; usedPercent: number; freeBytes: number; usedBytes: number; totalBytes: number }): string => {
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

          const getShortDiskName = (mountPath: string): string => {
            if (mountPath === '/' || mountPath === '') {
              return '/';
            }
            const clean = mountPath.endsWith('/') ? mountPath.slice(0, -1) : mountPath;
            const parts = clean.split(/[/\\]/).filter(Boolean);
            return parts[parts.length - 1] ?? mountPath;
          };

          let diskDisplayStr = '';
          if (cachedDisks.length === 1) {
            diskDisplayStr = formatMetric(cachedDisks[0]!);
          } else if (config.diskMultiDisplay === 'MostFull') {
            let worst = cachedDisks[0]!;
            for (let i = 1; i < cachedDisks.length; i++) {
              if (cachedDisks[i]!.usedPercent > worst.usedPercent) {
                worst = cachedDisks[i]!;
              }
            }
            diskDisplayStr = `${getShortDiskName(worst.mountPath)}: ${formatMetric(worst)}`;
          } else {
            diskDisplayStr = cachedDisks
              .map((d) => `${getShortDiskName(d.mountPath)}: ${formatMetric(d)}`)
              .join(' | ');
          }

          let diskMd: string | null = null;
          if (updateTooltips) {
            const lines = ['### Storage Utilization', ''];
            const storageCols: ColumnDef[] = [
              { header: 'Mount', align: 'left', minWidth: 5, maxWidth: 28, truncatePath: true },
              { header: 'Used Space', align: 'left' },
              { header: 'Available Space', align: 'left' },
            ];
            const storageRows: string[][] = cachedDisks.map((d) => [
              d.mountPath,
              `${renderBar(d.usedPercent, 6, false)}  ${d.usedPercent.toFixed(1).padStart(5, ' ')}%`,
              `${formatBytes(d.freeBytes)} of ${formatBytes(d.totalBytes)}`,
            ]);
            lines.push(...renderDynamicAsciiTable(storageCols, storageRows));
            const multiToggle = cachedDisks.length > 1 ? {
              label: config.diskMultiDisplay === 'All' ? 'Switch to Most Full Disk' : 'Switch to All Disks',
              command: 'resmon.toggleDiskMultiDisplay',
              prefix: 'Multi-Disk',
            } : undefined;
            lines.push(...getTooltipFooter(config.tooltipMode, multiToggle));
            diskMd = lines.join('\n');
          }
          updateWidget(widgets.disk, `$(database) ${diskDisplayStr}`, diskMd, true);
        } else {
          updateWidget(widgets.disk, '', '', false);
        }
      } else {
        updateWidget(widgets.disk, '', '', false);
      }
      lastUpdateError = '';
    } catch (err) {
      // Retain previous display state on transient read errors; log each distinct error once in a row.
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (!disposed && message !== lastUpdateError) {
        lastUpdateError = message;
        log.error(`Telemetry update failed: ${message}`);
      }
    } finally {
      isUpdating = false;
      if (pendingForceUpdate && !disposed) {
        pendingForceUpdate = false;
        void update(true);
      }
    }
  }

  /**
   * Schedules the subsequent update tick using an unreferenced timer.
   */
  function scheduleNext(): void {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (disposed) {
      return;
    }
    const config = getConfig();
    updateTimer = setTimeout(async () => {
      await update();
      // deactivate() may have run while update() was awaiting: never re-arm after dispose.
      if (!disposed) {
        scheduleNext();
      }
    }, config.updateFrequencyMs);
    updateTimer.unref();
  }

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.refresh', async () => {
      await update(true);
      scheduleNext();
    })
  );

  // Register toggle tooltip mode command (Static / Live)
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.toggleTooltipMode', async () => {
      const current = getConfig().tooltipMode;
      const next = current === 'Static' ? 'Live' : 'Static';
      const configuration = vscode.workspace.getConfiguration('resmon');
      await configuration.update('tooltip.mode', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Resource Monitor: Tooltip mode set to ${next}`);
    })
  );

  // Register toggle CPU layout command (Table / List)
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.toggleCpuLayout', async () => {
      const current = getConfig().cpuTooltipLayout;
      const next = current === 'Table' ? 'List' : 'Table';
      const configuration = vscode.workspace.getConfiguration('resmon');
      await configuration.update('tooltip.cpuLayout', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Resource Monitor: CPU layout set to ${next}`);
    })
  );

  // Register toggle load format command (Percent / Value)
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.toggleLoadFormat', async () => {
      const current = getConfig().loadFormat;
      const next = current === 'Percent' ? 'Value' : 'Percent';
      const configuration = vscode.workspace.getConfiguration('resmon');
      await configuration.update('loadFormat', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Resource Monitor: Load format set to ${next}`);
    })
  );

  // Register toggle multi-disk display mode command (All / MostFull)
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.toggleDiskMultiDisplay', async () => {
      const current = getConfig().diskMultiDisplay;
      const next = current === 'All' ? 'MostFull' : 'All';
      const configuration = vscode.workspace.getConfiguration('resmon');
      await configuration.update('disk.multiDisplay', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Resource Monitor: Multi-disk display set to ${next}`);
    })
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('resmon')) {
        const newConfig = getConfig();
        if (
          newConfig.priority !== currentConfig.priority ||
          newConfig.alignment !== currentConfig.alignment
        ) {
          // Dispose and recreate widgets if layout alignment or base priority changed
          disposeWidgets();
          currentConfig = newConfig;
          widgets = createWidgets(currentConfig.alignment, currentConfig.priority);
        }

        cachedBattery = null;
        cachedDisks = [];
        void update(true);
        scheduleNext();
      }
    })
  );

  // Initial update and scheduling
  void update(true);
  scheduleNext();
}

/**
 * Cleans up extension resources and timer handles when the extension is deactivated.
 */
export function deactivate(): void {
  disposed = true;
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  disposeWidgets();
  cachedBattery = null;
  cachedDisks = [];
  lastBatterySampleAt = 0;
  lastDiskSampleAt = 0;
  lastTooltipRefreshAt = 0;
}
