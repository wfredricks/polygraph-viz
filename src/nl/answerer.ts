/**
 * Chat answerer — graph-walking narrative.
 *
 * Honors the 2026-05-12 insight: "the narrative writes itself by walking
 * the graph." Steps:
 *
 *   1. Cosine-retrieve candidate nodes (lexicon-expanded query).
 *   2. LLM-rerank survivors (filter + 'why this matched').
 *   3. Walk the graph one hop out from each survivor to collect
 *      adjacent context (nodes their edges point to/from + the edge
 *      types). Pack into the narrative prompt.
 *   4. Include the conversation history + any KB matches.
 *   5. Stream the narrative answer with inline node-id citations.
 *
 * The LLM gets the schema fingerprint so it cannot hallucinate edge
 * types. It sees a structured snapshot of the relevant subgraph, not
 * the whole graph.
 */

import type { GraphExport, VizNode, VizEdge } from '../types.js';
import type { BedrockClient, ChatMessage } from './bedrock.js';
import type { SchemaFingerprint, RankedHit } from './ranker.js';
import type { KBEntry } from './kb.js';

export interface AnswerContextNode {
  nodeId: string;
  /** Short user-facing code (e.g. 'REQ-SI-070', 'installChat'). The LLM cites by this. */
  code: string;
  labels: string[];
  name: string;
  summary: string;
  /** One-hop adjacency: edges leaving + edges arriving, with their other-endpoint code AND id. */
  outgoing: Array<{ type: string; toId: string; toCode: string }>;
  incoming: Array<{ type: string; fromId: string; fromCode: string }>;
}

/**
 * Build the structured subgraph snapshot the LLM will narrate over.
 * Pulls the ranked-hit nodes plus their one-hop neighbors so the LLM
 * has enough graph context to answer "why" and "what depends on this".
 */
export function buildAnswerContext(
  graph: GraphExport,
  rankedHits: RankedHit[],
  maxNodes = 40,
): AnswerContextNode[] {
  const nodeIndex = new Map(graph.nodes.map((n) => [n.id, n]));
  const focusIds = new Set(rankedHits.map((r) => r.nodeId));
  const includeIds = new Set<string>(focusIds);

  // One-hop expand.
  for (const e of graph.edges) {
    if (focusIds.has(e.fromId)) includeIds.add(e.toId);
    if (focusIds.has(e.toId)) includeIds.add(e.fromId);
  }

  // Cap at maxNodes to keep the prompt manageable.
  const idList = [...includeIds].slice(0, maxNodes);
  const idSet = new Set(idList);

  // Precompute adjacency for just the included subgraph.
  const outgoing = new Map<string, Array<{ type: string; toId: string }>>();
  const incoming = new Map<string, Array<{ type: string; fromId: string }>>();
  for (const id of idList) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of graph.edges) {
    if (idSet.has(e.fromId) && idSet.has(e.toId)) {
      outgoing.get(e.fromId)?.push({ type: e.type, toId: e.toId });
      incoming.get(e.toId)?.push({ type: e.type, fromId: e.fromId });
    }
  }

  // Build a quick code lookup over the full graph (not just the
  // included subset) so adjacency endpoints we never include can still
  // be referenced by code in the prompt.
  const codeById = new Map<string, string>();
  for (const n of graph.nodes) {
    const c = n.properties['code'];
    if (typeof c === 'string' && c.length > 0) codeById.set(n.id, c);
  }
  const codeOrId = (nodeId: string): string => codeById.get(nodeId) ?? nodeId;

  const ctx: AnswerContextNode[] = [];
  for (const id of idList) {
    const node = nodeIndex.get(id);
    if (!node) continue;
    const props = node.properties as Record<string, unknown>;
    const name =
      typeof props['name'] === 'string'
        ? (props['name'] as string)
        : typeof props['title'] === 'string'
          ? (props['title'] as string)
          : id;
    const summary =
      typeof props['summary'] === 'string'
        ? (props['summary'] as string).slice(0, 400)
        : typeof props['description'] === 'string'
          ? (props['description'] as string).slice(0, 400)
          : '';
    ctx.push({
      nodeId: id,
      code: codeOrId(id),
      labels: node.labels,
      name,
      summary,
      outgoing: (outgoing.get(id) ?? []).map((e) => ({
        type: e.type,
        toId: e.toId,
        toCode: codeOrId(e.toId),
      })),
      incoming: (incoming.get(id) ?? []).map((e) => ({
        type: e.type,
        fromId: e.fromId,
        fromCode: codeOrId(e.fromId),
      })),
    });
  }
  return ctx;
}

