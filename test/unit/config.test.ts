// Settings readers (src/config.ts): widget order, per-section intervals (invalid values, rounding,
// bounds, minimums), the scope whose interval object applies, component sensors and priority, read
// through getConfig() against the vscode mock (test/harness/vscode-mock.cjs). `vscode` resolves to the
// mock here as in config.ts, so both see the same settings.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import * as vscode from 'vscode';
import {
  DEFAULT_STATUS_BAR_MS,
  DEFAULT_TOOLTIP_MS,
  DEFAULT_WIDGET_ORDER,
  getConfig,
  MAX_INTERVAL_MS,
  MAX_PRIORITY,
  MIN_INTERVAL_MS,
  MIN_PRIORITY,
  minStatusBarMs,
  readIntervals,
  readStoredIntervals,
  readWidgetOrder,
  setConfigLog,
  type TooltipSection,
} from '../../src/config.js';

/** Settings per scope, as the mock keeps them (user, workspace, workspace folder). */
interface MockState {
  cfg: Record<string, unknown>;
  workspaceCfg: Record<string, unknown>;
  folderCfg: Record<string, unknown>;
}
const state = (vscode as unknown as { __state: MockState }).__state;

afterEach(() => {
  state.cfg = {};
  state.workspaceCfg = {};
  state.folderCfg = {};
  setConfigLog(undefined);
});

/** The same value for every section. */
const all = (ms: number): Record<TooltipSection, number> => ({ cpu: ms, freq: ms, temp: ms, mem: ms, battery: ms, disk: ms });

describe('readWidgetOrder', () => {
  test('not a list: the default order', () => {
    for (const raw of [undefined, null, 'cpu', 42, { 0: 'cpu' }]) {
      assert.deepEqual(readWidgetOrder(raw), [...DEFAULT_WIDGET_ORDER], JSON.stringify(raw));
    }
  });

  test('known, unique ids in the given order, missing ones appended in default order', () => {
    // A partial or invalid list never hides a widget.
    assert.deepEqual(readWidgetOrder(['disk', 'cpu']), ['disk', 'cpu', 'freq', 'temp', 'mem', 'battery']);
    assert.deepEqual(readWidgetOrder(['mem', 'bogus', 'mem', 7, null, 'CPU', 'temp']), ['mem', 'temp', 'cpu', 'freq', 'battery', 'disk']);
    assert.deepEqual(readWidgetOrder([]), [...DEFAULT_WIDGET_ORDER]);
    const reversed = [...DEFAULT_WIDGET_ORDER].reverse();
    assert.deepEqual(readWidgetOrder(reversed), reversed, 'a full permutation kept as is');
  });

  test('a new list each time', () => {
    // Callers may change the result: the default order must not change with it.
    readWidgetOrder(undefined).pop();
    assert.equal(readWidgetOrder(undefined).length, 6);
  });
});

describe('readIntervals', () => {
  test('not an object: every section from the fallback', () => {
    for (const raw of [undefined, null, 5, 'cpu', [1000, 2000], [{ cpu: 1000 }]]) {
      assert.deepEqual(readIntervals(raw, DEFAULT_STATUS_BAR_MS), DEFAULT_STATUS_BAR_MS, JSON.stringify(raw));
    }
  });

  test('invalid entries take the fallback, the others are kept', () => {
    // NaN, infinities, strings, arrays and null are not milliseconds; unknown keys are ignored.
    const raw = { cpu: Number.NaN, freq: Number.POSITIVE_INFINITY, temp: '5000', mem: [3000], battery: null, disk: 4000, bogus: 1 };
    assert.deepEqual(readIntervals(raw, DEFAULT_TOOLTIP_MS), { ...DEFAULT_TOOLTIP_MS, disk: 4000 });
  });

  test('rounded to whole milliseconds, clamped to 200 ms - 1 h', () => {
    assert.deepEqual(readIntervals({ cpu: 333.4, freq: 333.5, temp: 50, mem: -1, battery: 99_999_999, disk: 3_600_000.4 }, DEFAULT_STATUS_BAR_MS), {
      cpu: 333, freq: 334, temp: MIN_INTERVAL_MS, mem: MIN_INTERVAL_MS, battery: MAX_INTERVAL_MS, disk: MAX_INTERVAL_MS,
    });
    assert.deepEqual(readIntervals({}, all(10)), all(MIN_INTERVAL_MS), 'the fallback is clamped too');
  });

  test('minimum per section', () => {
    // getConfig passes the measured minimums (status bar) or the status bar intervals (tooltips).
    const min = (s: TooltipSection): number => (s === 'temp' ? 8400 : 1000);
    assert.deepEqual(readIntervals({ cpu: 500, temp: 2000, mem: 1500 }, DEFAULT_STATUS_BAR_MS, min), {
      ...DEFAULT_STATUS_BAR_MS, cpu: 1000, temp: 8400, mem: 1500,
    });
  });
});

