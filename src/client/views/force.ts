/**
 * Force-directed renderer (real D3).
 *
 * Replaces the v0.1 hand-rolled spring-physics SVG renderer with the
 * standard d3-force simulation:
 *   - forceLink for edges (with distance)
 *   - forceManyBody (charge) for node repulsion
 *   - forceCenter to keep the graph centered
 *   - forceCollide so labels don't overlap
 *
 * Pan/zoom via d3-zoom, drag via d3-drag.
 *
 * Why SVG (not Canvas): under ~5k nodes SVG is fine and gives us free
 * hit-testing for click-to-inspect. The bookend SIG (304 nodes) and the
 * build SIG (~2k nodes when fully loaded) both fit comfortably.
 *
 * Why no var(--*) in SVG attributes: SVG presentation attributes set
 * via .attr('stroke', 'var(--edge)') do not reliably resolve CSS
 * variables across all browsers and contexts. We pin presentation
 * tokens via CSS class selectors in styles.css so the theme system
 * (which flips data-theme on <html>) reaches into the SVG correctly.
 */

import { select } from 'd3-selection';
import { drag, type D3DragEvent } from 'd3-drag';
import { zoom, type D3ZoomEvent } from 'd3-zoom';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphExport, VizNode, VizEdge } from '../../types.js';
import { buildColorMap, primaryLabel, autoColor, symbolPathForLabel, swatchSvg } from '../ui/palette.js';
import {
  showNode,
  showEdge,
  clearInspector,
  pickDisplayName,
  nodeMatches,
} from '../ui/inspector.js';
import type { ViewHandle } from './types.js';

interface ForceNode extends SimulationNodeDatum {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  primary: string;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string;
  type: string;
}

/**
 * Read the container's real size, falling back to sensible defaults
 * when the container has not been laid out yet.
 */
function measure(container: HTMLElement): { width: number; height: number } {
  const r = container.getBoundingClientRect();
  return {
    width: Math.max(r.width || container.clientWidth || 800, 200),
    height: Math.max(r.height || container.clientHeight || 600, 200),
  };
}

// ── Sidebar integration helpers ─────────────────────────────────────────────
// These are assigned after renderForce() sets up its internal state and are
// exported so the sidebar can call them without referencing the ViewHandle
// (which doesn't expose add/remove surface).
//
// They are module-level variables so the sidebar module can import them
// directly. They are replaced every time renderForce() is called (i.e.
// on every view switch back to force). The sidebar should obtain fresh
// references after each render.

/** Add nodes returned by /api/neighbors/:nodeId to the running simulation. */
export let addAreaNodes: (nodeId: string) => Promise<{ added: number; nodeIds: string[] }> =
  async () => ({ added: 0, nodeIds: [] });

/** Add nodes by label from /api/nodes-by-label. */
export let addLabelNodes: (labels: string[]) => Promise<{ added: number; nodeIds: string[] }> =
  async () => ({ added: 0, nodeIds: [] });

/** Remove a set of node IDs from the canvas. */
export let removeNodes: (nodeIds: string[]) => void = () => {};

/**
 * connectVisible — fetch all edges between currently visible nodes via /api/subgraph
 * and add any that are not yet drawn. Call this after loading nodes to wire up
 * cross-type connections (the 'draw connections' action).
 */
export let connectVisible: () => Promise<number> = async () => 0;

/**
 * focusByLabel — highlight all visible nodes whose primary label matches.
 * Call with the same label again (or null) to clear the highlight.
 * Used by the sidebar label-click feature.
 */
export let focusByLabel: (label: string | null) => void = () => {};

