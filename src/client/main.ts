/**
 * polygraph-viz client bootstrap.
 *
 * This is the only entry the browser loads. It:
 *   1. Fetches /api/graph once (the same snapshot the server holds in
 *      memory) and caches it on the page.
 *   2. Wires the toolbar (view tabs, search, theme toggle).
 *   3. Hands the data to the active renderer (Force by default; Chord
 *      and Sankey are stubbed pending steps G and H).
 *
 * Why a real client bundle (instead of inline <script>): the v0.1 viewer
 * shipped one giant <script> string inside cli.ts and hand-rolled SVG
 * physics. v0.2 swaps in d3-force, d3-chord, and d3-sankey, each of which
 * needs ESM module resolution that the browser cannot do without a
 * bundle step.
 */

import type { GraphExport } from '../types.js';
import { installTheme } from './ui/theme.js';
import { installToolbar, type ViewKey } from './ui/toolbar.js';
import { renderStats } from './ui/stats.js';
import { renderForce } from './views/force.js';
import { renderChord } from './views/chord.js';
import { renderSankey } from './views/sankey.js';

interface AppState {
  graph: GraphExport | null;
  currentView: ViewKey;
}

const state: AppState = {
  graph: null,
  currentView: 'force',
};

async function fetchGraph(): Promise<GraphExport> {
  const r = await fetch('/api/graph');
  if (!r.ok) {
    throw new Error(`/api/graph returned ${r.status}`);
  }
  return (await r.json()) as GraphExport;
}

/**
 * Switch the active view. Renderers are responsible for cleaning up
 * their own DOM in the #viz container before the next renderer mounts.
 */
function switchView(view: ViewKey): void {
  state.currentView = view;
  const viz = document.getElementById('viz');
  if (!viz || !state.graph) return;

  // Clear previous renderer output.
  viz.innerHTML = '';

  switch (view) {
    case 'force':
      renderForce(viz, state.graph);
      break;
    case 'chord':
      renderChord(viz, state.graph);
      break;
    case 'sankey':
      renderSankey(viz, state.graph);
      break;
  }
}

async function boot(): Promise<void> {
  installTheme();
  installToolbar({
    onViewChange: (view) => switchView(view),
    onSearch: (q) => {
      // Why: search wiring expands in step I (inspector + filter-on-search).
      // For now, log so the toolbar event is observably reaching the boot
      // module.
      console.debug('search query:', q);
    },
  });

  try {
    state.graph = await fetchGraph();
    void renderStats(state.graph);
    switchView(state.currentView);
  } catch (err) {
    const viz = document.getElementById('viz');
    if (viz) {
      viz.innerHTML = `<p class="placeholder error">Failed to load graph: ${String(
        err,
      )}</p>`;
    }
    // Why: surface the failure visibly — silent failures are explicitly
    // listed as a class to avoid in HEARTBEAT.md.
    console.error('polygraph-viz boot failed:', err);
  }
}

void boot();
