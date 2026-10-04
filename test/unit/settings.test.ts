// Settings panel (src/settings/): the whitelist against the package.json schema (every kind, not only the
// enums), validation of numbers and path lists, the "Open in VS Code Settings" message, and the page
// itself (its inline script parses, the macOS page). The panel runs against the vscode mock
// (test/harness/vscode-mock.cjs); test/host/extension.test.mjs covers it inside the running extension.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import * as vm from 'node:vm';
import * as vscode from 'vscode';
import { MAX_INTERVAL_MS, MAX_PRIORITY, measuredMinimums, MIN_INTERVAL_MS, MIN_PRIORITY, TOOLTIP_SECTIONS } from '../../src/config.js';
import { SettingsPanel } from '../../src/settings/panel.js';
import { renderSettingsHtml } from '../../src/settings/panel_html.js';
import { EDITABLE_SETTINGS, validateSetting } from '../../src/settings/schema.js';

/** package.json schema of one setting (the fields compared here). */
interface PropertySchema {
  type: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  uniqueItems?: boolean;
  items?: { type: string; enum?: string[] };
  properties?: Record<string, { type: string; minimum: number; maximum: number }>;
}

// The bundle runs from dist/, next to the repository's package.json.
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
const properties = manifest.contributes.configuration.properties as Record<string, PropertySchema>;

/** The mock's records: webview panels and executed commands. */
interface MockPanel {
  webview: { html: string };
  receive(msg: unknown): void;
}
interface MockState {
  panels: MockPanel[];
  posted: { type: string; message?: string }[];
  executed: unknown[][];
}
const state = (vscode as unknown as { __state: MockState }).__state;

describe('whitelist and package.json', () => {
  test('every enum equals its package.json enum', () => {
    // Same options in the same order: the panel buttons and the Settings UI list them alike.
    const enums = EDITABLE_SETTINGS.filter((spec) => spec.kind === 'enum');
    assert.ok(enums.length >= 9, `${enums.length} enum settings`);
    for (const spec of enums) {
      assert.deepEqual(spec.options, properties[`mirabar.${spec.key}`]?.enum, spec.key);
    }
  });

  test('every other kind matches its package.json type and bounds', () => {
    // The panel validates with the same bounds the Settings UI shows.
    for (const spec of EDITABLE_SETTINGS) {
      const schema = properties[`mirabar.${spec.key}`]!;
      switch (spec.kind) {
        case 'boolean':
          assert.equal(schema.type, 'boolean', spec.key);
          break;
        case 'number':
          assert.deepEqual([schema.type, schema.minimum, schema.maximum], ['number', spec.min, spec.max], spec.key);
          break;
        case 'stringArray':
          assert.deepEqual([schema.type, schema.items?.type], ['array', 'string'], spec.key);
          break;
        case 'order':
          assert.deepEqual([schema.type, schema.items?.enum, schema.uniqueItems], ['array', [...TOOLTIP_SECTIONS], true], spec.key);
          break;
        case 'intervals':
          assert.equal(schema.type, 'object', spec.key);
          assert.deepEqual(Object.keys(schema.properties!), [...TOOLTIP_SECTIONS], `${spec.key} sections`);
          for (const [section, bounds] of Object.entries(schema.properties!)) {
            assert.deepEqual([bounds.type, bounds.minimum, bounds.maximum], ['number', MIN_INTERVAL_MS, MAX_INTERVAL_MS], `${spec.key}.${section}`);
          }
          break;
        case 'enum':
          break;
      }
    }
  });
});

describe('validateSetting', () => {
  test('unknown keys rejected', () => {
    assert.deepEqual(validateSetting('evil.key', 1), { ok: false, reason: 'unknown setting "evil.key"' });
    assert.equal(validateSetting('statusbarms', {}).ok, false, 'keys are case-sensitive');
  });

  test('number: rounded and clamped, non-numbers rejected', () => {
    assert.deepEqual(validateSetting('priority', 12.4), { ok: true, value: 12 });
    assert.deepEqual(validateSetting('priority', 12.5), { ok: true, value: 13 });
    assert.deepEqual(validateSetting('priority', -99_999), { ok: true, value: MIN_PRIORITY });
    assert.deepEqual(validateSetting('priority', 99_999), { ok: true, value: MAX_PRIORITY });
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined, [50]]) {
      assert.deepEqual(validateSetting('priority', value), { ok: false, reason: 'priority must be a number' }, String(value));
    }
  });

  test('stringArray: trimmed, empty lines dropped, duplicates removed, at most 32', () => {
    assert.deepEqual(validateSetting('disk.drives', ['  /home  ', '', '   ', '/', '/home', '\t/data\n']), { ok: true, value: ['/home', '/', '/data'] });
    assert.deepEqual(validateSetting('disk.drives', []), { ok: true, value: [] });
    const many = Array.from({ length: 40 }, (_, i) => `/mnt/d${i}`);
    assert.deepEqual(validateSetting('disk.drives', many), { ok: true, value: many.slice(0, 32) });
    // Duplicates do not count against the cap.
    assert.deepEqual(validateSetting('disk.drives', [...Array(32).fill('/a'), '/b']), { ok: true, value: ['/a', '/b'] });
    for (const value of ['/home', ['/', 5], ['/', null], { 0: '/' }, null]) {
      assert.deepEqual(validateSetting('disk.drives', value), { ok: false, reason: 'disk.drives must be a list of paths' }, JSON.stringify(value));
    }
  });

  test('boolean and enum: exact values only', () => {
    assert.deepEqual(validateSetting('show.mem', false), { ok: true, value: false });
    assert.equal(validateSetting('show.mem', 'false').ok, false);
    assert.equal(validateSetting('show.mem', 0).ok, false);
    assert.deepEqual(validateSetting('mem.unit', 'MB'), { ok: true, value: 'MB' });
    assert.deepEqual(validateSetting('mem.unit', 'mb'), { ok: false, reason: 'mem.unit must be one of GB, MB, KB, B' });
  });
});

