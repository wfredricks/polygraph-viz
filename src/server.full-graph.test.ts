/**
 * Tests for the --full-graph-path / meta-area drill-down feature.
 *
 * Covers:
 *   1. AREA_SLUG_PATTERNS — every area has at least one pattern
 *   2. matchesDomainNode  — sw.feature, data.table, sw.business_object matching
 *   3. /api/neighbors/:nodeId
 *      a. meta.area node WITH full graph → returns domain nodes from full graph
 *      b. meta.area node WITHOUT full graph → returns primary graph neighbors
 *      c. non-meta.area node (e.g. meta.layer) → returns primary graph neighbors
 *      d. node not found → 404
 */

import { describe, it, expect } from 'vitest';
import { buildApp, AREA_SLUG_PATTERNS, matchesDomainNode } from './server.js';
import type { GraphExport, VizNode } from './types.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

/** Minimal meta-graph with one meta.area and one meta.layer node. */
function makeMetaGraph(): GraphExport {
  return {
    nodes: [
      {
        id: 'area.customer-orders',
        labels: ['meta.area'],
        properties: { name: 'Customer Orders' },
      },
      {
        id: 'layer.business',
        labels: ['meta.layer'],
        properties: { name: 'Business Layer' },
      },
    ],
    edges: [
      {
        id: 'e-layer-area',
        type: 'CONTAINS_AREA',
        fromId: 'layer.business',
        toId: 'area.customer-orders',
        properties: {},
      },
    ],
    metadata: {
      source: 'test',
      nodeCount: 2,
      edgeCount: 1,
      exportedAt: new Date().toISOString(),
    },
  };
}

/** Minimal full graph with features, tables, and BOs. */
function makeFullGraph(): GraphExport {
  return {
    nodes: [
      // Matches area.customer-orders via sw.feature → segment
      {
        id: 'feat-co-001',
        labels: ['sw.feature'],
        properties: { segment: 'customer-order', name: 'PlaceOrder' },
      },
      {
        id: 'feat-co-002',
        labels: ['sw.feature'],
        properties: { segment: 'redo-customer-order', name: 'RedoPlaceOrder' },
      },
      // Matches area.customer-orders via data.table → JSON segments array
      {
        id: 'tbl-co-001',
        labels: ['data.table'],
        properties: { segments: '["customer-order","shared"]', name: 'ORDER_HDR' },
      },
      // Does NOT match — different area
      {
        id: 'feat-admin-001',
        labels: ['sw.feature'],
        properties: { segment: 'biz-admin', name: 'AdminConfig' },
      },
      // Matches area.customer-orders via sw.business_object → segments string
      {
        id: 'bo-co-001',
        labels: ['sw.business_object'],
        properties: { segments: 'customer-order', name: 'CustomerOrderBO' },
      },
      // Unrelated — not a domain node type we care about
      {
        id: 'dom-entity-001',
        labels: ['dom.entity'],
        properties: { name: 'OrderEntity' },
      },
    ],
    edges: [
      // Edge between two co nodes — should be included in drill-down result
      {
        id: 'e-feat-bo',
        type: 'IMPLEMENTS',
        fromId: 'feat-co-001',
        toId: 'bo-co-001',
        properties: {},
      },
      // Edge crossing areas — fromId matches, toId doesn't → excluded
      {
        id: 'e-cross',
        type: 'USES',
        fromId: 'feat-co-001',
        toId: 'feat-admin-001',
        properties: {},
      },
    ],
    metadata: {
      source: 'test-full',
      nodeCount: 6,
      edgeCount: 2,
      exportedAt: new Date().toISOString(),
    },
  };
}

// ── AREA_SLUG_PATTERNS ─────────────────────────────────────────────────────────

describe('AREA_SLUG_PATTERNS', () => {
  it('covers all 13 expected area ids', () => {
    const expectedAreas = [
      'area.customer-orders',
      'area.customer-receipts',
      'area.customer-catalog',
      'area.customer-bizlogic',
      'area.customer-other',
      'area.account-mgmt',
      'area.admin',
      'area.catalog-mgmt',
      'area.reports',
      'area.batch',
      'area.trading-partner',
      'area.audit-recon',
      'area.other',
    ];
    for (const area of expectedAreas) {
      expect(AREA_SLUG_PATTERNS).toHaveProperty(area);
      expect(AREA_SLUG_PATTERNS[area].length).toBeGreaterThan(0);
    }
  });

  it('area.batch matches batch- slug', () => {
    const patterns = AREA_SLUG_PATTERNS['area.batch'];
    expect(patterns.some((p) => p.test('batch-nightly'))).toBe(true);
    expect(patterns.some((p) => p.test('biz-admin'))).toBe(false);
  });

  it('area.account-mgmt matches acct- prefix only at start', () => {
    const patterns = AREA_SLUG_PATTERNS['area.account-mgmt'];
    expect(patterns.some((p) => p.test('acct-mgmt'))).toBe(true);
    expect(patterns.some((p) => p.test('not-acct-mgmt'))).toBe(false);
  });
});

