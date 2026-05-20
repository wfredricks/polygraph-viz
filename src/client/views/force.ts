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
import { showNode, clearInspector, pickDisplayName, nodeMatches } from '../ui/inspector.js';
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

export function renderForce(container: HTMLElement, graph: GraphExport): ViewHandle {
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const nodes: ForceNode[] = graph.nodes.map((n: VizNode) => ({
    id: n.id,
    labels: n.labels,
    properties: n.properties,
    primary: primaryLabel(n.labels),
  }));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Why: keep the original VizNode handy so inspector + search can
  // operate on the un-mutated properties object.
  const vizById = new Map(graph.nodes.map((n) => [n.id, n]));

  const links: ForceLink[] = graph.edges
    .map((e: VizEdge): ForceLink | null => {
      const source = nodeById.get(e.fromId);
      const target = nodeById.get(e.toId);
      if (!source || !target) return null;
      return { id: e.id, type: e.type, source, target };
    })
    .filter((l): l is ForceLink => l !== null);

  const svg = select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const layer = svg.append('g').attr('class', 'force-layer');

  const linkSel = layer
    .append('g')
    .attr('class', 'links')
    .selectAll<SVGLineElement, ForceLink>('line')
    .data(links, (d) => d.id)
    .enter()
    .append('line')
    .attr('stroke', 'var(--edge)')
    .attr('stroke-opacity', 0.7)
    .attr('stroke-width', 1.2);

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
    .attr('r', 7)
    .attr('fill', (d) => colorForLabel(d.primary))
    .attr('stroke', 'var(--ink)')
    .attr('stroke-width', 0.8);

  nodeSel
    .append('text')
    .text((d) => {
      const viz = vizById.get(d.id);
      return viz ? pickDisplayName(viz) : d.id;
    })
    .attr('x', 11)
    .attr('y', 4)
    .attr('fill', 'var(--ink)')
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
      linkSel
        .attr('x1', (d) => (d.source as ForceNode).x ?? 0)
        .attr('y1', (d) => (d.source as ForceNode).y ?? 0)
        .attr('x2', (d) => (d.target as ForceNode).x ?? 0)
        .attr('y2', (d) => (d.target as ForceNode).y ?? 0);
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

  nodeSel.on('click', (_event, d) => {
    const viz = vizById.get(d.id);
    if (viz) showNode(viz);
  });

  // ── ViewHandle ──────────────────────────────────────────────
  const handle: ViewHandle = {
    setSearch(query: string): void {
      // Greyout non-matches. Empty query restores everything.
      if (!query) {
        nodeSel.style('opacity', 1).select('circle').attr('stroke-width', 0.8);
        linkSel.style('opacity', 0.7);
        return;
      }
      const matchedIds = new Set<string>();
      for (const n of graph.nodes) {
        if (nodeMatches(n, query)) matchedIds.add(n.id);
      }
      nodeSel
        .style('opacity', (d) => (matchedIds.has(d.id) ? 1 : 0.15))
        .select('circle')
        .attr('stroke-width', (d) => (matchedIds.has(d.id) ? 2.2 : 0.8))
        .attr('stroke', (d) => (matchedIds.has(d.id) ? 'var(--accent)' : 'var(--ink)'));
      linkSel.style('opacity', (d) => {
        const s = (d.source as ForceNode).id;
        const t = (d.target as ForceNode).id;
        return matchedIds.has(s) && matchedIds.has(t) ? 0.7 : 0.05;
      });
    },
    destroy(): void {
      sim.stop();
      svg.remove();
      clearInspector();
    },
  };
  return handle;
}
