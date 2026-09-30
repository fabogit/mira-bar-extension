import * as vscode from 'vscode';
import type { DiskSpaceFormat, FreqUnit, MemUnit } from './types.js';

/** Status bar sections that own a tooltip ('freq' is CPU frequency on Linux, system load on macOS). */
export type TooltipSection = 'cpu' | 'freq' | 'temp' | 'mem' | 'battery' | 'disk';

export const TOOLTIP_SECTIONS: readonly TooltipSection[] = ['cpu', 'freq', 'temp', 'mem', 'battery', 'disk'];

/** Default left-to-right order of the status bar widgets (resmon.order). */
export const DEFAULT_WIDGET_ORDER: readonly TooltipSection[] = TOOLTIP_SECTIONS;

/**
 * Validates resmon.order: keeps known, unique section ids in the given order and appends any
 * missing section in its default position, so a partial or invalid list never hides a widget.
 */
export function readWidgetOrder(raw: unknown): TooltipSection[] {
  const order: TooltipSection[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === 'string' && (TOOLTIP_SECTIONS as readonly string[]).includes(value) &&
          !order.includes(value as TooltipSection)) {
        order.push(value as TooltipSection);
      }
    }
  }
  for (const section of DEFAULT_WIDGET_ORDER) {
    if (!order.includes(section)) {
      order.push(section);
    }
  }
  return order;
}

/** Bounds of every interval (status bar and tooltip), in milliseconds. */
export const MIN_INTERVAL_MS = 200;
export const MAX_INTERVAL_MS = 3_600_000;

/**
 * Measured minimum status bar interval per section, in milliseconds: the interval at which reading the
 * section's source costs its share of the project budget (0.5% of one core, shared by the 6 sections,
 * so all of them at their minimum stay within it). Each read happens at the status bar interval, so
 * the minimum applies there; tooltips only reuse the latest reading.
 *
 * Source: test/bench-darwin.mjs on an Apple M4 (see docs/ARCHITECTURE.md, "Refresh floors"). Values
 * below MIN_INTERVAL_MS mean the source is cheap enough for the UI minimum.
 */
export const MEASURED_MIN_STATUS_BAR_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: MIN_INTERVAL_MS,
  freq: MIN_INTERVAL_MS,
  temp: 2000,
  mem: MIN_INTERVAL_MS,
  battery: 2000,
  disk: 2000,
};

/** Default status bar interval per section: how often it reads its source and updates its text. */
export const DEFAULT_STATUS_BAR_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: 2000,
  freq: 2000,
  temp: 5000,
  mem: 2000,
  battery: 10_000,
  disk: 10_000,
};

/** Default tooltip interval per section (Static mode with auto-refresh). */
export const DEFAULT_TOOLTIP_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: 5000,
  freq: 5000,
  temp: 5000,
  mem: 5000,
  battery: 10_000,
  disk: 10_000,
};

/** Bounds of the pre-release single status bar interval (resmon.updatefrequencyms, now a fallback). */
export const MIN_UPDATE_FREQUENCY_MS = 200;
export const MAX_UPDATE_FREQUENCY_MS = 15_000;

/** Status bar base priority bounds. */
export const MIN_PRIORITY = -10_000;
export const MAX_PRIORITY = 10_000;

/**
 * Minimum status bar interval of a section.
 *
 * @param section - Status bar section.
 * @param allowFast - resmon.allowFastRefresh: lowers every minimum to MIN_INTERVAL_MS.
 */
export function minStatusBarMs(section: TooltipSection, allowFast: boolean): number {
  return allowFast ? MIN_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, MEASURED_MIN_STATUS_BAR_MS[section]);
}

/**
 * Validates a per-section interval object: missing or invalid entries take `fallback[section]`, and
 * values are rounded and clamped to [min(section), MAX_INTERVAL_MS].
 *
 * @param raw - Untrusted value (settings or panel).
 * @param fallback - Value per section when `raw` has none.
 * @param min - Minimum per section.
 */
export function readIntervals(
  raw: unknown,
  fallback: Readonly<Record<TooltipSection, number>>,
  min: (section: TooltipSection) => number = () => MIN_INTERVAL_MS
): Record<TooltipSection, number> {
  const values = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result = {} as Record<TooltipSection, number>;
  for (const section of TOOLTIP_SECTIONS) {
    const value = values[section];
    const chosen = typeof value === 'number' && Number.isFinite(value) ? value : fallback[section];
    result[section] = Math.round(Math.min(MAX_INTERVAL_MS, Math.max(min(section), chosen)));
  }
  return result;
}

