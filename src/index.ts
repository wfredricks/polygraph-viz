/**
 * PolyGraph Visualizer — public API.
 *
 * Exports types and utilities for embedding the visualizer in another
 * Hono app, or for building a viz around an already-loaded graph.
 */

export * from './types.js';
export {
  computeStats,
  searchNodes,
  filterByLabels,
  filterByRelTypes,
  buildDemoGraph,
  exportGraph,
  connectGraph,
} from './graph-api.js';
export { buildApp, loadGraph } from './server.js';
