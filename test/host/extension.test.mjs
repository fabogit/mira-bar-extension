// Behaviour tests of the extension outside VS Code (test/harness/vscode-mock.cjs): per-section
// schedule, tooltips, minimums, settings panel, disk isolation, lifecycle (heap stability: `pnpm run test:soak`).
//
// The tests share one extension instance and run in order: each one starts from the settings the
// previous one left (most restore them at the end).
//
// Usage (macOS after `pnpm run compile:native`, or Linux):  pnpm run test:host
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');

// statfs control, installed before the extension is loaded: `hang` keeps requests pending.
let statfsCalls = 0;
let hang = false;
const hung = [];
const origStatfs = fsp.statfs;
fsp.statfs = (p, ...rest) => {
  statfsCalls++;
  if (hang) {
    return new Promise((resolve, reject) => hung.push(() => origStatfs(p).then(resolve, reject)));
  }
  return origStatfs(p, ...rest);
};

const { loadExtension, loadModule } = await import('../harness/load-extension.mjs');
const { vscode, ext, cleanup } = loadExtension('test-extension');
const { module: config, cleanup: cleanupConfig } = loadModule('src/config.ts', 'test-config');
const s = vscode.__state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the extension timer is unref()'d
after(() => {
  clearInterval(keepAlive);
  cleanup();
  cleanupConfig();
});
const live = () => s.items.filter((i) => !i.disposed);
const item = (label) => live().find((i) => i.name === `MiraBar: ${label}`);
const gear = () => live().find((i) => i.text === '$(settings-gear)');
/** Row of the gear tooltip's section table: { shown, bar, tooltip } as displayed. */
const row = (label) => {
  const line = gear().tooltip.value.split('\n').find((l) => l.startsWith(label + ' ') && l.includes('│'));
  const [, shown, bar, tooltip] = line.split('│').map((c) => c.trim());
  return { shown, bar, tooltip };
};
const setCfg = async (patch, wait = 250) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete s.cfg[k];
    else s.cfg[k] = v;
  }
  vscode.__fireConfigChange();
  await sleep(wait);
};
/** Tooltip writes per second of an item over `ms` (Live: one per read). */
const tooltipRate = async (label, ms) => {
  const it = item(label);
  const n0 = it.tooltipSetCount;
  await sleep(ms);
  return ((it.tooltipSetCount - n0) * 1000) / ms;
};

// Measured minimums of this host (they differ per platform, ADR-0010) and how the gear tooltip shows them.
const MIN = config.measuredMinimums(process.platform);
const LABELS = { cpu: 'CPU usage', freq: process.platform === 'darwin' ? 'System load' : 'CPU frequency', temp: 'Temperature', mem: 'Memory', battery: 'Battery', disk: 'Disk' };
const duration = (ms) => (ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`);
/** Status bar cell for a stored value: raised to the minimum (flagged) when below it. */
const barCell = (section, stored) => (stored < MIN[section] ? `${duration(MIN[section])} *` : duration(stored));

// Minimums per platform, with the platform injected: macOS keeps its measured values, Linux has its own,
// an unmeasured platform takes the highest of each section; the unlock lowers all of them to 200 ms.
test('minimums per platform', (t) => {
  const all = (ms) => ({ cpu: ms, freq: ms, temp: ms, mem: ms, battery: ms, disk: ms });
  assert.deepEqual(config.measuredMinimums('darwin'), { ...all(200), temp: 8400 }, 'macOS minimums unchanged');
  const linux = config.measuredMinimums('linux');
  for (const section of config.TOOLTIP_SECTIONS) {
    assert.ok(linux[section] >= 200 && linux[section] % 100 === 0, `linux ${section}: ${linux[section]} ms`);
    assert.equal(config.measuredMinimums('win32')[section], Math.max(linux[section], config.measuredMinimums('darwin')[section]), `win32 ${section}: highest measured`);
    for (const platform of ['darwin', 'linux', 'win32']) {
      assert.equal(config.minStatusBarMs(section, true, platform), 200, `${platform} ${section} unlocked`);
      assert.equal(config.minStatusBarMs(section, false, platform), config.measuredMinimums(platform)[section]);
    }
  }
  assert.ok(linux.temp < 8400, 'linux temperature below the macOS minimum');
  for (const section of config.TOOLTIP_SECTIONS) {
    assert.ok(config.DEFAULT_STATUS_BAR_MS[section] >= Math.max(...['darwin', 'linux', 'win32'].map((p) => config.measuredMinimums(p)[section])),
      `default ${section} not below any platform's minimum`);
  }
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).contributes.configuration.properties;
  assert.deepEqual(pkg['mirabar.statusBarMs'].default, config.DEFAULT_STATUS_BAR_MS, 'package.json statusBarMs default = config.ts');
  assert.deepEqual(pkg['mirabar.tooltipMs'].default, config.DEFAULT_TOOLTIP_MS, 'package.json tooltipMs default = config.ts');
  t.diagnostic(`this host (${process.platform}): ${config.TOOLTIP_SECTIONS.map((x) => `${x} ${MIN[x]}`).join(', ')}`);
});

