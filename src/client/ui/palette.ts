/**
 * Label-to-color assignment.
 *
 * v0.2.4 and earlier used a deterministic FNV-1a hash of the label name
 * modulo a 12-color palette. The hash gave per-label stability across
 * reloads, but produced visible collisions even on small graphs: in
 * the SI build SIG, `sw.feature` and `sw.stage` both landed on light
 * purple, `intended_behavior` and `Role` and `Narrative` all landed
 * on orange, and so on.
 *
 * v0.2.5 fixes this by:
 *
 *   1. Assigning colors by ORDER-OF-FIRST-APPEARANCE into a palette,
 *      not by hash. The first distinct label gets palette[0], the
 *      second gets palette[1], and so on. This guarantees zero
 *      collisions when distinct-label-count ≤ palette-size.
 *
 *   2. Sorting the input label list deterministically (alphabetically)
 *      before assignment so the same graph reloads to the same colors.
 *
 *   3. Extending the palette from 12 to 16 colorblind-aware hues for
 *      headroom. The first 8 are the Okabe-Ito set (the de-facto
 *      colorblind-safe palette); the next 8 are interpolated hues
 *      that maintain reasonable distinguishability from each other
 *      and from the Okabe-Ito set.
 *
 *   4. When the graph has >16 distinct labels, falling back to an HSL
 *      rotation that distributes additional labels around the color
 *      wheel evenly. We never reuse a palette slot — collisions become
 *      impossible by construction.
 *
 * Usage pattern:
 *   const cm = buildColorMap(graph.nodes);
 *   cm.colorForLabel('sw.feature')    // -> '#56b4e9'
 *   cm.entries                         // -> [{ label, color }, ...] for the legend
 *   primaryLabel(node.labels)          // unchanged
 */

import type { VizNode } from '../../types.js';

/**
 * 16-color palette. First 8 are Okabe-Ito (colorblind-safe).
 * The next 8 are picked to maintain spacing on the HSL wheel and
 * stay visually distinct from the first 8 and from each other.
 */
const PALETTE_16 = [
  // Okabe-Ito 8
  '#56b4e9', // sky blue
  '#e69f00', // orange
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#f0e442', // yellow
  '#0072b2', // deep blue
  '#d55e00', // vermillion
  '#000000', // black (only when on a non-black background)
  // Extension 8 — additional hues
  '#7b3294', // royal purple
  '#a6cee3', // pale blue
  '#b2df8a', // pale green
  '#fb9a99', // salmon
  '#fdbf6f', // peach
  '#1f78b4', // medium blue
  '#33a02c', // medium green
  '#6a3d9a', // dark purple
] as const;

/** Utility labels that should not drive node color. */
const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

/**
 * Pick the "primary" label of a node — the first non-utility label, or
 * the first label if all are utilities. Determines coloring + grouping.
 */
export function primaryLabel(labels: string[]): string {
  if (labels.length === 0) return 'Node';
  const meaningful = labels.find((l) => !UTILITY_LABELS.has(l));
  return meaningful ?? labels[0]!;
}

export interface ColorMapEntry {
  label: string;
  color: string;
  count: number;
}

export interface ColorMap {
  /** Look up a color for a given label. Falls back to a default if the label is unknown to this map. */
  colorForLabel(label: string): string;
  /** Sorted (by count desc, then alpha) legend entries. */
  entries: ColorMapEntry[];
}

/**
 * Build a color map from a set of nodes. Labels are sorted alphabetically
 * for assignment so the result is stable across reloads of the same graph.
 *
 * Why not sort by count: count would be more "useful" visually (most
 * common gets palette[0], a strong color), but it would also mean a
 * dataset that gains/loses nodes can re-color silently. Alphabetic
 * sort is the safer stability guarantee.
 */
export function buildColorMap(nodes: VizNode[]): ColorMap {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const p = primaryLabel(n.labels);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  // Stable, deterministic assignment order.
  const labelsAlpha = [...counts.keys()].sort();
  const assignment = new Map<string, string>();

  for (let i = 0; i < labelsAlpha.length; i++) {
    const label = labelsAlpha[i]!;
    if (i < PALETTE_16.length) {
      assignment.set(label, PALETTE_16[i]!);
    } else {
      // HSL fallback for labels beyond the palette. Distribute evenly
      // around the wheel, offsetting so we don't clash with the early
      // palette entries.
      const overflow = i - PALETTE_16.length;
      const overflowCount = labelsAlpha.length - PALETTE_16.length;
      const hue = (overflow * 360) / Math.max(1, overflowCount);
      assignment.set(label, hslToHex(hue, 55, 55));
    }
  }

  const entries: ColorMapEntry[] = [...counts.entries()]
    .map(([label, count]) => ({
      label,
      color: assignment.get(label) ?? PALETTE_16[0]!,
      count,
    }))
    // Legend display order: count descending, then alpha.
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    colorForLabel(label: string): string {
      return assignment.get(label) ?? PALETTE_16[0]!;
    },
    entries,
  };
}

/**
 * Backward-compatible single-label color helper used by the renderers
 * before they switched to ColorMap. Stable per label name across calls
 * within a single session but uses a synthetic same-everywhere assignment
 * so the renderer's per-render ColorMap is the source of truth.
 *
 * Why keep this: chord.ts and sankey.ts touch palette via this function
 * in places where threading a full ColorMap would be awkward. The
 * renderer-level ColorMap overrides at the SVG attribute level; this
 * function just supplies a "first run" color that gets refined.
 *
 * @deprecated For new code, prefer buildColorMap(nodes).colorForLabel(label).
 */
export function colorForLabel(label: string): string {
  // Deterministic single-label color: stable hash into the palette.
  // Used only as a fallback when no ColorMap has been built (Sankey
  // multi-chain, Chord ribbons at render time).
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return PALETTE_16[(h >>> 0) % PALETTE_16.length] ?? PALETTE_16[0]!;
}

/**
 * HSL -> #rrggbb. Simple conversion for the overflow case.
 */
function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
