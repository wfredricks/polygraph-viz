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
}

/**
 * Default no-op handle used by views that have not yet returned one.
 */
export const NULL_HANDLE: ViewHandle = {
  setSearch: () => undefined,
  destroy: () => undefined,
};
