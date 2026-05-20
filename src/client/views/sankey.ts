/**
 * Sankey renderer.
 *
 * Renders the graph as one or more left-to-right flow diagrams across
 * *chains* of label classes (e.g. Requirement → Feature → UseCase →
 * Repo → Module).
 *
 * The chain(s) may be:
 *   - explicit via URL: ?sankey=Requirement,Feature,UseCase,Repo,Module
 *     forces single-chain mode with the supplied chain
 *   - auto-detected (default): find the longest viable chain and (if
 *     "show all chains" is enabled) iteratively peel off additional
 *     disjoint chains from the remaining labels
 *
 * Why multi-chain matters: many real graphs contain weakly-connected
 * components in their label-transition graph. The SI build SIG has
 * `sw.feature -> sw.use_case -> intended_behavior` AND a separate
 * `sw.stage -> sw.repo` flow; rendering only one means half the
 * traceability story is invisible. Bill requested multi-chain on
 * 2026-05-20 10:03 EDT.
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
import { buildColorMap, primaryLabel } from '../ui/palette.js';
import { showEdge, showNode, clearInspector, nodeMatches } from '../ui/inspector.js';
import type { ViewHandle } from './types.js';
import { NULL_HANDLE } from './types.js';

interface SNodeExtra {
  id: string;
  graphId: string;
  layer: string;
  name: string;
}

interface SLinkExtra {
  edgeId: string;
  edgeType: string;
}

type SNode = SankeyNode<SNodeExtra, SLinkExtra>;
type SLink = SankeyLink<SNodeExtra, SLinkExtra>;

const MAX_CHAIN_DEPTH = 8;

/**
 * Parse ?sankey=A,B,C from window.location. Forces single-chain mode.
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
 * Parse ?sankeyAll=1 (default-on multi-chain mode).
 */
function readShowAllOverride(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('sankeyAll') === '1';
  } catch {
    return false;
  }
}

interface Transitions {
  transitions: Map<string, Map<string, number>>;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
}

function buildTransitions(graph: GraphExport, primary: Map<string, string>): Transitions {
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
  return { transitions, inDegree, outDegree };
}

/**
 * Find the longest chain restricted to a set of allowed labels.
 *
 * Strategy: enumerate every viable source within `allowed`, DFS each
 * one, return the longest path found. Tie-break by total edge weight.
 */
function bestChainInSubgraph(t: Transitions, allowed: Set<string>): string[] {
  const sources = [...allowed]
    .filter((l) => (t.outDegree.get(l) ?? 0) > 0)
    .map((l) => ({
      label: l,
      score: (t.outDegree.get(l) ?? 0) - (t.inDegree.get(l) ?? 0),
    }))
    .sort((a, b) => b.score - a.score);
  if (sources.length === 0) return [];

  let bestChain: string[] = [];
  let bestWeight = -1;

  function dfs(current: string, path: string[], pw: number, visited: Set<string>): void {
    if (path.length > MAX_CHAIN_DEPTH) return;
    if (path.length >= 2) {
      const better =
        path.length > bestChain.length ||
        (path.length === bestChain.length && pw > bestWeight);
      if (better) {
        bestChain = [...path];
        bestWeight = pw;
      }
    }
    const row = t.transitions.get(current);
    if (!row) return;
    const next = [...row.entries()].sort((a, b) => b[1] - a[1]);
    for (const [n, weight] of next) {
      if (visited.has(n) || !allowed.has(n)) continue;
      visited.add(n);
      path.push(n);
      dfs(n, path, pw + weight, visited);
      path.pop();
      visited.delete(n);
    }
  }

  for (const c of sources) {
    const visited = new Set<string>([c.label]);
    dfs(c.label, [c.label], 0, visited);
  }

  return bestChain;
}

/**
 * Auto-detect ALL chains. Iteratively peel off the longest chain from
 * the remaining labels until nothing of length ≥ 2 remains. Each label
 * appears in at most one chain so the rendered Sankeys are visually
 * disjoint (no label appears twice on screen).
 */
