/**
 * polygraph-viz client bootstrap.
 *
 * This is the only entry the browser loads. It:
 *   1. Fetches /api/graph once (the same snapshot the server holds in
 *      memory) and caches it on the page.
 *   2. Wires the toolbar (view tabs, search, theme toggle).
 *   3. Hands the data to the active renderer (Force / Chord / Sankey).
 *   4. Forwards search input to the active view's ViewHandle.
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
import type { ViewHandle } from './views/types.js';
import { NULL_HANDLE } from './views/types.js';
import { installChat } from './ui/chat.js';

interface AppState {
  graph: GraphExport | null;
  currentView: ViewKey;
  currentHandle: ViewHandle;
  currentSearch: string;
}

const state: AppState = {
  graph: null,
  currentView: 'force',
  currentHandle: NULL_HANDLE,
  currentSearch: '',
};

async function fetchGraph(): Promise<GraphExport> {
  const r = await fetch('/api/graph');
  if (!r.ok) {
    throw new Error(`/api/graph returned ${r.status}`);
  }
  return (await r.json()) as GraphExport;
}

/**
 * Switch the active view. Previous handle is destroyed first; the new
 * renderer takes responsibility for what lives inside #viz.
 */
function switchView(view: ViewKey): void {
  const viz = document.getElementById('viz');
  if (!viz || !state.graph) return;

  // Tear down whatever was there.
  state.currentHandle.destroy();
  viz.innerHTML = '';

  state.currentView = view;

  switch (view) {
    case 'force':
      state.currentHandle = renderForce(viz, state.graph);
      break;
    case 'chord':
      state.currentHandle = renderChord(viz, state.graph);
      break;
    case 'sankey':
      state.currentHandle = renderSankey(viz, state.graph);
      break;
  }

  // Re-apply current search to the new view so the user's filter is
  // preserved across view switches.
  if (state.currentSearch) {
    state.currentHandle.setSearch(state.currentSearch);
  }
}

async function boot(): Promise<void> {
  installTheme();
  installToolbar({
    onViewChange: (view) => switchView(view),
    onSearch: (q) => {
      state.currentSearch = q;
      state.currentHandle.setSearch(q);
    },
  });

  try {
    state.graph = await fetchGraph();
    void renderStats(state.graph);
    switchView(state.currentView);

    // Install the chat drawer if the server enabled NL. Off-by-default
    // so embedders without an LLM are unaffected.
    try {
      const cfg = await fetch('/api/config').then((r) => r.json() as Promise<{
        nlEnabled?: boolean;
        embedCache?: { snapshotHash?: string } | null;
      }>);
      if (cfg.nlEnabled) {
        installChat({
          nlEnabled: true,
          snapshotHash: cfg.embedCache?.snapshotHash ?? 'default',
          getCurrentViewHandle: () => state.currentHandle,
        });
      }
    } catch (err) {
      console.warn('chat drawer: config fetch failed', err);
    }
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