// Settings validated on read: an invalid value falls back to the default and is logged once.
test('settings validated on read', () => {
  const warnings = [];
  config.setConfigLog({ warn: (m) => warnings.push(m) });
  s.cfg = { 'disk.format': 'Bogus', 'freq.unit': 'THz', 'mem.unit': 'TB', 'disk.drives': '/home', priority: 'high', 'show.mem': 'yes', alignment: 'Center' };
  const c = config.getConfig();
  assert.deepEqual(
    [c.diskFormat, c.freqUnit, c.memUnit, c.diskDrives, c.priority, c.showMem, c.alignment],
    ['PercentRemaining', 'GHz', 'GB', [], 100, true, 'Left'],
    'invalid values fall back to the defaults'
  );
  s.cfg = { ...s.cfg, priority: Number.NaN };
  assert.equal(config.getConfig().priority, 100, 'NaN priority');
  s.cfg = { 'disk.drives': ['/', 5, null, '/home'], priority: 99999 };
  assert.deepEqual(config.getConfig().diskDrives, ['/', '/home'], 'non-string paths dropped, the others kept');
  assert.equal(config.getConfig().priority, config.MAX_PRIORITY, 'priority clamped');
  for (let i = 0; i < 3; i++) config.getConfig();
  s.cfg = { 'disk.format': 'Bogus' };
  config.getConfig();
  assert.equal(warnings.filter((w) => w.includes('mirabar.disk.format')).length, 1, `logged once: ${warnings.join(' / ')}`);
  assert.equal(warnings.filter((w) => w.includes('mirabar.disk.drives')).length, 2, 'each invalid value logged once');
  assert.ok(warnings.some((w) => w === 'Setting mirabar.freq.unit: invalid value "THz", using "GHz"'), warnings.join(' / '));
  config.setConfigLog(undefined);
  s.cfg = {};
});

// Every default in the code equals its package.json default: with an invalid value for every key, each
// setting falls back to the code's default, and the panel snapshot (every key) must equal package.json.
test('defaults and options match package.json', (t) => {
  const { module: schema, cleanup: cleanupSchema } = loadModule('src/settings/schema.ts', 'test-schema');
  t.after(cleanupSchema);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).contributes.configuration.properties;
  const defaults = Object.fromEntries(Object.entries(pkg).map(([k, spec]) => [k.replace(/^mirabar\./, ''), spec.default]));
  s.cfg = Object.fromEntries(Object.keys(defaults).map((k) => [k, 'bogus']));
  assert.deepEqual(schema.readSettingsSnapshot(), defaults, 'getConfig defaults = package.json defaults');
  assert.deepEqual(schema.EDITABLE_SETTINGS.map((spec) => spec.key).sort(), Object.keys(defaults).sort(), 'every setting editable in the panel');
  for (const spec of schema.EDITABLE_SETTINGS.filter((x) => x.kind === 'enum')) {
    assert.deepEqual(spec.options, pkg[`mirabar.${spec.key}`].enum, `${spec.key} options = package.json enum`);
  }
  s.cfg = {};
});

