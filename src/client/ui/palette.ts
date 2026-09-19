/**
 * Label → visual encoding: color, shape, size.
 *
 * All visual properties are **deterministic from the label name alone** —
 * no hardcoded domain maps, no graph-context needed. Point PolyGraph Viz
 * at any database and every label gets a stable, distinguishable look.
 *
 * Design:
 *   - **Color:** FNV-1a hash of the label → HSL hue. Labels sharing a
 *     dot-prefix (e.g. `data.table`, `data.column`) get hues in the same
 *     neighborhood (±30° of the prefix's base hue) so they read as a
 *     visual family.
 *   - **Shape:** d3-shape symbols, assigned per prefix group. All `data.*`
 *     labels share one shape, all `dom.*` another, etc. Ungrouped labels
 *     each get a shape from their own name hash.
 *   - **Size:** uniform base (area ≈ 150 px²). Easy to add variation later.
 *
 * The Okabe-Ito palette is retained as a fallback for the `buildColorMap`
 * legend (which still cycles colors for small graphs), but the primary
 * coloring path is `autoColor()`.
 */

import {
  symbol as d3Symbol,
  symbolCircle,
  symbolCross,
  symbolDiamond,
  symbolSquare,
  symbolStar,
  symbolTriangle2,
  symbolWye,
  type SymbolType,
} from 'd3-shape';
import type { VizNode } from '../../types.js';

// ─── Hash utility ──────────────────────────────────────────────────────────

/** FNV-1a hash → unsigned 32-bit integer. */
function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** MurmurHash3 finalization mix — spreads clustered FNV bits for short strings. */
function mixHash(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ─── Color ─────────────────────────────────────────────────────────────────

/** Golden ratio conjugate — maximally separates sequential hue assignments. */
const GOLDEN_ANGLE = 137.508;

/** Precomputed label → color cache, populated by seedColorMap(). */
const colorCache = new Map<string, string>();

/**
 * Seed the color cache from a label distribution (golden-ratio fallback).
 */
export function seedColorMap(dist: Record<string, number>): void {
  // Only seed labels that don't already have a meta-node color
  const groups = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const label of Object.keys(dist)) {
    if (label.startsWith('meta.')) continue; // skip meta-labels
    if (colorCache.has(label)) continue;     // already set by meta-node
    const dot = label.indexOf('.');
    if (dot > 0) {
      const prefix = label.slice(0, dot);
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix)!.push(label);
    } else {
      ungrouped.push(label);
    }
  }

  for (const [prefix, labels] of groups) {
    labels.sort();
    const baseHue = mixHash(fnvHash(prefix)) % 360;
    for (let i = 0; i < labels.length; i++) {
      const hue = (baseHue + i * GOLDEN_ANGLE) % 360;
      const lightness = 44 + (i % 3) * 8;
      colorCache.set(labels[i]!, hslToHex(hue, 62, lightness));
    }
  }

  ungrouped.sort();
  for (let i = 0; i < ungrouped.length; i++) {
    const hue = (i * GOLDEN_ANGLE) % 360;
    colorCache.set(ungrouped[i]!, hslToHex(hue, 58, 52));
  }
}

/**
 * Seed the color cache from meta.label nodes in the graph.
 *
 * Meta-nodes carry {forLabel, color, shape, size} properties.
 * Extracts the label→color mapping so autoColor() returns the
 * graph-defined color for every label that has a meta-node.
 *
 * Call once at startup after fetching /api/graph.
 */
export function seedFromMetaNodes(graph: { nodes: VizNode[] }): void {
  for (const node of graph.nodes) {
    if (node.labels.includes('meta.label') && node.properties.forLabel && node.properties.color) {
      colorCache.set(node.properties.forLabel as string, node.properties.color as string);
    }
  }
}

/**
 * Deterministic color from a label name.
 *
 * If seedColorMap() has been called, returns the precomputed color
 * (golden-ratio stepping within groups). Otherwise falls back to
 * hash-based coloring.
 */
export function autoColor(label: string): string {
  const cached = colorCache.get(label);
  if (cached) return cached;

  // Fallback for labels not in the seed
  const dot = label.indexOf('.');
  const prefix = dot > 0 ? label.slice(0, dot) : '';

  if (prefix) {
    const subLabel = label.slice(dot + 1);
    const baseHue = mixHash(fnvHash(prefix)) % 360;
    const offset = (mixHash(fnvHash(subLabel)) % 90) - 45;
    const hue = (baseHue + offset + 360) % 360;
    const lightness = 42 + (mixHash(fnvHash(subLabel + '_l')) % 20);
    return hslToHex(hue, 58, lightness);
  }
  return hslToHex(mixHash(fnvHash(label)) % 360, 58, 52);
}

