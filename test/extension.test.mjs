// Behaviour tests of the extension outside VS Code (test/harness/vscode-mock.cjs): per-section
// schedule, tooltips, minimums, settings panel, disk isolation, lifecycle and heap stability.
//
// Usage (macOS after `pnpm run compile:native`, or Linux):  node --expose-gc test/extension.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const { loadExtension } = await import('./harness/load-extension.mjs');
const { vscode, ext, cleanup } = loadExtension('test-extension');
const s = vscode.__state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the extension timer is unref()'d
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
const step = (name) => console.log(`ok - ${name}`);

s.cfg = { 'show.disk': true };
ext.activate({ subscriptions: [] });
await sleep(500);

// Activation: metric widgets, gear last with the intervals in use.
{
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
  step('activation and gear tooltip');
}

// Per-section status bar intervals: Live tooltips follow each section's own reads.
{
  await setCfg({ 'tooltip.mode': 'Live', statusBarMs: { cpu: 200, mem: 1000, freq: 5000, temp: 5000, battery: 10000, disk: 10000 } }, 400);
  const [cpu, mem] = await Promise.all([tooltipRate('CPU usage', 3000), tooltipRate('Memory', 3000)]);
  assert.ok(cpu >= 4 && cpu <= 5.6, `cpu reads/s at 200 ms: ${cpu}`);
  assert.ok(mem >= 0.6 && mem <= 1.4, `memory reads/s at 1000 ms: ${mem}`);
  assert.match(item('CPU usage').tooltip.value, /Updated at \d\d:\d\d:\d\d\.\d\*/, 'tenths below 1000 ms');
  assert.match(item('Memory').tooltip.value, /Updated at \d\d:\d\d:\d\d\*/, 'no tenths at 1000 ms');
  step(`per-section status bar: cpu ${cpu.toFixed(1)}/s, memory ${mem.toFixed(1)}/s`);
}

// Static tooltips at their own interval, never faster than the status bar; auto-refresh off = click only.
{
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
  step(`static tooltips: cpu ${cpu.toFixed(1)}/s, memory ${mem.toFixed(1)}/s`);
}

// Measured minimums on the status bar interval, unlockable.
{
  await setCfg({ statusBarMs: { temp: 200, battery: 200, disk: 200, cpu: 200, mem: 200, freq: 200 } });
  assert.equal(row('Temperature').bar, '8.4 s *', 'temperature raised to its measured minimum, flagged');
  assert.ok(gear().tooltip.value.includes('raised to its measured minimum'), 'note under the table');
  assert.deepEqual(['CPU usage', 'Memory', 'Battery', 'Disk'].map((l) => row(l).bar), ['200 ms', '200 ms', '200 ms', '200 ms'], 'cheap sections at 200 ms');
  assert.equal(row('CPU usage').tooltip, '5 s');
  await setCfg({ allowFastRefresh: true });
  assert.equal(row('Temperature').bar, '200 ms', 'unlocked');
  await setCfg({ allowFastRefresh: undefined, statusBarMs: undefined });
  step('measured minimums');
}

// Only the mirabar.* interval settings exist: the beta keys are gone from package.json.
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const keys = Object.keys(pkg.contributes.configuration.properties);
  for (const legacy of ['updatefrequencyms', 'refreshMs', 'refreshSeconds', 'allowFastBatteryDiskRefresh']) {
    assert.ok(!keys.includes(`mirabar.${legacy}`), `${legacy} not contributed`);
  }
  assert.ok(keys.every((k) => k.startsWith('mirabar.')), 'every setting under mirabar.*');
  assert.ok(pkg.contributes.commands.every((c) => c.command.startsWith('mirabar.') && c.category === 'MiraBar'), 'commands under mirabar.*, category MiraBar');
  step('settings and commands namespace');
}

// Settings panel: single instance, CSP, validation, serialized messages.
{
  s.cmds['mirabar.openSettings']();
  s.cmds['mirabar.openSettings']();
  assert.equal(s.panels.length, 1);
  const panel = s.panels[0];
  assert.equal(panel.reveals, 1);
  const html = panel.webview.html;
  const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes("default-src 'none'"));
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv/g, '')), 'no remote resources');

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
  assert.equal(row('Temperature').bar, '8.4 s *', 'effective value is the minimum');
  assert.deepEqual(await write('order', ['disk', 'bogus', 'disk', 'cpu']), ['disk', 'cpu', 'freq', 'temp', 'mem', 'battery']);
  const before = JSON.stringify(s.cfg);
  s.posted.length = 0;
  panel.receive({ type: 'update', key: 'evil.key', value: 1 });
  panel.receive({ type: 'update', key: 'statusBarMs', value: 5 });
  panel.receive({ type: 'update', key: 'show.mem', value: 'yes' });
  await sleep(30);
  assert.equal(JSON.stringify(s.cfg), before, 'invalid updates rejected');
  assert.equal(s.posted.filter((m) => m.type === 'error').length, 3);
  const itemsBefore = s.items.length;
  panel.receive({ type: 'reset' });
  await sleep(400);
  assert.ok(s.items.length - itemsBefore <= 7, 'restore defaults recreates the widgets at most once');
  for (const k of ['statusBarMs', 'tooltipMs', 'allowFastRefresh', 'order']) assert.ok(!(k in s.cfg), `${k} reset`);
  s.cfg['show.disk'] = true;
  vscode.__fireConfigChange();
  await sleep(300);
  step('settings panel');
}

// Hidden sections are not read; with everything hidden no timer runs.
{
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
  step('hidden sections');
}

// Disk: a hung statfs neither blocks the other sections nor piles up; new paths recover; stale result dropped.
{
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
  step('disk isolation');
}

// Placement changes recreate the widgets without leaking them.
{
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
  step('placement and order');
}

// Heap stability at 200 ms Live with every section on.
if (typeof globalThis.gc === 'function') {
  await setCfg({ allowFastRefresh: true, 'tooltip.mode': 'Live', statusBarMs: { cpu: 200, freq: 200, temp: 200, mem: 200, battery: 200, disk: 200 } }, 3000);
  globalThis.gc();
  const h0 = process.memoryUsage().heapUsed;
  await sleep(15000);
  globalThis.gc();
  const growthKb = (process.memoryUsage().heapUsed - h0) / 1024;
  assert.ok(growthKb < 512, `heap growth over 15 s: ${growthKb.toFixed(0)} KB`);
  step(`heap growth over 15 s at 200 ms Live: ${growthKb.toFixed(0)} KB`);
}

// Deactivate with a statfs pending, then activate again: no writes to disposed items, one schedule.
{
  hang = true;
  s.cmds['mirabar.refresh']();
  const panel = s.panels[0];
  ext.deactivate();
  assert.ok(panel.disposed, 'panel disposed');
  const t0 = s.textSets + s.tooltipSets;
  await sleep(600);
  assert.equal(s.textSets + s.tooltipSets, t0, 'nothing runs after deactivate');
  hang = false;
  s.cfg = { 'tooltip.mode': 'Live', statusBarMs: { cpu: 200 } };
  ext.activate({ subscriptions: [] });
  await sleep(300);
  for (const resolve of hung.splice(0)) resolve();
  await sleep(300);
  const rate = await tooltipRate('CPU usage', 2000);
  assert.ok(rate >= 4 && rate <= 5.6, `one schedule after re-activation: ${rate}/s`);
  ext.deactivate();
  step('deactivate and re-activate');
}

assert.deepEqual(s.errors.filter((e) => /disposed/.test(e)), [], 'no writes to disposed items');
clearInterval(keepAlive);
cleanup();
console.log('EXTENSION TESTS OK');
