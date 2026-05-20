/**
 * Segment classifier — biz / dom / imp / meta.
 *
 * Honors Bill's monikers from 2026-05-20 14:53 EDT:
 *   1. The business end (biz) is the end from requirements on down to
 *      features. Contains the business concerns that are mapped/traced to.
 *   2. The domain end (dom) is the end from features on down to functions,
 *      alternative flows, and call outs. The implementation-agnostic part
 *      of the SIG equation.
 *   3. The implementation end (imp) is the end that identifies the
 *      implementation targets (e.g., TypeScript, Service Now, Appian).
 *
 * Architectural note: features straddle biz and dom. Per Bill's framing
 * features are the entry point of the BIZ side ("what we promise" face).
 * The DOM side starts at sw.function, sw.module, sw.endpoint, sw.test.
 *
 * Pure function — no DOM, no graph mutations. Importable from client
 * renderers (filter views) AND from server endpoints (NL query
 * "in the biz segment" routing).
 */

import type { VizNode } from '../types.js';

export type Segment = 'biz' | 'dom' | 'imp' | 'meta';

const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

/** Pick the meaningful label (first non-utility). */
function primaryLabel(labels: string[]): string {
  if (labels.length === 0) return 'Node';
  const meaningful = labels.find((l) => !UTILITY_LABELS.has(l));
  return meaningful ?? labels[0]!;
}

/**
 * Classify a node into one of the four segments.
 *
 * The rule is label-driven (not Tier-property-driven) because Bill's
 * monikers slice features off from Tier-2 — they share Tier with
 * sw.use_case but live in different segments (features = biz, use_cases =
 * also biz here since they describe what the business needs).
 */
export function segmentForNode(node: VizNode): Segment {
  const primary = primaryLabel(node.labels);

  // Tier 3 paradigm-bound labels = implementation segment.
  // Recognized prefixes: cs_ (current C# 2026), sn_ (ServiceNow),
  // next_ (Next.js), appian_ (Appian), java_, py_, etc. The leading
  // pattern is <namespace>_<era>.<element>.
  if (
    primary.startsWith('cs_') ||
    primary.startsWith('sn_') ||
    primary.startsWith('next_') ||
    primary.startsWith('appian_') ||
    primary.startsWith('java_') ||
    primary.startsWith('py_') ||
    primary.startsWith('cobol_')
  ) {
    return 'imp';
  }

  // Business end — requirements, use cases, features, findings, risks.
  switch (primary) {
    case 'intended_behavior':
    case 'constraint':
    case 'evidence':
    case 'finding':
    case 'risk_item':
    case 'sw.use_case':
    case 'sw.feature':
      return 'biz';
  }

  // Domain end — implementation-agnostic shape of HOW things are built.
  // sw.repo + sw.stage capture build planning; sw.function / module /
  // endpoint / test / class / audit_event / workflow capture
  // architectural shape that survives a paradigm rotation.
  switch (primary) {
    case 'sw.repo':
    case 'sw.stage':
    case 'sw.module':
    case 'sw.function':
    case 'sw.class':
    case 'sw.interface':
    case 'sw.type':
    case 'sw.test':
    case 'sw.endpoint':
    case 'sw.cli_command':
    case 'sw.compose_service':
    case 'sw.audit_event':
    case 'sw.workflow':
    case 'sw.dependency_edge':
      return 'dom';
  }

  // Anything we haven't named explicitly defaults to 'meta'.
  return 'meta';
}

/**
 * Tally a graph's segment distribution. Used by the legend, /api/segments,
 * and the /stats command's chat output.
 */
export interface SegmentCounts {
  biz: number;
  dom: number;
  imp: number;
  meta: number;
}

export function tallySegments(nodes: VizNode[]): SegmentCounts {
  const counts: SegmentCounts = { biz: 0, dom: 0, imp: 0, meta: 0 };
  for (const n of nodes) {
    counts[segmentForNode(n)]++;
  }
  return counts;
}
