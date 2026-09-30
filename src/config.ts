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

/**
 * Default refresh interval per section, in milliseconds. It sets how fresh each section is: the Static
 * tooltip auto-refresh interval and, for battery, disk and temperature, also how often they are sampled.
 */
export const DEFAULT_SECTION_REFRESH_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: 5000,
  freq: 5000,
  temp: 5000,
  mem: 5000,
  battery: 10_000,
  disk: 10_000,
};

export const MIN_SECTION_REFRESH_MS = 200;
export const MAX_SECTION_REFRESH_MS = 3_600_000;
/** A full temperature pass costs ~16 ms of HID IPC (Apple M4), so it is never sampled more often than every 2 s. */
export const MIN_TEMP_REFRESH_MS = 2000;

/** Polling interval bounds for the status bar values, in milliseconds. */
export const MIN_UPDATE_FREQUENCY_MS = 200;
export const MAX_UPDATE_FREQUENCY_MS = 15_000;

/**
 * Validates the per-section refresh object from settings, falling back to defaults for missing or
 * invalid entries and clamping values to [200 ms, 1 h] (temperature: [2 s, 1 h]), whole milliseconds.
 */
export function readSectionRefreshMs(raw: unknown): Record<TooltipSection, number> {
  const result = { ...DEFAULT_SECTION_REFRESH_MS };
  if (raw !== null && typeof raw === 'object') {
    const values = raw as Record<string, unknown>;
    for (const section of TOOLTIP_SECTIONS) {
      const value = values[section];
      if (typeof value === 'number' && Number.isFinite(value)) {
        const min = section === 'temp' ? MIN_TEMP_REFRESH_MS : MIN_SECTION_REFRESH_MS;
        result[section] = Math.round(Math.min(MAX_SECTION_REFRESH_MS, Math.max(min, value)));
      }
    }
  }
  return result;
}

/**
 * Raw per-section refresh value: resmon.refreshMs when the user set it, otherwise the deprecated
 * resmon.refreshSeconds (pre-release, seconds) converted to milliseconds, otherwise the default.
 */
function rawSectionRefresh(config: vscode.WorkspaceConfiguration): unknown {
  const inspected = config.inspect<unknown>('refreshMs');
  const userMs = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (userMs !== undefined) {
    return userMs;
  }
  const legacy = config.get<unknown>('refreshSeconds');
  if (legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const converted: Record<string, number> = {};
    for (const [section, seconds] of Object.entries(legacy as Record<string, unknown>)) {
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        converted[section] = seconds * 1000;
      }
    }
    return converted;
  }
  return config.get<unknown>('refreshMs');
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
  /** Sampling and refresh interval in milliseconds (minimum 200 ms). */
  updateFrequencyMs: number;
  /** Display unit for CPU frequency (GHz, MHz, KHz, Hz). */
  freqUnit: FreqUnit;
  /** Display unit for memory metrics (GB, MB, KB, B). */
  memUnit: MemUnit;
  /** Base priority for status bar positioning. */
  priority: number;
  /** Status bar alignment side ('Left' | 'Right'). */
  alignment: 'Left' | 'Right';
  /** Tooltip refresh mode: 'Static' (on click, plus optional timed auto-refresh) or 'Live' (every tick). */
  tooltipMode: 'Static' | 'Live';
  /** Static mode: whether tooltips auto-refresh at the per-section intervals (sectionRefreshMs). */
  tooltipAutoRefresh: boolean;
  /**
   * Refresh interval per section, in milliseconds: Static tooltip auto-refresh interval and, for battery,
   * disk and temperature, their sampling interval (both tooltip modes).
   */
  sectionRefreshMs: Record<TooltipSection, number>;
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
    updateFrequencyMs: Math.min(
      MAX_UPDATE_FREQUENCY_MS,
      Math.max(MIN_UPDATE_FREQUENCY_MS, config.get<number>('updatefrequencyms', 2000))
    ),
    freqUnit: config.get<FreqUnit>('freq.unit', 'GHz'),
    memUnit: config.get<MemUnit>('mem.unit', 'GB'),
    priority: config.get<number>('priority', 100),
    alignment: config.get<'Left' | 'Right'>('alignment', 'Left'),
    tooltipMode: config.get<'Static' | 'Live'>('tooltip.mode', 'Static'),
    tooltipAutoRefresh: config.get<boolean>('tooltip.autoRefresh', true),
    sectionRefreshMs: readSectionRefreshMs(rawSectionRefresh(config)),
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
