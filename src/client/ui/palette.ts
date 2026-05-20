/**
 * Deterministic label-to-color palette.
 *
 * Why Okabe-Ito-derived: it's the de-facto colorblind-safe 8-class set
 * (Okabe & Ito 2008). We extend to 12 by interleaving lighter and
 * darker mid-stops so we have enough hues for graphs with many label
 * classes without crashing into legibility.
 *
 * Assignment is deterministic by label name (FNV-1a hash → modulo) so
 * the same label gets the same color across views, reloads, and
 * different graphs (e.g. a `Requirement` node in the bookend SIG and a
 * `Requirement` node in the build SIG render in the same blue).
 */

const PALETTE_12 = [
  '#56b4e9', // sky blue
  '#e69f00', // orange
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#f0e442', // yellow
  '#0072b2', // deep blue
  '#d55e00', // vermillion
  '#a6cee3', // light blue
  '#b2df8a', // light green
  '#fb9a99', // salmon
  '#fdbf6f', // light orange
  '#cab2d6', // light purple
] as const;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function colorForLabel(label: string): string {
  return PALETTE_12[fnv1a(label) % PALETTE_12.length] ?? PALETTE_12[0]!;
}

/**
 * Pick a primary label for a node (for coloring + grouping). Convention:
 * first non-utility label wins. "Bookend" and "BuildSIG" are utility
 * labels that mark *which* SIG a node belongs to, not what kind of node
 * it is, so they sort to the back.
 */
const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

export function primaryLabel(labels: string[]): string {
  if (labels.length === 0) return 'Node';
  const meaningful = labels.find((l) => !UTILITY_LABELS.has(l));
  return meaningful ?? labels[0]!;
}
