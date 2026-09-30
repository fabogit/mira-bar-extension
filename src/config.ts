import * as vscode from 'vscode';
import type { DiskSpaceFormat, FreqUnit, MemUnit } from './types.js';

/** Status bar sections that own a tooltip ('freq' is CPU frequency on Linux, system load on macOS). */
export type TooltipSection = 'cpu' | 'freq' | 'temp' | 'mem' | 'battery' | 'disk';

export const TOOLTIP_SECTIONS: readonly TooltipSection[] = ['cpu', 'freq', 'temp', 'mem', 'battery', 'disk'];

/** Default Static-mode tooltip auto-refresh interval per section, in seconds. */
export const DEFAULT_TOOLTIP_REFRESH_SECONDS: Readonly<Record<TooltipSection, number>> = {
  cpu: 5,
  freq: 5,
  temp: 5,
  mem: 5,
  battery: 10,
  disk: 10,
};

const MIN_TOOLTIP_REFRESH_SECONDS = 1;
const MAX_TOOLTIP_REFRESH_SECONDS = 3600;

/**
 * Validates the per-section refresh object from settings, falling back to defaults for
 * missing or invalid entries and clamping values to [1, 3600] seconds.
 */
function readTooltipRefreshSeconds(raw: unknown): Record<TooltipSection, number> {
  const result = { ...DEFAULT_TOOLTIP_REFRESH_SECONDS };
  if (raw !== null && typeof raw === 'object') {
    const values = raw as Record<string, unknown>;
    for (const section of TOOLTIP_SECTIONS) {
      const value = values[section];
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[section] = Math.min(MAX_TOOLTIP_REFRESH_SECONDS, Math.max(MIN_TOOLTIP_REFRESH_SECONDS, value));
      }
    }
  }
  return result;
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
  /** Static mode: whether tooltips auto-refresh at the per-section intervals. */
  tooltipAutoRefresh: boolean;
  /** Static mode: tooltip auto-refresh interval per section, in seconds. */
  tooltipRefreshSeconds: Record<TooltipSection, number>;
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
    diskFormat: config.get<DiskSpaceFormat>('disk.format', 'PercentRemaining'),
    diskDrives: config.get<string[]>('disk.drives', []),
    diskMultiDisplay: config.get<'All' | 'MostFull'>('disk.multiDisplay', 'All'),
    updateFrequencyMs: Math.max(200, config.get<number>('updatefrequencyms', 2000)),
    freqUnit: config.get<FreqUnit>('freq.unit', 'GHz'),
    memUnit: config.get<MemUnit>('mem.unit', 'GB'),
    priority: config.get<number>('priority', 100),
    alignment: config.get<'Left' | 'Right'>('alignment', 'Left'),
    tooltipMode: config.get<'Static' | 'Live'>('tooltip.mode', 'Static'),
    tooltipAutoRefresh: config.get<boolean>('tooltip.autoRefresh', true),
    tooltipRefreshSeconds: readTooltipRefreshSeconds(config.get<unknown>('tooltip.refreshSeconds')),
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