export function renderForce(container: HTMLElement, graph: GraphExport): ViewHandle {
  let { width, height } = measure(container);

  const nodes: ForceNode[] = graph.nodes.map((n: VizNode) => ({
    id: n.id,
    labels: n.labels,
    properties: n.properties,
    primary: primaryLabel(n.labels),
  }));

  // Build a per-render color map (collision-free for ≤16 distinct labels).
  // Used both for node fill AND for the on-canvas legend.
  const colorMap = buildColorMap(graph.nodes);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const vizById = new Map(graph.nodes.map((n) => [n.id, n]));

  const links: ForceLink[] = graph.edges
    .map((e: VizEdge): ForceLink | null => {
      const source = nodeById.get(e.fromId);
      const target = nodeById.get(e.toId);
      if (!source || !target) return null;
      return { id: e.id, type: e.type, source, target };
    })
    .filter((l): l is ForceLink => l !== null);

  // Pending edges: cross-type edges where one endpoint wasn't in the canvas
  // when the edge arrived. Resolved after each addLabelNodes/addAreaNodes call.
  const pendingEdges: VizEdge[] = [];

  function resolveEdges(): void {
    const existingEdgeIds = new Set(links.map((l) => l.id));
    let resolved = 0;
    for (let i = pendingEdges.length - 1; i >= 0; i--) {
      const ve = pendingEdges[i]!;
      if (existingEdgeIds.has(ve.id)) { pendingEdges.splice(i, 1); continue; }
      const source = nodeById.get(ve.fromId);
      const target = nodeById.get(ve.toId);
      if (!source || !target) continue;
      const fl: ForceLink = { id: ve.id, type: ve.type, source, target };
      links.push(fl);
      graph.edges.push(ve);
      outgoing.get(ve.fromId)?.add(ve.toId);
      incoming.get(ve.toId)?.add(ve.fromId);
      pendingEdges.splice(i, 1);
      resolved++;
    }
    if (resolved > 0) {
      linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .data(links, (d) => d.id).enter()
        .append('line').attr('class', 'edge-hit')
        .attr('stroke', 'transparent').attr('stroke-width', 10)
        .style('cursor', 'pointer')
        .on('click', (_ev, d) => {
          const original = graph.edges.find((e) => e.id === d.id);
          if (!original) return;
          const src = vizById.get(original.fromId);
          const tgt = vizById.get(original.toId);
          showEdge(original, src, tgt);
        }).append('title').text((d) => d.type);
      linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge')
        .data(links, (d) => d.id).enter()
        .append('line').attr('class', 'edge').attr('stroke-width', 1.2)
        .attr('pointer-events', 'none');
      linkSel = linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge');
      (sim.force('link') as any).links(links); // eslint-disable-line @typescript-eslint/no-explicit-any
      sim.alpha(0.1).restart();
    }
  }

  // Adjacency lookup tables for the focus/constellation feature.
  // Why O(E) once at render time: per-click work is then O(1) for the
  // direct-neighbors case and O(reachable-set) for the transitive
  // case via BFS.
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const n of nodes) {
    outgoing.set(n.id, new Set());
    incoming.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    outgoing.get(e.fromId)?.add(e.toId);
    incoming.get(e.toId)?.add(e.fromId);
  }

  // SVG. Tokens (stroke for edges, stroke for node outline) come from
  // CSS class selectors in styles.css, not from var(--) in attributes.
  const svg = select(container)
    .append('svg')
    .attr('class', 'force-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const layer = svg.append('g').attr('class', 'force-layer');

  // Two-layer edges: a wide transparent hit-target line behind a thin
  // visible line. The visible line gets the .edge class (themed via
  // CSS); the hit-target line is invisible but catches pointer events.
  // Why: 1-2px lines are nearly impossible to click. The halo gives
  // the user a ~10px hit area without changing the visual.
  const linkGroup = layer.append('g').attr('class', 'links');

  linkGroup
    .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
    .data(links, (d) => d.id)
    .enter()
    .append('line')
    .attr('class', 'edge-hit')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 10)
    .style('cursor', 'pointer')
    .append('title')
    .text((d) => d.type);

  let linkSel = linkGroup
    .selectAll<SVGLineElement, ForceLink>('line.edge')
    .data(links, (d) => d.id)
    .enter()
    .append('line')
    .attr('class', 'edge')
    .attr('stroke-width', 1.2)
    .attr('pointer-events', 'none');

  // The hit lines own the click handler; the visible lines own the look.
  linkGroup
    .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
    .on('click', (_event, d) => {
      // Re-derive the original VizEdge for inspector display.
      const original = graph.edges.find((e) => e.id === d.id);
      if (!original) return;
      const src = vizById.get(original.fromId);
      const tgt = vizById.get(original.toId);
      showEdge(original, src, tgt);
    });

  const nodesGroup = layer.append('g').attr('class', 'nodes');
  let nodeSel = nodesGroup
    .selectAll<SVGGElement, ForceNode>('g')
    .data(nodes, (d) => d.id)
    .enter()
    .append('g')
    .attr('class', 'node')
    .style('cursor', 'pointer');

  nodeSel
    .append('path')
    .attr('class', 'node-shape')
    .attr('d', (d) => symbolPathForLabel(d.primary))
    .attr('fill', (d) => d.properties?.color || colorMap.colorForLabel(d.primary))
    .attr('stroke-width', 0.8);

  nodeSel
    .append('text')
    .attr('class', 'node-label')
    .text((d) => {
      const viz = vizById.get(d.id);
      return viz ? pickDisplayName(viz) : d.id;
    })
    .attr('x', 11)
    .attr('y', 4)
    .attr('font-size', 10)
    .attr('pointer-events', 'none');

  nodeSel.append('title').text((d) => `${d.id}\n${d.labels.join(' · ')}`);

  const sim: Simulation<ForceNode, ForceLink> = forceSimulation<ForceNode>(nodes)
    .force(
      'link',
      forceLink<ForceNode, ForceLink>(links)
        .id((d) => d.id)
        .distance(70)
        .strength(0.5),
    )
    .force('charge', forceManyBody<ForceNode>().strength(-180))
    .force('center', forceCenter(width / 2, height / 2))
    .force('collide', forceCollide<ForceNode>().radius(18))
    .on('tick', () => {
      // Position both the visible edge and its hit-area halo at the
      // same coordinates so click stays aligned with what the user sees.
      const x1fn = (d: ForceLink): number => (d.source as ForceNode).x ?? 0;
      const y1fn = (d: ForceLink): number => (d.source as ForceNode).y ?? 0;
      const x2fn = (d: ForceLink): number => (d.target as ForceNode).x ?? 0;
      const y2fn = (d: ForceLink): number => (d.target as ForceNode).y ?? 0;
      linkSel.attr('x1', x1fn).attr('y1', y1fn).attr('x2', x2fn).attr('y2', y2fn);
      linkGroup
        .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .attr('x1', x1fn)
        .attr('y1', y1fn)
        .attr('x2', x2fn)
        .attr('y2', y2fn);
      nodeSel.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

  const dragBehavior = drag<SVGGElement, ForceNode>()
    .on('start', (event: D3DragEvent<SVGGElement, ForceNode, ForceNode>, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
  nodeSel.call(dragBehavior);

  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      layer.attr('transform', event.transform.toString());
    });
  svg.call(zoomBehavior);

  /** Zoom to fit a set of node IDs with padding. */
  function zoomToFit(ids: Set<string>): void {
    const matched = nodes.filter((d) => ids.has(d.id));
    if (matched.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of matched) {
      const x = d.x ?? 0;
      const y = d.y ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 60;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const s = Math.min(width / bw, height / bh, 2);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = width / 2 - cx * s;
    const ty = height / 2 - cy * s;
    // Use d3.zoomIdentity from the already-imported zoom module
    import('d3-zoom').then(({ zoomIdentity }) => {
      svg.transition().duration(500).call(
        zoomBehavior.transform as any,
        zoomIdentity.translate(tx, ty).scale(s),
      );
    });
  }

  // ── Focus / constellation state ─────────────────────────────
  // Click a node → dim everything except the connected constellation
  // (direct neighbors by default; transitive subgraph with Shift-click).
  // Click the same node again → clear. Click empty space → clear. ESC → clear.
  // focused.id      : single-node focus (constellation around that node)
  // focused.byLabel : label-class focus (highlight every node of that label)
  // focused.byIds   : multi-id focus (union of 1-hop neighborhoods)
  // The three modes are mutually exclusive at click time but share applyFocus.
  let focused:
    | { id: string; transitive: boolean; byLabel?: string; byIds?: string[] }
    | null = null;

  function computeFocusSet(nodeId: string, transitive: boolean): Set<string> {
    if (!transitive) {
      const set = new Set<string>([nodeId]);
      outgoing.get(nodeId)?.forEach((n) => set.add(n));
      incoming.get(nodeId)?.forEach((n) => set.add(n));
      return set;
    }
    const set = new Set<string>([nodeId]);
    const queue: string[] = [nodeId];
    while (queue.length) {
      const cur = queue.shift()!;
      outgoing.get(cur)?.forEach((n) => {
        if (!set.has(n)) {
          set.add(n);
          queue.push(n);
        }
      });
      incoming.get(cur)?.forEach((n) => {
        if (!set.has(n)) {
          set.add(n);
          queue.push(n);
        }
      });
    }
    return set;
  }

  function applyFocus(): void {
    if (!focused) {
      nodeSel.style('opacity', 1);
      nodeSel
        .select<SVGPathElement>('.node-shape')
        .attr('stroke-width', 0.8)
        .attr('stroke', null);
      linkSel.style('opacity', 0.9);
      linkGroup
        .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .style('pointer-events', 'auto');
      return;
    }
    let focusSet: Set<string>;
    if (focused.byIds && focused.byIds.length > 0) {
      // Multi-id focus: union of 1-hop neighborhoods for each id.
      focusSet = new Set<string>();
      for (const id of focused.byIds) {
        focusSet.add(id);
        outgoing.get(id)?.forEach((n) => focusSet.add(n));
        incoming.get(id)?.forEach((n) => focusSet.add(n));
      }
    } else if (focused.byLabel) {
      // Label-class focus: highlight every node whose primary label matches.
      focusSet = new Set<string>();
      for (const n of nodes) {
        if (n.primary === focused.byLabel) focusSet.add(n.id);
      }
    } else {
      focusSet = computeFocusSet(focused.id, focused.transitive);
    }
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
      '#7aa2ff';
    const anchorId = focused.id; // empty string when byLabel
    nodeSel
      .style('opacity', (d) => (focusSet.has(d.id) ? 1 : 0.12))
      .select<SVGPathElement>('.node-shape')
      .attr('stroke-width', (d) =>
        d.id === anchorId ? 3 : focusSet.has(d.id) ? 1.6 : 0.8,
      )
      .attr('stroke', (d) => (focusSet.has(d.id) ? accent : null));
    linkSel.style('opacity', (d) => {
      const s = (d.source as ForceNode).id;
      const t = (d.target as ForceNode).id;
      return focusSet.has(s) && focusSet.has(t) ? 0.95 : 0.04;
    });
    linkGroup
      .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
      .style('pointer-events', (d) => {
        const s = (d.source as ForceNode).id;
        const t = (d.target as ForceNode).id;
        return focusSet.has(s) && focusSet.has(t) ? 'auto' : 'none';
      });
  }

  // ── Legend ─────────────────────────────────────────────────
  // Why an HTML overlay (not an SVG <g>): HTML gives us free
  // accessibility (a real list of buttons), text wrapping, and easy
  // theming via CSS variables. SVG-rendered legends require manual
  // measurement and layout.
  const legend = document.createElement('div');
  legend.className = 'force-legend';
  legend.setAttribute('aria-label', 'Node color legend');
  for (const entry of colorMap.entries) {
    const row = document.createElement('button');
    row.className = 'legend-row';
    row.type = 'button';
    row.title = `${entry.count} ${entry.label} node${entry.count === 1 ? '' : 's'} — click to focus`;
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.innerHTML = swatchSvg(entry.label, 12);
    const label = document.createElement('span');
    label.className = 'legend-label';
    label.textContent = entry.label;
    const count = document.createElement('span');
    count.className = 'legend-count';
    count.textContent = String(entry.count);
    row.appendChild(swatch);
    row.appendChild(label);
    row.appendChild(count);
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Toggle: if this label is already the focus filter, clear it.
      if (focused && focused.byLabel === entry.label) {
        focused = null;
      } else {
        focused = { id: '', byLabel: entry.label, transitive: false };
      }
      applyFocus();
    });
    legend.appendChild(row);
  }
  container.appendChild(legend);

  // ── Context menu ────────────────────────────────────────────
  // Right-click on a node opens a small floating overlay with secondary
  // actions. Uses position:fixed + clientX/Y so it never gets clipped.
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'node-ctx-menu';
  ctxMenu.style.display = 'none';
  document.body.appendChild(ctxMenu);

  let ctxMenuTarget: ForceNode | null = null;

  function showToast(msg: string, durationMs = 2200): void {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(30,30,36,0.92)', color: '#e0e0e0', padding: '8px 18px',
      borderRadius: '8px', fontSize: '13px', zIndex: '9999',
      backdropFilter: 'blur(6px)', pointerEvents: 'none',
      boxShadow: '0 2px 12px rgba(0,0,0,0.4)', whiteSpace: 'nowrap',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), durationMs);
  }

  function hideCtxMenu(): void {
    ctxMenu.style.display = 'none';
    ctxMenuTarget = null;
  }

  function showCtxMenu(event: MouseEvent, d: ForceNode): void {
    ctxMenuTarget = d;
    ctxMenu.style.left = `${event.clientX + 4}px`;
    ctxMenu.style.top = `${event.clientY + 4}px`;
    ctxMenu.style.display = 'block';
  }

  // ── Expand neighbors ─────────────────────────────────────────
  // Fetches 1-hop neighbors from /api/neighbors/:id and merges any new
  // nodes/edges into the running simulation without a full re-render.
  async function expandNeighbors(nodeId: string): Promise<void> {
    try {
      const res = await fetch(`/api/neighbors/${encodeURIComponent(nodeId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { nodes: VizNode[]; edges: VizEdge[] };

      const newVizNodes = data.nodes.filter((n) => !nodeById.has(n.id) && !n.properties?.['suppressed']);
      const existingEdgeIds = new Set(links.map((l) => l.id));
      const suppressedNbrIds = new Set(data.nodes.filter(n => n.properties?.['suppressed']).map(n => n.id));
      const newVizEdges = data.edges.filter((e) => !existingEdgeIds.has(e.id) && !suppressedNbrIds.has(e.fromId) && !suppressedNbrIds.has(e.toId));

      if (newVizNodes.length === 0 && newVizEdges.length === 0) {
        showToast('All neighbors already visible');
        return;
      }

      // Seed positions near the anchor node so new nodes don't pile at origin.
      const anchor = nodeById.get(nodeId);
      const anchorX = anchor?.x ?? width / 2;
      const anchorY = anchor?.y ?? height / 2;

      for (const vn of newVizNodes) {
        const fn: ForceNode = {
          id: vn.id,
          labels: vn.labels,
          properties: vn.properties,
          primary: primaryLabel(vn.labels),
          x: anchorX + (Math.random() - 0.5) * 80,
          y: anchorY + (Math.random() - 0.5) * 80,
        };
        nodes.push(fn);
        nodeById.set(fn.id, fn);
        vizById.set(fn.id, vn);
        graph.nodes.push(vn);
        outgoing.set(fn.id, new Set());
        incoming.set(fn.id, new Set());
      }

      for (const ve of newVizEdges) {
        const source = nodeById.get(ve.fromId);
        const target = nodeById.get(ve.toId);
        if (!source || !target) continue;
        const fl: ForceLink = { id: ve.id, type: ve.type, source, target };
        links.push(fl);
        graph.edges.push(ve);
        outgoing.get(ve.fromId)?.add(ve.toId);
        incoming.get(ve.toId)?.add(ve.fromId);
      }

      // Incrementally enter new nodes into the SVG.
      if (newVizNodes.length > 0) {
        const entered = nodesGroup
          .selectAll<SVGGElement, ForceNode>('g')
          .data(nodes, (d) => d.id)
          .enter()
          .append('g')
          .attr('class', 'node')
          .style('cursor', 'pointer');

        entered
          .append('path')
          .attr('class', 'node-shape')
          .attr('d', (d) => symbolPathForLabel(d.primary))
          .attr('fill', (d) => d.properties?.color || colorMap.colorForLabel(d.primary))
          .attr('stroke-width', 0.8);

        entered
          .append('text')
          .attr('class', 'node-label')
          .text((d) => {
            const v = vizById.get(d.id);
            return v ? pickDisplayName(v) : d.id;
          })
          .attr('x', 11)
          .attr('y', 4)
          .attr('font-size', 10)
          .attr('pointer-events', 'none');

        entered.append('title').text((d) => `${d.id}\n${d.labels.join(' · ')}`);

        entered.on('click', (event: MouseEvent, d) => {
          const v = vizById.get(d.id);
          if (v) showNode(v);
          const transitive = event.shiftKey;
          if (focused && focused.id === d.id && focused.transitive === transitive) {
            focused = null;
          } else {
            focused = { id: d.id, transitive };
          }
          applyFocus();
          event.stopPropagation();
        });

        entered.on('contextmenu', (event: MouseEvent, d) => {
          event.preventDefault();
          showCtxMenu(event, d);
        });

        entered.call(dragBehavior);

        // Widen nodeSel so tick, applyFocus, and setSearch reach new nodes.
        nodeSel = nodesGroup.selectAll<SVGGElement, ForceNode>('g');
      }

      // Incrementally enter new links into the SVG.
      if (newVizEdges.length > 0) {
        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .data(links, (d) => d.id)
          .enter()
          .append('line')
          .attr('class', 'edge-hit')
          .attr('stroke', 'transparent')
          .attr('stroke-width', 10)
          .style('cursor', 'pointer')
          .on('click', (_ev, d) => {
            const original = graph.edges.find((e) => e.id === d.id);
            if (!original) return;
            const src = vizById.get(original.fromId);
            const tgt = vizById.get(original.toId);
            showEdge(original, src, tgt);
          })
          .append('title')
          .text((d) => d.type);

        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge')
          .data(links, (d) => d.id)
          .enter()
          .append('line')
          .attr('class', 'edge')
          .attr('stroke-width', 1.2)
          .attr('pointer-events', 'none');

        // Widen linkSel so tick handler positions new edges.
        linkSel = linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge');
      }

      // Restart simulation with the expanded node/link arrays.
      sim.nodes(nodes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sim.force('link') as any).links(links);
      sim.alpha(0.3).restart();

      // Resolve any pending cross-type edges now that new nodes are present.
      resolveEdges();
    } catch (err) {
      console.error('expandNeighbors failed:', err);
    }
  }

  // ── Sidebar integration: module-level function references ──────────────
  // Assigned here so the sidebar can call them after renderForce() runs.
  // Re-assigned on every renderForce() call so stale closures never escape.

  connectVisible = async (): Promise<number> => {
    const visibleIds = [...nodeById.keys()];
    if (visibleIds.length < 2) return 0;
    try {
      const res = await fetch('/api/subgraph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeIds: visibleIds }),
      });
      if (!res.ok) return 0;
      const data = (await res.json()) as { nodes: VizNode[]; edges: VizEdge[] };
      const existingEdgeIds = new Set(links.map((l) => l.id));
      const newEdges = data.edges.filter((e) => !existingEdgeIds.has(e.id));
      let added = 0;
      for (const ve of newEdges) {
        const source = nodeById.get(ve.fromId);
        const target = nodeById.get(ve.toId);
        if (!source || !target) continue;
        const fl: ForceLink = { id: ve.id, type: ve.type, source, target };
        links.push(fl);
        graph.edges.push(ve);
        outgoing.get(ve.fromId)?.add(ve.toId);
        incoming.get(ve.toId)?.add(ve.fromId);
        added++;
      }
      if (added > 0) {
        linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .data(links, (d) => d.id).enter()
          .append('line').attr('class', 'edge-hit')
          .attr('stroke', 'transparent').attr('stroke-width', 10)
          .style('cursor', 'pointer')
          .on('click', (_ev, d) => {
            const original = graph.edges.find((e) => e.id === d.id);
            if (!original) return;
            const src = vizById.get(original.fromId);
            const tgt = vizById.get(original.toId);
            showEdge(original, src, tgt);
          }).append('title').text((d) => d.type);
        linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge')
          .data(links, (d) => d.id).enter()
          .append('line').attr('class', 'edge').attr('stroke-width', 1.2)
          .attr('stroke', (d) => colorMap.colorForLabel(d.type))
          .attr('stroke-opacity', 0.6);
        (sim.force('link') as any).links(links);
        sim.alpha(0.15).restart();
      }
      return added;
    } catch { return 0; }
  };

  addAreaNodes = async (nodeId: string): Promise<{ added: number; nodeIds: string[] }> => {
    const before = nodes.length;
    await expandNeighbors(nodeId);
    const after = nodes.length;
    const added = after - before;
    // Return the IDs of the newly added nodes (the tail of the array)
    const newIds = nodes.slice(before).map((n) => n.id);
    return { added, nodeIds: newIds };
  };

  addLabelNodes = async (labels: string[]): Promise<{ added: number; nodeIds: string[] }> => {
    try {
      const q = labels.map(encodeURIComponent).join(',');
      // Request up to 2000 nodes — enough for any single label in STORES.
      // The server default cap is 500 which truncates code.file (891), features (1895), etc.
      const res = await fetch(`/api/nodes-by-label?labels=${q}&limit=2000`);
      if (!res.ok) return { added: 0, nodeIds: [] };
      const data = (await res.json()) as { nodes: VizNode[]; edges: VizEdge[] };

      // Exclude suppressed nodes (Phase 1+ consolidation — marked suppressed:true)
      const newVizNodes = data.nodes.filter((n) => !nodeById.has(n.id) && !n.properties?.['suppressed']);
      const existingEdgeIds = new Set(links.map((l) => l.id));
      // Also exclude edges whose endpoints are suppressed
      const suppressedIds = new Set(data.nodes.filter(n => n.properties?.['suppressed']).map(n => n.id));
      const newVizEdges = data.edges.filter((e) => !existingEdgeIds.has(e.id) && !suppressedIds.has(e.fromId) && !suppressedIds.has(e.toId));

      const newIds: string[] = [];

      if (newVizNodes.length === 0 && newVizEdges.length === 0) {
        return { added: 0, nodeIds: [] };
      }

      for (const vn of newVizNodes) {
        const fn: ForceNode = {
          id: vn.id,
          labels: vn.labels,
          properties: vn.properties,
          primary: primaryLabel(vn.labels),
          x: width / 2 + (Math.random() - 0.5) * 200,
          y: height / 2 + (Math.random() - 0.5) * 200,
        };
        nodes.push(fn);
        nodeById.set(fn.id, fn);
        vizById.set(fn.id, vn);
        graph.nodes.push(vn);
        outgoing.set(fn.id, new Set());
        incoming.set(fn.id, new Set());
        newIds.push(fn.id);
      }

      for (const ve of newVizEdges) {
        const source = nodeById.get(ve.fromId);
        const target = nodeById.get(ve.toId);
        if (!source || !target) {
          // Park for later resolution when the other endpoint arrives.
          pendingEdges.push(ve);
          continue;
        }
        const fl: ForceLink = { id: ve.id, type: ve.type, source, target };
        links.push(fl);
        graph.edges.push(ve);
        outgoing.get(ve.fromId)?.add(ve.toId);
        incoming.get(ve.toId)?.add(ve.fromId);
      }

      if (newVizNodes.length > 0) {
        const entered = nodesGroup
          .selectAll<SVGGElement, ForceNode>('g')
          .data(nodes, (d) => d.id)
          .enter()
          .append('g')
          .attr('class', 'node')
          .style('cursor', 'pointer');

        entered
          .append('path')
          .attr('class', 'node-shape')
          .attr('d', (d) => symbolPathForLabel(d.primary))
          .attr('fill', (d) => d.properties?.color || colorMap.colorForLabel(d.primary))
          .attr('stroke-width', 0.8);

        entered
          .append('text')
          .attr('class', 'node-label')
          .text((d) => {
            const v = vizById.get(d.id);
            return v ? pickDisplayName(v) : d.id;
          })
          .attr('x', 11)
          .attr('y', 4)
          .attr('font-size', 10)
          .attr('pointer-events', 'none');

        entered.append('title').text((d) => `${d.id}\n${d.labels.join(' \u00b7 ')}`);

        entered.on('click', (event: MouseEvent, d) => {
          const v = vizById.get(d.id);
          if (v) showNode(v);
          const transitive = event.shiftKey;
          if (focused && focused.id === d.id && focused.transitive === transitive) {
            focused = null;
          } else {
            focused = { id: d.id, transitive };
          }
          applyFocus();
          event.stopPropagation();
        });

        entered.on('contextmenu', (event: MouseEvent, d) => {
          event.preventDefault();
          showCtxMenu(event, d);
        });

        entered.call(dragBehavior);
        nodeSel = nodesGroup.selectAll<SVGGElement, ForceNode>('g');
      }

      if (newVizEdges.length > 0) {
        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .data(links, (d) => d.id)
          .enter()
          .append('line')
          .attr('class', 'edge-hit')
          .attr('stroke', 'transparent')
          .attr('stroke-width', 10)
          .style('cursor', 'pointer')
          .on('click', (_ev, d) => {
            const original = graph.edges.find((e) => e.id === d.id);
            if (!original) return;
            const src = vizById.get(original.fromId);
            const tgt = vizById.get(original.toId);
            showEdge(original, src, tgt);
          })
          .append('title')
          .text((d) => d.type);

        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge')
          .data(links, (d) => d.id)
          .enter()
          .append('line')
          .attr('class', 'edge')
          .attr('stroke-width', 1.2)
          .attr('pointer-events', 'none');

        linkSel = linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge');
      }

      sim.nodes(nodes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sim.force('link') as any).links(links);
      sim.alpha(0.3).restart();

      // Resolve any pending edges that now have both endpoints.
      resolveEdges();

      // Auto-connect: find edges between all currently visible nodes.
      // This is the 'draw connections' pass — wires up cross-type edges
      // regardless of the order node types were loaded.
      void connectVisible();

      return { added: newIds.length, nodeIds: newIds };
    } catch (err) {
      console.error('addLabelNodes failed:', err);
      return { added: 0, nodeIds: [] };
    }
  };

  removeNodes = (nodeIds: string[]): void => {
    const removeSet = new Set(nodeIds);
    // Remove from data arrays
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (removeSet.has(nodes[i]!.id)) nodes.splice(i, 1);
    }
    for (let i = links.length - 1; i >= 0; i--) {
      const s = (links[i]!.source as ForceNode).id;
      const t = (links[i]!.target as ForceNode).id;
      if (removeSet.has(s) || removeSet.has(t)) links.splice(i, 1);
    }
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      if (removeSet.has(graph.nodes[i]!.id)) graph.nodes.splice(i, 1);
    }
    for (let i = graph.edges.length - 1; i >= 0; i--) {
      if (removeSet.has(graph.edges[i]!.fromId) || removeSet.has(graph.edges[i]!.toId)) {
        graph.edges.splice(i, 1);
      }
    }
    for (const id of nodeIds) {
      nodeById.delete(id);
      vizById.delete(id);
      outgoing.delete(id);
      incoming.delete(id);
    }
    // Remove from SVG
    nodeSel = nodesGroup.selectAll<SVGGElement, ForceNode>('g')
      .data(nodes, (d) => d.id);
    nodeSel.exit().remove();
    nodeSel = nodesGroup.selectAll<SVGGElement, ForceNode>('g');

    linkSel = linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge')
      .data(links, (d) => d.id);
    linkSel.exit().remove();
    linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge-hit')
      .data(links, (d) => d.id)
      .exit().remove();
    linkSel = linkGroup.selectAll<SVGLineElement, ForceLink>('line.edge');

    // Restart simulation
    sim.nodes(nodes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sim.force('link') as any).links(links);
    sim.alpha(0.2).restart();
  };

  // Sidebar label-click: highlight all visible nodes of a given label.
  focusByLabel = (label: string | null): void => {
    if (!label || (focused && focused.byLabel === label)) {
      focused = null;
    } else {
      focused = { id: '', byLabel: label, transitive: false };
    }
    applyFocus();
  };

  // Build context menu buttons.
  const ctxItems: { label: string; action: () => void }[] = [
    {
      label: '⊕ Expand neighbors',
      action: () => {
        if (!ctxMenuTarget) return;
        void expandNeighbors(ctxMenuTarget.id);
        hideCtxMenu();
      },
    },
    {
      label: '◎ Focus',
      action: () => {
        if (!ctxMenuTarget) return;
        const viz = vizById.get(ctxMenuTarget.id);
        if (viz) showNode(viz);
        focused = { id: ctxMenuTarget.id, transitive: false };
        applyFocus();
        hideCtxMenu();
      },
    },
    {
      label: '⎘ Copy ID',
      action: () => {
        if (!ctxMenuTarget) return;
        navigator.clipboard.writeText(ctxMenuTarget.id).catch(() => {
          /* clipboard unavailable — silent */
        });
        hideCtxMenu();
      },
    },
  ];
  for (const item of ctxItems) {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.type = 'button';
    btn.textContent = item.label;
    btn.addEventListener('click', item.action);
    ctxMenu.appendChild(btn);
  }

  // Dismiss context menu when clicking anywhere outside it.
  const ctxOutsideHandler = (e: MouseEvent): void => {
    if (ctxMenu.style.display !== 'none' && !ctxMenu.contains(e.target as Node)) {
      hideCtxMenu();
    }
  };
  document.addEventListener('mousedown', ctxOutsideHandler);

  nodeSel.on('click', (event: MouseEvent, d) => {
    const viz = vizById.get(d.id);
    if (viz) showNode(viz);
    const transitive = event.shiftKey;
    if (focused && focused.id === d.id && focused.transitive === transitive) {
      focused = null;
    } else {
      focused = { id: d.id, transitive };
    }
    applyFocus();
    event.stopPropagation();
  });

  nodeSel.on('contextmenu', (event: MouseEvent, d) => {
    event.preventDefault();
    showCtxMenu(event, d);
  });

  // Click on empty SVG background clears focus.
  svg.on('click', () => {
    if (focused) {
      focused = null;
      applyFocus();
    }
  });

  // ESC clears focus.
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (ctxMenu.style.display !== 'none') {
        hideCtxMenu();
      } else if (focused) {
        focused = null;
        applyFocus();
      }
    }
  };
  document.addEventListener('keydown', escHandler);

  // ── ResizeObserver: keep the simulation centered as the container resizes.
  // Why: the renderer runs once at mount time; if the page is still
  // laying out (flex/grid resolving), the first measure() may report
  // a wrong size and the graph clusters in the top-left. The observer
  // catches the real size shortly after.
  const ro = new ResizeObserver(() => {
    const next = measure(container);
    if (next.width === width && next.height === height) return;
    width = next.width;
    height = next.height;
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    sim.force('center', forceCenter(width / 2, height / 2));
    sim.alpha(0.3).restart();
  });
  ro.observe(container);

  // ── ViewHandle ──────────────────────────────────────────────
  const handle: ViewHandle = {
    setSearch(query: string): void {
      // Why: search clears any active focus so a search match isn't
      // dimmed by a stale constellation overlay.
      if (focused) {
        focused = null;
      }
      if (!query) {
        // Restore display for all nodes (clear search-imposed hiding)
        nodeSel.style('display', null).style('opacity', 1);
        nodeSel
          .select<SVGPathElement>('.node-shape')
          .attr('stroke-width', 0.8)
          .attr('stroke', null);
        linkSel.style('display', null).style('opacity', 0.9);
        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .style('display', null)
          .style('pointer-events', 'auto');
        return;
      }
      const matchedIds = new Set<string>();
      for (const n of graph.nodes) {
        if (nodeMatches(n, query)) matchedIds.add(n.id);
      }
      // Search overrides any active filter: un-hide matched nodes
      // that were hidden by setFilter so search works across the full
      // graph regardless of active slice.
      nodeSel.style('display', (d) =>
        matchedIds.has(d.id) ? null : 'none',
      );
      nodeSel
        .style('opacity', (d) => (matchedIds.has(d.id) ? 1 : 0.15))
        .select<SVGPathElement>('.node-shape')
        .attr('stroke-width', (d) => (matchedIds.has(d.id) ? 2.2 : 0.8))
        .attr('stroke', (d) =>
          matchedIds.has(d.id)
            ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
              '#7aa2ff'
            : null,
        );
      linkSel
        .style('display', (d) => {
          const s = (d.source as ForceNode).id;
          const t = (d.target as ForceNode).id;
          return matchedIds.has(s) && matchedIds.has(t) ? null : 'none';
        })
        .style('opacity', (d) => {
          const s = (d.source as ForceNode).id;
          const t = (d.target as ForceNode).id;
          return matchedIds.has(s) && matchedIds.has(t) ? 0.9 : 0.05;
        });
      // Disable clicks on filtered-out edges so users don't open
      // inspectors for things they can't even see.
      linkGroup
        .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .style('pointer-events', (d) => {
          const s = (d.source as ForceNode).id;
          const t = (d.target as ForceNode).id;
          return matchedIds.has(s) && matchedIds.has(t) ? 'auto' : 'none';
        });
      // Zoom to fit matched nodes so they're visible
      zoomToFit(matchedIds);
    },
    focus(
      nodeId: string | string[] | null,
      opts?: { transitive?: boolean },
    ): void {
      if (!nodeId) {
        focused = null;
      } else if (Array.isArray(nodeId)) {
        if (nodeId.length === 0) {
          focused = null;
        } else if (nodeId.length === 1) {
          // Why: a one-element array reduces to single-id constellation
          // focus for the cleanest UX (anchor halo on the one node).
          focused = { id: nodeId[0]!, transitive: !!opts?.transitive };
        } else {
          focused = { id: '', transitive: false, byIds: [...nodeId] };
        }
      } else {
        focused = { id: nodeId, transitive: !!opts?.transitive };
      }
      applyFocus();
    },
    setFilter(keepIds: string[] | null): void {
      // Hard filter: hide non-matching nodes + edges with display:none
      // so the visible graph is exactly the kept subset. Restores on null.
      if (!keepIds) {
        nodeSel.style('display', null);
        linkSel.style('display', null);
        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .style('display', null);
        return;
      }
      const keep = new Set<string>(keepIds);
      nodeSel.style('display', (d) => (keep.has(d.id) ? null : 'none'));
      linkSel.style('display', (d) => {
        const s = (d.source as ForceNode).id;
        const t = (d.target as ForceNode).id;
        return keep.has(s) && keep.has(t) ? null : 'none';
      });
      linkGroup
        .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .style('display', (d) => {
          const s = (d.source as ForceNode).id;
          const t = (d.target as ForceNode).id;
          return keep.has(s) && keep.has(t) ? null : 'none';
        });
      // Zoom to fit the filtered subset
      zoomToFit(keep);
    },
    refit(): void {
      // Simple zoom-to-fit of all nodes in the current graph
      const allIds = new Set(nodes.map(d => d.id));
      zoomToFit(allIds);
    },
    destroy(): void {
      ro.disconnect();
      sim.stop();
      svg.remove();
      legend.remove();
      ctxMenu.remove();
      document.removeEventListener('mousedown', ctxOutsideHandler);
      clearInspector();
      document.removeEventListener('keydown', escHandler);
    },
  };
  return handle;
}
