/**
 * polygraph-viz client bootstrap.
 *
 * This is the only entry the browser loads. It:
 *   1. Fetches /api/graph once (the same snapshot the server holds in
 *      memory) and caches it on the page.
 *   2. Wires the toolbar (view tabs, search, theme toggle).
 *   3. Hands the data to the active renderer (Force / Chord / Sankey).
 *   4. Forwards search input to the active view's ViewHandle.
 *   5. Installs the chat drawer when /api/config reports nlEnabled.
 *   6. Owns the "Render Subgraph" flow: swap the renderer's input to a
 *      subgraph extraction from /api/subgraph, show a "← Back to full
 *      graph" pill, and restore on click.
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
import { installCommandPalette } from './ui/command-palette.js';
import type { CommandContext } from './ui/commands.js';

interface AppState {
  /** The graph currently being rendered. May be the full /api/graph snapshot or a subgraph. */
  graph: GraphExport | null;
  /** The full graph snapshot, cached so "Back to full graph" can restore instantly. */
  fullGraph: GraphExport | null;
  /** Whether we are currently rendering a subgraph (vs the full graph). */
  inSubgraph: boolean;
  /** Free-text label shown in the back-pill when in subgraph mode. */
  subgraphTitle: string;
  currentView: ViewKey;
  currentHandle: ViewHandle;
  currentSearch: string;
  /** Active slash-command filter, e.g. 'biz', 'label:sw.feature', 'focus:req:REQ-SI-001'. */
  activeFilter: string | null;
}

/**
 * Echo a system-style line into the chat drawer log. If the drawer
 * is not installed, the line is dropped (with a console.info for
 * debugging). Used by slash-command runners via CommandContext.
 */
function echoToChat(text: string): void {
  const logEl = document.querySelector('#chat-drawer .chat-log');
  if (!logEl) {
    // Drawer not present; for /help and /stats output it's worth a
    // console.info so a user without the chat enabled can still see
    // the command result.
    // eslint-disable-next-line no-console
    console.info('[cmd]', text);
    return;
  }
  const sysMsg = document.createElement('div');
  sysMsg.className = 'chat-msg chat-msg-system';
  // Render minimal markdown (bold + code spans).
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
  sysMsg.innerHTML = html;
  logEl.appendChild(sysMsg);
  // Auto-scroll to bottom.
  logEl.scrollTop = logEl.scrollHeight;
}

const state: AppState = {
  graph: null,
  fullGraph: null,
  inSubgraph: false,
  subgraphTitle: '',
  currentView: 'force',
  currentHandle: NULL_HANDLE,
  currentSearch: '',
  activeFilter: null,
};

async function fetchGraph(): Promise<GraphExport> {
  const r = await fetch('/api/graph');
  if (!r.ok) {
    throw new Error(`/api/graph returned ${r.status}`);
  }
  return (await r.json()) as GraphExport;
}

async function fetchSubgraph(nodeIds: string[]): Promise<GraphExport> {
  const r = await fetch('/api/subgraph', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodeIds,
      // One hop of neighbors gives enough context to read the subgraph
      // without overwhelming it. The user can shrink later if needed.
      hops: 1,
      includeIncoming: true,
      includeOutgoing: true,
    }),
  });
  if (!r.ok) {
    throw new Error(`/api/subgraph returned ${r.status}`);
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

/** Stats line and the optional "Back to full graph" pill. */
function refreshStatusLine(): void {
  if (state.graph) {
    void renderStats(state.graph);
  }
  ensureSubgraphPill();
  ensureFilterPill();
}

/**
 * Show / hide the "Filter: biz" pill in the stats footer based on whether
 * a slash-command filter is currently active.
 */
function ensureFilterPill(): void {
  const stats = document.getElementById('stats');
  if (!stats) return;
  let pill = document.getElementById('filter-pill');
  if (state.activeFilter) {
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'filter-pill';
      pill.setAttribute('type', 'button');
      pill.addEventListener('click', () => {
        state.activeFilter = null;
        state.currentHandle.focus(null);
        state.currentHandle.setFilter(null);
        ensureFilterPill();
      });
      stats.appendChild(pill);
    }
    pill.textContent = `× Filter: ${state.activeFilter}`;
  } else if (pill) {
    pill.remove();
  }
}