// ── matchesDomainNode ──────────────────────────────────────────────────────────

describe('matchesDomainNode', () => {
  const patterns = AREA_SLUG_PATTERNS['area.customer-orders']!;

  it('matches sw.feature by segment property', () => {
    const node: VizNode = {
      id: 'f1',
      labels: ['sw.feature'],
      properties: { segment: 'customer-order' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(true);
  });

  it('does NOT match sw.feature with wrong segment', () => {
    const node: VizNode = {
      id: 'f2',
      labels: ['sw.feature'],
      properties: { segment: 'biz-admin' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });

  it('does NOT match sw.feature with empty segment', () => {
    const node: VizNode = {
      id: 'f3',
      labels: ['sw.feature'],
      properties: { segment: '' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });

  it('matches data.table by first element of segments JSON array', () => {
    const node: VizNode = {
      id: 't1',
      labels: ['data.table'],
      properties: { segments: '["customer-order","other"]' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(true);
  });

  it('does NOT match data.table with empty segments array', () => {
    const node: VizNode = {
      id: 't2',
      labels: ['data.table'],
      properties: { segments: '[]' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });

  it('does NOT match data.table with malformed segments JSON', () => {
    const node: VizNode = {
      id: 't3',
      labels: ['data.table'],
      properties: { segments: 'not-json' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });

  it('matches sw.business_object by segments string', () => {
    const node: VizNode = {
      id: 'bo1',
      labels: ['sw.business_object'],
      properties: { segments: 'customer-order' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(true);
  });

  it('does NOT match sw.business_object with wrong segments', () => {
    const node: VizNode = {
      id: 'bo2',
      labels: ['sw.business_object'],
      properties: { segments: 'biz-admin' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });

  it('does NOT match unrecognized label', () => {
    const node: VizNode = {
      id: 'e1',
      labels: ['dom.entity'],
      properties: { name: 'Customer' },
    };
    expect(matchesDomainNode(node, patterns)).toBe(false);
  });
});

// ── /api/neighbors/:nodeId ─────────────────────────────────────────────────────

describe('GET /api/neighbors/:nodeId', () => {
  const metaGraph = makeMetaGraph();
  const fullGraph = makeFullGraph();

  it('meta.area with full graph → returns domain nodes from full graph', async () => {
    const app = buildApp(metaGraph, { fullGraphData: fullGraph });
    const res = await app.fetch(new Request('http://localhost/api/neighbors/area.customer-orders'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { nodeId: string; nodes: VizNode[]; edges: unknown[] };
    expect(body.nodeId).toBe('area.customer-orders');

    // Should contain the 3 matching domain nodes (2 features + 1 table + 1 BO = 4 actually)
    const nodeIds = body.nodes.map((n) => n.id);
    expect(nodeIds).toContain('feat-co-001');
    expect(nodeIds).toContain('feat-co-002');
    expect(nodeIds).toContain('tbl-co-001');
    expect(nodeIds).toContain('bo-co-001');

    // Should NOT contain non-matching domain nodes
    expect(nodeIds).not.toContain('feat-admin-001');
    expect(nodeIds).not.toContain('dom-entity-001');

    // Edge between co nodes should be included; cross-area edge excluded
    const edgeIds = (body.edges as { id: string }[]).map((e) => e.id);
    expect(edgeIds).toContain('e-feat-bo');
    expect(edgeIds).not.toContain('e-cross');
  });

  it('meta.area WITHOUT full graph → falls back to primary graph neighbors', async () => {
    const app = buildApp(metaGraph, { fullGraphData: null });
    const res = await app.fetch(new Request('http://localhost/api/neighbors/area.customer-orders'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { nodeId: string; nodes: VizNode[] };
    // Only the primary graph neighbors — the meta.layer node that points to this area
    const nodeIds = body.nodes.map((n) => n.id);
    expect(nodeIds).toContain('area.customer-orders'); // origin
    expect(nodeIds).toContain('layer.business');       // 1-hop neighbor
    // No domain nodes (full graph not loaded)
    expect(nodeIds).not.toContain('feat-co-001');
  });

  it('meta.layer node (non-meta.area) → returns primary graph neighbors even with full graph', async () => {
    const app = buildApp(metaGraph, { fullGraphData: fullGraph });
    const res = await app.fetch(new Request('http://localhost/api/neighbors/layer.business'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { nodeId: string; nodes: VizNode[] };
    const nodeIds = body.nodes.map((n) => n.id);
    expect(nodeIds).toContain('layer.business');        // origin
    expect(nodeIds).toContain('area.customer-orders');  // 1-hop neighbor
    // No domain nodes (layer.business is not meta.area)
    expect(nodeIds).not.toContain('feat-co-001');
  });

  it('unknown node → 404', async () => {
    const app = buildApp(metaGraph, { fullGraphData: fullGraph });
    const res = await app.fetch(new Request('http://localhost/api/neighbors/does-not-exist'));
    expect(res.status).toBe(404);
  });
});
