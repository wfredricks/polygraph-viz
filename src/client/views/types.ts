/**
 * Shared view contract.
 *
 * Each view's renderer returns a small handle that main.ts can drive
 * without knowing which view is currently mounted: apply a search
 * filter, tear down, or expose the current selection.
 *
 * Why a handle (not events): explicit calls are easier to reason about
 * than EventTarget plumbing and keep main.ts's state machine flat.
 */

export interface ViewHandle {
  /** Apply a search query — empty string clears any filter. */
  setSearch(query: string): void;
  /** Tear down DOM + simulations + listeners. */
  destroy(): void;
  /**
   * Focus on a node's connection constellation, or on a set of nodes.
   *
   *   focus(null)              — clear focus (restore default rendering)
   *   focus(id)                — highlight 1-hop neighborhood of `id`
   *   focus(id, { transitive: true }) — highlight the full reachable
   *                              subgraph in both directions (BFS)
   *   focus([id1, id2, ...])   — highlight the union of all 1-hop
   *                              neighborhoods. Used by chat 'Focus in
   *                              Graph' button.
   *
   * Views without a meaningful constellation (e.g. Sankey before nodes
   * are clickable) may no-op.
   */
  focus(
    nodeId: string | string[] | null,
    opts?: { transitive?: boolean },
  ): void;
  /**
   * Hard filter: keep only the nodes whose id is in `keepIds` (plus the
   * edges between them). Everything else is hidden — not dimmed,
   * HIDDEN — so segment filtering produces a real "show only biz" view
   * instead of accidentally lighting up neighbors-of-biz.
   *
   *   setFilter(null)            — clear filter, restore full view
   *   setFilter([id1, id2, ...]) — render only those nodes + interior edges
   *
   * Why hard hide vs dim: focus(string[]) is union-of-1-hop-neighborhoods,
   * which for large selections (e.g. all 145 biz nodes in the SI build
   * SIG) pulls in almost every other node via adjacency. Segment commands
   * need precise membership semantics that ignore adjacency.
   */
  setFilter(keepIds: string[] | null): void;
}

/**
 * Default no-op handle used by views that have not yet returned one.
 */
export const NULL_HANDLE: ViewHandle = {
  setSearch: () => undefined,
  destroy: () => undefined,
  focus: () => undefined,
  setFilter: () => undefined,
};
