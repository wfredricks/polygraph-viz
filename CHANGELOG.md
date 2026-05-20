# Changelog

All notable changes to polygraph-viz follow [Keep a Changelog](https://keepachangelog.com/) format. This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.7] — 2026-05-20

### Added

- **`--title <string>` CLI flag** to override the viewer's browser-tab title and toolbar header. Defaults to `"PolyGraph Viz"`. Lets downstream products embed the viewer with their own branding without forking the viewer source. Example: `npx polygraph-viz --path ./data --title "Solution Intel"` renders with `<title>Solution Intel</title>` and `<h1>Solution Intel</h1>`. Solution Intelligence's `si-sig-viz` container now uses this.
- `buildApp(graphData, { title })` accepts the same option programmatically.
- `index.html` ships with a `{{TITLE}}` placeholder; the server substitutes at request time so a single shipped HTML serves both default and custom-branded variants. Any `<`, `>`, `"`, `'` in the supplied title are stripped to prevent injection.

## [0.2.6] — 2026-05-20

### Fixed

- **Pure-black palette slot disappeared in dark mode.** v0.2.5's 16-color palette included `#000000` at slot 8 (the Okabe-Ito recommendation for line plots on light backgrounds). Against the dark theme's `#0e1019` background, that slot rendered as effectively invisible. In the live SI build SIG, `sw.feature` hashed to slot 8 in the Chord view and produced ghost arcs. Bill reported 2026-05-20 10:23 EDT. Replaced `#000000` with `#00b3b3` (teal), and replaced `#6a3d9a` (also too dark for dark mode) with `#a675c4` (soft violet).
- **Chord and Sankey still used the legacy hash-based color function.** v0.2.5 threaded the new `ColorMap` through Force only and left Chord/Sankey on the FNV-1a fallback, which produced collisions on the same data Force resolved cleanly. Now Chord and Sankey both consume the same per-render `ColorMap`, so the same label gets the same color across all three views and matches the Force-view legend.

### Changed

- All 16 palette slots are now constrained to a luminance band that reads against both dark (`#0e1019`) and light (`#fafafa`) backgrounds — nothing too dark to vanish in dark mode, nothing too pale to vanish in light mode.
- `renderSingleSankey` gains a `colorMap` parameter; the top-level `renderSankey` builds it once and passes it to every chain's renderer.
- `renderChord` builds a `ColorMap` per render and uses it for arc fills + ribbon fills.

## [0.2.5] — 2026-05-20

### Fixed

- **Color palette collisions in Force view.** v0.2.4 and earlier used FNV-1a hash of the label name modulo a 12-color palette, which produced visible collisions even on small graphs. In the SI build SIG: `sw.feature` and `sw.stage` both landed on light purple; `intended_behavior`, `Role`, and `Narrative` all landed on orange. Bill reported this 2026-05-20 10:18 EDT.

### Added

- **Collision-free color assignment.** Colors are now assigned by ORDER-OF-FIRST-APPEARANCE into a 16-color palette (Okabe-Ito 8 + 8 extension hues). Labels are sorted alphabetically before assignment so the result is stable across reloads of the same graph. Zero collisions guaranteed when distinct-label-count ≤ 16; for >16 labels, falls back to an HSL hue rotation that distributes evenly around the wheel.
- **Force view legend.** A floating panel in the top-right of the Force view lists every label with its color swatch and node count, sorted by count descending. The legend is built per-render from the actual graph data (no hard-coded labels). Hover a row to highlight. **Click a row to focus all nodes of that label** — clicking the same row again clears.
- New `buildColorMap(nodes)` helper in `ui/palette.ts` returns `{ colorForLabel, entries }`. The legacy `colorForLabel(label)` is kept as a deprecated fallback for Sankey/Chord paths that don't yet thread a full ColorMap.

## [0.2.4] — 2026-05-20

### Added

- **Connection constellation on click (Force view).** Clicking a node now dims everything except the connected constellation — the node itself, its direct neighbors, and the edges between them. Inspired by ECharts' `focusNodeAdjacency` pattern. The focused node gets an accent halo at 3px stroke; neighbors get a 1.6px accent ring; everything else drops to 12% opacity. Click the same node again to clear, click empty SVG background to clear, or press ESC.
- **Shift-click for transitive constellation.** Holding Shift while clicking shows the *full reachable subgraph* in both directions via BFS, not just direct neighbors. Useful for "if this breaks, what else is affected?" in dependency graphs (e.g. trace FT-SI-16 forward to see everything downstream).
- **`focus(nodeId, opts?)` method on `ViewHandle`** for programmatic focus. Allows future analyst panels (e.g. a build-order panel) to highlight a feature's dependency neighborhood by hovering rows in the panel.

### Changed

- Adjacency lookup tables (`outgoing` + `incoming` maps) are precomputed once at render time — O(E) up front, then O(1) for direct-neighbor focus and O(reachable-set) for transitive focus via BFS. For the 160-node SI build SIG, both modes feel instant.
- Search now clears any active focus before applying its filter, so a search match isn't dimmed by a stale constellation overlay.

### Known limitations

- **Focus is only implemented in Force.** Sankey and Chord have the `focus()` method as a documented no-op for now; extending to those two surfaces is a v0.3 candidate (the layout-internal node ids and the multi-chain split make the implementation chunkier than Force's).

## [0.2.3] — 2026-05-20

### Added

- **Sankey: "show all chains" toggle.** When the graph contains multiple disjoint chains in its label-transition graph (a common case for SIGs with weakly-connected components), Sankey now detects and renders all of them. A small toolbar appears at the top of the Sankey view with a status counter (`N chains shown` / `N more chains hidden`) and a toggle button (`Show all chains` / `Show primary only`). When all chains are shown, the view splits into stacked Sankey panels, one per chain, sized proportionally to the available height.
- **`?sankeyAll=1` URL parameter** to default-on multi-chain mode on first load. Pairs with the existing `?sankey=A,B,C` override (which still forces single-chain mode with the supplied chain).
- **Chain auto-detection across all components.** Iteratively peels off the longest chain from the remaining labels until no chain of length ≥2 remains; each label appears in at most one chain so the rendered Sankeys are visually disjoint.
- For the SI build SIG (160 nodes, 383 edges) this resolves to two chains: `sw.feature → sw.use_case → intended_behavior` (the traceability flow, 230 edge-weight) and `sw.stage → sw.repo` (the build sequencing flow, 14 edge-weight). Both are now visible together. Bill requested 2026-05-20 10:03 EDT.

### Changed

- `renderSankey` factored into `autoDetectChains` (returns string[][]) + `renderSingleSankey` (one chain into one SVG) + a top-level wrapper that handles single vs. multi layout. The single-chain mode is unchanged from v0.2.2.
- Module-level `showAllChains` cache persists the toggle state across view re-renders within a session; the URL parameter is the persistent form across page reloads.

## [0.2.2] — 2026-05-20

### Fixed

- **Sankey auto-detect now finds the longest chain, not the greedy first step.** v0.2.1's greedy walk picked the dominant outgoing transition at each label, which terminated chains prematurely when the dominant target was a sink. Concrete symptom in the SI build SIG: `sw.feature` had 131 IMPLEMENTS edges to `intended_behavior` (a sink) and 75 INVOLVES edges to `sw.use_case` (which itself has 155 EXERCISES edges to `intended_behavior`); the greedy algorithm picked the 131-edge step and ended the chain at 2 layers, missing the real 3-layer story (`sw.feature → sw.use_case → intended_behavior`, weight 230). New algorithm enumerates every viable source, DFS's each one to depth 8, and returns the longest chain (tie-broken by total weight). Bill reported the bug 2026-05-20 10:00 EDT.

## [0.2.1] — 2026-05-20

### Added

- **Edge inspection** across all three views. PolyGraph supports edge
  properties, but v0.2.0 had no way to surface them; they're now
  reachable end-to-end.
  - **Force**: edges are clickable via a transparent 10px-wide hit-area
    halo behind the thin visible line (1-2px lines were impossible to
    click reliably). Click an edge → right-side inspector shows edge
    type, endpoint ids, friendly endpoint names, and the full property
    table.
  - **Sankey**: links are clickable. Each link corresponds to exactly
    one edge in the source graph; click → same inspector.
  - **Chord**: ribbons are clickable. Because a ribbon aggregates many
    cross-group edges, the inspector shows a `showAggregate` view: a
    count of edges by type plus a sample of up to 30 constituent edges.
- **Hit-area dimming respects search filter**: when the search filter
  hides an edge (both endpoints not matching), the edge's hit area is
  disabled too so users don't accidentally click invisible targets.
- **Force edge stroke-opacity raised** 0.7 → 0.9 to match the higher
  visible-edge contrast introduced in v0.2.0's final fix.

### Changed

- `inspector.ts` grew two new exports (`showEdge`, `showAggregate`) and
  one new helper (the edge view formats type as a code-styled accent
  badge so the inspector visually distinguishes edge-mode from
  node-mode).

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
