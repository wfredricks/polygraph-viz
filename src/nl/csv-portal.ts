/**
 * csv-portal.ts — CSV download + additive-upsert merge.
 *
 * Two-way CSV interface for the build SIG:
 *
 *   Download: GET /api/csv/list -> lists the 7 CSVs
 *             GET /api/csv/:name -> generates the CSV from live graph
 *                                     state (no stale files)
 *
 *   Upload:   POST /api/csv/merge -> preview (counts only, no writes)
 *             POST /api/csv/merge/apply -> applies the preview
 *
 * Protocol A — additive-only upsert. Rows in the uploaded CSV are
 * created-if-new and updated-if-exists. Rows missing from the upload
 * are LEFT ALONE (no deletes). Future v0.4+ adds an optional `_action`
 * column for tombstone-style deletes when the use case shows up.
 *
 * Idempotency: every write goes through a query-then-create guard so
 * re-uploading the same CSV produces no duplicate edges. This also
 * fixes the v0.3.5 IMPLEMENTS_INTENT_OF doubling bug that surfaced
 * when load-fillin was run twice.
 */

import type { GraphExport, VizNode, VizEdge } from '../types.js';

// ── Schema registry ──────────────────────────────────────────────

/**
 * Each CSV that the portal supports. The `name` is the URL slug
 * (`/api/csv/dom-files` → `dom-files`); the `columns` are the column
 * order in download and the expected column set on upload. `kind`
 * determines whether each row is a node or an edge.
 */
export interface CsvSchema {
  name: string;
  description: string;
  kind: 'node' | 'edge';
  columns: string[];
  /** When kind=node, the label class the rows produce. */
  label?: string;
  /** When kind=edge, the edge type the rows produce. */
  edgeType?: string;
  /** Required columns. Missing => upload rejected. */
  required: string[];
}

export const CSV_SCHEMAS: CsvSchema[] = [
  {
    name: 'dom-files',
    description: 'Source files as sw.file nodes',
    kind: 'node',
    label: 'sw.file',
    columns: ['id', 'path', 'repo', 'language', 'lineCount'],
    required: ['id', 'path', 'repo'],
  },
  {
    name: 'dom-functions',
    description: 'Exported functions as sw.function nodes',
    kind: 'node',
    label: 'sw.function',
    columns: ['id', 'name', 'signature', 'returnType', 'kind', 'isAsync', 'fileId', 'sourceLineStart', 'sourceLineEnd'],
    required: ['id', 'name', 'fileId'],
  },
  {
    name: 'dom-alt-flows',
    description: 'Alternate/error flow branches as sw.alt_flow nodes',
    kind: 'node',
    label: 'sw.alt_flow',
    columns: ['id', 'name', 'condition', 'behavior', 'fnId', 'sourceLineStart', 'sourceLineEnd'],
    required: ['id', 'name', 'fnId'],
  },
  {
    name: 'dom-call-outs',
    description: 'External invocations as sw.call_out nodes',
    kind: 'node',
    label: 'sw.call_out',
    columns: ['id', 'target', 'kind', 'purpose', 'fnId', 'sourceLineStart', 'sourceLineEnd'],
    required: ['id', 'target', 'kind', 'fnId'],
  },
  {
    name: 'biz-extensions',
    description: 'Extension biz items: REQ-SI2-*, UC-SI2-*, FT-SI2-*',
    kind: 'node', // mixed actually; the loader fans rows out by `kind` column
    columns: ['kind', 'id', 'title', 'summary', 'category', 'reqsExercised', 'reqsImplemented', 'ucsInvolved'],
    required: ['kind', 'id', 'title'],
  },
  {
    name: 'function-features',
    description: 'Hand-curated IMPLEMENTS_INTENT_OF edges from functions to features',
    kind: 'edge',
    edgeType: 'IMPLEMENTS_INTENT_OF',
    columns: ['fnId', 'features', 'note'],
    required: ['fnId', 'features'],
  },
  {
    name: 'edges',
    description: 'Generic structural edges: LIVES_IN, DECLARES, HAS_ALT_FLOW, EMITS_CALLOUT, REALIZES_FORM',
    kind: 'edge',
    columns: ['fromId', 'toId', 'type', 'source'],
    required: ['fromId', 'toId', 'type'],
  },
];

