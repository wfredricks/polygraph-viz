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
   *                              Graph' button + segment chips.
   *
   * Views without a meaningful constellation (e.g. Sankey before nodes
   * are clickable) may no-op.
   */
  focus(
    nodeId: string | string[] | null,
    opts?: { transitive?: boolean },
  ): void;
}

/**
 * Default no-op handle used by views that have not yet returned one.
 */
export const NULL_HANDLE: ViewHandle = {
  setSearch: () => undefined,
  destroy: () => undefined,
  focus: () => undefined,
};
