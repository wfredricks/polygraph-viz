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
import { BedrockClient } from './nl/bedrock.js';
import { EmbedCache, computeSnapshotHash } from './nl/embed-cache.js';
import { computeSchemaFingerprint, rankWithLlm } from './nl/ranker.js';
import { loadLexicon } from './nl/lexicon.js';
import { KnowledgeBase } from './nl/kb.js';
import { answerStream, answerOnce } from './nl/answerer.js';
import type { ChatMessage } from './nl/bedrock.js';
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
/**
 * Configuration for the NL surface (search + chat). When `provider` is
 * `'off'`, the server does NOT mount any /api/nl-* or /api/chat routes
 * and the client surfaces the literal-search input only.
 */
export interface NlConfig {
  provider: 'off' | 'bedrock';
  awsProfile?: string;
  awsRegion?: string;
  llmModel?: string;
  embedModel?: string;
  lexiconPath?: string;
  kbPath?: string;
}

export interface BuildAppOptions {
  title?: string;
  nl?: NlConfig;
}

export function buildApp(
  graphData: GraphExport,
  options: BuildAppOptions = {},
): Hono {
  const app = new Hono();
  // Why: a default title so the viewer brands as itself when no
  // downstream product overrides; downstream products (e.g. SI's
  // si-sig-viz container) pass --title to rebrand.
  const title = (options.title ?? 'PolyGraph Viz').replace(/[<>"']/g, '');
  const nlConfig: NlConfig = options.nl ?? { provider: 'off' };
  const nlEnabled = nlConfig.provider !== 'off';
  const bedrock: BedrockClient | null =
    nlConfig.provider === 'bedrock'
      ? new BedrockClient({
          awsProfile: nlConfig.awsProfile,
          awsRegion: nlConfig.awsRegion,
          llmModel: nlConfig.llmModel,
          embedModel: nlConfig.embedModel,
        })
      : null;
  if (bedrock) {
    const d = bedrock.describe();
    console.log(`  🧠 NL enabled — llm=${d.llmModel}  embed=${d.embedModel}`);
  }

  // Embedding cache (only used when NL is enabled).
  // Why this scope: build once at server start, share across all
  // /api/nl-search and /api/chat handlers. Re-embedding mid-run would
  // need a stop-the-world rebuild that v0.3 doesn't yet implement.
  let embedCache: EmbedCache | null = null;
  let embedCacheReady = false;
  let embedCacheError: string | null = null;
  let snapshotHash = '';
  const schema = computeSchemaFingerprint(graphData);
  const lexicon = loadLexicon(graphData, nlConfig.lexiconPath);
  if (nlEnabled && lexicon.size > 0) {
    console.log(`  📖 lexicon active: ${lexicon.size} terms (${lexicon.domain})`);
  }
  // Why: KB persists Save-This entries per graph. Path picked off
  // --kb if provided, else next to embeddings cache, else /tmp.
  const kbPath =
    nlConfig.kbPath
    ?? process.env['POLYGRAPH_VIZ_KB']
    ?? resolve(process.cwd(), `kb-${snapshotHash || 'demo'}.json`);
  const kb = nlEnabled ? new KnowledgeBase(kbPath) : null;
  if (kb) {
    console.log(`  💾 KB at ${kbPath} (${kb.size()} entries)`);
  }
  if (bedrock) {
    snapshotHash = computeSnapshotHash(graphData);
    const cachePath = process.env['POLYGRAPH_VIZ_EMBED_CACHE']
      ?? resolve(process.cwd(), `embeddings-${snapshotHash}.json`);
    embedCache = new EmbedCache(cachePath);
    const onDisk = embedCache.loadFromDisk();
    const stale =
      onDisk === null ||
      embedCache.isStale(graphData, bedrock.describe().embedModel);
    if (!stale) {
      console.log(`  🧠 embed cache loaded: ${embedCache.size()} nodes (${cachePath})`);
      embedCacheReady = true;
    } else {
      // Fire and forget. /api/nl-search returns 503 with a clear
      // 'building' status until done.
      console.log(`  🧠 building embed cache for ${graphData.nodes.length} nodes…`);
      const startedAt = Date.now();
      void embedCache
        .build(graphData, bedrock, (done, total) => {
          if (done === total || done % 25 === 0) {
            console.log(`     embedding ${done}/${total}`);
          }
        })
        .then(() => {
          embedCache!.saveToDisk();
          embedCacheReady = true;
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.log(
            `  🧠 embed cache built in ${elapsed}s and saved to ${cachePath}`,
          );
        })
        .catch((err: unknown) => {
          embedCacheError = String(err);
          console.error('embed cache build failed:', err);
        });
    }
  }

  // Why: the viewer page may be served from a different origin during
  // development (a proposal-time static page, an iframe in a wiki, etc.),
  // and the API surface is read-only, so a permissive CORS header is
  // safe and useful.
  app.use('/api/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });

  // ── API ────────────────────────────────────────────────────────
  // /api/config: surfaces capability flags to the browser so the UI
  // can show/hide the NL toggle without inspecting environment vars.
  app.get('/api/config', (c) =>
    c.json({
      title,
      nlEnabled,
      nlProvider: nlConfig.provider,
      embedCache: bedrock
        ? {
            ready: embedCacheReady,
            error: embedCacheError,
            snapshotHash,
            size: embedCache?.size() ?? 0,
          }
        : null,
    }),
  );
  app.get('/api/graph', (c) => c.json(graphData));
  app.get('/api/stats', (c) => c.json(computeStats(graphData)));
  app.get('/api/search', (c) => {
    const q = c.req.query('q') || '';
    return c.json(searchNodes(graphData, q));
  });
  // ── NL endpoints ────────────────────────────────────────────
  // Only mounted when --nl-search is on. Each route checks `bedrock`
  // for null and returns 503 with a clear message if NL is off, so a
  // misconfigured client doesn't get a confusing 404.
  app.post('/api/embed', async (c) => {
    if (!bedrock) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    const body = (await c.req.json()) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }
    if (text.length > 8000) {
      return c.json({ error: 'text exceeds 8000 chars' }, 400);
    }
    try {
      const vec = await bedrock.embed(text);
      // Send as plain number[] so the JSON serializer doesn't choke on
      // Float32Array; the client can wrap into a typed array if it wants.
      return c.json({
        dimensions: vec.length,
        embedding: Array.from(vec),
      });
    } catch (err) {
      console.error('embed failed:', err);
      return c.json(
        { error: 'embedding call failed', detail: String(err) },
        500,
      );
    }
  });

  /**
   * NL search step D: returns top-K nodes by cosine similarity to the
   * query embedding. No LLM ranker yet — that lands in step F.
   *
   * Request:  { query: string, k?: number }
   * Response: { query, results: [{nodeId, score, text, node?}], hash }
   */
  app.post('/api/nl-search', async (c) => {
    if (!bedrock) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    if (!embedCacheReady) {
      return c.json(
        {
          error: embedCacheError
            ? `embed cache failed to build: ${embedCacheError}`
            : 'embed cache still building',
        },
        503,
      );
    }
    const body = (await c.req.json()) as { query?: string; k?: number };
    const query = (body.query ?? '').trim();
    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }
    const k = Math.min(Math.max(body.k ?? 10, 1), 50);
    // We retrieve a wider net (3K) for the ranker to filter from, then
    // hand back at most `k` survivors.
    const retrieveK = Math.min(50, k * 3);
    try {
      const expandedQuery = lexicon.expand(query);
      const qvec = await bedrock.embed(expandedQuery);
      const cosineHits = embedCache!.searchByEmbedding(qvec, retrieveK);
      // Schema-aware LLM rerank + per-hit 'why'.
      const ranked = await rankWithLlm(bedrock, query, schema, cosineHits);
      const nodeIndex = new Map(graphData.nodes.map((n) => [n.id, n]));
      const cosineByNode = new Map(cosineHits.map((h) => [h.nodeId, h]));
      const top = ranked.slice(0, k).map((r) => {
        const cosine = cosineByNode.get(r.nodeId);
        return {
          nodeId: r.nodeId,
          why: r.why,
          embedScore: cosine?.score ?? 0,
          text: (cosine?.text ?? '').slice(0, 240),
          node: nodeIndex.get(r.nodeId) ?? null,
        };
      });
      return c.json({
        query,
        snapshotHash,
        results: top,
        // Surface the wider candidate set too for clients that want to
        // see what the cosine layer thought before the ranker filtered.
        candidates: cosineHits.slice(0, retrieveK).map((h) => ({
          nodeId: h.nodeId,
          embedScore: h.score,
        })),
      });
    } catch (err) {
      console.error('nl-search failed:', err);
      return c.json({ error: 'nl-search failed', detail: String(err) }, 500);
    }
  });

  /**
   * Multi-turn chat with graph-grounded answers (SSE streaming).
   *
   * Request: { query: string, history?: ChatMessage[] }
   * Response: text/event-stream with frames:
   *   event: meta     data: {citedNodes: [...], snapshotHash}
   *   event: token    data: {text}  (many of these)
   *   event: done     data: {}
   *
   * The client appends `token` frames to render streaming text, uses
   * `meta` for the citation list (sent once before tokens start), and
   * closes the stream on `done`.
   */
  app.post('/api/chat', async (c) => {
    if (!bedrock || !kb) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    if (!embedCacheReady) {
      return c.json({ error: 'embed cache still building' }, 503);
    }
    const body = (await c.req.json()) as {
      query?: string;
      history?: ChatMessage[];
    };
    const query = (body.query ?? '').trim();
    if (!query) return c.json({ error: 'query is required' }, 400);
    const history = (body.history ?? []).filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    );

    // Retrieve + rank.
    const expanded = lexicon.expand(query);
    const qvec = await bedrock.embed(expanded);
    const cosineHits = embedCache!.searchByEmbedding(qvec, 30);
    const ranked = await rankWithLlm(bedrock, query, schema, cosineHits);
    const kbMatches = kb.search(query, 3);

    // SSE stream.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const frame = (event: string, data: unknown): void => {
          controller.enqueue(
            enc.encode(`event: ${event}
data: ${JSON.stringify(data)}

`),
          );
        };
        frame('meta', {
          citedNodes: ranked.map((r) => r.nodeId),
          snapshotHash,
        });
        try {
          for await (const chunk of answerStream(
            bedrock!,
            graphData,
            schema,
            title,
            query,
            history,
            ranked,
            kbMatches,
          )) {
            frame('token', { text: chunk });
          }
          frame('done', {});
        } catch (err) {
          frame('error', { detail: String(err) });
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  /**
   * Non-streaming version of /api/chat for clients that prefer one
   * JSON blob. Used by tests and by lightweight embedders.
   */
  app.post('/api/chat/once', async (c) => {
    if (!bedrock || !kb) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    if (!embedCacheReady) {
      return c.json({ error: 'embed cache still building' }, 503);
    }
    const body = (await c.req.json()) as {
      query?: string;
      history?: ChatMessage[];
    };
    const query = (body.query ?? '').trim();
    if (!query) return c.json({ error: 'query is required' }, 400);
    const history = (body.history ?? []).filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    );
    const expanded = lexicon.expand(query);
    const qvec = await bedrock.embed(expanded);
    const cosineHits = embedCache!.searchByEmbedding(qvec, 30);
    const ranked = await rankWithLlm(bedrock, query, schema, cosineHits);
    const kbMatches = kb.search(query, 3);
    const answer = await answerOnce(
      bedrock,
      graphData,
      schema,
      title,
      query,
      history,
      ranked,
      kbMatches,
    );
    return c.json({
      query,
      answer,
      citedNodes: ranked.map((r) => r.nodeId),
      snapshotHash,
    });
  });

  /**
   * Save This — append a chat turn to the KB.
   * Body: { query, answer, citedNodes: string[] }
   */
  app.post('/api/kb', async (c) => {
    if (!kb) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    const body = (await c.req.json()) as {
      query?: string;
      answer?: string;
      citedNodes?: string[];
    };
    if (!body.query || !body.answer) {
      return c.json({ error: 'query and answer are required' }, 400);
    }
    const entry = kb.add({
      query: body.query,
      answer: body.answer,
      citedNodes: body.citedNodes ?? [],
    });
    return c.json({ ok: true, entry });
  });

  app.get('/api/kb', (c) => {
    if (!kb) {
      return c.json({ error: 'NL features not enabled on this server' }, 503);
    }
    return c.json({ size: kb.size() });
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