// Renderers and panel page: frequency text width per unit, section names and rows per platform.
test('frequency width per unit, panel per platform', (t) => {
  const { module: sections, cleanup: cleanupSections } = loadModule('src/sections.ts', 'test-sections');
  t.after(cleanupSections);
  const base = config.getConfig();
  for (const unit of ['GHz', 'MHz', 'KHz', 'Hz']) {
    const text = (hz) => sections.renderFreqOrLoad({ kind: 'freq', data: { avgHz: hz, maxHz: hz, perCoreHz: [] } },
      { config: { ...base, freqUnit: unit }, updatedAt: '00:00:00' }, false).text;
    const widths = [400e6, 1.2e9, 4.5e9, 9.9e9].map((hz) => text(hz).length);
    assert.ok(widths.every((w) => w === widths[0]), `${unit} text width stable: ${widths}`);
  }
  const battery = sections.renderBattery({ percent: 80, status: 'Discharging', cycleCount: 120 },
    { config: base, updatedAt: '00:00:00' }, true).tooltip;
  assert.ok(battery.includes('120 cycles') && !battery.includes('Condition'), 'no battery condition no platform reports');

  const { module: page, cleanup: cleanupPage } = loadModule('src/settings/panel_html.ts', 'test-panel-html');

  t.after(cleanupPage);
  const labels = (html) => JSON.parse(html.match(/const LABELS = (\{.*\});/)[1]);
  const hiddenRows = (html) => [...html.matchAll(/data-platform="(\w+)"( hidden)?/g)].map((m) => `${m[1]}${m[2] ? ' hidden' : ''}`);
  const darwin = page.renderSettingsHtml('n', 'csp', 'darwin');
  const linux = page.renderSettingsHtml('n', 'csp', 'linux');
  const win32 = page.renderSettingsHtml('n', 'csp', 'win32');
  assert.equal(labels(darwin).freq, 'System load');
  assert.equal(labels(linux).freq, 'CPU frequency');
  assert.deepEqual(hiddenRows(darwin), ['linux hidden', 'darwin', 'linux hidden']);
  assert.deepEqual(hiddenRows(linux), ['linux', 'darwin hidden', 'linux']);
  assert.deepEqual(hiddenRows(win32), ['linux hidden', 'darwin hidden', 'linux hidden'], 'win32 shows neither platform\'s rows');
  assert.ok(!/let platform/.test(linux), 'no hard-coded platform in the page');
  for (const unit of ['GHz', 'MHz', 'KHz', 'Hz', 'GB', 'MB', 'KB', 'B']) assert.ok(linux.includes(`<option value="${unit}">${unit}</option>`), unit);
});

// Activation: metric widgets, gear last with the intervals in use.
test('activation and gear tooltip', async () => {
  s.cfg = { 'show.disk': true };
  ext.activate({ subscriptions: [] });
  await sleep(500);
  assert.ok(item('CPU usage')?.visible && item('Memory')?.visible, 'cpu and memory shown');
  const g = gear();
  assert.ok(g && g.command === 'mirabar.openSettings');
  assert.ok(live().every((i) => i === g || i.priority > g.priority), 'gear after the metrics');
  assert.deepEqual(row('CPU usage'), { shown: 'yes', bar: '2 s', tooltip: '5 s' });
  assert.deepEqual(row('Temperature'), { shown: 'yes', bar: '10 s', tooltip: '10 s' });
  assert.deepEqual([row('Battery').bar, row('Disk').bar, row('Disk').shown], ['10 s', '10 s', 'yes']);
  assert.ok(g.tooltip.value.includes('| Tooltip mode | Static | [switch to Live](command:mirabar.toggleTooltipMode) |'), 'options table');
  for (const cmd of ['toggleTooltipMode', 'toggleTooltipAutoRefresh', 'toggleCpuLayout', 'toggleDiskMultiDisplay', 'openSettings']) {
    assert.ok(g.tooltip.value.includes(`command:mirabar.${cmd}`), `gear links ${cmd}`);
  }
  const lines = item('CPU usage').tooltip.value.split('\n');
  assert.equal(lines[0], '### CPU Utilization');
  assert.match(lines.at(-3), /^\*Updated at \d\d:\d\d:\d\d\*$/, 'update time without tenths at 2 s');
});

// Only changes to mirabar.* settings reach the widgets (the listener filters the change events).
test('changes to other settings ignored', async () => {
  s.cfg['show.mem'] = false;
  vscode.__fireConfigChange(['editor.fontSize', 'mirabarx.show']);
  await sleep(250);
  assert.ok(item('Memory')?.visible, 'another section changed: settings not read again');
  vscode.__fireConfigChange();
  await sleep(250);
  assert.ok(!item('Memory')?.visible, 'mirabar.show.mem changed: memory hidden');
  await setCfg({ 'show.mem': undefined });
  assert.ok(item('Memory')?.visible, 'shown again');
});