function autoDetectChains(graph: GraphExport, primary: Map<string, string>): string[][] {
  const t = buildTransitions(graph, primary);
  const allLabels = new Set<string>([...t.transitions.keys(), ...t.inDegree.keys()]);
  if (allLabels.size === 0) return [];

  const chains: string[][] = [];
  const remaining = new Set(allLabels);
  // Safety bound — at most one chain per label.
  for (let i = 0; i < allLabels.size; i++) {
    const chain = bestChainInSubgraph(t, remaining);
    if (chain.length < 2) break;
    chains.push(chain);
    for (const label of chain) remaining.delete(label);
    if (remaining.size < 2) break;
  }
  return chains;
}

/**
 * Render a single Sankey diagram for one chain into a given SVG element.
 *
 * Returns an object exposing the selections needed by setSearch so the
 * top-level renderSankey can wire search across all rendered chains.
 * Selections are typed as `unknown` here on purpose — d3's generics
 * across selection / transition / merge are stricter than what we need
 * at the dispatch site, and the only consumer (setSearch) uses bounded
 * casts on the way out.
 */
interface ChainSelections {
  rectSel: unknown;
  textSel: unknown;
  linkSel: unknown;
  /** node graphId -> in this chain? Used by setSearch. */
  graphIdsInChain: Set<string>;
}

function renderSingleSankey(
  svg: ReturnType<typeof select>,
  graph: GraphExport,
  primary: Map<string, string>,
  vizById: Map<string, VizNode>,
  chain: string[],
  width: number,
  height: number,
  colorMap: { colorForLabel(label: string): string },
): ChainSelections {
  const chainIndex = new Map(chain.map((l, i) => [l, i]));
  const inChain = (id: string): boolean => {
    const p = primary.get(id);
    return p !== undefined && chainIndex.has(p);
  };

  const sNodes: SNodeExtra[] = [];
  const sNodeIndex = new Map<string, number>();
  const graphIdsInChain = new Set<string>();
  for (const n of graph.nodes) {
    if (!inChain(n.id)) continue;
    const layer = primary.get(n.id)!;
    const sId = `${layer}::${n.id}`;
    sNodeIndex.set(n.id, sNodes.length);
    graphIdsInChain.add(n.id);
    const props = n.properties as Record<string, unknown>;
    const labelText =
      typeof props['name'] === 'string'
        ? (props['name'] as string)
        : typeof props['label'] === 'string'
          ? (props['label'] as string)
          : n.id;
    sNodes.push({ id: sId, graphId: n.id, layer, name: labelText });
  }

  const sLinks: {
    source: number;
    target: number;
    value: number;
    edgeId: string;
    edgeType: string;
  }[] = [];
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
    // Render a tiny header explaining the empty chain so user sees why.
    svg
      .append('text')
      .attr('x', width / 2)
      .attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('class', 'sankey-header')
      .text(`${chain.join(' → ')} (no edges; chain skipped)`);
    return {
      rectSel: null,
      textSel: null,
      linkSel: null,
      graphIdsInChain,
    };
  }

  const sankeyGen = sankeyLayout<SNodeExtra, SLinkExtra>()
    .nodeId((d) => d.id)
    .nodeWidth(14)
    .nodePadding(10)
    .extent([
      [12, 28],
      [width - 12, height - 12],
    ]);

  const layoutInput: SankeyGraph<SNodeExtra, SLinkExtra> = {
    nodes: sNodes.map((n) => ({ ...n })) as SNode[],
    links: sLinks.map((l) => ({ ...l })) as unknown as SLink[],
  };
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

  // Visible link layer: paints the colored ribbon. pointer-events:none
  // so clicks fall through to the hit-area layer above (in render order)
  // which sits on top of the node rects and is reliably clickable.
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
      return colorMap.colorForLabel(src.layer);
    })
    .attr('stroke-opacity', 0.35)
    .attr('stroke-width', (d) => Math.max(1, d.width ?? 1))
    .attr('pointer-events', 'none');
  linkSel.append('title').text((d) => {
    const src = d.source as SNode;
    const tgt = d.target as SNode;
    return `${src.name} → ${tgt.name} (${(d as { edgeType?: string }).edgeType ?? 'edge'})`;
  });

  // Link hit-area halo: invisible, wide click target. Sits ABOVE the
  // visible link layer (which is pointer-events:none) but BELOW the
  // node rects. Where a link path is visible mid-ribbon, the halo
  // catches clicks. Where a link endpoint is geometrically under a
  // node rect, the rect catches clicks (node inspector opens).
  // Why: thin sankey ribbons are nearly impossible to click as bare
  // SVG paths; widening the visible ribbon would distort the chart.
  // The halo is the standard fix.
  const linkHitSel = svg
    .append('g')
    .attr('class', 'sankey-link-hits')
    .attr('fill', 'none')
    .selectAll<SVGPathElement, (typeof laidOut.links)[number]>('path')
    .data(laidOut.links)
    .enter()
    .append('path')
    .attr('class', 'sankey-link-hit')
    .attr('d', sankeyLinkHorizontal())
    .attr('stroke', 'transparent')
    .attr('stroke-width', (d) => Math.max(16, d.width ?? 1))
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      const edgeId = (d as { edgeId?: string }).edgeId;
      if (!edgeId) return;
      const original = graph.edges.find((e) => e.id === edgeId);
      if (!original) return;
      const src = vizById.get(original.fromId);
      const tgt = vizById.get(original.toId);
      showEdge(original, src, tgt);
    });
  linkHitSel.append('title').text((d) => {
    const src = d.source as SNode;
    const tgt = d.target as SNode;
    return `${src.name} → ${tgt.name} (${(d as { edgeType?: string }).edgeType ?? 'edge'})`;
  });

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
    .attr('fill', (d) => colorMap.colorForLabel(d.layer))
    .attr('stroke-width', 0.5)
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      const v = vizById.get(d.graphId);
      if (v) showNode(v);
    });
  rectSel.append('title').text((d) => `${d.name}\n${d.layer}`);

  const textSel = nodeGroup
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
    .attr('y', 18)
    .attr('text-anchor', 'middle')
    .attr('font-size', 11)
    .attr('font-weight', 600)
    .text((d) => d[0]);

  return {
    rectSel,
    textSel,
    linkSel,
    graphIdsInChain,
  };
}