function buildAnswerSystemPrompt(
  schema: SchemaFingerprint,
  graphTitle: string,
): string {
  const labels = Object.entries(schema.labelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (${n})`)
    .join(', ');
  const edgeTypes = Object.entries(schema.edgeTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} (${n})`)
    .join(', ');

  return [
    `You answer questions about a graph called "${graphTitle}". You will be given:`,
    '  1. The user query (in context of a multi-turn conversation).',
    '  2. A subgraph snapshot: nodes with their labels, summaries, and one-hop edges.',
    '  3. Optionally, prior Save-This entries the user previously accepted as good answers.',
    '',
    `Graph schema you may reference:`,
    `  Labels: ${labels}`,
    `  Edge types: ${edgeTypes}`,
    '',
    'STYLE RULES:',
    '  - Write a tight, evidence-grounded answer (2-5 paragraphs typical, fewer when the query is narrow).',
    '  - EVERY claim must be supported by either a node summary or an edge that appears in the snapshot.',
    '  - Cite nodes inline by their CODE wrapped in backticks (NOT their full id). Examples: `REQ-SI-070`, `FT-SI-09`, `installCommandPalette`, `polygraph-viz`. The snapshot below provides the code for every node — use exactly that string.',
    '  - Cite edges by their type when relevant, e.g. "via DEPENDS_ON" or "via IMPLEMENTS".',
    '  - Do NOT invent ids, labels, edge types, or properties not in the snapshot or the schema.',
    '  - If the snapshot does not contain enough information, say so plainly and suggest what to ask instead.',
    '  - Do not begin with "Based on the snapshot…" — write naturally.',
  ].join('\n');
}

function formatContextForPrompt(ctx: AnswerContextNode[]): string {
  const lines: string[] = ['Subgraph snapshot:', ''];
  for (const n of ctx) {
    // The code is the citation handle. Make it prominent.
    lines.push(`### ${n.code}`);
    lines.push(`(id: ${n.nodeId})`);
    lines.push(`labels: ${n.labels.join(', ')}`);
    if (n.name && n.name !== n.code) lines.push(`name: ${n.name}`);
    if (n.summary) lines.push(`summary: ${n.summary}`);
    if (n.outgoing.length > 0) {
      const formatted = n.outgoing
        .slice(0, 12)
        .map((e) => `--${e.type}--> ${e.toCode}`)
        .join('; ');
      lines.push(`outgoing: ${formatted}${n.outgoing.length > 12 ? ' …' : ''}`);
    }
    if (n.incoming.length > 0) {
      const formatted = n.incoming
        .slice(0, 12)
        .map((e) => `${e.fromCode} --${e.type}-->`)
        .join('; ');
      lines.push(`incoming: ${formatted}${n.incoming.length > 12 ? ' …' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatKBForPrompt(matches: KBEntry[]): string {
  if (matches.length === 0) return '';
  const lines: string[] = ['', 'Relevant Save-This entries from this user:', ''];
  for (const e of matches) {
    lines.push(`- Past query: "${e.query}"`);
    lines.push(`  Past answer (saved as canonical): ${e.answer.slice(0, 400)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build the messages array for the answerer. The current user query is
 * augmented with the subgraph snapshot and any KB matches.
 */
export function buildAnswerMessages(
  query: string,
  history: ChatMessage[],
  ctx: AnswerContextNode[],
  kbMatches: KBEntry[],
): ChatMessage[] {
  const augmented = [
    `User query: ${query}`,
    '',
    formatContextForPrompt(ctx),
    formatKBForPrompt(kbMatches),
  ].join('\n');
  // History gets passed through with the augmented final user message.
  return [...history, { role: 'user', content: augmented }];
}

/**
 * Non-streaming answer. Used by tests and any client that prefers JSON.
 */
export async function answerOnce(
  bedrock: BedrockClient,
  graph: GraphExport,
  schema: SchemaFingerprint,
  graphTitle: string,
  query: string,
  history: ChatMessage[],
  rankedHits: RankedHit[],
  kbMatches: KBEntry[],
): Promise<string> {
  const ctx = buildAnswerContext(graph, rankedHits);
  const systemPrompt = buildAnswerSystemPrompt(schema, graphTitle);
  const messages = buildAnswerMessages(query, history, ctx, kbMatches);
  return bedrock.chat(systemPrompt, messages, {
    maxTokens: 1024,
    temperature: 0.3,
  });
}

/**
 * Streaming answer. Yields token chunks.
 */
export async function* answerStream(
  bedrock: BedrockClient,
  graph: GraphExport,
  schema: SchemaFingerprint,
  graphTitle: string,
  query: string,
  history: ChatMessage[],
  rankedHits: RankedHit[],
  kbMatches: KBEntry[],
): AsyncIterable<string> {
  const ctx = buildAnswerContext(graph, rankedHits);
  const systemPrompt = buildAnswerSystemPrompt(schema, graphTitle);
  const messages = buildAnswerMessages(query, history, ctx, kbMatches);
  yield* bedrock.chatStream(systemPrompt, messages, {
    maxTokens: 1024,
    temperature: 0.3,
  });
}