export function findSchema(name: string): CsvSchema | null {
  return CSV_SCHEMAS.find((s) => s.name === name) ?? null;
}

// ── CSV emit ────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines: string[] = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Generate the CSV for a given schema name against the current graph
 * snapshot. Returns null if the schema doesn't exist.
 */
export function generateCsv(name: string, graph: GraphExport): string | null {
  const schema = findSchema(name);
  if (!schema) return null;

  if (schema.name === 'dom-files') {
    const rows = graph.nodes
      .filter((n) => n.labels.includes('sw.file'))
      .map((n) => ({
        id: n.id,
        path: n.properties['path'] ?? '',
        repo: n.properties['repo'] ?? '',
        language: n.properties['language'] ?? '',
        lineCount: n.properties['lineCount'] ?? '',
      }));
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'dom-functions') {
    const rows = graph.nodes
      .filter((n) => n.labels.includes('sw.function'))
      .map((n) => ({
        id: n.id,
        name: n.properties['name'] ?? '',
        signature: n.properties['signature'] ?? '',
        returnType: n.properties['returnType'] ?? '',
        kind: n.properties['kind'] ?? '',
        isAsync: n.properties['isAsync'] === true ? 'true' : 'false',
        fileId: n.properties['fileId'] ?? '',
        sourceLineStart: n.properties['sourceLineStart'] ?? '',
        sourceLineEnd: n.properties['sourceLineEnd'] ?? '',
      }));
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'dom-alt-flows') {
    const rows = graph.nodes
      .filter((n) => n.labels.includes('sw.alt_flow'))
      .map((n) => ({
        id: n.id,
        name: n.properties['name'] ?? '',
        condition: n.properties['condition'] ?? '',
        behavior: n.properties['behavior'] ?? '',
        fnId: n.properties['fnId'] ?? '',
        sourceLineStart: n.properties['sourceLineStart'] ?? '',
        sourceLineEnd: n.properties['sourceLineEnd'] ?? '',
      }));
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'dom-call-outs') {
    const rows = graph.nodes
      .filter((n) => n.labels.includes('sw.call_out'))
      .map((n) => ({
        id: n.id,
        target: n.properties['target'] ?? '',
        kind: n.properties['kind'] ?? '',
        purpose: n.properties['purpose'] ?? '',
        fnId: n.properties['fnId'] ?? '',
        sourceLineStart: n.properties['sourceLineStart'] ?? '',
        sourceLineEnd: n.properties['sourceLineEnd'] ?? '',
      }));
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'biz-extensions') {
    // Mixed: REQ / UC / FT nodes that live in the SI2 namespace.
    // (Namespace check is by `namespace` property === 'SI2'.)
    const rows: Array<Record<string, unknown>> = [];
    for (const n of graph.nodes) {
      if (n.properties['namespace'] !== 'SI2') continue;
      const ftId = n.properties['ftId'] as string | undefined;
      const ucId = n.properties['ucId'] as string | undefined;
      const reqId = n.properties['reqId'] as string | undefined;
      if (n.labels.includes('intended_behavior')) {
        rows.push({
          kind: 'req',
          id: reqId ?? n.id,
          title: n.properties['title'] ?? '',
          summary: n.properties['summary'] ?? '',
          category: n.properties['category'] ?? '',
          reqsExercised: '',
          reqsImplemented: '',
          ucsInvolved: '',
        });
      } else if (n.labels.includes('sw.use_case')) {
        // Find exercised REQs via outgoing EXERCISES edges.
        const exercised = graph.edges
          .filter((e) => e.type === 'EXERCISES' && e.fromId === n.id)
          .map((e) => (graph.nodes.find((x) => x.id === e.toId)?.properties['reqId'] as string | undefined))
          .filter((x): x is string => !!x);
        rows.push({
          kind: 'uc',
          id: ucId ?? n.id,
          title: n.properties['title'] ?? '',
          summary: n.properties['summary'] ?? '',
          category: '',
          reqsExercised: exercised.join('|'),
          reqsImplemented: '',
          ucsInvolved: '',
        });
      } else if (n.labels.includes('sw.feature')) {
        const implReqs = graph.edges
          .filter((e) => e.type === 'IMPLEMENTS' && e.fromId === n.id)
          .map((e) => (graph.nodes.find((x) => x.id === e.toId)?.properties['reqId'] as string | undefined))
          .filter((x): x is string => !!x);
        const involvedUcs = graph.edges
          .filter((e) => e.type === 'INVOLVES' && e.fromId === n.id)
          .map((e) => (graph.nodes.find((x) => x.id === e.toId)?.properties['ucId'] as string | undefined))
          .filter((x): x is string => !!x);
        rows.push({
          kind: 'ft',
          id: ftId ?? n.id,
          title: n.properties['title'] ?? '',
          summary: n.properties['summary'] ?? '',
          category: '',
          reqsExercised: '',
          reqsImplemented: implReqs.join('|'),
          ucsInvolved: involvedUcs.join('|'),
        });
      }
    }
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'function-features') {
    // One row per (fnId, features) where features = |-joined list of
    // FT-* ids the function implements.
    const byFn = new Map<string, string[]>();
    for (const e of graph.edges) {
      if (e.type !== 'IMPLEMENTS_INTENT_OF') continue;
      const targetNode = graph.nodes.find((n) => n.id === e.toId);
      if (!targetNode) continue;
      const ftId = (targetNode.properties['ftId'] as string | undefined) ?? '';
      if (!ftId) continue;
      if (!byFn.has(e.fromId)) byFn.set(e.fromId, []);
      const list = byFn.get(e.fromId)!;
      if (!list.includes(ftId)) list.push(ftId);
    }
    const rows = [...byFn.entries()].map(([fnId, features]) => ({
      fnId,
      features: features.join('|'),
      note: '',
    }));
    return buildCsv(schema.columns, rows);
  }

  if (schema.name === 'edges') {
    // Every edge that is not one of the more specific types covered by
    // other CSVs (we exclude IMPLEMENTS / INVOLVES / EXERCISES /
    // IMPLEMENTS_INTENT_OF since they live in their own CSVs).
    const excluded = new Set([
      'IMPLEMENTS_INTENT_OF',
      'IMPLEMENTS',
      'INVOLVES',
      'EXERCISES',
    ]);
    const rows = graph.edges
      .filter((e) => !excluded.has(e.type))
      .map((e) => ({
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        source: e.properties?.['source'] ?? '',
      }));
    return buildCsv(schema.columns, rows);
  }

  return null;
}