// Per-section status bar intervals: Live tooltips follow each section's own reads (minimums unlocked:
// the schedule is under test here, not the platform's minimums).
test('per-section status bar', async (t) => {
  await setCfg({ allowFastRefresh: true, 'tooltip.mode': 'Live', statusBarMs: { cpu: 200, mem: 1000, freq: 5000, temp: 5000, battery: 10000, disk: 10000 } }, 400);
  const [cpu, mem] = await Promise.all([tooltipRate('CPU usage', 3000), tooltipRate('Memory', 3000)]);
  assert.ok(cpu >= 4 && cpu <= 5.6, `cpu reads/s at 200 ms: ${cpu}`);
  assert.ok(mem >= 0.6 && mem <= 1.4, `memory reads/s at 1000 ms: ${mem}`);
  assert.match(item('CPU usage').tooltip.value, /Updated at \d\d:\d\d:\d\d\.\d\*/, 'tenths below 1000 ms');
  assert.match(item('Memory').tooltip.value, /Updated at \d\d:\d\d:\d\d\*/, 'no tenths at 1000 ms');
  t.diagnostic(`cpu ${cpu.toFixed(1)}/s, memory ${mem.toFixed(1)}/s`);
});

// Static tooltips at their own interval, never faster than the status bar; auto-refresh off = click only.
test('static tooltips', async (t) => {
  await setCfg({ 'tooltip.mode': 'Static', tooltipMs: { cpu: 1000, mem: 200 } }, 400);
  const [cpu, mem] = await Promise.all([tooltipRate('CPU usage', 4000), tooltipRate('Memory', 4000)]);
  assert.ok(cpu >= 0.7 && cpu <= 1.3, `static cpu tooltip at 1000 ms (bar 200 ms): ${cpu}/s`);
  assert.ok(mem >= 0.5 && mem <= 1.3, `static memory tooltip 200 ms follows its 1000 ms bar: ${mem}/s`);
  await setCfg({ 'tooltip.autoRefresh': false }, 400);
  const frozen = item('CPU usage').tooltip.value;
  await sleep(1500);
  assert.equal(item('CPU usage').tooltip.value, frozen, 'no auto-refresh when off');
  assert.equal(row('CPU usage').tooltip, 'on click');
  await sleep(1000);
  s.cmds['mirabar.refresh']();
  assert.notEqual(item('CPU usage').tooltip.value, frozen, 'click rebuilds the tooltip');
  await setCfg({ 'tooltip.autoRefresh': undefined, tooltipMs: undefined });
  t.diagnostic(`cpu ${cpu.toFixed(1)}/s, memory ${mem.toFixed(1)}/s`);
});

// Measured minimums on the status bar interval, unlockable.
test('measured minimums', async () => {
  await setCfg({ allowFastRefresh: undefined, statusBarMs: { temp: 200, battery: 200, disk: 200, cpu: 200, mem: 200, freq: 200 } });
  assert.equal(row('Temperature').bar, barCell('temp', 200), 'temperature raised to its measured minimum, flagged');
  assert.ok(gear().tooltip.value.includes('raised to its measured minimum'), 'note under the table');
  for (const [section, label] of Object.entries(LABELS)) {
    assert.equal(row(label).bar, barCell(section, 200), `${section} at this platform's minimum`);
  }
  assert.equal(row('CPU usage').tooltip, '5 s');
  await setCfg({ allowFastRefresh: true });
  for (const label of Object.values(LABELS)) {
    assert.equal(row(label).bar, '200 ms', `${label} unlocked`);
  }
  await setCfg({ allowFastRefresh: undefined, statusBarMs: undefined });
});

