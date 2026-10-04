// Bundles src/extension.ts against test/harness/vscode-mock.cjs and loads it, so tests and benches can
// drive the real extension code outside VS Code.
import { createRequire } from 'node:module';
import { loadModule, mockPath } from './bundle.mjs';

const require = createRequire(import.meta.url);
export { loadModule, mockPath };

/**
 * @param {string} name - Bundle name, written to dist/ (next to dist/native, where the addon loader looks).
 * @returns {{ vscode: any, ext: any, cleanup: () => void }}
 */
export function loadExtension(name) {
  const { module: ext, cleanup } = loadModule('src/extension.ts', name);
  return { vscode: require(mockPath), ext, cleanup };
}