// ── CSV parse ────────────────────────────────────────────────────

export interface CsvRow {
  [column: string]: string;
}

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    if (raw.startsWith('#')) continue;
    lines.push(raw);
  }
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]!);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    if (fields.length === 0) continue;
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = fields[c] ?? '';
    }
    rows.push(row);
  }
  return { header, rows };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    let value = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          value += line[i];
          i++;
        }
      }
    } else {
      while (i < line.length && line[i] !== ',') {
        value += line[i];
        i++;
      }
    }
    fields.push(value);
    if (line[i] === ',') i++;
  }
  return fields;
}

// ── Merge preview ───────────────────────────────────────────────

export interface MergePreview {
  csvName: string;
  schemaOk: boolean;
  schemaError?: string;
  nodesToCreate: number;
  nodesToUpdate: number;
  edgesToCreate: number;
  edgesAlreadyExist: number;
  warnings: string[];
  /** Token to pass to /apply. Holds the parsed rows server-side. */
  token: string;
}

/** Module-level cache of pending merges keyed by token. TTL 10 min. */
const PENDING = new Map<string, { csvName: string; parsedRows: CsvRow[]; createdAt: number }>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of PENDING.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) PENDING.delete(k);
  }
}

function genToken(): string {
  return `merge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Validate a parsed CSV against its schema. Returns null on success, an
 * error string on failure.
 */
function validateAgainstSchema(
  schema: CsvSchema,
  header: string[],
): string | null {
  const headerSet = new Set(header);
  const missing = schema.required.filter((c) => !headerSet.has(c));
  if (missing.length > 0) {
    return `CSV missing required columns: ${missing.join(', ')}. Expected: ${schema.columns.join(', ')}`;
  }
  return null;
}

/**
 * Preview a merge: count rows that would be created vs updated, no
 * mutations. Stash the parsed CSV under a token so /apply can complete
 * without re-uploading.
 */
export function previewMerge(
  csvName: string,
  csvText: string,
  graph: GraphExport,
): MergePreview {
  pruneExpired();
  const schema = findSchema(csvName);
  if (!schema) {
    return {
      csvName,
      schemaOk: false,
      schemaError: `Unknown CSV name: ${csvName}`,
      nodesToCreate: 0,
      nodesToUpdate: 0,
      edgesToCreate: 0,
      edgesAlreadyExist: 0,
      warnings: [],
      token: '',
    };
  }
  const parsed = parseCsv(csvText);
  const err = validateAgainstSchema(schema, parsed.header);
  if (err) {
    return {
      csvName,
      schemaOk: false,
      schemaError: err,
      nodesToCreate: 0,
      nodesToUpdate: 0,
      edgesToCreate: 0,
      edgesAlreadyExist: 0,
      warnings: [],
      token: '',
    };
  }

  const nodeIdSet = new Set(graph.nodes.map((n) => n.id));
  const edgeKey = (e: VizEdge): string => `${e.fromId}|${e.type}|${e.toId}`;
  const edgeSet = new Set(graph.edges.map(edgeKey));

  let nodesToCreate = 0,
    nodesToUpdate = 0,
    edgesToCreate = 0,
    edgesAlreadyExist = 0;
  const warnings: string[] = [];

  for (const row of parsed.rows) {
    if (schema.kind === 'node') {
      if (schema.name === 'biz-extensions') {
        // The biz-extensions CSV mixes node kinds plus implicit edges.
        const kind = row['kind'];
        const id = row['id'] ?? '';
        if (!kind || !id) {
          warnings.push(`row missing kind/id: ${JSON.stringify(row)}`);
          continue;
        }
        const nodeId =
          kind === 'req' ? `req:${id}` : kind === 'uc' ? `uc:${id}` : `ft:${id}`;
        if (nodeIdSet.has(nodeId)) nodesToUpdate++;
        else nodesToCreate++;
        // Implicit edges from this row.
        const edgeFields = ['reqsExercised', 'reqsImplemented', 'ucsInvolved'];
        for (const ef of edgeFields) {
          const vals = (row[ef] ?? '').split('|').map((v) => v.trim()).filter(Boolean);
          for (const v of vals) {
            let edge: VizEdge;
            if (ef === 'reqsExercised') {
              edge = { id: '', type: 'EXERCISES', fromId: nodeId, toId: `req:${v}`, properties: {} };
            } else if (ef === 'reqsImplemented') {
              edge = { id: '', type: 'IMPLEMENTS', fromId: nodeId, toId: `req:${v}`, properties: {} };
            } else {
              edge = { id: '', type: 'INVOLVES', fromId: nodeId, toId: `uc:${v}`, properties: {} };
            }
            if (edgeSet.has(edgeKey(edge))) edgesAlreadyExist++;
            else edgesToCreate++;
          }
        }
      } else {
        // Plain node row.
        const id = row['id'] ?? '';
        if (!id) {
          warnings.push(`row missing id: ${JSON.stringify(row)}`);
          continue;
        }
        if (nodeIdSet.has(id)) nodesToUpdate++;
        else nodesToCreate++;
      }
    } else if (schema.kind === 'edge') {
      if (schema.name === 'function-features') {
        const fnId = row['fnId'] ?? '';
        const features = (row['features'] ?? '').split('|').map((s) => s.trim()).filter(Boolean);
        if (!fnId || features.length === 0) {
          warnings.push(`function-features row needs fnId and features: ${JSON.stringify(row)}`);
          continue;
        }
        if (!nodeIdSet.has(fnId)) {
          warnings.push(`function-features: fnId ${fnId} not in graph`);
          continue;
        }
        for (const ft of features) {
          const featureNodeId = `ft:${ft}`;
          if (!nodeIdSet.has(featureNodeId)) {
            warnings.push(`function-features: feature ${ft} not in graph (skipping edge from ${fnId})`);
            continue;
          }
          const edge: VizEdge = {
            id: '',
            type: 'IMPLEMENTS_INTENT_OF',
            fromId: fnId,
            toId: featureNodeId,
            properties: {},
          };
          if (edgeSet.has(edgeKey(edge))) edgesAlreadyExist++;
          else edgesToCreate++;
        }
      } else {
        // Plain edge row.
        const fromId = row['fromId'] ?? '';
        const toId = row['toId'] ?? '';
        const type = row['type'] ?? '';
        if (!fromId || !toId || !type) {
          warnings.push(`edge row needs fromId+toId+type: ${JSON.stringify(row)}`);
          continue;
        }
        if (!nodeIdSet.has(fromId)) warnings.push(`edge fromId ${fromId} not in graph`);
        if (!nodeIdSet.has(toId)) warnings.push(`edge toId ${toId} not in graph`);
        if (edgeSet.has(`${fromId}|${type}|${toId}`)) edgesAlreadyExist++;
        else edgesToCreate++;
      }
    }
  }

  const token = genToken();
  PENDING.set(token, { csvName, parsedRows: parsed.rows, createdAt: Date.now() });

  return {
    csvName,
    schemaOk: true,
    nodesToCreate,
    nodesToUpdate,
    edgesToCreate,
    edgesAlreadyExist,
    warnings,
    token,
  };
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  csvName: string;
  nodesCreated: number;
  nodesUpdated: number;
  edgesCreated: number;
  edgesSkipped: number;
  warnings: string[];
}

/**
 * Apply the merge captured under `token` against the supplied PolyGraph
 * adapter. The caller passes upsertNode + upsertEdge functions so this
 * module stays free of polygraph-db imports (which only the server
 * runtime side has).
 */
export async function applyMerge(
  token: string,
  upsertNode: (id: string, labels: string[], properties: Record<string, unknown>) => Promise<'created' | 'updated'>,
  upsertEdge: (fromId: string, toId: string, type: string, properties: Record<string, unknown>) => Promise<'created' | 'existed'>,
): Promise<ApplyResult> {
  pruneExpired();
  const pending = PENDING.get(token);
  if (!pending) {
    return {
      ok: false,
      error: 'unknown or expired merge token',
      csvName: '',
      nodesCreated: 0,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      warnings: [],
    };
  }
  PENDING.delete(token); // single-use

  const schema = findSchema(pending.csvName);
  if (!schema) {
    return {
      ok: false,
      error: `schema disappeared: ${pending.csvName}`,
      csvName: pending.csvName,
      nodesCreated: 0,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesSkipped: 0,
      warnings: [],
    };
  }

  let nodesCreated = 0,
    nodesUpdated = 0,
    edgesCreated = 0,
    edgesSkipped = 0;
  const warnings: string[] = [];

  for (const row of pending.parsedRows) {
    try {
      if (schema.kind === 'node') {
        if (schema.name === 'biz-extensions') {
          const kind = row['kind'];
          const id = row['id'] ?? '';
          if (!kind || !id) continue;
          const nodeId =
            kind === 'req' ? `req:${id}` : kind === 'uc' ? `uc:${id}` : `ft:${id}`;
          const label =
            kind === 'req' ? 'intended_behavior' : kind === 'uc' ? 'sw.use_case' : 'sw.feature';
          const props: Record<string, unknown> = {
            id: nodeId,
            name: id,
            title: row['title'] ?? '',
            summary: row['summary'] ?? '',
            namespace: 'SI2',
            tier: kind === 'req' ? 1 : 2,
            domain: kind === 'req' ? undefined : 'sw',
            sourceFile: 'csv-portal upload',
          };
          if (kind === 'req') props['reqId'] = id;
          if (kind === 'uc') props['ucId'] = id;
          if (kind === 'ft') props['ftId'] = id;
          if (row['category']) props['category'] = row['category'];
          const result = await upsertNode(nodeId, [label, 'BuildSIG'], props);
          if (result === 'created') nodesCreated++;
          else nodesUpdated++;
          // Edges from this row.
          for (const f of [
            { col: 'reqsExercised', type: 'EXERCISES', prefix: 'req:' },
            { col: 'reqsImplemented', type: 'IMPLEMENTS', prefix: 'req:' },
            { col: 'ucsInvolved', type: 'INVOLVES', prefix: 'uc:' },
          ]) {
            const vals = (row[f.col] ?? '').split('|').map((v) => v.trim()).filter(Boolean);
            for (const v of vals) {
              const res = await upsertEdge(nodeId, `${f.prefix}${v}`, f.type, {
                source: 'csv-portal:biz-extensions',
              });
              if (res === 'created') edgesCreated++;
              else edgesSkipped++;
            }
          }
        } else {
          const id = row['id'] ?? '';
          if (!id || !schema.label) continue;
          const props: Record<string, unknown> = { id, tier: 2, domain: 'sw' };
          for (const c of schema.columns) {
            if (c === 'id') continue;
            const v = row[c];
            if (v === undefined || v === '') continue;
            if (c === 'lineCount' || c.startsWith('sourceLine')) {
              const n = parseInt(v, 10);
              if (!isNaN(n)) props[c] = n;
            } else if (c === 'isAsync') {
              props[c] = v === 'true';
            } else {
              props[c] = v;
            }
          }
          // sw.file uses path as the human name; sw.function uses name; etc.
          if (!props['name']) {
            props['name'] = row['name'] ?? row['path'] ?? row['target'] ?? id;
          }
          const result = await upsertNode(id, [schema.label, 'BuildSIG'], props);
          if (result === 'created') nodesCreated++;
          else nodesUpdated++;
        }
      } else if (schema.kind === 'edge') {
        if (schema.name === 'function-features') {
          const fnId = row['fnId'] ?? '';
          const features = (row['features'] ?? '').split('|').map((s) => s.trim()).filter(Boolean);
          for (const ft of features) {
            const res = await upsertEdge(fnId, `ft:${ft}`, 'IMPLEMENTS_INTENT_OF', {
              source: 'csv-portal:function-features',
              note: row['note'] ?? '',
            });
            if (res === 'created') edgesCreated++;
            else edgesSkipped++;
          }
        } else {
          const fromId = row['fromId'] ?? '';
          const toId = row['toId'] ?? '';
          const type = row['type'] ?? '';
          if (!fromId || !toId || !type) continue;
          const res = await upsertEdge(fromId, toId, type, {
            source: row['source'] ?? 'csv-portal:edges',
          });
          if (res === 'created') edgesCreated++;
          else edgesSkipped++;
        }
      }
    } catch (err) {
      warnings.push(`row failed: ${(err as Error).message?.slice(0, 100) ?? String(err)}`);
    }
  }

  return {
    ok: true,
    csvName: pending.csvName,
    nodesCreated,
    nodesUpdated,
    edgesCreated,
    edgesSkipped,
    warnings,
  };
}