// Only the mirabar.* interval settings exist: the beta keys are gone from package.json.
test('settings and commands namespace', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const keys = Object.keys(pkg.contributes.configuration.properties);
  for (const legacy of ['updatefrequencyms', 'refreshMs', 'refreshSeconds', 'allowFastBatteryDiskRefresh']) {
    assert.ok(!keys.includes(`mirabar.${legacy}`), `${legacy} not contributed`);
  }
  assert.ok(keys.every((k) => k.startsWith('mirabar.')), 'every setting under mirabar.*');
  const sensors = pkg.contributes.configuration.properties['mirabar.temperature.componentSensors'];
  assert.deepEqual([sensors.enum, sensors.default, sensors.enumDescriptions.length], [['awake', 'always', 'off'], 'awake', 3]);
  assert.ok(pkg.contributes.commands.every((c) => c.command.startsWith('mirabar.') && c.category === 'MiraBar'), 'commands under mirabar.*, category MiraBar');
});

// Settings panel: single instance, CSP, validation, serialized messages.
test('settings panel', async () => {
  s.cmds['mirabar.openSettings']();
  s.cmds['mirabar.openSettings']();
  assert.equal(s.panels.length, 1);
  const panel = s.panels[0];
  assert.equal(panel.reveals, 1);
  const html = panel.webview.html;
  const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes("default-src 'none'"));
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv/g, '')), 'no remote resources');
  assert.ok(html.includes(`temperature ${MIN.temp} ms`), "panel explains this platform's temperature minimum");
  assert.deepEqual(JSON.parse(html.match(/const LIMITS = (\{.*\});/)[1]).measuredMin, MIN, "panel enforces this platform's minimums");

  const state = async () => {
    s.posted.length = 0;
    panel.receive({ type: 'ready' });
    await sleep(10);
    return s.posted.find((m) => m.type === 'state').values;
  };
  const write = async (key, value) => {
    panel.receive({ type: 'update', key, value });
    await sleep(30);
    return s.cfg[key];
  };
  const st = await state();
  assert.deepEqual(st.statusBarMs, { cpu: 2000, freq: 2000, temp: 10000, mem: 2000, battery: 10000, disk: 10000 }, 'panel sees the defaults');
  assert.equal(st['temperature.componentSensors'], 'awake', 'component sensors default');
  assert.ok(panel.webview.html.includes('data-setting="temperature.componentSensors"'), 'component sensors control');

  // A reset followed at once by an edit: the edit must apply after the reset (messages are serialized).
  s.cfg.priority = 50;
  panel.receive({ type: 'reset' });
  panel.receive({ type: 'update', key: 'statusBarMs', value: { ...st.statusBarMs, cpu: 1500 } });
  panel.receive({ type: 'update', key: 'tooltipMs', value: { ...st.tooltipMs, mem: 7000 } });
  await sleep(400);
  assert.ok(!('priority' in s.cfg), 'reset applied');
  assert.equal(s.cfg.statusBarMs.cpu, 1500, 'edit after the reset kept');
  assert.equal(s.cfg.tooltipMs.mem, 7000, 'second edit kept');
  assert.deepEqual(await write('tooltipMs', { cpu: 50, freq: 333.4, bogus: 1, disk: 99999999 }),
    { cpu: 200, freq: 333, temp: 10000, mem: 5000, battery: 10000, disk: 3600000 }, 'tooltipMs clamped, whole ms');
  await write('statusBarMs', { ...s.cfg.statusBarMs, temp: 300 });
  assert.equal(s.cfg.statusBarMs.temp, 300, 'stored below the minimum (applied on read)');
  await sleep(200);
  assert.equal(row('Temperature').bar, barCell('temp', 300), 'effective value is the minimum');
  assert.deepEqual(await write('order', ['disk', 'bogus', 'disk', 'cpu']), ['disk', 'cpu', 'freq', 'temp', 'mem', 'battery']);
  assert.equal(await write('temperature.componentSensors', 'off'), 'off');
  assert.equal((await state())['temperature.componentSensors'], 'off', 'panel sees the stored value');
  const before = JSON.stringify(s.cfg);
  s.posted.length = 0;
  panel.receive({ type: 'update', key: 'evil.key', value: 1 });
  panel.receive({ type: 'update', key: 'statusBarMs', value: 5 });
  panel.receive({ type: 'update', key: 'show.mem', value: 'yes' });
  panel.receive({ type: 'update', key: 'temperature.componentSensors', value: 'sometimes' });
  await sleep(30);
  assert.equal(JSON.stringify(s.cfg), before, 'invalid updates rejected');
  assert.equal(s.posted.filter((m) => m.type === 'error').length, 4);
  const itemsBefore = s.items.length;
  panel.receive({ type: 'reset' });
  await sleep(400);
  assert.ok(s.items.length - itemsBefore <= 7, 'restore defaults recreates the widgets at most once');
  for (const k of ['statusBarMs', 'tooltipMs', 'allowFastRefresh', 'order', 'temperature.componentSensors']) assert.ok(!(k in s.cfg), `${k} reset`);
  s.cfg['show.disk'] = true;
  vscode.__fireConfigChange();
  await sleep(300);
});

