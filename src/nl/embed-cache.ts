/**
 * Per-graph embedding cache.
 *
 * Walks every node, builds a "natural-language summary" of it from its
 * id + labels + properties, embeds that summary via Bedrock, and caches
 * the result keyed by a hash of the graph snapshot. On a subsequent
 * boot against the same graph, the cache is reloaded from disk.
 *
 * The cache file is JSON with a stable schema:
 *
 *   {
 *     "snapshotHash": "abc123...",
 *     "embedModel": "amazon.titan-embed-text-v2:0",
 *     "dimensions": 1024,
 *     "entries": [
 *       { "nodeId": "req:REQ-SI-001", "text": "...", "embedding": [...] }
 *     ]
 *   }
 *
 * Re-embed triggers when ANY of:
 *   - snapshotHash differs (node ids changed or counts changed)
 *   - embedModel differs (operator switched models)
 *   - dimensions differs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { GraphExport, VizNode } from '../types.js';
import type { BedrockClient } from './bedrock.js';

export interface EmbedCacheEntry {
  nodeId: string;
  /** The text that was actually embedded (kept for debugging + UI display). */
  text: string;
  /** 1024-dim L2-normalized vector (Titan-v2 with normalize=true). */
  embedding: number[];
}

export interface EmbedCacheFile {
  snapshotHash: string;
  embedModel: string;
  dimensions: number;
  builtAt: string;
  entries: EmbedCacheEntry[];
}

/**
 * Compute a stable hash of the graph's identity. Sensitive to: node ids,
 * node label set, and node count. Insensitive to: edge changes (we
 * re-rank edges on the fly rather than re-embed), property value churn
 * inside a node (we accept some staleness in exchange for cache hits).
 *
 * Why this granularity: SI build SIG grows by adding new nodes (REQs,
 * features, source files); the value of re-embedding when only an
 * existing node's `bodyMarkdown` got a typo fix is low. New-node changes
 * are the ones that need fresh embeddings.
 */
export function computeSnapshotHash(graph: GraphExport): string {
  const sortedIds = graph.nodes.map((n) => n.id).sort();
  const sortedLabels = graph.nodes
    .map((n) => `${n.id}::${n.labels.slice().sort().join(',')}`)
    .sort();
  const h = createHash('sha256');
  h.update(`count:${graph.nodes.length}\n`);
  h.update(`ids:${sortedIds.join('|')}\n`);
  h.update(`labels:${sortedLabels.join('|')}\n`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Build the natural-language summary text that goes into the embedding.
 * Sensitive to common name + summary + label classes. Trimmed at 4 KB so
 * Titan accepts it without complaint.
 */
export function nodeSummaryText(n: VizNode): string {
  const props = n.properties as Record<string, unknown>;
  const parts: string[] = [];
  // Why: lead with the id so embedding similarity to the id itself works.
  parts.push(`Node: ${n.id}`);
  if (n.labels.length > 0) parts.push(`Labels: ${n.labels.join(', ')}`);
  const name = props['name'] ?? props['title'] ?? props['label'];
  if (typeof name === 'string' && name.length > 0) {
    parts.push(`Name: ${name}`);
  }
  const summary = props['summary'] ?? props['description'];
  if (typeof summary === 'string' && summary.length > 0) {
    parts.push(`Summary: ${summary}`);
  }
  // Pull a few more text-y properties when present.
  for (const key of ['purpose', 'why', 'category', 'categoryGroup', 'title']) {
    if (key === 'title' && parts.some((p) => p.startsWith('Name:'))) continue;
    const v = props[key];
    if (typeof v === 'string' && v.length > 0 && v.length < 500) {
      parts.push(`${key}: ${v}`);
    }
  }
  // bodyMarkdown is the meaty content; truncate to keep tokens reasonable.
  const body = props['bodyMarkdown'];
  if (typeof body === 'string' && body.length > 0) {
    parts.push(`Body: ${body.slice(0, 2000)}`);
  }
  const text = parts.join('\n');
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

/**
 * In-memory embedding store. Holds the loaded cache + (lazily) a flat
 * Float32Array used for fast cosine-similarity searches.
 */
export class EmbedCache {
  private entries: EmbedCacheEntry[] = [];
  private byId = new Map<string, EmbedCacheEntry>();
  private snapshotHash = '';
  private embedModel = '';
  private dimensions = 0;
  private cachePath: string;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
  }

  /**
   * Load from disk if present, otherwise return null so the caller knows
   * to build fresh.
   */
  loadFromDisk(): EmbedCacheFile | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const data = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as EmbedCacheFile;
      this.snapshotHash = data.snapshotHash;
      this.embedModel = data.embedModel;
      this.dimensions = data.dimensions;
      this.entries = data.entries;
      this.byId.clear();
      for (const e of data.entries) this.byId.set(e.nodeId, e);
      return data;
    } catch (err) {
      console.warn(`embed-cache: failed to load ${this.cachePath}: ${err}`);
      return null;
    }
  }

  saveToDisk(): void {
    const file: EmbedCacheFile = {
      snapshotHash: this.snapshotHash,
      embedModel: this.embedModel,
      dimensions: this.dimensions,
      builtAt: new Date().toISOString(),
      entries: this.entries,
    };
    writeFileSync(this.cachePath, JSON.stringify(file, null, 2));
  }

  size(): number {
    return this.entries.length;
  }

  getAll(): EmbedCacheEntry[] {
    return this.entries;
  }

  has(nodeId: string): boolean {
    return this.byId.has(nodeId);
  }

  /**
   * Build (or rebuild) the cache from scratch by embedding every node.
   * The caller is responsible for deciding when to call this — usually
   * when the snapshot hash or embed model changes from what was on disk.
   */
  async build(
    graph: GraphExport,
    bedrock: BedrockClient,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const { embedModel } = bedrock.describe();
    this.snapshotHash = computeSnapshotHash(graph);
    this.embedModel = embedModel;
    this.entries = [];
    this.byId.clear();

    let i = 0;
    for (const node of graph.nodes) {
      const text = nodeSummaryText(node);
      const vec = await bedrock.embed(text);
      this.dimensions = vec.length;
      const entry: EmbedCacheEntry = {
        nodeId: node.id,
        text,
        embedding: Array.from(vec),
      };
      this.entries.push(entry);
      this.byId.set(node.id, entry);
      i++;
      if (onProgress) onProgress(i, graph.nodes.length);
    }
  }

  /**
   * Return whether the cache on disk matches the current graph + model.
   * If not, the caller should call `build()` and `saveToDisk()`.
   */
  isStale(graph: GraphExport, currentEmbedModel: string): boolean {
    const expectedHash = computeSnapshotHash(graph);
    return (
      this.snapshotHash !== expectedHash || this.embedModel !== currentEmbedModel
    );
  }

  /**
   * Top-K nearest entries to a query embedding by cosine similarity.
   * Both inputs are assumed L2-normalized (Titan-v2 with normalize=true),
   * so cosine reduces to a dot product.
   */
  searchByEmbedding(
    queryEmbedding: Float32Array,
    k = 30,
  ): Array<{ nodeId: string; score: number; text: string }> {
    const results: Array<{ nodeId: string; score: number; text: string }> = [];
    for (const e of this.entries) {
      let dot = 0;
      const v = e.embedding;
      const n = Math.min(v.length, queryEmbedding.length);
      for (let i = 0; i < n; i++) {
        dot += v[i]! * queryEmbedding[i]!;
      }
      results.push({ nodeId: e.nodeId, score: dot, text: e.text });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }
}
