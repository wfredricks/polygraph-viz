/**
 * Graph API — reads from PolyGraph and serves data to the visualizer.
 *
 * Why: The visualizer needs graph data in a standard format.
 * This module reads from a local PolyGraph or proxies to a remote API.
 *
 * @style pure + effect-shell
 */

import { PolyGraph, MemoryAdapter, LevelAdapter } from 'polygraph-db';
import type { GraphExport, GraphStats, VizNode, VizEdge } from './types.js';

/**
 * Build graph stats from raw data.
 * @style pure
 */
export function computeStats(data: GraphExport): GraphStats {
  const labelDist: Record<string, number> = {};
  const relDist: Record<string, number> = {};

  for (const node of data.nodes) {
    for (const label of node.labels) {
      labelDist[label] = (labelDist[label] || 0) + 1;
    }
  }

  for (const edge of data.edges) {
    relDist[edge.type] = (relDist[edge.type] || 0) + 1;
  }

  const n = data.nodes.length;
  const maxEdges = n * (n - 1);
  const density = maxEdges > 0 ? data.edges.length / maxEdges : 0;

  return {
    nodeCount: n,
    edgeCount: data.edges.length,
    labelDistribution: labelDist,
    relationshipDistribution: relDist,
    density,
    components: 1, // TODO: compute connected components
  };
}

/**
 * Compute node degrees for sizing.
 * @style pure
 */
export function computeDegrees(data: GraphExport): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const edge of data.edges) {
    degrees.set(edge.fromId, (degrees.get(edge.fromId) || 0) + 1);
    degrees.set(edge.toId, (degrees.get(edge.toId) || 0) + 1);
  }
  return degrees;
}

/**
 * Search nodes by property value.
 * @style pure
 */
export function searchNodes(data: GraphExport, query: string): VizNode[] {
  const lower = query.toLowerCase();
  return data.nodes.filter(node => {
    for (const value of Object.values(node.properties)) {
      if (String(value).toLowerCase().includes(lower)) return true;
    }
    return node.labels.some(l => l.toLowerCase().includes(lower));
  });
}

/**
 * Filter graph by labels.
 * @style pure
 */
export function filterByLabels(data: GraphExport, labels: string[]): GraphExport {
  const labelSet = new Set(labels);
  const nodes = data.nodes.filter(n => n.labels.some(l => labelSet.has(l)));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = data.edges.filter(e => nodeIds.has(e.fromId) && nodeIds.has(e.toId));
  return { nodes, edges, metadata: { ...data.metadata, nodeCount: nodes.length, edgeCount: edges.length } };
}

/**
 * Filter graph by relationship types.
 * @style pure
 */
export function filterByRelTypes(data: GraphExport, types: string[]): GraphExport {
  const typeSet = new Set(types);
  const edges = data.edges.filter(e => typeSet.has(e.type));
  const nodeIds = new Set([...edges.map(e => e.fromId), ...edges.map(e => e.toId)]);
  const nodes = data.nodes.filter(n => nodeIds.has(n.id));
  return { nodes, edges, metadata: { ...data.metadata, nodeCount: nodes.length, edgeCount: edges.length } };
}

// ─── Effect Shell ──────────────────────────────────────────────────

/**
 * Export full graph from a PolyGraph instance.
 * @style effect
 */
export async function exportGraph(graph: PolyGraph): Promise<GraphExport> {
  const stats = await graph.stats();
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];

  // PolyGraph 0.1.3+ exposes `allNodes()` (colon-safe label-index walk).
  // Previously this used the Cypher bridge with `MATCH (n) RETURN n`,
  // which (a) silently returned empty for ids containing colons and
  // (b) never read relationships at all. Both are fixed here by going
  // through the engine's first-class adapters.
  const allNodes = await graph.allNodes();
  for (const n of allNodes) {
    nodes.push({
      id: n.id,
      labels: n.labels,
      properties: n.properties,
    });
  }

  // Edges: walk each node's outgoing adjacency. Each edge surfaces once
  // (from its source); we de-dupe by relationship id just in case.
  const seen = new Set<string>();
  for (const n of allNodes) {
    const outgoing = await graph.getNeighbors(n.id, undefined, 'outgoing');
    for (const { node: target, relationship: rel } of outgoing) {
      if (seen.has(rel.id)) continue;
      seen.add(rel.id);
      edges.push({
        id: rel.id,
        type: rel.type,
        fromId: n.id,
        toId: target.id,
        properties: rel.properties,
      });
    }
  }

  return {
    nodes,
    edges,
    metadata: {
      source: 'polygraph',
      nodeCount: nodes.length || stats.nodeCount,
      edgeCount: edges.length || stats.relationshipCount,
      exportedAt: new Date().toISOString(),
    },
  };
}