// Settings scopes: toggles, panel edits and "Restore defaults" act on the scope that sets the value
// (a write to the user settings would not change a value set in the workspace).
test('settings scopes', async () => {
  const panel = s.panels[0];
  await setCfg({});
  s.workspaceCfg['tooltip.mode'] = 'Live';
  s.notifications.length = 0;
  await s.cmds['mirabar.toggleTooltipMode']();
  assert.equal(s.workspaceCfg['tooltip.mode'], 'Static', 'toggle writes the workspace value');
  assert.ok(!('tooltip.mode' in s.cfg), 'toggle leaves the user settings alone');
  assert.equal(s.notifications.at(-1), 'MiraBar: Tooltip mode set to Static (workspace settings)');
  await s.cmds['mirabar.toggleCpuLayout']();
  assert.equal(s.cfg['tooltip.cpuLayout'], 'List', 'a value set nowhere goes to the user settings');
  assert.equal(s.notifications.at(-1), 'MiraBar: CPU layout set to List');

  s.workspaceCfg.priority = 50;
  panel.receive({ type: 'update', key: 'priority', value: 60 });
  await sleep(30);
  assert.equal(s.workspaceCfg.priority, 60, 'panel edit writes the workspace value');
  assert.ok(!('priority' in s.cfg), 'panel edit leaves the user settings alone');

  // Reset clears the user and workspace values; a folder value VS Code refuses to remove is reported.
  s.cfg['show.mem'] = false;
  s.workspaceCfg['show.mem'] = false;
  s.folderCfg.alignment = 'Right';
  s.posted.length = 0;
  panel.receive({ type: 'reset' });
  await sleep(400);
  assert.deepEqual(Object.keys(s.workspaceCfg), [], 'workspace values reset');
  assert.deepEqual(Object.keys(s.cfg), [], 'user values reset');
  const error = s.posted.find((m) => m.type === 'error');
  assert.ok(error && error.message.includes('mirabar.alignment (workspace folder)'), `remaining value reported: ${error?.message}`);
  assert.ok(!s.posted.some((m) => m.type === 'saved'), 'no "Saved" when a value remains');
  delete s.folderCfg.alignment;
  await setCfg({ 'show.disk': true }, 300);
});

// Invalid values in settings.json: widgets and panel keep working with the defaults, each value logged once.
test('invalid settings in the running extension', async () => {
  const panel = s.panels[0];
  s.warnings.length = 0;
  await setCfg({ 'disk.format': 'Bogus', 'mem.unit': 'TB', 'freq.unit': 'THz', 'disk.drives': '/', priority: 'high' }, 400);
  vscode.__fireConfigChange(['mirabar.disk.format']); // a second read of the same values
  await sleep(300);
  assert.ok(!item('Disk').text.includes('undefined'), `disk text: ${item('Disk').text}`);
  assert.match(item('Memory').text, / GB$/, `memory text: ${item('Memory').text}`);
  if (item('CPU frequency')?.visible) assert.match(item('CPU frequency').text, / GHz$/);
  s.posted.length = 0;
  panel.receive({ type: 'ready' });
  await sleep(10);
  const values = s.posted.find((m) => m.type === 'state').values;
  assert.deepEqual([values['disk.drives'], values['disk.format'], values.priority], [[], 'PercentRemaining', 100], 'panel snapshot valid');
  for (const key of ['disk.format', 'mem.unit', 'freq.unit', 'disk.drives', 'priority']) {
    assert.equal(s.warnings.filter((w) => w.includes(`mirabar.${key}:`)).length, 1, `${key} logged once`);
  }
  await setCfg({ 'disk.format': undefined, 'mem.unit': undefined, 'freq.unit': undefined, 'disk.drives': undefined, priority: undefined }, 300);
});

