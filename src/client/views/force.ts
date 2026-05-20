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
import { colorForLabel, primaryLabel } from '../ui/palette.js';
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

export function renderForce(container: HTMLElement, graph: GraphExport): ViewHandle {
  let { width, height } = measure(container);

  const nodes: ForceNode[] = graph.nodes.map((n: VizNode) => ({
    id: n.id,
    labels: n.labels,
    properties: n.properties,
    primary: primaryLabel(n.labels),
  }));

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

  const linkSel = linkGroup
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

  const nodeSel = layer
    .append('g')
    .attr('class', 'nodes')
    .selectAll<SVGGElement, ForceNode>('g')
    .data(nodes, (d) => d.id)
    .enter()
    .append('g')
    .attr('class', 'node')
    .style('cursor', 'pointer');

  nodeSel
    .append('circle')
    .attr('class', 'node-circle')
    .attr('r', 7)
    .attr('fill', (d) => colorForLabel(d.primary))
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

  nodeSel.call(
    drag<SVGGElement, ForceNode>()
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
      }),
  );

  svg.call(
    zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        layer.attr('transform', event.transform.toString());
      }),
  );

  // ── Focus / constellation state ─────────────────────────────
  // Click a node → dim everything except the connected constellation
  // (direct neighbors by default; transitive subgraph with Shift-click).
  // Click the same node again → clear. Click empty space → clear. ESC → clear.
  let focused: { id: string; transitive: boolean } | null = null;

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
        .select<SVGCircleElement>('circle')
        .attr('stroke-width', 0.8)
        .attr('stroke', null);
      linkSel.style('opacity', 0.9);
      linkGroup
        .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
        .style('pointer-events', 'auto');
      return;
    }
    const focusSet = computeFocusSet(focused.id, focused.transitive);
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
      '#7aa2ff';
    nodeSel
      .style('opacity', (d) => (focusSet.has(d.id) ? 1 : 0.12))
      .select<SVGCircleElement>('circle')
      .attr('stroke-width', (d) =>
        d.id === focused!.id ? 3 : focusSet.has(d.id) ? 1.6 : 0.8,
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

  // Click on empty SVG background clears focus.
  svg.on('click', () => {
    if (focused) {
      focused = null;
      applyFocus();
    }
  });

  // ESC clears focus.
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && focused) {
      focused = null;
      applyFocus();
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
        nodeSel.style('opacity', 1);
        nodeSel
          .select<SVGCircleElement>('circle')
          .attr('stroke-width', 0.8)
          .attr('stroke', null);
        linkSel.style('opacity', 0.9);
        linkGroup
          .selectAll<SVGLineElement, ForceLink>('line.edge-hit')
          .style('pointer-events', 'auto');
        return;
      }
      const matchedIds = new Set<string>();
      for (const n of graph.nodes) {
        if (nodeMatches(n, query)) matchedIds.add(n.id);
      }
      nodeSel
        .style('opacity', (d) => (matchedIds.has(d.id) ? 1 : 0.15))
        .select<SVGCircleElement>('circle')
        .attr('stroke-width', (d) => (matchedIds.has(d.id) ? 2.2 : 0.8))
        .attr('stroke', (d) =>
          matchedIds.has(d.id)
            ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() ||
              '#7aa2ff'
            : null,
        );
      linkSel.style('opacity', (d) => {
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
    },
    focus(nodeId: string | null, opts?: { transitive?: boolean }): void {
      if (!nodeId) {
        focused = null;
      } else {
        focused = { id: nodeId, transitive: !!opts?.transitive };
      }
      applyFocus();
    },
    destroy(): void {
      ro.disconnect();
      sim.stop();
      svg.remove();
      clearInspector();
      document.removeEventListener('keydown', escHandler);
    },
  };
  return handle;
}
