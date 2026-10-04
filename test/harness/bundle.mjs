// The one esbuild setup for tests and benches: TypeScript sources bundled for Node, with `vscode`
// resolved to test/harness/vscode-mock.cjs. The mock stays external (required by absolute path), so the
// bundle and the test that inspects the mock share one instance.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const mockPath = path.join(here, 'vscode-mock.cjs');

/**
 * Bundles one entry (a file, or `contents` as a TypeScript module resolved from the repository root)
 * to `dist/<name>.cjs`: next to dist/native, where the darwin addon loader looks (`__dirname`).
 *
 * @param {{ entry?: string, contents?: string, name: string }} options - `entry` relative to the root.
 * @returns {string} The bundle's path; the caller removes it.
 */
export function bundle({ entry, contents, name }) {
  const outfile = path.join(root, 'dist', `${name}.cjs`);
  require('esbuild').buildSync({
    ...(contents === undefined
      ? { entryPoints: [path.join(root, entry)] }
      : { stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: `${name}.ts` } }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    alias: { vscode: mockPath },
    external: ['*.node', mockPath],
    outfile,
    logLevel: 'warning',
  });
  return outfile;
}

/**
 * Bundles and loads one source file.
 *
 * @param {string} entry - Source file, relative to the repository root.
 * @param {string} name - Bundle name, written to dist/.
 * @returns {{ module: any, cleanup: () => void }}
 */
export function loadModule(entry, name) {
  const outfile = bundle({ entry, name });
  try {
    return { module: require(outfile), cleanup: () => fs.rmSync(outfile, { force: true }) };
  } catch (err) {
    fs.rmSync(outfile, { force: true });
    throw err;
  }
}
