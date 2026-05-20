/**
 * Segment classifier — biz / dom / imp / meta.
 *
 * Honors Bill's monikers from 2026-05-20 14:53 EDT + the layer-with-
 * boundary refinement from 2026-05-20 16:09 EDT (Option C):
 *
 *   1. The business end (biz) — requirements through features. Business
 *      concerns being mapped/traced to.
 *   2. The domain end (dom) — features through domain leaves (functions,
 *      modules, alternative flows, call outs). Implementation-agnostic.
 *   3. The implementation end (imp) — paradigm-bound targets
 *      (TypeScript / ServiceNow / Appian / Next.js / ...).
 *
 * Seam doctrine: features live in BOTH biz and dom. Functions/modules
 * (when they exist) will live in BOTH dom and imp. Segments are not
 * disjoint partitions of the label set — they are pipeline layers that
 * overlap at the seams. The classifier returns a Set<Segment> per node
 * so a single feature is correctly { biz, dom } simultaneously.
 *
 * Slice semantics (used by /biz, /dom, /imp commands):
 *   slice(segment) =
 *     {nodes with segment ∈ segments(node)}
 *     ∪
 *     {nodes any slice-resident node points to with an outgoing edge}
 *
 * This includes the OUTBOUND-edge boundary so a /biz slice ending at
 * features shows "what those features promise" via their connections
 * down into dom. Symmetric for /dom into imp.
 *
 * Pure functions — no DOM, no graph mutations. Importable from client
 * renderers (filter views) AND from server endpoints (NL query
 * "in the biz segment" routing).
 */

import type { GraphExport, VizNode } from '../types.js';

export type Segment = 'biz' | 'dom' | 'imp' | 'meta';

const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

/** Pick the meaningful label (first non-utility). */
function primaryLabel(labels: string[]): string {
  if (labels.length === 0) return 'Node';
  const meaningful = labels.find((l) => !UTILITY_LABELS.has(l));
  return meaningful ?? labels[0]!;
}

/**
 * Classify a node into the set of segments it inhabits. Most nodes are
 * in exactly one segment; seam nodes (features today; functions/modules
 * when they exist) are in two.
 */
export function segmentsForNode(node: VizNode): Set<Segment> {
  const primary = primaryLabel(node.labels);

  // Tier 3 paradigm-bound labels = implementation segment.
  // Future-proof prefix set; the methodology anticipates more.
  for (const pre of ['cs_', 'sn_', 'next_', 'appian_', 'java_', 'py_', 'cobol_']) {
    if (primary.startsWith(pre)) return new Set(['imp']);
  }

  // The biz–dom seam: features are the bottom of biz AND the top of dom.
  // They're how business intent enters implementation. Both segments
  // include them so /biz and /dom both render features.
  if (primary === 'sw.feature') return new Set(['biz', 'dom']);

  // The dom–imp seam: when functions/modules land (Stage 4+), they will
  // be both dom (the implementation-agnostic shape) and imp (the actual
  // realized code in a specific paradigm). For now these labels exist
  // as forward declarations; current graphs have no instances.
  if (
    primary === 'sw.function' ||
    primary === 'sw.module' ||
    primary === 'sw.class' ||
    primary === 'sw.interface' ||
    primary === 'sw.endpoint' ||
    primary === 'sw.test' ||
    primary === 'sw.cli_command' ||
    primary === 'sw.audit_event' ||
    primary === 'sw.workflow' ||
    primary === 'sw.dependency_edge'
  ) {
    return new Set(['dom', 'imp']);
  }

  // Pure biz layer — requirements, use cases, findings, risks, constraints.
  switch (primary) {
    case 'intended_behavior':
    case 'constraint':
    case 'evidence':
    case 'finding':
    case 'risk_item':
    case 'sw.use_case':
      return new Set(['biz']);
  }

  // Pure dom layer — build-planning nodes (repos, stages, types).
  // These describe how we organize the build; they're paradigm-agnostic
  // but they're not biz concerns.
  switch (primary) {
    case 'sw.repo':
    case 'sw.stage':
    case 'sw.type':
    case 'sw.compose_service':
      return new Set(['dom']);
  }

  // Anything we haven't named explicitly defaults to meta.
  return new Set(['meta']);
}