// ─── Shape ─────────────────────────────────────────────────────────────────

/**
 * The shape cycle. Six visually distinct d3 symbol types, ordered from
 * most conventional (circle) to most exotic (wye). Assigned per prefix
 * group so every `data.*` label shares a shape, every `dom.*` another, etc.
 */
const SHAPE_CYCLE: SymbolType[] = [
  symbolCircle,
  symbolDiamond,
  symbolSquare,
  symbolTriangle2,
  symbolStar,
  symbolCross,
  symbolWye,
];

/** Human-readable shape names, parallel to SHAPE_CYCLE. */
const SHAPE_NAMES = [
  'circle', 'diamond', 'square', 'triangle', 'star', 'cross', 'wye',
];

/**
 * Deterministic d3 SymbolType for a label.
 *
 * Labels with the same dot-prefix share a shape; ungrouped labels each
 * get a shape from their full name hash.
 */
export function shapeTypeForLabel(label: string): SymbolType {
  const dot = label.indexOf('.');
  const group = dot > 0 ? label.slice(0, dot) : label;
  return SHAPE_CYCLE[fnvHash(group) % SHAPE_CYCLE.length]!;
}

/** Human-readable shape name for a label (for tooltips / screen readers). */
export function shapeNameForLabel(label: string): string {
  const dot = label.indexOf('.');
  const group = dot > 0 ? label.slice(0, dot) : label;
  return SHAPE_NAMES[fnvHash(group) % SHAPE_NAMES.length]!;
}

/** Default symbol area in px² (≈ circle r≈7). */
const DEFAULT_SYMBOL_AREA = 150;

/**
 * SVG path `d` attribute for a label's shape at the given area.
 *
 * Usage:  `selection.append('path').attr('d', symbolPathForLabel(label))`
 */
export function symbolPathForLabel(label: string, area: number = DEFAULT_SYMBOL_AREA): string {
  return d3Symbol().type(shapeTypeForLabel(label)).size(area)() ?? '';
}

/**
 * Tiny inline SVG string showing a label's shape + color at a given pixel size.
 * Used for sidebar and legend swatches.
 */
export function swatchSvg(label: string, sizePx: number = 12): string {
  const color = autoColor(label);
  const area = sizePx * sizePx * 0.6;  // area scaled to fit the viewBox
  const path = d3Symbol().type(shapeTypeForLabel(label)).size(area)() ?? '';
  const half = sizePx / 2;
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="${-half} ${-half} ${sizePx} ${sizePx}" style="vertical-align:middle"><path d="${path}" fill="${color}"/></svg>`;
}

// ─── Utility labels ────────────────────────────────────────────────────────

/** Labels that should not drive node color (utility / meta). */
const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

/**
 * Pick the "primary" label of a node — the first non-utility label, or
 * the first label if all are utilities.
 */
export function primaryLabel(labels: string[]): string {
  if (labels.length === 0) return 'Node';
  const meaningful = labels.find((l) => !UTILITY_LABELS.has(l));
  return meaningful ?? labels[0]!;
}

// ─── ColorMap (for legend + backward compat) ───────────────────────────────

export interface ColorMapEntry {
  label: string;
  color: string;
  count: number;
}

export interface ColorMap {
  colorForLabel(label: string): string;
  entries: ColorMapEntry[];
}

/**
 * Build a color map from a set of nodes.
 *
 * Every label's color comes from `autoColor(label)` — fully deterministic,
 * no fixed map, no palette-slot assignment. The map is still useful for
 * the legend (sorted entries with counts) and the `colorForLabel` accessor.
 */
export function buildColorMap(nodes: VizNode[]): ColorMap {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const p = primaryLabel(n.labels);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const entries: ColorMapEntry[] = [...counts.entries()]
    .map(([label, count]) => ({
      label,
      color: autoColor(label),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    colorForLabel: autoColor,
    entries,
  };
}

/**
 * Standalone label → color (no graph context needed).
 *
 * Used by chord.ts and sankey.ts where threading a full ColorMap is awkward.
 */
export function colorForLabel(label: string): string {
  return autoColor(label);
}

// ─── HSL → hex ─────────────────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const toHex = (v: number): string =>
    Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
