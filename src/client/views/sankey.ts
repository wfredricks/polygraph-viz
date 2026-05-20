/**
 * Sankey renderer.
 *
 * Renders the graph as a left-to-right flow diagram across a *chain* of
 * label classes (e.g. Requirement → Feature → UseCase → Repo → Module).
 *
 * The chain may be:
 *   - explicit via URL: ?sankey=Requirement,Feature,UseCase,Repo,Module
 *   - auto-detected from the graph (default): pick label classes that
 *     form the longest single-source directed path through the graph's
 *     label-to-label transition counts.
 *
 * Why Sankey: when the question is "for any X at the front of the chain,
 * what fraction of it flows to which terminal Y, and through which
 * intermediate layers?", Sankey is the right view. For SI: REQ →
 * Feature → UC → Repo → Module is the traceability story in one
 * diagram.
 */

import { select } from 'd3-selection';
import {
  sankey as sankeyLayout,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyNode,
  type SankeyLink,
} from 'd3-sankey';
import type { GraphExport, VizNode } from '../../types.js';
import { colorForLabel, primaryLabel } from '../ui/palette.js';
import { showNode, showEdge, clearInspector, nodeMatches } from '../ui/inspector.js';
import type { ViewHandle } from './types.js';
import { NULL_HANDLE } from './types.js';

interface SNodeExtra {
  /** Sankey node id (synthetic: `${layerLabel}::${graphNodeId}`). */
  id: string;
  /** Original graph node id. */
  graphId: string;
  /** Layer this node sits in (primary label). */
  layer: string;
  /** Display name. */
  name: string;
}

interface SLinkExtra {
  /** Original graph edge id. */
  edgeId: string;
  /** Original edge type. */
  edgeType: string;
}

type SNode = SankeyNode<SNodeExtra, SLinkExtra>;
type SLink = SankeyLink<SNodeExtra, SLinkExtra>;

/**
 * Parse ?sankey=A,B,C from window.location.
 */
function readChainOverride(): string[] | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('sankey');
    if (!v) return null;
    const chain = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return chain.length >= 2 ? chain : null;
  } catch {
    return null;
  }
}

/**
 * Auto-detect a chain through the graph's label-to-label transition graph.
 *
 * Strategy: enumerate every viable source (a label with outbound
 * transitions and zero inbound, or the next-best by `out - in` score),
 * DFS each one, and return the LONGEST chain found. Tie-break by total
 * edge weight along the chain so wider flows win over narrower ones at
 * the same length.
 *
 * Why not greedy (the v0.1 behavior): greedy picks the dominant outgoing
 * transition at each step. If that transition leads to a sink (e.g.
 * sw.feature -> intended_behavior with 131 edges, but intended_behavior
 * has zero out-edges) the walk terminates after one step and a longer
 * chain through the non-dominant first-step transition (sw.feature ->
 * sw.use_case -> intended_behavior, 75 + 155 edges) is missed entirely.
 * The bug was reported by Bill 2026-05-20 10:00 EDT.
 *
 * The user can always override via ?sankey=A,B,C.
 */
function autoDetectChain(graph: GraphExport, primary: Map<string, string>): string[] {
  // Build label -> {next-label -> count} transition map.
  const transitions = new Map<string, Map<string, number>>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of graph.edges) {
    const a = primary.get(e.fromId);
    const b = primary.get(e.toId);
    if (!a || !b || a === b) continue;
    if (!transitions.has(a)) transitions.set(a, new Map());
    const row = transitions.get(a)!;
    row.set(b, (row.get(b) ?? 0) + 1);
    outDegree.set(a, (outDegree.get(a) ?? 0) + 1);
    inDegree.set(b, (inDegree.get(b) ?? 0) + 1);
  }

  const allLabels = new Set<string>([
    ...transitions.keys(),
    ...inDegree.keys(),
  ]);
  if (allLabels.size === 0) return [];

  // Enumerate candidate sources, ranked by (out - in) descending. A
  // label with zero inbound is the cleanest source; we still consider
  // others in case the graph has cycles or no clean root.
  const sourceCandidates = [...allLabels]
    .map((l) => ({
      label: l,
      score: (outDegree.get(l) ?? 0) - (inDegree.get(l) ?? 0),
    }))
    .filter((s) => (outDegree.get(s.label) ?? 0) > 0) // must have at least one outbound
    .sort((a, b) => b.score - a.score);
  if (sourceCandidates.length === 0) return [];

  // DFS from each candidate; track the best (longest, then heaviest) chain.
  const MAX_DEPTH = 8;
  let bestChain: string[] = [];
  let bestWeight = -1;

  function dfs(current: string, path: string[], pathWeight: number, visited: Set<string>): void {
    if (path.length > MAX_DEPTH) return;
    // Score this prefix as a candidate chain too (a 3-layer answer can
    // beat a 4-layer answer with a much smaller flow at the tail).
    if (path.length >= 2) {
      const better =
        path.length > bestChain.length ||
        (path.length === bestChain.length && pathWeight > bestWeight);
      if (better) {
        bestChain = [...path];
        bestWeight = pathWeight;
      }
    }
    const row = transitions.get(current);
    if (!row) return;
    // Explore in descending-weight order so heavier first-found chains
    // bias the ties slightly toward the dominant story.
    const next = [...row.entries()].sort((a, b) => b[1] - a[1]);
    for (const [n, weight] of next) {
      if (visited.has(n)) continue;
      visited.add(n);
      path.push(n);
      dfs(n, path, pathWeight + weight, visited);
      path.pop();
      visited.delete(n);
    }
  }

  for (const c of sourceCandidates) {
    const visited = new Set<string>([c.label]);
    dfs(c.label, [c.label], 0, visited);
  }

  return bestChain;
}

