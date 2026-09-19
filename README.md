# PolyGraph Visualizer

**See your graph. Instantly.**

A browser-based visualizer for [PolyGraph](https://github.com/wfredricks/polygraph) — the embeddable graph database. Three D3-powered views, light + dark mode, no Neo4j Browser required.

## What's new in v0.2

- **Three views**, switchable from a toolbar:
  - **Force** — d3-force directed graph (pan + zoom + drag).
  - **Chord** — d3-chord diagram, grouped by primary node label, with ribbons sized by between-group traffic.
  - **Sankey** — d3-sankey flow across a chain of label classes. Auto-detects a chain (longest dominant transition path), or pass `?sankey=A,B,C` to override.
- **Light + dark mode** — toggle in the toolbar, persisted in localStorage, OS-preference-aware on first load.
- **Search-as-greyout** — type in the toolbar search box; non-matching nodes dim to 15% opacity across all three views. Matched nodes get an accent halo in Force; matched groups stay solid in Chord; matched nodes light up in Sankey.
- **Click to inspect** — every view exposes click-to-inspect via a shared right-side panel. Force/Sankey show the node's full property table; Chord shows the group's member list.
- **Okabe-Ito colorblind-safe palette** — 12 hues assigned deterministically by FNV-1a hash of the label name, so `Requirement` is always the same blue across views and graphs.

## Quick Start

```bash
# Demo mode (sample twin graph)
npx polygraph-viz --demo

# Visualize a local PolyGraph database
npx polygraph-viz --path ./my-graph-data

# Pull from a remote PolyGraph viz endpoint
npx polygraph-viz --url http://localhost:30100/api/graph
```

Opens `http://localhost:4444` (override with `--port`).

## Embedding

```typescript
import { serve } from '@hono/node-server';
import { buildApp, loadGraph } from 'polygraph-viz';

const graph = await loadGraph({ path: './data' });
const app = buildApp(graph);
serve({ fetch: app.fetch, port: 4444 });
```

The Hono app exposes:

- `GET /` — the viewer HTML shell.
- `GET /styles.css`, `GET /client.js` — viewer assets.
- `GET /api/graph` — full graph snapshot (nodes + edges).
- `GET /api/stats` — node/edge counts, label + relationship distribution, density, component count.
- `GET /api/search?q=<text>` — server-side substring filter (the in-browser search is independent).
- `GET /api/filter/labels?labels=A,B,C` — node subset.

All `/api/*` routes carry permissive CORS so the viewer can be embedded in a page served from a different origin.

## Architecture

```
src/
├── cli.ts          # argv -> loadGraph -> buildApp -> serve
├── server.ts       # buildApp() + loadGraph() — Hono server + asset routes
├── graph-api.ts    # PolyGraph -> GraphExport (allNodes + adjacency walk)
├── middleware.ts   # (stub for Hono middleware export, v0.3)
├── types.ts        # VizNode, VizEdge, GraphExport, VizConfig
└── client/
    ├── main.ts                 # client bootstrap
    ├── ui/
    │   ├── theme.ts            # light/dark CSS variable driver
    │   ├── toolbar.ts          # view tabs + search debouncing
    │   ├── stats.ts            # footer counts
    │   ├── inspector.ts        # shared right-side detail panel
    │   └── palette.ts          # Okabe-Ito 12-class palette
    └── views/
        ├── types.ts            # ViewHandle contract
        ├── force.ts            # d3-force renderer
        ├── chord.ts            # d3-chord renderer
        └── sankey.ts           # d3-sankey renderer
```

`tsup.client.config.ts` bundles `src/client/main.ts` -> `public/client.js` for the browser (target ES2022, all d3 modules bundled in via `noExternal: [/^d3-/]`). The server bundle and middleware are emitted by the default `tsup` build into `dist/`.

## Why?

If you own the engine, own the viewer. PolyGraph replaces Neo4j — this replaces Neo4j Browser.

## License

Apache 2.0

## Part of the PolyGraph Ecosystem

- [**PolyGraph**](https://github.com/wfredricks/polygraph) — embeddable graph database
- **PolyGraph Visualizer** — this package
- **BangAuth** — embeddable identity provider