// ── Toggle state ──────────────────────────────────────────────
// Why a module-level cache: the toggle survives view-switches and
// view-rerenders within the same session, but resets on reload (no
// localStorage; the URL param is the persistent form).
let showAllChains = false;

export function renderSankey(container: HTMLElement, graph: GraphExport): ViewHandle {
  // Initial state seeds from URL once per page load.
  if (readShowAllOverride()) showAllChains = true;

  // Precompute primary label per node.
  const primary = new Map<string, string>();
  for (const n of graph.nodes) {
    primary.set(n.id, primaryLabel(n.labels));
  }
  const vizById = new Map<string, VizNode>(graph.nodes.map((n) => [n.id, n]));
  // Why: shared collision-free ColorMap so arcs/links across all chains
  // colour the same labels the same way as the Force view's legend.
  const colorMap = buildColorMap(graph.nodes);

  // Resolve chains: URL override forces single mode; otherwise auto-detect.
  const override = readChainOverride();
  let chains: string[][];
  if (override) {
    chains = [override];
  } else {
    const allChains = autoDetectChains(graph, primary);
    chains = showAllChains ? allChains : allChains.slice(0, 1);
  }

  if (chains.length === 0 || chains[0]!.length < 2) {
    container.innerHTML = `
      <p class="placeholder">
        Sankey needs a chain of at least 2 label classes. Could not auto-detect one.
        Try a URL like <code>?sankey=Requirement,Feature,UseCase</code>.
      </p>`;
    return NULL_HANDLE;
  }

  // ── Layout wrapper ──────────────────────────────────────────
  // Why a wrapper: when showAllChains is on we stack multiple SVGs
  // vertically. The wrapper holds them all + a small header bar showing
  // how many chains are visible and a toggle button.
  const allChains = autoDetectChains(graph, primary);
  const hasMultiple = !override && allChains.length > 1;

  const wrapper = document.createElement('div');
  wrapper.className = 'sankey-wrapper';
  container.appendChild(wrapper);

  if (hasMultiple) {
    const bar = document.createElement('div');
    bar.className = 'sankey-toolbar';
    const status = document.createElement('span');
    status.className = 'sankey-status';
    status.textContent = showAllChains
      ? `${allChains.length} chains shown`
      : `${allChains.length - 1} more chain${allChains.length - 1 === 1 ? '' : 's'} hidden`;
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'sankey-toggle';
    toggleBtn.textContent = showAllChains ? 'Show primary only' : 'Show all chains';
    toggleBtn.title = showAllChains
      ? `Currently showing all ${allChains.length} chains. Click to show only the primary.`
      : `${allChains.length - 1} secondary chain${allChains.length - 1 === 1 ? '' : 's'} hidden. Click to show all.`;
    toggleBtn.addEventListener('click', () => {
      showAllChains = !showAllChains;
      // Tear down and re-render through the same view handle.
      handle.destroy();
      container.innerHTML = '';
      const next = renderSankey(container, graph);
      // Re-apply current search if any (the toolbar/main.ts will also
      // reapply; this is defensive).
      Object.assign(handle, next);
    });
    bar.appendChild(status);
    bar.appendChild(toggleBtn);
    wrapper.appendChild(bar);
  }

  // For each chain, append an SVG sized for its share of the wrapper height.
  const wrapperRect = container.getBoundingClientRect();
  const wrapperWidth = wrapperRect.width || container.clientWidth || 1000;
  const totalHeight = wrapperRect.height || container.clientHeight || 600;
  const barHeight = hasMultiple ? 34 : 0;
  const perChainHeight = Math.max(
    180,
    Math.floor((totalHeight - barHeight) / chains.length),
  );

  const allSelections: ChainSelections[] = [];
  for (const chain of chains) {
    const svgWrap = document.createElement('div');
    svgWrap.className = 'sankey-chain';
    svgWrap.style.height = `${perChainHeight}px`;
    wrapper.appendChild(svgWrap);

    const svg = select(svgWrap)
      .append('svg')
      .attr('class', 'sankey-svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${wrapperWidth} ${perChainHeight}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const sel = renderSingleSankey(
      svg as unknown as ReturnType<typeof select>,
      graph,
      primary,
      vizById,
      chain,
      wrapperWidth,
      perChainHeight,
      colorMap,
    );
    allSelections.push(sel);
  }

  const handle: ViewHandle = {
    setSearch(query: string): void {
      const matched = new Set<string>();
      if (query) {
        for (const n of graph.nodes) {
          if (nodeMatches(n, query)) matched.add(n.id);
        }
      }
      // Selections are typed `unknown` at the storage site; we narrow
      // to a structural shape just for the style() calls. Each shape
      // accepts either a literal or a per-datum callback, matching d3.
      type StyleFn<D> = {
        style: (k: string, v: number | ((d: D) => number)) => unknown;
      };
      for (const sel of allSelections) {
        if (!sel.rectSel || !sel.textSel || !sel.linkSel) continue;
        const rectStyle = sel.rectSel as StyleFn<SNode>;
        const textStyle = sel.textSel as StyleFn<SNode>;
        const linkStyle = sel.linkSel as StyleFn<{ source: SNode; target: SNode }>;
        if (!query) {
          rectStyle.style('opacity', 1);
          textStyle.style('opacity', 1);
          linkStyle.style('stroke-opacity', 0.35);
          continue;
        }
        rectStyle.style('opacity', (d) => (matched.has(d.graphId) ? 1 : 0.2));
        textStyle.style('opacity', (d) => (matched.has(d.graphId) ? 1 : 0.2));
        linkStyle.style('stroke-opacity', (d) => {
          const s = (d.source as SNode).graphId;
          const t = (d.target as SNode).graphId;
          return matched.has(s) && matched.has(t) ? 0.55 : 0.05;
        });
      }
    },
    focus(_nodeId: string | null, _opts?: { transitive?: boolean }): void {
      // Why: focus / constellation highlighting is not yet implemented
      // for this view. Force is the canonical surface for it; extending
      // to Sankey + Chord is tracked as a future v0.3 candidate. The
      // interface method is required so main.ts can call it uniformly.
      void _nodeId;
      void _opts;
    },
    destroy(): void {
      select(container).select('.sankey-wrapper').remove();
      clearInspector();
    },
  };
  return handle;
}
