// End-to-end cost of the extension logic (sampling + text/tooltip rendering) outside VS Code.
//
// Runs src/extension.ts with a stand-in `vscode` module (test/harness/vscode-mock.cjs) under several
// configurations and reports the CPU time of this process per second (% of one core) and how many
// status bar texts/tooltips it writes per second. The IPC to the VS Code renderer and the renderer's
// own work are not included: they come on top of these numbers.
//
// The per-section rows show one section alone at 200 ms in Live mode (text and tooltip rebuilt with
// every read): its extension-host CPU per read, the figure that joins the native read cost in the
// refresh-floor rule (docs/ARCHITECTURE.md, "Refresh Floors").
//
// Usage (macOS after `pnpm run compile:native`, or Linux):
//   node test/bench-extension.mjs            # 6 s per scenario, 2 rounds (~3 min)
//   node test/bench-extension.mjs 15         # custom seconds per scenario
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { loadExtension } from './harness/load-extension.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const seconds = Number(process.argv[2] ?? 6);
const { vscode, ext, cleanup } = loadExtension('bench-extension');
const s = vscode.__state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the extension timer is unref()'d

const ALL_HIDDEN = {
  'show.cpuusage': false, 'show.cpufreq': false, 'show.cputemp': false,
  'show.mem': false, 'show.battery': false, 'show.disk': false, 'show.settings': false,
};
const ALL_SHOWN = {
  'show.cpuusage': true, 'show.cpufreq': true, 'show.cputemp': true,
  'show.mem': true, 'show.battery': true, 'show.disk': true, 'show.settings': true,
};
const every = (ms) => ({ cpu: ms, freq: ms, temp: ms, mem: ms, battery: ms, disk: ms });

const scenarios = [
  { name: 'all widgets hidden (idle process)', cfg: { ...ALL_HIDDEN } },
  { name: 'defaults, all widgets shown', cfg: { ...ALL_SHOWN } },
  { name: 'all sections 1000 ms, Static tooltips', cfg: { ...ALL_SHOWN, statusBarMs: every(1000), allowFastRefresh: true } },
  { name: 'all sections 200 ms, Static tooltips', cfg: { ...ALL_SHOWN, statusBarMs: every(200), allowFastRefresh: true } },
  {
    name: 'all sections 200 ms, Live tooltips',
    cfg: { ...ALL_SHOWN, statusBarMs: every(200), allowFastRefresh: true, 'tooltip.mode': 'Live' },
  },
];

const SECTION_SHOW = { cpu: 'show.cpuusage', freq: 'show.cpufreq', temp: 'show.cputemp', mem: 'show.mem', battery: 'show.battery', disk: 'show.disk' };
for (const [section, key] of Object.entries(SECTION_SHOW)) {
  scenarios.push({
    name: `only ${section}, 200 ms, Live`,
    section,
    cfg: { ...ALL_HIDDEN, [key]: true, statusBarMs: every(200), allowFastRefresh: true, 'tooltip.mode': 'Live' },
  });
}

const context = { subscriptions: [] };
ext.activate(context);
// Warm-up (not reported): lets V8 compile the render paths, whose compiler threads count as CPU.
s.cfg = { ...scenarios[scenarios.length - 1].cfg };
vscode.__fireConfigChange();
await sleep(3000);

// Two rounds; only the second is reported (the first absorbs JIT and GC settling after each change).
let rows = [];
for (let round = 0; round < 2; round++) {
  rows = [];
  for (const sc of scenarios) {
    s.cfg = { ...sc.cfg };
    vscode.__fireConfigChange();
    await sleep(1000); // settle (debounce, first reads)
    const cpu0 = process.cpuUsage();
    const texts0 = s.textSets;
    const tips0 = s.tooltipSets;
    const t0 = performance.now();
    await sleep(seconds * 1000);
    const elapsed = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMsPerS = (cpu.user + cpu.system) / 1000 / (elapsed / 1000);
    const readsPerS = sc.section ? (((s.tooltipSets - tips0) * 1000) / elapsed) : 0;
    rows.push({
      scenario: sc.name,
      section: sc.section,
      readsPerS,
      cpuMsPerS,
      'CPU ms/s': cpuMsPerS.toFixed(2),
      '% of one core': (cpuMsPerS / 10).toFixed(3),
      'texts/s': (((s.textSets - texts0) * 1000) / elapsed).toFixed(1),
      'tooltips/s': (((s.tooltipSets - tips0) * 1000) / elapsed).toFixed(1),
    });
  }
}

ext.deactivate();
clearInterval(keepAlive);
cleanup();
console.log(`bench-extension: ${process.platform}-${process.arch}, node ${process.version}, ${seconds} s per scenario`);
const idle = rows[0].cpuMsPerS;
console.table(rows.map(({ section, readsPerS, cpuMsPerS, ...shown }) => shown));
const perSection = rows.filter((r) => r.section);
if (perSection.length) {
  console.log('Extension-host CPU per read (one section alone, Live, idle row subtracted):');
  console.table(perSection.map((r) => ({
    section: r.section,
    'reads/s': r.readsPerS.toFixed(1),
    'µs per read (text + tooltip)': r.readsPerS > 0 ? (((r.cpuMsPerS - idle) * 1000) / r.readsPerS).toFixed(0) : 'n/a (not available here)',
  })));
}
// Saved for test/bench-darwin.mjs and test/bench-linux.mjs, which combine it with the source costs into the
// proposed minimums.
const perReadUs = Object.fromEntries(perSection.filter((r) => r.readsPerS > 0).map((r) => [r.section, ((r.cpuMsPerS - idle) * 1000) / r.readsPerS]));
fs.writeFileSync(path.join(root, 'dist', 'bench-extension.json'), JSON.stringify({ platform: process.platform, arch: process.arch, perReadUs }, null, 2));
if (s.errors.length) {
  console.log('Extension errors:', s.errors);
}
console.log('The first row is the floor of this process (Node timers, GC); subtract it from the others.');
