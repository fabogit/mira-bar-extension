const esbuild = require('esbuild');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', '*.node'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] Build complete.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
