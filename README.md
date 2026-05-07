# PolyGraph Visualizer

**See your graph. Instantly.**

A browser-based visualizer for [PolyGraph](https://github.com/wfredricks/polygraph) — the embeddable graph database. No Neo4j Browser required. No Java. One command.

## Quick Start

```bash
# Demo mode (sample twin graph)
npx polygraph-viz --demo

# Visualize a local PolyGraph database
npx polygraph-viz --path ./my-graph-data

# Connect to a remote twin
npx polygraph-viz --url http://localhost:3000/api/graph
```

Opens `http://localhost:4444` with a force-directed graph visualization.

## Features

- 🕸️ **Force-directed layout** — nodes repel, edges attract, graph self-organizes
- 🎨 **Color by label** — Twin (blue), Document (green), Role (red), Task (yellow)
- 🔍 **Search** — type to find nodes by any property value
- 📊 **Stats panel** — node count, edge count, label distribution
- 👆 **Click to inspect** — see all properties, incoming/outgoing relationships
- 🌙 **Dark theme** — easy on the eyes

## Embedding

```typescript
// As Hono/Express middleware
import { vizMiddleware } from 'polygraph-viz/middleware';
app.use('/graph', vizMiddleware({ path: './data' }));
```

## Why?

If you own the engine, own the viewer. PolyGraph replaces Neo4j — this replaces Neo4j Browser.

## License

Apache 2.0

## Part of the PolyGraph Ecosystem

- [**PolyGraph**](https://github.com/wfredricks/polygraph) — embeddable graph database
- **PolyGraph Visualizer** — this package
- **BangAuth** — embeddable identity provider (coming soon)
