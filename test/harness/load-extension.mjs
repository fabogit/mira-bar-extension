// Bundles src/extension.ts against test/harness/vscode-mock.cjs and loads it, so tests and benches can
// drive the real extension code outside VS Code.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
export const mockPath = path.join(here, 'vscode-mock.cjs');

/**
 * @param {string} name - Bundle name, written to dist/ (next to dist/native, where the addon loader looks).
 * @returns {{ vscode: any, ext: any, cleanup: () => void }}
 */
export function loadExtension(name) {
  const outfile = path.join(root, 'dist', `${name}.cjs`);
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['vscode'],
    logLevel: 'warning',
  });
  // Point the bundle at the same mock instance the caller inspects.
  fs.writeFileSync(outfile, fs.readFileSync(outfile, 'utf8').replaceAll('require("vscode")', `require(${JSON.stringify(mockPath)})`));
  const vscode = require(mockPath);
  const ext = require(outfile);
  return { vscode, ext, cleanup: () => fs.rmSync(outfile, { force: true }) };
}
