// Runs test files with the Node.js test runner (node:test): TypeScript files are bundled first
// (test/harness/bundle.mjs: `vscode` resolved to the mock, inline source maps), .mjs files run as they are.
// A directory stands for its *.test.ts and *.test.mjs files. Every other argument goes to node, so test
// runner options work as usual. Bundles are removed when the run ends, whatever its outcome.
//
// Usage:  node test/harness/run-ts.mjs [node options] <file | directory>...
//   e.g.  node test/harness/run-ts.mjs test/unit
//         node test/harness/run-ts.mjs --test-name-pattern="rescan" test/unit/linux-temp.test.ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bundle, root } from './bundle.mjs';

const TEST_FILE = /\.test\.(ts|mjs)$/;
const options = [];
const entries = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-')) {
    options.push(arg);
  } else if (fs.statSync(arg, { throwIfNoEntry: false })?.isDirectory()) {
    entries.push(...fs.readdirSync(arg).filter((f) => TEST_FILE.test(f)).sort().map((f) => path.join(arg, f)));
  } else {
    entries.push(arg);
  }
}
if (entries.length === 0) {
  console.error('run-ts: no test files given');
  process.exit(1);
}

const bundles = [];
const cleanup = () => {
  for (const file of bundles.splice(0)) fs.rmSync(file, { force: true });
};

const files = [];
try {
  for (const entry of entries) {
    const rel = path.relative(root, path.resolve(entry));
    if (!rel.endsWith('.ts')) {
      files.push(rel);
      continue;
    }
    // One bundle per entry (dist/test-unit-linux-temp.test.cjs): parallel runs never share a file.
    const name = `test-${rel.replace(/\.ts$/, '').replaceAll(path.sep, '-').replace(/^test-/, '')}`;
    bundles.push(bundle({ entry: rel, name }));
    files.push(bundles.at(-1));
  }
} catch (err) {
  cleanup();
  console.error(err.message);
  process.exit(1);
}

// The spec reporter also when piped (CI logs, test/verify-macos.sh), where node would pick TAP.
const reporter = options.some((o) => o.startsWith('--test-reporter')) ? [] : ['--test-reporter=spec'];
const child = spawn(process.execPath, ['--enable-source-maps', ...reporter, ...options, '--test', ...files], { cwd: root, stdio: 'inherit' });
// Ctrl+C reaches the child too (same process group): wait for it, then clean up.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  cleanup();
  process.exit(code ?? (signal ? 1 : 0));
});