/** Value the user set for a key (any scope), or undefined when only the default applies. */
function userValue(config: vscode.WorkspaceConfiguration, key: string): unknown {
  const inspected = config.inspect<unknown>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

/** Pre-release per-section values (resmon.refreshMs, or resmon.refreshSeconds in seconds), if set. */
function legacySectionMs(config: vscode.WorkspaceConfiguration): Partial<Record<TooltipSection, number>> {
  const out: Partial<Record<TooltipSection, number>> = {};
  const ms = userValue(config, 'refreshMs');
  const seconds = userValue(config, 'refreshSeconds');
  for (const section of TOOLTIP_SECTIONS) {
    const m = ms !== null && typeof ms === 'object' ? (ms as Record<string, unknown>)[section] : undefined;
    const sec = seconds !== null && typeof seconds === 'object' ? (seconds as Record<string, unknown>)[section] : undefined;
    if (typeof m === 'number' && Number.isFinite(m)) {
      out[section] = m;
    } else if (typeof sec === 'number' && Number.isFinite(sec)) {
      out[section] = sec * 1000;
    }
  }
  return out;
}

/**
 * Stored per-section intervals with their fallbacks, before any minimum is applied:
 * - status bar: resmon.statusBarMs; else, for CPU, load and memory, the older single interval
 *   resmon.updatefrequencyms; for temperature, battery and disk, the pre-release resmon.refreshMs
 *   (their sampling interval then), else the default or updatefrequencyms if slower; else the default.
 * - tooltip: resmon.tooltipMs; else resmon.refreshMs / resmon.refreshSeconds; else the default.
 */
export function readStoredIntervals(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('resmon')
): { statusBarMs: Record<TooltipSection, number>; tooltipMs: Record<TooltipSection, number> } {
  const legacy = legacySectionMs(config);
  const tick = userValue(config, 'updatefrequencyms');
  const barFallback = { ...DEFAULT_STATUS_BAR_MS };
  for (const section of ['cpu', 'freq', 'mem'] as const) {
    if (typeof tick === 'number' && Number.isFinite(tick)) {
      barFallback[section] = Math.min(MAX_UPDATE_FREQUENCY_MS, Math.max(MIN_UPDATE_FREQUENCY_MS, tick));
    }
  }
  for (const section of ['temp', 'battery', 'disk'] as const) {
    // Released versions read these on the single tick too: a slower tick keeps them at least that slow.
    const slowTick = typeof tick === 'number' && Number.isFinite(tick) ? Math.max(barFallback[section], tick) : barFallback[section];
    barFallback[section] = legacy[section] ?? slowTick;
  }
  const tipFallback = { ...DEFAULT_TOOLTIP_MS, ...legacy };
  // userValue, not get(): get() returns the package.json default object, which would hide the fallbacks.
  return {
    statusBarMs: readIntervals(userValue(config, 'statusBarMs'), barFallback),
    tooltipMs: readIntervals(userValue(config, 'tooltipMs'), tipFallback),
  };
}

/**
 * Strongly typed configuration options for Resource Monitor NG.
 */
export interface ResMonConfig {
  /** Whether to show CPU usage percentage in the status bar. */
  showCpuUsage: boolean;
  /** Whether to show CPU clock frequency in the status bar. */
  showCpuFreq: boolean;
  /** Whether to show CPU temperature in the status bar. */
  showCpuTemp: boolean;
  /** Whether to show RAM consumption in the status bar. */
  showMem: boolean;
  /** Whether to show battery percentage in the status bar. */
  showBattery: boolean;
  /** Whether to show disk space in the status bar. */
  showDisk: boolean;
  /** Whether to show the settings (gear) widget in the status bar. */
  showSettings: boolean;
  /** Left-to-right order of the metric widgets in the status bar. */
  order: TooltipSection[];
  /** Format used to render disk space strings. */
  diskFormat: DiskSpaceFormat;
  /** Explicit filesystem mount points to monitor. Empty means active workspace or root. */
  diskDrives: string[];
  /** Display unit for CPU frequency (GHz, MHz, KHz, Hz). */
  freqUnit: FreqUnit;
  /** Display unit for memory metrics (GB, MB, KB, B). */
  memUnit: MemUnit;
  /** Base priority for status bar positioning. */
  priority: number;
  /** Status bar alignment side ('Left' | 'Right'). */
  alignment: 'Left' | 'Right';
  /** Tooltip mode: 'Static' (on click, plus optional auto-refresh at tooltipMs) or 'Live' (with every read). */
  tooltipMode: 'Static' | 'Live';
  /** Static mode: whether tooltips refresh automatically at tooltipMs (otherwise only on click). */
  tooltipAutoRefresh: boolean;
  /**
   * Effective status bar interval per section (ms, minimums applied): how often the section reads its
   * source and updates its text. Live tooltips follow it.
   */
  statusBarMs: Record<TooltipSection, number>;
  /**
   * Effective Static tooltip interval per section (ms): the stored value, never shorter than the
   * section's status bar interval (a tooltip can only show what was read).
   */
  tooltipMs: Record<TooltipSection, number>;
  /** Lowers every measured minimum to MIN_INTERVAL_MS (performance impact, see package.json). */
  allowFastRefresh: boolean;
  /** CPU core breakdown layout in tooltip: 'Table' (compact side-by-side grid) or 'List' (vertical clusters). */
  cpuTooltipLayout: 'Table' | 'List';
  /** Multi-disk status bar display mode: 'All' or 'MostFull'. */
  diskMultiDisplay: 'All' | 'MostFull';
  /** Format used to display System Load Average on Darwin: 'Percent' or 'Value'. */
  loadFormat: 'Percent' | 'Value';
}

/**
 * Retrieves the current Resource Monitor settings from VS Code workspace configuration.
 *
 * @returns An immutable snapshot of the user configuration with safe defaults applied.
 */
export function getConfig(): ResMonConfig {
  const config = vscode.workspace.getConfiguration('resmon');
  const allowFastSetting = userValue(config, 'allowFastRefresh') ?? userValue(config, 'allowFastBatteryDiskRefresh');
  const allowFastRefresh = allowFastSetting === true;
  const stored = readStoredIntervals(config);
  const statusBarMs = readIntervals(stored.statusBarMs, DEFAULT_STATUS_BAR_MS, (s) => minStatusBarMs(s, allowFastRefresh));
  const tooltipMs = readIntervals(stored.tooltipMs, DEFAULT_TOOLTIP_MS, (s) => statusBarMs[s]);

  return {
    showCpuUsage: config.get<boolean>('show.cpuusage', true),
    showCpuFreq: config.get<boolean>('show.cpufreq', true),
    showCpuTemp: config.get<boolean>('show.cputemp', true),
    showMem: config.get<boolean>('show.mem', true),
    showBattery: config.get<boolean>('show.battery', true),
    showDisk: config.get<boolean>('show.disk', false),
    showSettings: config.get<boolean>('show.settings', true),
    order: readWidgetOrder(config.get<unknown>('order')),
    diskFormat: config.get<DiskSpaceFormat>('disk.format', 'PercentRemaining'),
    diskDrives: config.get<string[]>('disk.drives', []),
    diskMultiDisplay: config.get<'All' | 'MostFull'>('disk.multiDisplay', 'All'),
    freqUnit: config.get<FreqUnit>('freq.unit', 'GHz'),
    memUnit: config.get<MemUnit>('mem.unit', 'GB'),
    priority: Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, config.get<number>('priority', 100))),
    alignment: config.get<'Left' | 'Right'>('alignment', 'Left'),
    tooltipMode: config.get<'Static' | 'Live'>('tooltip.mode', 'Static'),
    tooltipAutoRefresh: config.get<boolean>('tooltip.autoRefresh', true),
    statusBarMs,
    tooltipMs,
    allowFastRefresh,
    cpuTooltipLayout: config.get<'Table' | 'List'>('tooltip.cpuLayout', 'Table'),
    loadFormat: config.get<'Percent' | 'Value'>('loadFormat', 'Percent'),
  };
}

/**
 * Conversion divisors for standard frequency and byte binary/decimal units.
 */
export const UNIT_DIVISORS: Record<string, number> = {
  GHz: 1_000_000_000,
  MHz: 1_000_000,
  KHz: 1_000,
  Hz: 1,
  GB: 1024 * 1024 * 1024,
  MB: 1024 * 1024,
  KB: 1024,
  B: 1,
};
