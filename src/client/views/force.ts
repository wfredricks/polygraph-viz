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

import { select, type Selection } from 'd3-selection';
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

/** d3-force mutates nodes with x/y/vx/vy; widen the type for the sim. */
interface ForceNode extends SimulationNodeDatum {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  /** Cached primary label for coloring + tooltip. */
  primary: string;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string;
  type: string;
}

export function renderForce(container: HTMLElement, graph: GraphExport): void {
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const nodes: ForceNode[] = graph.nodes.map((n: VizNode) => ({
    id: n.id,
    labels: n.labels,
    properties: n.properties,
    primary: primaryLabel(n.labels),
  }));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const links: ForceLink[] = graph.edges
    .map((e: VizEdge): ForceLink | null => {
      const source = nodeById.get(e.fromId);
      const target = nodeById.get(e.toId);
      if (!source || !target) return null;
      return { id: e.id, type: e.type, source, target };
    })
    .filter((l): l is ForceLink => l !== null);

  // Root SVG + a zoom-able layer.
  const svg = select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const layer = svg.append('g').attr('class', 'force-layer');

  // Edges first so nodes draw on top.
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
    .text((d) => labelText(d))
    .attr('x', 11)
    .attr('y', 4)
    .attr('fill', 'var(--ink)')
    .attr('font-size', 10)
    .attr('pointer-events', 'none');

  nodeSel.append('title').text((d) => `${d.id}\n${d.labels.join(' · ')}`);

  // Simulation.
  const sim: Simulation<ForceNode, ForceLink> = forceSimulation<ForceNode>(
    nodes,
  )
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

  // Drag.
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

  // Pan + zoom.
  svg.call(
    zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        layer.attr('transform', event.transform.toString());
      }),
  );

  // Click to inspect.
  nodeSel.on('click', (_event, d) => {
    showInspector(d);
  });
}

function labelText(n: ForceNode): string {
  // Why: prefer a human-readable property over the id when one is
  // available. SI nodes use `name`; PolyGraph demos use `label`.
  const props = n.properties as Record<string, unknown>;
  const candidate = props['name'] ?? props['label'] ?? props['summary'];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate.length > 40 ? candidate.slice(0, 37) + '…' : candidate;
  }
  return n.id;
}

function showInspector(n: ForceNode): void {
  const aside = document.getElementById('inspector') as HTMLElement | null;
  if (!aside) return;
  aside.hidden = false;

  const props = Object.entries(n.properties)
    .map(
      ([k, v]) =>
        `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`,
    )
    .join('');

  aside.innerHTML = `
    <header>
      <h2>${escapeHtml(labelText(n))}</h2>
      <p class="labels">${n.labels.map(escapeHtml).join(' · ')}</p>
    </header>
    <table class="props">
      <thead><tr><th>key</th><th>value</th></tr></thead>
      <tbody>${props}</tbody>
    </table>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

declare module 'd3-selection' {
  // Why: silences the "may be implicitly any" on .selectAll downstream
  // when Selection is used through call().
  interface Selection<
    GElement extends Element | EnterElement | Document | Window | null,
    Datum,
    PElement extends Element | EnterElement | Document | Window | null,
    PDatum,
  > {}
}
