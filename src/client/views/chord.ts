/**
 * Chord renderer.
 *
 * Renders the graph as a chord diagram. Nodes are partitioned into
 * groups by their primary label; ribbons between groups carry the
 * weight of all edges that cross between them.
 *
 * Why chord (not adjacency matrix or arc): for "who talks to whom"
 * questions across a small number of categorical groups (5-15), chord
 * is the most legible D3 view. Above ~20 groups the ribbons crowd and
 * we should switch to a different view; the bookend and build SIGs
 * both have under 15 distinct label classes so we are comfortably in
 * range.
 *
 * URL params:
 *   ?chordGroup=<label-property>  override the grouping (default: primary label)
 */

import { select } from 'd3-selection';
import { arc } from 'd3-shape';
import { chord, ribbon } from 'd3-chord';
import { descending } from 'd3-array';
import type { GraphExport, VizNode, VizEdge } from '../../types.js';
import { buildColorMap, primaryLabel } from '../ui/palette.js';
import { showGroup, showAggregate, clearInspector, nodeMatches } from '../ui/inspector.js';
import type { ViewHandle } from './types.js';
import { NULL_HANDLE } from './types.js';

/**
 * Build the group-by-group adjacency matrix used by d3.chord().
 * Returns the matrix, group order, group counts, AND a map of
 * group-pair -> underlying VizEdges (so ribbon clicks can surface
 * the constituent edges).
 */
function buildMatrix(graph: GraphExport): {
  matrix: number[][];
  groups: string[];
  groupCounts: Record<string, number>;
  /** Map from `"groupA||groupB"` (canonical order) to the edges
   *  whose endpoints fall into those two groups. */
  edgesByPair: Map<string, VizEdge[]>;
} {
  // Group every node by its primary label.
  const nodeGroup = new Map<string, string>();
  const groupCounts: Record<string, number> = {};
  for (const n of graph.nodes) {
    const g = primaryLabel(n.labels);
    nodeGroup.set(n.id, g);
    groupCounts[g] = (groupCounts[g] ?? 0) + 1;
  }
  const groups = Object.keys(groupCounts).sort();
  const index = new Map(groups.map((g, i) => [g, i]));
  const n = groups.length;
  const matrix: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => 0),
  );
  const edgesByPair = new Map<string, VizEdge[]>();
  const pairKey = (a: string, b: string): string =>
    a <= b ? `${a}||${b}` : `${b}||${a}`;
  for (const e of graph.edges) {
    const a = nodeGroup.get(e.fromId);
    const b = nodeGroup.get(e.toId);
    if (!a || !b) continue;
    const i = index.get(a)!;
    const j = index.get(b)!;
    // Why symmetric: chord shows undirected co-occurrence. A directed
    // edge from group A to group B contributes 1 to matrix[A][B]; we
    // mirror to matrix[B][A] so the ribbon thickness reflects total
    // traffic between the two groups regardless of direction.
    matrix[i]![j]! += 1;
    if (i !== j) matrix[j]![i]! += 1;
    const key = pairKey(a, b);
    if (!edgesByPair.has(key)) edgesByPair.set(key, []);
    edgesByPair.get(key)!.push(e);
  }
  return { matrix, groups, groupCounts, edgesByPair };
}