// Panel message queue: a message whose handling fails does not block the ones after it.
test('panel queue survives a failed message', async () => {
  const panel = s.panels[0];
  const postMessage = panel.webview.postMessage;
  panel.webview.postMessage = () => {
    throw new Error('Webview is disposed'); // VS Code throws synchronously once the webview is gone
  };
  panel.receive({ type: 'update', key: 'show.mem', value: 'yes' }); // its error report throws too: the handler rejects
  await sleep(10);
  panel.webview.postMessage = postMessage;
  panel.receive({ type: 'update', key: 'tooltip.cpuLayout', value: 'List' });
  await sleep(30);
  assert.equal(s.cfg['tooltip.cpuLayout'], 'List', 'later message applied');
  await setCfg({ 'tooltip.cpuLayout': undefined });
});

// Component sensors (Linux): mirabar.temperature.componentSensors applies without a reload. Machines
// without a temperature sensor (CI VMs) have no temperature widget: the modes are covered by test/unit/linux-temp.
test('component sensors applied live', { skip: process.platform !== 'linux' && 'Linux only' }, async (t) => {
  if (!item('Temperature')?.tooltip) {
    t.skip('no temperature sensor here');
    return;
  }
  const componentRows = () => item('Temperature').tooltip.value.split('\n')
    .filter((l) => /^(NVMe|RAM DIMM|Wi-Fi|Battery)/.test(l)).length;
  const readTwice = async () => {
    s.cmds['mirabar.refresh'](); // starts a pass
    await sleep(300);
    s.cmds['mirabar.refresh'](); // shows it
  };
  await readTwice();
  const before = componentRows();
  await setCfg({ 'temperature.componentSensors': 'off' }, 400);
  await readTwice();
  assert.equal(componentRows(), 0, 'off: CPU row only');
  await setCfg({ 'temperature.componentSensors': undefined }, 400);
  await readTwice();
  assert.equal(componentRows(), before, 'awake again: component rows back');
  t.diagnostic(`${before} component rows here`);
});

// Hidden sections are not read; with everything hidden no timer runs.
test('hidden sections', async () => {
  const it = item('Memory');
  await setCfg({ 'show.mem': false, 'tooltip.mode': 'Live', statusBarMs: { mem: 200, cpu: 200 } });
  assert.equal(it.visible, false);
  const n0 = it.tooltipSetCount;
  await sleep(800);
  assert.equal(it.tooltipSetCount, n0, 'hidden memory not rendered');
  await setCfg({ 'show.mem': true });
  assert.ok(it.visible, 'shown again');
  await setCfg({ 'show.cpuusage': false, 'show.cpufreq': false, 'show.cputemp': false, 'show.mem': false, 'show.battery': false, 'show.disk': false });
  const t0 = s.textSets + s.tooltipSets;
  await sleep(800);
  assert.equal(s.textSets + s.tooltipSets, t0, 'nothing runs with every section hidden');
  await setCfg({ 'show.cpuusage': undefined, 'show.cpufreq': undefined, 'show.cputemp': undefined, 'show.mem': undefined, 'show.battery': undefined, 'show.disk': true });
});

// Disk: a hung statfs neither blocks the other sections nor piles up; new paths recover; stale result dropped.
test('disk isolation', async () => {
  await setCfg({ allowFastRefresh: true, statusBarMs: { disk: 200, cpu: 200 }, 'tooltip.mode': 'Live' }, 400);
  hang = true;
  const calls0 = statfsCalls;
  s.cmds['mirabar.refresh']();
  const cpuRate = await tooltipRate('CPU usage', 1200);
  assert.ok(cpuRate >= 3, `cpu keeps updating while statfs hangs: ${cpuRate}/s`);
  assert.equal(statfsCalls - calls0, 1, 'one pending statfs, no pile-up');
  assert.ok(item('Disk').visible, 'last disk value kept');
  hang = false;
  const before = statfsCalls;
  await setCfg({ 'disk.drives': ['/'] }, 400);
  assert.ok(statfsCalls > before, 'new paths sampled while the old request hangs');
  for (const resolve of hung.splice(0)) resolve();
  await sleep(300);
  assert.ok(item('Disk').visible, 'stale result does not clear the widget');
  await setCfg({ 'disk.drives': undefined, allowFastRefresh: undefined, statusBarMs: undefined, 'tooltip.mode': undefined }, 400);
});