export function renderSankey(container: HTMLElement, graph: GraphExport): ViewHandle {
  const width = container.clientWidth || 1000;
  const height = container.clientHeight || 600;

  // Precompute primary label per node.
  const primary = new Map<string, string>();
  for (const n of graph.nodes) {
    primary.set(n.id, primaryLabel(n.labels));
  }

  // Resolve chain.
  const chain = readChainOverride() ?? autoDetectChain(graph, primary);
  if (chain.length < 2) {
    container.innerHTML = `
      <p class="placeholder">
        Sankey needs a chain of at least 2 label classes. Could not auto-detect one.
        Try a URL like <code>?sankey=Requirement,Feature,UseCase</code>.
      </p>`;
    return NULL_HANDLE;
  }
  const chainIndex = new Map(chain.map((l, i) => [l, i]));

  // Filter nodes to those in the chain.
  const inChain = (id: string): boolean => {
    const p = primary.get(id);
    return p !== undefined && chainIndex.has(p);
  };

  // Build Sankey nodes — one per real graph node in the chain.
  const sNodes: SNodeExtra[] = [];
  const sNodeIndex = new Map<string, number>();
  for (const n of graph.nodes) {
    if (!inChain(n.id)) continue;
    const layer = primary.get(n.id)!;
    const sId = `${layer}::${n.id}`;
    sNodeIndex.set(n.id, sNodes.length);
    const props = n.properties as Record<string, unknown>;
    const labelText =
      typeof props['name'] === 'string'
        ? (props['name'] as string)
        : typeof props['label'] === 'string'
          ? (props['label'] as string)
          : n.id;
    sNodes.push({ id: sId, graphId: n.id, layer, name: labelText });
  }

  // Build Sankey links — edges where source.layer comes BEFORE target.layer
  // in the chain order. (Sankey is a DAG; non-monotonic edges are
  // dropped.)
  const sLinks: { source: number; target: number; value: number; edgeId: string; edgeType: string }[] = [];
  for (const e of graph.edges) {
    if (!inChain(e.fromId) || !inChain(e.toId)) continue;
    const sIdx = sNodeIndex.get(e.fromId);
    const tIdx = sNodeIndex.get(e.toId);
    if (sIdx === undefined || tIdx === undefined) continue;
    const sLayer = primary.get(e.fromId)!;
    const tLayer = primary.get(e.toId)!;
    if (chainIndex.get(sLayer)! >= chainIndex.get(tLayer)!) continue;
    sLinks.push({
      source: sIdx,
      target: tIdx,
      value: 1,
      edgeId: e.id,
      edgeType: e.type,
    });
  }

  if (sLinks.length === 0) {
    container.innerHTML = `
      <p class="placeholder">
        Sankey chain <code>${chain.join(' → ')}</code> resolves to 0 cross-layer edges.
        Try a different chain via <code>?sankey=A,B,C</code>.
      </p>`;
    return NULL_HANDLE;
  }

  // VizNode lookup for click-to-inspect.
  const vizById = new Map<string, VizNode>(graph.nodes.map((n) => [n.id, n]));

  const sankeyGen = sankeyLayout<SNodeExtra, SLinkExtra>()
    .nodeId((d) => d.id)
    .nodeWidth(14)
    .nodePadding(10)
    .extent([
      [12, 12],
      [width - 12, height - 12],
    ]);

  const layoutInput: SankeyGraph<SNodeExtra, SLinkExtra> = {
    nodes: sNodes.map((n) => ({ ...n })) as SNode[],
    links: sLinks.map((l) => ({ ...l })) as unknown as SLink[],
  };

  // d3-sankey resolves source/target by id when nodeId() is set, but
  // we passed numeric indexes — convert to id refs. We go through
  // `unknown` because the type declares source/target as `number | SNode`
  // while d3-sankey at runtime accepts the id string when nodeId() is set.
  for (const link of layoutInput.links) {
    const li = link as unknown as { source: unknown; target: unknown };
    if (typeof li.source === 'number') {
      li.source = layoutInput.nodes[li.source]!.id;
    }
    if (typeof li.target === 'number') {
      li.target = layoutInput.nodes[li.target]!.id;
    }
  }

  const laidOut = sankeyGen(layoutInput);

  const svg = select(container)
    .append('svg')
    .attr('class', 'sankey-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  // Links.
  const linkSel = svg
    .append('g')
    .attr('class', 'sankey-links')
    .attr('fill', 'none')
    .selectAll<SVGPathElement, (typeof laidOut.links)[number]>('path')
    .data(laidOut.links)
    .enter()
    .append('path')
    .attr('class', 'sankey-link')
    .attr('d', sankeyLinkHorizontal())
    .attr('stroke', (d) => {
      const src = d.source as SNode;
      return colorForLabel(src.layer);
    })
    .attr('stroke-opacity', 0.35)
    .attr('stroke-width', (d) => Math.max(1, d.width ?? 1))
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      // The Sankey link carries the original graph edge id; re-derive
      // the VizEdge for the inspector.
      const edgeId = (d as { edgeId?: string }).edgeId;
      if (!edgeId) return;
      const original = graph.edges.find((e) => e.id === edgeId);
      if (!original) return;
      const src = vizById.get(original.fromId);
      const tgt = vizById.get(original.toId);
      showEdge(original, src, tgt);
    });
  linkSel.append('title').text((d) => {
    const src = d.source as SNode;
    const tgt = d.target as SNode;
    return `${src.name} → ${tgt.name} (${(d as { edgeType?: string }).edgeType ?? 'edge'})`;
  });

  // Nodes.
  const nodeGroup = svg
    .append('g')
    .attr('class', 'sankey-nodes')
    .selectAll('g')
    .data(laidOut.nodes)
    .enter()
    .append('g');

  const rectSel = nodeGroup
    .append('rect')
    .attr('class', 'sankey-node')
    .attr('x', (d) => d.x0 ?? 0)
    .attr('y', (d) => d.y0 ?? 0)
    .attr('height', (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
    .attr('width', (d) => Math.max(1, (d.x1 ?? 0) - (d.x0 ?? 0)))
    .attr('fill', (d) => colorForLabel(d.layer))
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      const v = vizById.get(d.graphId);
      if (v) showNode(v);
    });
  rectSel.append('title').text((d) => `${d.name}\n${d.layer}`);

  nodeGroup
    .append('text')
    .attr('class', 'sankey-node-label')
    .attr('x', (d) => ((d.x0 ?? 0) < width / 2 ? (d.x1 ?? 0) + 6 : (d.x0 ?? 0) - 6))
    .attr('y', (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', (d) => ((d.x0 ?? 0) < width / 2 ? 'start' : 'end'))
    .attr('font-size', 10)
    .text((d) => {
      const n = d.name;
      return n.length > 30 ? n.slice(0, 27) + '…' : n;
    });

  // Layer headers along the top.
  const layerX = new Map<string, number>();
  for (const n of laidOut.nodes) {
    const x = n.x0 ?? 0;
    if (!layerX.has(n.layer)) layerX.set(n.layer, x);
  }
  svg
    .append('g')
    .attr('class', 'sankey-headers')
    .selectAll('text')
    .data([...layerX.entries()])
    .enter()
    .append('text')
    .attr('class', 'sankey-header')
    .attr('x', (d) => d[1] + 7)
    .attr('y', 8)
    .attr('text-anchor', 'middle')
    .attr('font-size', 11)
    .attr('font-weight', 600)
    .text((d) => d[0]);

  // ── ViewHandle ──────────────────────────────────────────────
  return {
    setSearch(query: string): void {
      if (!query) {
        rectSel.style('opacity', 1);
        nodeGroup.selectAll('text').style('opacity', 1);
        linkSel.style('stroke-opacity', 0.35);
        return;
      }
      const matched = new Set<string>();
      for (const n of graph.nodes) {
        if (nodeMatches(n, query)) matched.add(n.id);
      }
      rectSel.style('opacity', (d) => (matched.has(d.graphId) ? 1 : 0.2));
      nodeGroup
        .selectAll<SVGTextElement, SNode>('text')
        .style('opacity', (d) => (matched.has(d.graphId) ? 1 : 0.2));
      linkSel.style('stroke-opacity', (d) => {
        const s = (d.source as SNode).graphId;
        const t = (d.target as SNode).graphId;
        return matched.has(s) && matched.has(t) ? 0.55 : 0.05;
      });
    },
    destroy(): void {
      select(container).select('svg').remove();
      clearInspector();
    },
  };
}
