import { defineConfig } from 'tsup';

/**
 * Client bundle config for polygraph-viz.
 *
 * Separate from the (default) server build so we can target the browser
 * and emit a single named file (`client.js`) into public/ that
 * index.html references with <script type="module" src="/client.js">.
 */
export default defineConfig({
  entry: { client: 'src/client/main.ts' },
  format: ['esm'],
  outDir: 'public',
  minify: true,
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  sourcemap: false,
  clean: false, // public/ also holds index.html + styles.css — don't wipe.
  dts: false,
  // Why: tsup externalizes deps from package.json by default. The d3
  // modules MUST be bundled into the client because the browser cannot
  // resolve bare specifiers like 'd3-force'. noExternal forces them in.
  noExternal: [/^d3-/],
});
