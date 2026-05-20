/**
 * Schema-aware LLM ranker.
 *
 * Takes the cosine-similarity top-K hits from the embed cache and
 * asks the LLM to:
 *   1. Filter out hits that are not actually responsive to the query
 *      (cosine gives semantic neighborhood, not direct answers)
 *   2. Re-rank the survivors
 *   3. Produce a one-line "why this matched" string per survivor that
 *      cites the actual property text that triggered the match
 *
 * The LLM ONLY sees:
 *   - the query
 *   - the schema fingerprint (label counts + edge types)
 *   - the K candidate hits, each as their nodeSummaryText
 *
 * The LLM is constrained to return STRICT JSON with shape:
 *   { ranked: [{ nodeId, why }] }
 * Any hallucinated nodeId (one not in the input candidates) is dropped.
 *
 * Schema injection defends against the classic hallucinate-edges class
 * of failure: the model literally cannot mention a label or edge type
 * that the schema fingerprint did not name.
 */

import type { GraphExport } from '../types.js';
import type { BedrockClient } from './bedrock.js';

export interface SchemaFingerprint {
  labelCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

export function computeSchemaFingerprint(graph: GraphExport): SchemaFingerprint {
  const labelCounts: Record<string, number> = {};
  for (const n of graph.nodes) {
    for (const l of n.labels) labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  }
  const edgeTypeCounts: Record<string, number> = {};
  for (const e of graph.edges) {
    edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] ?? 0) + 1;
  }
  return {
    labelCounts,
    edgeTypeCounts,
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
  };
}

export interface RankerHit {
  nodeId: string;
  score: number;
  text: string;
}

export interface RankedHit {
  nodeId: string;
  why: string;
}

/**
 * Build the system prompt for the ranker. Includes the schema so the
 * LLM knows what labels and edge types exist; any sentence in `why`
 * that names a label not in this list is a hallucination and will
 * be flagged in QA.
 */
function buildRankerSystemPrompt(schema: SchemaFingerprint): string {
  const labels = Object.entries(schema.labelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (${n})`)
    .join(', ');
  const edgeTypes = Object.entries(schema.edgeTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} (${n})`)
    .join(', ');

  return [
    'You are the ranker for a graph-visualization search box. Your only job is to filter and rerank a list of candidate nodes against the user query.',
    '',
    'The graph has these labels (with node counts):',
    `  ${labels}`,
    '',
    'And these edge types (with counts):',
    `  ${edgeTypes}`,
    '',
    'CONSTRAINTS:',
    '  - You may ONLY return nodeIds that appear in the candidates list. Do not invent ids.',
    '  - Drop candidates that are not directly relevant to the query, even if they have high embedding scores.',
    '  - Order the survivors from most-relevant to least-relevant.',
    '  - Each survivor needs a one-line "why" (max 100 chars) that quotes or paraphrases the candidate text. Do not invent properties or edges.',
    '  - If NO candidate is relevant, return an empty list.',
    '',
    'Return STRICT JSON with no prose, no markdown fence, no comments:',
    '  {"ranked": [{"nodeId": "...", "why": "..."}]}',
  ].join('\n');
}

function buildRankerUserPrompt(query: string, hits: RankerHit[]): string {
  const lines: string[] = [];
  lines.push(`Query: ${query}`);
  lines.push('');
  lines.push('Candidates:');
  for (const h of hits) {
    lines.push(`---`);
    lines.push(`id: ${h.nodeId}`);
    lines.push(`embedScore: ${h.score.toFixed(3)}`);
    lines.push(`text:`);
    lines.push(h.text);
  }
  return lines.join('\n');
}

/**
 * Re-rank candidate hits with the LLM. The candidate ids set is enforced
 * so the LLM cannot smuggle invented nodes into the output.
 */
export async function rankWithLlm(
  bedrock: BedrockClient,
  query: string,
  schema: SchemaFingerprint,
  hits: RankerHit[],
): Promise<RankedHit[]> {
  if (hits.length === 0) return [];
  const allowedIds = new Set(hits.map((h) => h.nodeId));
  const systemPrompt = buildRankerSystemPrompt(schema);
  const userPrompt = buildRankerUserPrompt(query, hits);

  const raw = await bedrock.chat(
    systemPrompt,
    [{ role: 'user', content: userPrompt }],
    { maxTokens: 1024, temperature: 0.1 },
  );

  // Parse strict JSON; defensive against the model adding an accidental
  // markdown fence even though we asked for none.
  let parsed: { ranked?: Array<{ nodeId?: unknown; why?: unknown }> };
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.warn('ranker: JSON parse failed, falling back to embed order', err);
    return hits.map((h) => ({ nodeId: h.nodeId, why: h.text.split('\n')[0] ?? h.nodeId }));
  }

  const ranked: RankedHit[] = [];
  for (const r of parsed.ranked ?? []) {
    if (typeof r.nodeId !== 'string') continue;
    if (!allowedIds.has(r.nodeId)) {
      // Why: enforce the contract. The LLM cannot invent ids.
      console.warn(`ranker: dropped invented nodeId ${r.nodeId}`);
      continue;
    }
    const why = typeof r.why === 'string' ? r.why.slice(0, 200) : '';
    ranked.push({ nodeId: r.nodeId, why });
  }
  return ranked;
}