/**
 * Create a PolyGraph connection from config.
 */
export async function connectGraph(path: string): Promise<PolyGraph> {
  const adapter = new LevelAdapter({ path });
  const graph = new PolyGraph({ adapter });
  await graph.open();
  return graph;
}

/**
 * Build demo graph data.
 * @style pure
 */
export function buildDemoGraph(): GraphExport {
  return {
    nodes: [
      { id: 'twin-1', labels: ['Twin'], properties: { name: 'BillDT', type: 'personal', status: 'alive' } },
      { id: 'identity-1', labels: ['Identity'], properties: { name: 'TwinBirthright' } },
      { id: 'p1', labels: ['Principle'], properties: { text: 'Honesty — always truthful', order: 0 } },
      { id: 'p2', labels: ['Principle'], properties: { text: 'Helpfulness — make human productive', order: 1 } },
      { id: 'p3', labels: ['Principle'], properties: { text: 'Discretion — private stays private', order: 2 } },
      { id: 'narrative-1', labels: ['Narrative'], properties: { text: 'I am BillDT, a personal digital twin...' } },
      { id: 'occ-1', labels: ['Occupation'], properties: { type: 'personal', focus: 'Represent my human' } },
      { id: 'task-1', labels: ['Task'], properties: { description: 'Track deadlines', priority: 'critical' } },
      { id: 'task-2', labels: ['Task'], properties: { description: 'Learn patterns', priority: 'high' } },
      { id: 'task-3', labels: ['Task'], properties: { description: 'Morning briefing', priority: 'high' } },
      { id: 'role-1', labels: ['Role'], properties: { name: 'solutions-architect' } },
      { id: 'role-2', labels: ['Role'], properties: { name: 'developer' } },
      { id: 'doc-1', labels: ['Document'], properties: { fileName: 'resume.pdf', classification: 'self' } },
      { id: 'doc-2', labels: ['Document'], properties: { fileName: 'fleet-rfi.pdf', classification: 'reference' } },
      { id: 'const-1', labels: ['Constellation'], properties: { name: 'twin-standard' } },
    ],
    edges: [
      { id: 'e1', type: 'HAS_IDENTITY', fromId: 'twin-1', toId: 'identity-1', properties: {} },
      { id: 'e2', type: 'HAS_PRINCIPLE', fromId: 'identity-1', toId: 'p1', properties: {} },
      { id: 'e3', type: 'HAS_PRINCIPLE', fromId: 'identity-1', toId: 'p2', properties: {} },
      { id: 'e4', type: 'HAS_PRINCIPLE', fromId: 'identity-1', toId: 'p3', properties: {} },
      { id: 'e5', type: 'HAS_NARRATIVE', fromId: 'identity-1', toId: 'narrative-1', properties: {} },
      { id: 'e6', type: 'HAS_OCCUPATION', fromId: 'twin-1', toId: 'occ-1', properties: {} },
      { id: 'e7', type: 'HAS_TASK', fromId: 'occ-1', toId: 'task-1', properties: {} },
      { id: 'e8', type: 'HAS_TASK', fromId: 'occ-1', toId: 'task-2', properties: {} },
      { id: 'e9', type: 'HAS_TASK', fromId: 'occ-1', toId: 'task-3', properties: {} },
      { id: 'e10', type: 'PERFORMS_ROLE', fromId: 'twin-1', toId: 'role-1', properties: {} },
      { id: 'e11', type: 'PERFORMS_ROLE', fromId: 'twin-1', toId: 'role-2', properties: {} },
      { id: 'e12', type: 'OWNS_DOCUMENT', fromId: 'twin-1', toId: 'doc-1', properties: {} },
      { id: 'e13', type: 'OWNS_DOCUMENT', fromId: 'twin-1', toId: 'doc-2', properties: {} },
      { id: 'e14', type: 'BELONGS_TO', fromId: 'twin-1', toId: 'const-1', properties: {} },
    ],
    metadata: {
      source: 'demo',
      nodeCount: 15,
      edgeCount: 14,
      exportedAt: new Date().toISOString(),
    },
  };
}