/**
 * Convenience for callers that want a single segment (the first one
 * found, in biz / dom / imp / meta order). Used by the legend and
 * by /stats for headline counts.
 *
 * For seam nodes the choice is biz < dom < imp < meta; features
 * therefore report as 'biz' here. UI elements that need accurate seam
 * representation (e.g. node coloring) should call segmentsForNode()
 * instead and handle the multi-segment case explicitly.
 */
export function segmentForNode(node: VizNode): Segment {
  const segs = segmentsForNode(node);
  if (segs.has('biz')) return 'biz';
  if (segs.has('dom')) return 'dom';
  if (segs.has('imp')) return 'imp';
  return 'meta';
}

export interface SegmentCounts {
  biz: number;
  dom: number;
  imp: number;
  meta: number;
  /** How many nodes inhabit MORE THAN ONE segment (seam nodes). */
  seams: number;
}

export function tallySegments(nodes: VizNode[]): SegmentCounts {
  const counts: SegmentCounts = { biz: 0, dom: 0, imp: 0, meta: 0, seams: 0 };
  for (const n of nodes) {
    const segs = segmentsForNode(n);
    if (segs.has('biz')) counts.biz++;
    if (segs.has('dom')) counts.dom++;
    if (segs.has('imp')) counts.imp++;
    if (segs.has('meta')) counts.meta++;
    if (segs.size > 1) counts.seams++;
  }
  return counts;
}

/**
 * Pipeline ordering. biz < dom < imp, with meta sitting outside the
 * pipeline (and therefore never participating in down-the-pipeline
 * boundary expansion).
 */
const SEGMENT_DEPTH: Record<Segment, number> = {
  biz: 0,
  dom: 1,
  imp: 2,
  meta: -1, // sentinel; never selected as a strictly-below target
};

/**
 * Compute the node-id set for an Option-C slice of a single segment.
 *
 * Returns nodes whose segment set contains `seg`, plus nodes any
 * slice-resident node points to via an OUTGOING edge whose TARGET is
 * strictly DEEPER in the pipeline (biz < dom < imp). This is the
 * "what this layer promises" boundary, directional by pipeline depth.
 *
 * Why direction-aware: a feature has outgoing edges in two
 * directions — IMPLEMENTS edges to REQs (up, biz), and (future)
 * realization edges to functions (down, dom∪imp). A naive "any
 * outgoing edge" boundary for /dom would re-include all REQs +
 * UCs via features' IMPLEMENTS edges, effectively expanding the
 * /dom slice back to the full graph. Direction-by-depth keeps the
 * slice honest: /dom extends down to imp, not back up to biz.
 *
 * For a multi-segment node (e.g. a feature in {biz, dom}), its
 * "effective depth" is the MAX of its segment depths, so down-the-
 * pipeline boundary correctly originates from the bottom of its
 * span. Without this, a feature in a /biz slice would expand its
 * boundary as if it were a pure biz node and miss its dom-facing
 * outgoing edges.
 */
export function sliceSegment(
  graph: GraphExport,
  seg: Segment,
): { nodeIds: Set<string>; segmentMemberCount: number } {
  const segmentMembers = new Set<string>();
  for (const n of graph.nodes) {
    if (segmentsForNode(n).has(seg)) {
      segmentMembers.add(n.id);
    }
  }

  // Index node -> its effective pipeline depth (max of its segments).
  const nodeDepth = new Map<string, number>();
  for (const n of graph.nodes) {
    let maxDepth = -1;
    for (const s of segmentsForNode(n)) {
      const d = SEGMENT_DEPTH[s];
      if (d > maxDepth) maxDepth = d;
    }
    nodeDepth.set(n.id, maxDepth);
  }

  const sliceDepth = SEGMENT_DEPTH[seg];
  const slice = new Set<string>(segmentMembers);
  for (const e of graph.edges) {
    if (!segmentMembers.has(e.fromId)) continue;
    const targetDepth = nodeDepth.get(e.toId) ?? -1;
    // Boundary: target is STRICTLY below the slice in the pipeline.
    // Why strict: a feature->REQ edge from a feature (depth 1, since
    // it's {biz,dom}) to a REQ (depth 0, biz) would otherwise be
    // included by `>=` and re-expand /dom back to biz.
    if (targetDepth > sliceDepth) {
      slice.add(e.toId);
    }
  }
  return { nodeIds: slice, segmentMemberCount: segmentMembers.size };
}