// Placement changes recreate the widgets without leaking them.
test('placement and order', async () => {
  for (let i = 0; i < 10; i++) {
    s.cfg.alignment = i % 2 ? 'Left' : 'Right';
    s.cfg.priority = 100 + i;
    vscode.__fireConfigChange();
    await sleep(15);
  }
  await sleep(300);
  assert.equal(live().length, 7, `live widgets: ${live().length}`);
  s.cfg.order = ['mem', 'cpu'];
  vscode.__fireConfigChange();
  await sleep(300);
  const names = live().sort((a, b) => b.priority - a.priority).map((i) => i.name);
  assert.deepEqual(names.slice(0, 2), ['MiraBar: Memory', 'MiraBar: CPU usage']);
  assert.equal(names.at(-1), 'MiraBar Settings');
  await setCfg({ order: undefined, alignment: undefined, priority: undefined }, 300);
});

// Deactivate with a statfs pending, then activate again: no writes to disposed items, one schedule.
test('deactivate and re-activate', async () => {
  hang = true;
  s.cmds['mirabar.refresh']();
  const panel = s.panels[0];
  ext.deactivate();
  assert.ok(panel.disposed, 'panel disposed');
  const t0 = s.textSets + s.tooltipSets;
  await sleep(600);
  assert.equal(s.textSets + s.tooltipSets, t0, 'nothing runs after deactivate');
  hang = false;
  s.cfg = { allowFastRefresh: true, 'tooltip.mode': 'Live', statusBarMs: { cpu: 200 } };
  ext.activate({ subscriptions: [] });
  await sleep(300);
  for (const resolve of hung.splice(0)) resolve();
  await sleep(300);
  const rate = await tooltipRate('CPU usage', 2000);
  assert.ok(rate >= 4 && rate <= 5.6, `one schedule after re-activation: ${rate}/s`);
  ext.deactivate();
});

// Battery refreshed off the thread ahead of each read (#40): from a 1 s interval (the ACPI driver's
// cache time) one refresh ~100 ms before every read; none at shorter intervals; dispose reaches the provider.
test('battery refreshed ahead of each read from 1 s, not below', async (t) => {
  const { module: monitorModule, cleanup: cleanupMonitor } = loadModule('src/monitor.ts', 'test-monitor');
  t.after(cleanupMonitor);
  const run = async (batteryMs, ms) => {
    const events = [];
    let disposed = false;
    const provider = {
      platformName: 'linux',
      isBatteryAvailable: () => true,
      sampleBattery: () => (events.push({ kind: 'read', at: Date.now() }), null),
      requestBatteryRefresh: () => events.push({ kind: 'refresh', at: Date.now() }),
      dispose: () => (disposed = true),
    };
    const base = config.getConfig();
    const cfg = {
      ...base,
      ...{ showCpuUsage: false, showCpuFreq: false, showCpuTemp: false, showMem: false, showDisk: false, showSettings: false, showBattery: true },
      statusBarMs: { ...base.statusBarMs, battery: batteryMs },
    };
    const monitor = new monitorModule.ResourceMonitor(provider, {}, vscode.window.createOutputChannel('test'), cfg);
    await sleep(ms);
    monitor.dispose();
    assert.ok(disposed, 'provider disposed with the monitor');
    return events;
  };
  const events = await run(1000, 2400);
  const reads = events.filter((e) => e.kind === 'read');
  const refreshes = events.filter((e) => e.kind === 'refresh');
  assert.equal(reads.length, 3, `reads at 0, 1 and 2 s: ${reads.length}`);
  assert.equal(refreshes.length, 2, `one refresh per read after the first: ${refreshes.length}`);
  for (const refresh of refreshes) {
    const next = reads.find((r) => r.at >= refresh.at);
    assert.ok(next && next.at - refresh.at >= 50 && next.at - refresh.at <= 200, `refresh ${next ? next.at - refresh.at : '-'} ms before the read`);
  }
  const fast = await run(500, 1200);
  assert.equal(fast.filter((e) => e.kind === 'refresh').length, 0, 'no refresh below 1 s');
});

// Errors logged to the output channel and writes to disposed items, over the whole run.
test('no errors logged, no writes to disposed items', () => {
  assert.deepEqual(s.errors, []);
});
