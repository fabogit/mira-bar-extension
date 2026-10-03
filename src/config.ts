import * as vscode from 'vscode';
import type { ComponentSensorsMode, DiskSpaceFormat, FreqUnit, MemUnit } from './types.js';

/** Status bar sections that own a tooltip ('freq' is CPU frequency on Linux, system load on macOS). */
export type TooltipSection = 'cpu' | 'freq' | 'temp' | 'mem' | 'battery' | 'disk';

export const TOOLTIP_SECTIONS: readonly TooltipSection[] = ['cpu', 'freq', 'temp', 'mem', 'battery', 'disk'];

/** Default left-to-right order of the status bar widgets (mirabar.order). */
export const DEFAULT_WIDGET_ORDER: readonly TooltipSection[] = TOOLTIP_SECTIONS;

/**
 * Validates mirabar.order: keeps known, unique section ids in the given order and appends any
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

/** Platforms whose minimums have been measured. */
export type MeasuredPlatform = 'darwin' | 'linux';

/**
 * Measured minimum status bar interval per platform and section, in milliseconds: the interval at which
 * the section's reads alone would use the whole project budget (0.5% of one core, docs/ROADMAP.md),
 * rounded up to 100 ms. Reads happen only at the status bar interval, so the minimum applies there;
 * tooltips reuse the latest reading. The defaults keep the whole extension within the budget.
 * The rule and the measurements: docs/ARCHITECTURE.md, "Refresh Floors" (ADR-0010).
 */
export const MEASURED_MIN_STATUS_BAR_MS: Readonly<Record<MeasuredPlatform, Readonly<Record<TooltipSection, number>>>> = {
  /**
   * Apple M4, 2026-09-30, test/bench-darwin.mjs and test/bench-extension.mjs. Temperature: one sensor
   * pass costs 40.4 ms of CPU across the system (HID server and our worker thread) plus 1.1 ms in the
   * extension host, so 41.6 ms / 0.5% = 8314 ms -> 8400 ms. The other sections cost 0.35-0.47 ms per
   * read (70-95 ms by the rule), so the UI minimum applies.
   */
  darwin: {
    cpu: MIN_INTERVAL_MS,
    freq: MIN_INTERVAL_MS,
    temp: 8400,
    mem: MIN_INTERVAL_MS,
    battery: MIN_INTERVAL_MS,
    disk: MIN_INTERVAL_MS,
  },
  /**
   * AMD Ryzen 7 7840U laptop (16 threads), 2026-10-03, test/bench-linux.mjs and test/bench-extension.mjs,
   * three runs at the machine's usual load (load average 1.1-2.0), highest result. Costs are process CPU,
   * kernel time in our syscalls included. Temperature: CPU hwmon read ~0.03 ms, component pass up to
   * 1.7 ms (async, libuv pool; the device time of the SSD, RAM and Wi-Fi sensors is not CPU) and up to
   * 0.87 ms in the extension host: 2.5 ms / 0.5% = 505 ms -> 600 ms. The other sections cost 0.2-0.7 ms
   * per read (40-136 ms by the rule), so the UI minimum applies.
   */
  linux: {
    cpu: MIN_INTERVAL_MS,
    freq: MIN_INTERVAL_MS,
    temp: 600,
    mem: MIN_INTERVAL_MS,
    battery: MIN_INTERVAL_MS,
    disk: MIN_INTERVAL_MS,
  },
};

/**
 * Measured minimums of a platform. A platform not measured yet (Windows) takes, per section, the highest
 * measured minimum: no section can cost more than the budget on a platform we know less about.
 *
 * @param platform - Host platform (default: this process).
 */
export function measuredMinimums(platform: NodeJS.Platform = process.platform): Readonly<Record<TooltipSection, number>> {
  if (platform === 'darwin' || platform === 'linux') {
    return MEASURED_MIN_STATUS_BAR_MS[platform];
  }
  const highest = {} as Record<TooltipSection, number>;
  for (const section of TOOLTIP_SECTIONS) {
    highest[section] = Math.max(...Object.values(MEASURED_MIN_STATUS_BAR_MS).map((m) => m[section]));
  }
  return highest;
}

/** Default status bar interval per section: how often it reads its source and updates its text. */
export const DEFAULT_STATUS_BAR_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: 2000,
  freq: 2000,
  temp: 10_000,
  mem: 2000,
  battery: 10_000,
  disk: 10_000,
};

/** Default tooltip interval per section (Static mode with auto-refresh). */
export const DEFAULT_TOOLTIP_MS: Readonly<Record<TooltipSection, number>> = {
  cpu: 5000,
  freq: 5000,
  temp: 10_000,
  mem: 5000,
  battery: 10_000,
  disk: 10_000,
};

/** Status bar base priority bounds. */
export const MIN_PRIORITY = -10_000;
export const MAX_PRIORITY = 10_000;

/**
 * Minimum status bar interval of a section.
 *
 * @param section - Status bar section.
 * @param allowFast - mirabar.allowFastRefresh: lowers every minimum to MIN_INTERVAL_MS.
 * @param platform - Host platform whose measurements apply (default: this process).
 */
export function minStatusBarMs(section: TooltipSection, allowFast: boolean, platform: NodeJS.Platform = process.platform): number {
  return allowFast ? MIN_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, measuredMinimums(platform)[section]);
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

/**
 * Stored per-section intervals (mirabar.statusBarMs, mirabar.tooltipMs) with defaults for the sections
 * the user did not set, before any minimum is applied.
 */
export function readStoredIntervals(
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('mirabar')
): { statusBarMs: Record<TooltipSection, number>; tooltipMs: Record<TooltipSection, number> } {
  // The user's own object, not get(): a partial object then keeps the defaults of the other sections.
  return {
    statusBarMs: readIntervals(userValue(config, 'statusBarMs'), DEFAULT_STATUS_BAR_MS),
    tooltipMs: readIntervals(userValue(config, 'tooltipMs'), DEFAULT_TOOLTIP_MS),
  };
}

/**
 * Strongly typed configuration options for MiraBar.
 */
export interface MiraBarConfig {
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
  /** Linux component temperature sensors (SSD, RAM, Wi-Fi, battery): 'awake', 'always' or 'off'. */
  componentSensors: ComponentSensorsMode;
}

export const COMPONENT_SENSORS_MODES: readonly ComponentSensorsMode[] = ['awake', 'always', 'off'];

/** Validates mirabar.temperature.componentSensors: an unknown value falls back to 'awake' (the default). */
export function readComponentSensors(raw: unknown): ComponentSensorsMode {
  return (COMPONENT_SENSORS_MODES as readonly unknown[]).includes(raw) ? (raw as ComponentSensorsMode) : 'awake';
}

/**
 * Retrieves the current MiraBar settings from VS Code workspace configuration.
 *
 * @returns An immutable snapshot of the user configuration with safe defaults applied.
 */
export function getConfig(): MiraBarConfig {
  const config = vscode.workspace.getConfiguration('mirabar');
  const allowFastRefresh = config.get<boolean>('allowFastRefresh', false) === true;
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
    componentSensors: readComponentSensors(config.get<unknown>('temperature.componentSensors')),
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
