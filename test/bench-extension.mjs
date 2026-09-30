// End-to-end cost of the extension logic (sampling + text/tooltip rendering) outside VS Code.
//
// Bundles src/extension.ts with a stand-in `vscode` module (test/harness/vscode-mock.cjs), runs it
// with several configurations and reports the CPU time of this process per second (% of one core)
// and how many status bar texts/tooltips it writes. The IPC to the VS Code renderer and the
// renderer's own work are not included: they come on top of these numbers.
//
// Usage (macOS after `pnpm run compile:native`, or Linux):
//   node test/bench-extension.mjs            # 10 s per scenario, 2 rounds (~1.5 min)
//   node test/bench-extension.mjs 30         # custom seconds per scenario
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const seconds = Number(process.argv[2] ?? 10);

const esbuild = require("esbuild");
const outfile = path.join(root, "dist", "bench-extension.cjs"); // next to dist/native for the addon loader
const mockPath = path.join(__dirname, "harness", "vscode-mock.cjs");
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  external: ["vscode"],
  logLevel: "warning",
});
// Point the bundle at the same mock instance this script inspects.
fs.writeFileSync(
  outfile,
  fs
    .readFileSync(outfile, "utf8")
    .replaceAll('require("vscode")', `require(${JSON.stringify(mockPath)})`),
);

const vscode = require(mockPath);
const ext = require(outfile);
const s = vscode.__state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // the extension timer is unref()'d

const ALL_HIDDEN = {
  "show.cpuusage": false,
  "show.cpufreq": false,
  "show.cputemp": false,
  "show.mem": false,
  "show.battery": false,
  "show.disk": false,
  "show.settings": false,
};
const ALL_SHOWN = {
  "show.cpuusage": true,
  "show.cpufreq": true,
  "show.cputemp": true,
  "show.mem": true,
  "show.battery": true,
  "show.disk": true,
  "show.settings": true,
};
const FAST = {
  cpu: 200,
  freq: 200,
  temp: 200,
  mem: 200,
  battery: 200,
  disk: 200,
};

const scenarios = [
  { name: "all widgets hidden (timer only)", cfg: { ...ALL_HIDDEN } },
  { name: "defaults, all widgets shown", cfg: { ...ALL_SHOWN } },
  {
    name: "status bar 200 ms, Static tooltips at defaults",
    cfg: {
      ...ALL_SHOWN,
      updatefrequencyms: 200,
      statusBarMs: FAST,
      allowFastRefresh: true,
    },
  },
  {
    name: "status bar 200 ms, Live tooltips",
    cfg: {
      ...ALL_SHOWN,
      updatefrequencyms: 200,
      statusBarMs: FAST,
      allowFastRefresh: true,
      "tooltip.mode": "Live",
    },
  },
];

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
    await sleep(1000); // settle (debounce, first samples)
    const cpu0 = process.cpuUsage();
    const texts0 = s.textSets,
      tips0 = s.tooltipSets;
    const t0 = performance.now();
    await sleep(seconds * 1000);
    const elapsed = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMsPerS = (cpu.user + cpu.system) / 1000 / (elapsed / 1000);
    rows.push({
      scenario: sc.name,
      "CPU ms/s": cpuMsPerS.toFixed(2),
      "% of one core": (cpuMsPerS / 10).toFixed(3),
      "texts/s": (((s.textSets - texts0) * 1000) / elapsed).toFixed(1),
      "tooltips/s": (((s.tooltipSets - tips0) * 1000) / elapsed).toFixed(1),
    });
  }
}

ext.deactivate();
clearInterval(keepAlive);
fs.rmSync(outfile, { force: true });
console.log(
  `bench-extension: ${process.platform}-${process.arch}, node ${process.version}, ${seconds} s per scenario`,
);
console.table(rows);
if (s.errors.length) {
  console.log("Extension errors:", s.errors);
}
console.log(
  "The first row is the floor of this process (Node timers, GC); subtract it from the others.",
);
