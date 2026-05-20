/**
 * Footer stats: node count, edge count, top labels.
 *
 * Why a separate /api/stats fetch (instead of recomputing client-side):
 * the server already computes the label distribution and component
 * count in graph-api.ts; we let it do that work once and ship the
 * pre-aggregated numbers. Negligible payload, no duplicated logic.
 */

import type { GraphExport } from '../../types.js';

interface StatsResponse {
  nodeCount: number;
  edgeCount: number;
  labelDistribution: Record<string, number>;
  relationshipDistribution: Record<string, number>;
  density: number;
  components: number;
}

export async function renderStats(_graph: GraphExport): Promise<void> {
  const el = document.getElementById('stats-counts');
  if (!el) return;

  try {
    const r = await fetch('/api/stats');
    if (!r.ok) {
      el.textContent = `${_graph.metadata.nodeCount} nodes · ${_graph.metadata.edgeCount} edges`;
      return;
    }
    const s = (await r.json()) as StatsResponse;
    const topLabels = Object.entries(s.labelDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([label, n]) => `${label} ${n}`)
      .join(' · ');

    el.textContent = topLabels
      ? `${s.nodeCount} nodes · ${s.edgeCount} edges · ${topLabels}`
      : `${s.nodeCount} nodes · ${s.edgeCount} edges`;
  } catch {
    // Why: silent fallback to in-memory counts is acceptable for stats
    // footer; the rest of the app still works without /api/stats.
    el.textContent = `${_graph.metadata.nodeCount} nodes · ${_graph.metadata.edgeCount} edges`;
  }
}
