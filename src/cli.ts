#!/usr/bin/env node
/**
 * PolyGraph Visualizer CLI.
 *
 * Thin lifecycle wrapper around src/server.ts:
 *  - Parse argv.
 *  - Load the graph snapshot.
 *  - Boot the Hono app.
 *  - Optionally open the browser.
 *
 * The server itself (routes, static asset serving, graph loader) lives
 * in src/server.ts so middleware consumers and tests can build a server
 * without going through this CLI.
 *
 * Usage:
 *   npx polygraph-viz --path ./my-graph-data
 *   npx polygraph-viz --url http://localhost:3000/api/graph
 *   npx polygraph-viz --demo
 */

import { serve } from '@hono/node-server';
import { buildApp, loadGraph } from './server.js';
import type { VizConfig } from './types.js';

/**
 * Parse argv into a VizConfig. Unknown flags are ignored.
 *
 * Defaults to demo mode when no source is supplied, so `npx polygraph-viz`
 * with no flags still produces a visible graph (the v0.1 behavior).
 */
function parseArgs(argv: string[]): VizConfig {
  const args = argv.slice(2);
  const config: VizConfig = { port: 4444 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--path':
        config.path = args[++i];
        break;
      case '--url':
        config.url = args[++i];
        break;
      case '--demo':
        config.demo = true;
        break;
      case '--port':
        config.port = parseInt(args[++i] ?? '4444', 10);
        break;
      case '--write':
        config.write = true;
        break;
      case '--open':
        config.open = true;
        break;
      default:
        // Why: forward-compat — silently ignore unknown flags so an older
        // CLI keeps working when a newer wrapper adds options.
        break;
    }
  }

  if (!config.path && !config.url && !config.demo) {
    config.demo = true;
  }

  return config;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  if (config.demo) {
    console.log('🎨 PolyGraph Visualizer — Demo Mode');
  } else if (config.path) {
    console.log(`🎨 PolyGraph Visualizer — Local: ${config.path}`);
  } else if (config.url) {
    console.log(`🎨 PolyGraph Visualizer — Remote: ${config.url}`);
  }

  const graphData = await loadGraph(config);
  const app = buildApp(graphData);

  const port = config.port ?? 4444;
  serve({ fetch: app.fetch, port }, () => {
    console.log(
      `\n  🕸️  Graph: ${graphData.metadata.nodeCount} nodes, ${graphData.metadata.edgeCount} edges`,
    );
    console.log(`  🌐  Open: http://localhost:${port}\n`);
  });

  if (config.open) {
    const { exec } = await import('node:child_process');
    exec(`open http://localhost:${port}`);
  }
}

main().catch((err) => {
  console.error('polygraph-viz fatal:', err);
  process.exit(1);
});
