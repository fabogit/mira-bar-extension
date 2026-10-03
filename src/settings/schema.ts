import * as vscode from 'vscode';
import {
  COMPONENT_SENSORS_MODES,
  DEFAULT_STATUS_BAR_MS,
  DEFAULT_TOOLTIP_MS,
  getConfig,
  MAX_PRIORITY,
  MIN_PRIORITY,
  readIntervals,
  readStoredIntervals,
  readWidgetOrder,
} from '../config.js';

/** Kinds of value the settings panel may write, each with its own validation. */
type SettingKind = 'boolean' | 'number' | 'enum' | 'stringArray' | 'order' | 'intervals';

interface SettingSpec {
  /** Key under the `mirabar` configuration section. */
  readonly key: string;
  readonly kind: SettingKind;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
}

/**
 * Whitelist of the settings the panel can change. Anything else sent by the webview is rejected,
 * and every value is validated/clamped here before it reaches the user's settings.json.
 */
export const EDITABLE_SETTINGS: readonly SettingSpec[] = [
  { key: 'tooltip.mode', kind: 'enum', options: ['Static', 'Live'] },
  { key: 'tooltip.autoRefresh', kind: 'boolean' },
  { key: 'statusBarMs', kind: 'intervals' },
  { key: 'tooltipMs', kind: 'intervals' },
  { key: 'allowFastRefresh', kind: 'boolean' },
  { key: 'order', kind: 'order' },
  { key: 'show.cpuusage', kind: 'boolean' },
  { key: 'show.cpufreq', kind: 'boolean' },
  { key: 'show.cputemp', kind: 'boolean' },
  { key: 'show.mem', kind: 'boolean' },
  { key: 'show.battery', kind: 'boolean' },
  { key: 'show.disk', kind: 'boolean' },
  { key: 'show.settings', kind: 'boolean' },
  { key: 'temperature.componentSensors', kind: 'enum', options: COMPONENT_SENSORS_MODES },
  { key: 'tooltip.cpuLayout', kind: 'enum', options: ['Table', 'List'] },
  { key: 'loadFormat', kind: 'enum', options: ['Percent', 'Value'] },
  { key: 'freq.unit', kind: 'enum', options: ['GHz', 'MHz', 'KHz', 'Hz'] },
  { key: 'mem.unit', kind: 'enum', options: ['GB', 'MB', 'KB', 'B'] },
  { key: 'disk.format', kind: 'enum', options: ['PercentRemaining', 'PercentUsed', 'Remaining', 'UsedOutOfTotal'] },
  { key: 'disk.multiDisplay', kind: 'enum', options: ['All', 'MostFull'] },
  { key: 'disk.drives', kind: 'stringArray' },
  { key: 'alignment', kind: 'enum', options: ['Left', 'Right'] },
  { key: 'priority', kind: 'number', min: MIN_PRIORITY, max: MAX_PRIORITY },
];

export type ValidationResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Validates a value sent by the settings panel for `key`, clamping numbers to their bounds.
 *
 * @param key - Setting key under `mirabar`.
 * @param value - Untrusted value from the webview.
 * @returns The value to store, or the reason it was rejected.
 */
export function validateSetting(key: string, value: unknown): ValidationResult {
  const spec = EDITABLE_SETTINGS.find((s) => s.key === key);
  if (!spec) {
    return { ok: false, reason: `unknown setting "${key}"` };
  }
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: `${key} must be true or false` };
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, reason: `${key} must be a number` };
      }
      return { ok: true, value: Math.round(Math.min(spec.max!, Math.max(spec.min!, value))) };
    }
    case 'enum':
      return typeof value === 'string' && spec.options!.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: `${key} must be one of ${spec.options!.join(', ')}` };
    case 'stringArray': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return { ok: false, reason: `${key} must be a list of paths` };
      }
      const paths = (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0).slice(0, 32);
      return { ok: true, value: [...new Set(paths)] };
    }
    case 'order':
      if (!Array.isArray(value)) {
        return { ok: false, reason: 'order must be a list of sections' };
      }
      return { ok: true, value: readWidgetOrder(value) };
    case 'intervals':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: `${key} must be an object of milliseconds per section` };
      }
      // Only the absolute bounds (200 ms to 1 h): the measured minimums are applied on read (getConfig),
      // so a value stored while they were unlocked survives edits to other rows and applies again
      // whenever mirabar.allowFastRefresh is on.
      return { ok: true, value: readIntervals(value, key === 'statusBarMs' ? DEFAULT_STATUS_BAR_MS : DEFAULT_TOOLTIP_MS) };
  }
}

/**
 * Current values keyed like the settings, for the panel: defaults applied and clamped. Intervals are the
 * stored values (defaults for the sections the user did not set); the panel shows the minimums and the
 * effective values itself.
 */
export function readSettingsSnapshot(): Record<string, unknown> {
  const c = getConfig();
  const stored = readStoredIntervals();
  return {
    'tooltip.mode': c.tooltipMode,
    'tooltip.autoRefresh': c.tooltipAutoRefresh,
    statusBarMs: stored.statusBarMs,
    tooltipMs: stored.tooltipMs,
    allowFastRefresh: c.allowFastRefresh,
    order: c.order,
    'show.cpuusage': c.showCpuUsage,
    'show.cpufreq': c.showCpuFreq,
    'show.cputemp': c.showCpuTemp,
    'show.mem': c.showMem,
    'show.battery': c.showBattery,
    'show.disk': c.showDisk,
    'show.settings': c.showSettings,
    'temperature.componentSensors': c.componentSensors,
    'tooltip.cpuLayout': c.cpuTooltipLayout,
    loadFormat: c.loadFormat,
    'freq.unit': c.freqUnit,
    'mem.unit': c.memUnit,
    'disk.format': c.diskFormat,
    'disk.multiDisplay': c.diskMultiDisplay,
    'disk.drives': c.diskDrives,
    alignment: c.alignment,
    priority: c.priority,
  };
}

/**
 * Writes one validated setting to the user (global) settings.
 */
export async function writeSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('mirabar').update(key, value, vscode.ConfigurationTarget.Global);
}

/**
 * Removes every panel-editable setting from the user settings, restoring the defaults.
 */
export async function resetSettings(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('mirabar');
  for (const spec of EDITABLE_SETTINGS) {
    await configuration.update(spec.key, undefined, vscode.ConfigurationTarget.Global);
  }
}