describe('panel', () => {
  after(() => SettingsPanel.disposeCurrent());
  /** Lets the panel's message queue run. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  test('openJson opens the VS Code settings filtered to MiraBar', async () => {
    SettingsPanel.show('linux');
    const panel = state.panels.at(-1)!;
    state.executed.length = 0;
    panel.receive({ type: 'openJson' });
    await settle();
    assert.deepEqual(state.executed, [['workbench.action.openSettings', 'mirabar.']]);
  });

  test('malformed messages ignored', async () => {
    const panel = state.panels.at(-1)!;
    state.executed.length = 0;
    state.posted.length = 0;
    for (const msg of [null, 'openJson', { type: 'OpenJson' }, { type: 'update', value: 1 }, { type: 'update', key: 5 }]) {
      panel.receive(msg);
    }
    await settle();
    assert.deepEqual([state.executed, state.posted], [[], []]);
  });

  test('openJson failure reported in the panel', async () => {
    const panel = state.panels.at(-1)!;
    const commands = vscode.commands as unknown as { executeCommand: (...args: unknown[]) => Promise<unknown> };
    const executeCommand = commands.executeCommand;
    commands.executeCommand = () => Promise.reject(new Error('no settings editor'));
    try {
      state.posted.length = 0;
      panel.receive({ type: 'openJson' });
      await settle();
      assert.deepEqual(state.posted, [{ type: 'error', message: 'Could not save: no settings editor' }]);
    } finally {
      commands.executeCommand = executeCommand;
    }
  });
});

describe('page', () => {
  /** The page's one inline script. */
  const script = (html: string): string => {
    const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, 'one inline script');
    assert.equal(html.match(/<script/g)!.length, 1, 'no other script tag');
    return scripts[0]![1]!;
  };

  test('the inline script parses on every platform', () => {
    // The script is a template literal in TypeScript: an escaping slip ('\n' instead of '\\n') or a bad
    // injected value would only show up as a dead panel in VS Code.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      assert.doesNotThrow(() => new vm.Script(script(renderSettingsHtml('bm9uY2U=', 'vscode-webview://csp', platform)), { filename: `panel-${platform}.js` }), platform);
    }
  });

  test('macOS page: its minimums, names and rows', () => {
    const html = renderSettingsHtml('bm9uY2U=', 'vscode-webview://csp', 'darwin');
    assert.ok(html.includes(`content="default-src 'none'; style-src vscode-webview://csp 'nonce-bm9uY2U='; script-src 'nonce-bm9uY2U=';"`), 'CSP with the nonce');
    assert.ok(html.includes('<style nonce="bm9uY2U=">'), 'style nonce');
    const limits = JSON.parse(html.match(/const LIMITS = (\{.*\});/)![1]!);
    assert.deepEqual(limits, {
      intervalMin: MIN_INTERVAL_MS,
      intervalMax: MAX_INTERVAL_MS,
      measuredMin: measuredMinimums('darwin'),
      priorityMin: MIN_PRIORITY,
      priorityMax: MAX_PRIORITY,
    });
    assert.ok(html.includes('some sections have a measured minimum on this platform: temperature 8400 ms.'), 'locked sections');
    assert.ok(html.includes('measured on an Apple M4'), 'where the minimums come from');
    assert.ok(/<section aria-labelledby="h-temp" data-platform="linux" hidden>/.test(html), 'component sensors hidden');
    assert.ok(/<div class="row" data-platform="darwin">\s*<div class="label">System load<\/div>/.test(html), 'load format shown');
    assert.ok(/<div class="row" data-platform="linux" hidden>\s*<div class="label">Frequency unit<\/div>/.test(html), 'frequency unit hidden');
    assert.equal(JSON.parse(html.match(/const LABELS = (\{.*\});/)![1]!).freq, 'System load');
  });
});