/**
 * Show / hide the "← Back to full graph" pill in the stats footer based
 * on whether we are currently in subgraph mode.
 */
function ensureSubgraphPill(): void {
  const stats = document.getElementById('stats');
  if (!stats) return;
  let pill = document.getElementById('subgraph-pill');
  if (state.inSubgraph) {
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'subgraph-pill';
      pill.setAttribute('type', 'button');
      pill.addEventListener('click', () => {
        // Restore the full graph and remount whatever view was active.
        if (!state.fullGraph) return;
        state.graph = state.fullGraph;
        state.inSubgraph = false;
        state.subgraphTitle = '';
        switchView(state.currentView);
        refreshStatusLine();
      });
      stats.appendChild(pill);
    }
    const titleSuffix = state.subgraphTitle ? `: ${state.subgraphTitle}` : '';
    pill.textContent = `← Back to full graph (subgraph${titleSuffix})`;
  } else if (pill) {
    pill.remove();
  }
}

async function showSubgraph(citedNodes: string[], title: string): Promise<void> {
  if (citedNodes.length === 0) return;
  try {
    const sub = await fetchSubgraph(citedNodes);
    state.graph = sub;
    state.inSubgraph = true;
    state.subgraphTitle = title;
    switchView(state.currentView);
    refreshStatusLine();
  } catch (err) {
    console.error('subgraph fetch failed:', err);
    const viz = document.getElementById('viz');
    if (viz) {
      const p = document.createElement('p');
      p.className = 'placeholder error';
      p.textContent = `Failed to render subgraph: ${String(err)}`;
      viz.appendChild(p);
    }
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
    state.fullGraph = await fetchGraph();
    state.graph = state.fullGraph;
    // Fetch the code map up front so focusNode resolves instantly
    // without per-click /api/resolve round-trips. Falls back to the
    // server resolver if a token is missing from the cache.
    try {
      const cr = await fetch('/api/codes');
      if (cr.ok) {
        const data = (await cr.json()) as { byCode?: Record<string, string> };
        if (data.byCode) {
          (window as unknown as { __pgvByCode?: Record<string, string> }).__pgvByCode =
            data.byCode;
        }
      }
    } catch (err) {
      console.warn('codes prefetch failed:', err);
    }
    refreshStatusLine();
    switchView(state.currentView);

    // Build the slash-command context once. The palette reuses it.
    const ctx: CommandContext = {
      get graph() {
        return state.graph ?? state.fullGraph!;
      },
      getView: () => state.currentHandle,
      echoSystem: (text: string) => {
        // The chat drawer subscribes; if it's not installed, log to console
        // and overlay nothing.
        echoToChat(text);
      },
      switchView: (view) => switchView(view),
      setActiveFilter: (label) => {
        state.activeFilter = label;
        refreshStatusLine();
      },
    };

    // Install palette on the toolbar search input. Works whether or
    // not NL is on; commands are graph operations, no LLM required.
    const searchEl = document.getElementById('search') as HTMLInputElement | null;
    if (searchEl) {
      installCommandPalette({
        input: searchEl,
        ctx,
        onRun: () => {
          /* searchEl is cleared by the palette after a successful run */
        },
      });
    }

    // Install the chat drawer if the server enabled NL.
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
          onSubgraphRequested: (citedNodes, title) => {
            void showSubgraph(citedNodes, title);
          },
        });
        // Wire the chat textarea to the palette too.
        const chatInput = document.querySelector('#chat-drawer .chat-input') as
          | HTMLTextAreaElement
          | null;
        if (chatInput) {
          installCommandPalette({
            input: chatInput,
            ctx,
            onRun: () => {
              /* chat input cleared by palette */
            },
          });
        }
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