export function renderChord(container: HTMLElement, graph: GraphExport): ViewHandle {
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;
  const radius = Math.min(width, height) / 2;
  const innerRadius = Math.max(radius - 80, 40);
  const outerRadius = innerRadius + 14;

  const { matrix, groups, groupCounts, edgesByPair } = buildMatrix(graph);
  // Why: build a collision-free ColorMap from the full node set so
  // arcs and ribbons match Force's legend. Sankey uses the same.
  const colorMap = buildColorMap(graph.nodes);
  const vizById = new Map<string, VizNode>(graph.nodes.map((n) => [n.id, n]));
  const pairKey = (a: string, b: string): string =>
    a <= b ? `${a}||${b}` : `${b}||${a}`;

  if (groups.length === 0) {
    container.innerHTML =
      '<p class="placeholder">Chord view needs at least one labeled node.</p>';
    return NULL_HANDLE;
  }
  if (groups.length === 1) {
    container.innerHTML = `<p class="placeholder">Chord view needs ≥2 distinct primary labels; this graph has one (${groups[0]}, ${groupCounts[groups[0]!]} nodes). Try Force view.</p>`;
    return NULL_HANDLE;
  }

  // Group -> member VizNodes (for click-to-inspect + search dimming).
  const membersByGroup = new Map<string, VizNode[]>();
  for (const n of graph.nodes) {
    const g = primaryLabel(n.labels);
    if (!membersByGroup.has(g)) membersByGroup.set(g, []);
    membersByGroup.get(g)!.push(n);
  }

  const svg = select(container)
    .append('svg')
    .attr('class', 'chord-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `${-width / 2} ${-height / 2} ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const chordLayout = chord()
    .padAngle(0.04)
    .sortSubgroups(descending);

  const chords = chordLayout(matrix);

  const groupArc = arc<{ startAngle: number; endAngle: number }>()
    .innerRadius(innerRadius)
    .outerRadius(outerRadius);

  // d3-chord's Ribbon type expects subgroups with their own .radius;
  // d3.ribbon().radius(n) supplies a shared radius and the geometry
  // works at runtime against Chord output, but TS sees the static
  // shape difference. Cast through unknown when invoking.
  const ribbonGen = ribbon().radius(innerRadius);

  // Group arcs (one per label class).
  const groupSel = svg
    .append('g')
    .attr('class', 'groups')
    .selectAll('g')
    .data(chords.groups)
    .enter()
    .append('g');

  const arcSel = groupSel
    .append('path')
    .attr('class', 'chord-arc')
    .attr('d', (d) =>
      groupArc({ startAngle: d.startAngle, endAngle: d.endAngle }) ?? '',
    )
    .attr('fill', (d) => colorMap.colorForLabel(groups[d.index]!))
    .attr('stroke-width', 1)
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      const g = groups[d.index]!;
      showGroup(g, membersByGroup.get(g) ?? []);
    });
  arcSel.append('title').text((d) => {
    const g = groups[d.index]!;
    return `${g} — ${groupCounts[g]} nodes`;
  });

  const midAngle = (d: { startAngle: number; endAngle: number }): number =>
    (d.startAngle + d.endAngle) / 2;

  groupSel
    .append('text')
    .attr('class', 'chord-label')
    .attr('dy', '.35em')
    .attr('transform', (d) => {
      const a = midAngle(d);
      return `rotate(${(a * 180) / Math.PI - 90}) translate(${outerRadius + 8}) ${a > Math.PI ? 'rotate(180)' : ''}`;
    })
    .attr('text-anchor', (d) => (midAngle(d) > Math.PI ? 'end' : 'start'))
    .attr('font-size', 11)
    .text((d) => {
      const g = groups[d.index]!;
      return `${g} (${groupCounts[g]})`;
    });

  // Ribbons (between-group traffic). Clickable -> showAggregate.
  const ribbonSel = svg
    .append('g')
    .attr('class', 'ribbons')
    .attr('fill-opacity', 0.55)
    .selectAll<SVGPathElement, (typeof chords)[number]>('path')
    .data(chords)
    .enter()
    .append('path')
    .attr('class', 'chord-ribbon')
    .attr('d', (d) => (ribbonGen as unknown as (x: unknown) => string | null)(d) ?? '')
    .attr('fill', (d) => colorMap.colorForLabel(groups[d.source.index]!))
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      const a = groups[d.source.index]!;
      const b = groups[d.target.index]!;
      const key = pairKey(a, b);
      const edges = edgesByPair.get(key) ?? [];
      showAggregate(a, b, edges, vizById);
    });
  ribbonSel.append('title').text((d) => {
    const a = groups[d.source.index]!;
    const b = groups[d.target.index]!;
    return `${a} ↔ ${b}: ${d.source.value} edges`;
  });

  return {
    setSearch(query: string): void {
      if (!query) {
        arcSel.style('opacity', 1);
        ribbonSel.style('opacity', 0.55);
        return;
      }
      // A group is "matched" if any of its member nodes match.
      const matchedGroups = new Set<string>();
      for (const [g, members] of membersByGroup.entries()) {
        if (members.some((n) => nodeMatches(n, query))) matchedGroups.add(g);
      }
      arcSel.style('opacity', (d) =>
        matchedGroups.has(groups[d.index]!) ? 1 : 0.2,
      );
      ribbonSel.style('opacity', (d) => {
        const a = groups[d.source.index]!;
        const b = groups[d.target.index]!;
        return matchedGroups.has(a) && matchedGroups.has(b) ? 0.55 : 0.05;
      });
    },
    setFilter(_keepIds: string[] | null): void {
      // Why: hard segment filtering is not yet implemented for this view.
      // Force is the canonical surface for it; the user can switch to
      // Force, run /biz / /dom / etc, then switch back to see filtered
      // results in this view via secondary filtering paths. v0.4 candidate.
      void _keepIds;
    },
    focus(_nodeId: string | string[] | null, _opts?: { transitive?: boolean }): void {
      // Why: focus / constellation highlighting is not yet implemented
      // for this view. Force is the canonical surface for it; extending
      // to Sankey + Chord is tracked as a future v0.3 candidate. The
      // interface method is required so main.ts can call it uniformly.
      void _nodeId;
      void _opts;
    },
    destroy(): void {
      select(container).select('svg').remove();
      clearInspector();
    },
  };
}
