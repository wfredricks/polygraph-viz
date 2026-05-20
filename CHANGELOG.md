# Changelog

All notable changes to polygraph-viz follow [Keep a Changelog](https://keepachangelog.com/) format. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] — 2026-05-20

### Added

- **Three D3 view modes** switchable from the toolbar:
  - **Force-directed** with d3-force (link + manyBody + center + collide), d3-zoom pan/zoom, d3-drag node drag.
  - **Chord** with d3-chord, grouped by primary node label, undirected adjacency matrix, click-to-inspect group members.
  - **Sankey** with d3-sankey, auto-detected chain via greedy walk of dominant outgoing transitions, `?sankey=A,B,C` URL override.
- **Light + dark mode**, with `data-theme` attribute on `<html>` driving CSS custom properties. Persisted in localStorage. First-load respects `prefers-color-scheme`.
- **Search-as-greyout**: non-matching nodes dim to 15% opacity across all three views; matched nodes get an accent halo in Force.
- **ViewHandle contract** (`setSearch`, `destroy`) so the orchestrator (main.ts) doesn't need to know which view is mounted.
- **Shared inspector** (`src/client/ui/inspector.ts`) with `showNode`, `showGroup`, `pickDisplayName`, `nodeMatches` helpers.
- **Okabe-Ito 12-class colorblind-safe palette** (`src/client/ui/palette.ts`) with deterministic FNV-1a hashing — `Requirement` is always the same blue across views and graphs.
- **Public API exports**: `buildApp`, `loadGraph`, `exportGraph`, `connectGraph` from package root for embedding.
- **CHANGELOG.md** (this file).

### Changed

- **`src/cli.ts`** is now a thin lifecycle wrapper (argv parse → loadGraph → buildApp → serve). Old 312-line file with inline HTML + hand-rolled SVG physics is gone.
- **`src/server.ts`** is new: owns Hono app construction. Reads `public/` assets via `fs.readFileSync` at request time because `@hono/node-server`'s `serveStatic` refuses absolute root paths and breaks under npx.
- **Build is now two-step**: `build:server` (tsup default) emits ESM + d.ts to `dist/`; `build:client` (`tsup.client.config.ts`) bundles `src/client/main.ts` to `public/client.js`, browser target, ES2022, minified, all d3 modules bundled in via `noExternal: [/^d3-/]`.
- **package.json `files[]`** narrowed from `["dist", "public"]` to the three known asset names to prevent stray contents from shipping.

### Fixed

- **`@types/d3-chord` and `@types/d3-array`** versions corrected to actual published versions (3.0.6 and 3.2.2). The proposal had stale numbers.

### Fixed (post-tag, rolled into 0.2.0)

- **Force-directed graph was left-justified on first paint.** The renderer measured the container before the page's grid layout had settled, so `forceCenter()` anchored at the wrong point and the simulation collapsed top-left. Now uses a `ResizeObserver` on the `#viz` container and re-anchors the center force whenever the container's real size changes.
- **Dark-mode edges were invisible.** SVG presentation attributes set via `.attr('stroke', 'var(--edge)')` do not reliably resolve CSS variables across browsers. Moved every `var(--*)` presentation token to CSS class selectors (`.edge`, `.node-circle`, `.chord-arc`, `.chord-ribbon`, `.chord-label`, `.sankey-link`, `.sankey-node`, `.sankey-node-label`, `.sankey-header`) so the cascade resolves correctly and theme toggles propagate atomically.
- **Edge contrast was too low to read.** Old `--edge` was `#3a3f55` (2.7:1 effective against `--bg` after 0.7 alpha). Raised to `#7e88a8` for dark (~5.9:1 effective at 0.9 alpha) and `#9aa1b4` for light (~2.5:1 effective at 0.9 alpha). Force-view `.edge` stroke-opacity raised 0.7 -> 0.9.

## [0.1.1] — 2026-05-20

### Fixed

- **`exportGraph` switched from Cypher bridge to `allNodes()` + `getNeighbors()`** (the engine's first-class adapters). The old `MATCH (n) RETURN n` path silently dropped nodes whose ids contained colons (e.g. `req:REQ-SI-001`) and never read relationships at all. Both are fixed.
- **Permissive CORS on `/api/*`** so an external viewer page can fetch from a different origin during development.

## [0.1.0] — 2026-05-07

### Added

- Initial release. Force-directed view only, dark theme only, hand-rolled SVG physics, inline HTML in `src/cli.ts`. Manual-test script. Examples.
