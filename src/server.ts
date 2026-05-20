/**
 * PolyGraph Visualizer — Hono server.
 *
 * Server-side surface only. Owns the in-memory graph snapshot and exposes
 * the same /api/graph contract that the v0.1 viewer used, so existing
 * consumers (the si-sig-viz container, embedded middleware users, etc.)
 * keep working without change.
 *
 * The browser UI is shipped as static assets under public/. Each file is
 * read at startup and served from memory via Hono routes — this avoids
 * @hono/node-server's serveStatic, which does not support absolute root
 * paths and therefore breaks when the process is launched from any cwd
 * other than the package directory (the common npx case).
 *
 * Why this is a separate file: cli.ts now does only argv parsing and
 * lifecycle (start server, optionally open browser). Server construction
 * is here so the middleware export and tests can use it without going
 * through process.argv.
 */

import { Hono } from 'hono';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  connectGraph,
  exportGraph,
  buildDemoGraph,
  computeStats,
  searchNodes,
  filterByLabels,
} from './graph-api.js';
import type { VizConfig, GraphExport } from './types.js';

/**
 * Resolve the directory that holds the bundled public/ assets.
 *
 * In development (running src/server.ts via tsx) this resolves to
 * <repo>/public. In a published package (running dist/server.js) the
 * same relative walk lands on <package>/public, which is included in
 * the `files` array of package.json.
 */
function resolvePublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'public');
}

/**
 * Per-asset content-type. Kept small and explicit; we know exactly
 * which files ship.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream';
}

/**
 * Load the graph snapshot indicated by the config.
 *
 * Exported so tests and the middleware can build a server around an
 * already-loaded graph without re-running this logic.
 */
export async function loadGraph(config: VizConfig): Promise<GraphExport> {
  if (config.demo) {
    return buildDemoGraph();
  }
  if (config.path) {
    const graph = await connectGraph(config.path);
    return exportGraph(graph);
  }
  if (config.url) {
    const response = await fetch(config.url);
    return (await response.json()) as GraphExport;
  }
  return buildDemoGraph();
}

/**
 * Build a Hono app that serves the visualizer for the given graph.
 *
 * The same `/api/*` routes the v0.1 viewer exposed are preserved here
 * so existing consumers do not break. Static assets are read once at
 * startup and served from memory.
 */
export function buildApp(
  graphData: GraphExport,
  options: { title?: string } = {},
): Hono {
  const app = new Hono();
  // Why: a default title so the viewer brands as itself when no
  // downstream product overrides; downstream products (e.g. SI's
  // si-sig-viz container) pass --title to rebrand.
  const title = (options.title ?? 'PolyGraph Viz').replace(/[<>"']/g, '');

  // Why: the viewer page may be served from a different origin during
  // development (a proposal-time static page, an iframe in a wiki, etc.),
  // and the API surface is read-only, so a permissive CORS header is
  // safe and useful.
  app.use('/api/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });

  // ── API ────────────────────────────────────────────────────────
  app.get('/api/graph', (c) => c.json(graphData));
  app.get('/api/stats', (c) => c.json(computeStats(graphData)));
  app.get('/api/search', (c) => {
    const q = c.req.query('q') || '';
    return c.json(searchNodes(graphData, q));
  });
  app.get('/api/filter/labels', (c) => {
    const labels = (c.req.query('labels') || '').split(',').filter(Boolean);
    return c.json(filterByLabels(graphData, labels));
  });

  // ── Static assets ──────────────────────────────────────────────
  // Why: serve from a known, absolute public/ path. @hono/node-server's
  // serveStatic refuses absolute roots, which makes it brittle in
  // published-package + npx scenarios.
  const publicDir = resolvePublicDir();
  const ASSETS = ['/index.html', '/styles.css', '/client.js'];

  app.get('/', (c) => {
    const filePath = resolve(publicDir, 'index.html');
    if (!existsSync(filePath)) {
      return c.text(
        'polygraph-viz: public/index.html not found. Did you run `npm run build`?',
        500,
      );
    }
    // Why: substitute the {{TITLE}} placeholder so the same shipped
    // index.html file serves both the default-branded viewer and any
    // downstream-branded variant.
    const html = readFileSync(filePath, 'utf-8').replace(/\{\{TITLE\}\}/g, title);
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  for (const asset of ASSETS) {
    app.get(asset, (c) => {
      const filePath = resolve(publicDir, asset.slice(1));
      if (!existsSync(filePath)) {
        return c.notFound();
      }
      const isBinary = asset.endsWith('.svg') === false && /\.(png|jpg|jpeg|gif|ico)$/i.test(asset);
      if (isBinary) {
        const buf = readFileSync(filePath);
        // Hono c.body accepts ArrayBuffer / Uint8Array
        return c.body(new Uint8Array(buf), 200, {
          'Content-Type': contentTypeFor(asset),
        });
      }
      return c.body(readFileSync(filePath, 'utf-8'), 200, {
        'Content-Type': contentTypeFor(asset),
      });
    });
  }

  return app;
}