describe('stored intervals and scopes', () => {
  test('defaults when no scope sets them', () => {
    assert.deepEqual(readStoredIntervals(), { statusBarMs: DEFAULT_STATUS_BAR_MS, tooltipMs: DEFAULT_TOOLTIP_MS });
  });

  test('a partial object keeps the defaults of the other sections', () => {
    state.cfg.statusBarMs = { cpu: 1000 };
    assert.deepEqual(readStoredIntervals().statusBarMs, { ...DEFAULT_STATUS_BAR_MS, cpu: 1000 });
  });

  test('the most specific scope that sets the object applies, whole', () => {
    // Workspace folder over workspace over user, as VS Code applies them: objects are not merged across scopes.
    state.cfg.statusBarMs = { cpu: 1000 };
    state.workspaceCfg.statusBarMs = { mem: 3000 };
    assert.deepEqual(readStoredIntervals().statusBarMs, { ...DEFAULT_STATUS_BAR_MS, mem: 3000 }, 'workspace over user');
    state.folderCfg.statusBarMs = { disk: 20_000 };
    assert.deepEqual(readStoredIntervals().statusBarMs, { ...DEFAULT_STATUS_BAR_MS, disk: 20_000 }, 'folder over workspace');
    state.workspaceCfg.tooltipMs = { cpu: 9000 };
    assert.deepEqual(readStoredIntervals().tooltipMs, { ...DEFAULT_TOOLTIP_MS, cpu: 9000 }, 'each key on its own');
    assert.equal(getConfig().statusBarMs.disk, 20_000, 'getConfig reads the same scope');
  });

  test('an explicit configuration is read instead of the workspace one', () => {
    const config = { inspect: () => ({ key: 'x', globalValue: { cpu: 700 } }) } as unknown as vscode.WorkspaceConfiguration;
    assert.equal(readStoredIntervals(config).tooltipMs.cpu, 700);
  });
});

describe('getConfig: intervals in effect', () => {
  test('status bar raised to the measured minimum unless unlocked', () => {
    // The stored value is kept (readStoredIntervals); the effective one is raised, on this host's platform.
    state.cfg.statusBarMs = all(MIN_INTERVAL_MS);
    const raised = getConfig().statusBarMs;
    for (const section of Object.keys(raised) as TooltipSection[]) {
      assert.equal(raised[section], minStatusBarMs(section, false), section);
    }
    assert.deepEqual(readStoredIntervals().statusBarMs, all(MIN_INTERVAL_MS), 'stored value unchanged');
    state.cfg.allowFastRefresh = true;
    assert.deepEqual(getConfig().statusBarMs, all(MIN_INTERVAL_MS), 'unlocked');
  });

  test('tooltip never faster than its status bar', () => {
    // A tooltip can only show what was read: a shorter value applies as the status bar interval.
    state.cfg.statusBarMs = { cpu: 3000, mem: 1000 };
    state.cfg.tooltipMs = { cpu: 1000, mem: 7000 };
    const config = getConfig();
    assert.equal(config.tooltipMs.cpu, 3000);
    assert.equal(config.tooltipMs.mem, 7000);
    assert.equal(config.tooltipMs.temp, Math.max(DEFAULT_TOOLTIP_MS.temp, config.statusBarMs.temp));
  });
});

test('component sensors: the three modes, anything else falls back to awake', () => {
  const warnings: string[] = [];
  setConfigLog({ warn: (m) => warnings.push(m) });
  assert.equal(getConfig().componentSensors, 'awake', 'default');
  for (const mode of ['awake', 'always', 'off']) {
    state.cfg['temperature.componentSensors'] = mode;
    assert.equal(getConfig().componentSensors, mode);
  }
  for (const raw of ['sometimes', 'OFF', false, 0]) {
    state.cfg['temperature.componentSensors'] = raw;
    assert.equal(getConfig().componentSensors, 'awake', JSON.stringify(raw));
  }
  assert.equal(warnings.length, 4, warnings.join(' / '));
  assert.equal(warnings[0], 'Setting mirabar.temperature.componentSensors: invalid value "sometimes", using "awake"');
  getConfig();
  assert.equal(warnings.length, 4, 'each invalid value reported once');
});

test('priority: clamped to its bounds, invalid values fall back to 100', () => {
  const priority = (raw: unknown): number => {
    state.cfg.priority = raw;
    return getConfig().priority;
  };
  assert.equal(priority(-99_999), MIN_PRIORITY);
  assert.equal(priority(99_999), MAX_PRIORITY);
  assert.equal(priority(MIN_PRIORITY), -10_000);
  assert.equal(priority(12.5), 12.5, 'not rounded on read');
  for (const raw of [Number.NaN, Number.NEGATIVE_INFINITY, '50', null]) {
    assert.equal(priority(raw), 100, String(raw));
  }
  // The most specific scope that sets it applies.
  state.cfg.priority = 1;
  state.workspaceCfg.priority = 2;
  assert.equal(getConfig().priority, 2);
  state.folderCfg.priority = 3;
  assert.equal(getConfig().priority, 3);
});
