/**
 * Lexicon — per-domain term expansion.
 *
 * Honors the indirection chain pattern from sig-mcp (2026-03-25):
 *   common-language query → lexicon expansion → embed → graph
 *
 * When the user types "auth handler", the lexicon expands the query to
 * "auth handler authentication identity bangauth session token" before
 * embedding. The richer query makes the embedding land closer to the
 * actual graph content.
 *
 * Lexicons are JSON files keyed by Tier-2 domain prefix. When the
 * server boots and sees a graph whose nodes have `sw.*` labels, it
 * picks the `sw` lexicon (if any). A graph with `ba.*` labels picks
 * `ba`. A user can supply --lexicon <path> to override entirely.
 *
 * The default lexicons that ship with polygraph-viz are intentionally
 * EMPTY — every Tier-2 domain has different jargon; we don't ship
 * opinions. Operators add terms as the graph matures.
 *
 * Format:
 *   {
 *     "version": 1,
 *     "domain": "sw",
 *     "entries": [
 *       { "term": "auth", "expansions": ["authentication", "identity", "bangauth"] }
 *     ]
 *   }
 */

import { readFileSync, existsSync } from 'node:fs';
import type { GraphExport } from '../types.js';

export interface LexiconEntry {
  term: string;
  expansions: string[];
}

export interface LexiconFile {
  version: number;
  domain: string;
  entries: LexiconEntry[];
}

export class Lexicon {
  private byTerm = new Map<string, string[]>();
  public readonly domain: string;
  public readonly size: number;

  constructor(file: LexiconFile | null) {
    this.domain = file?.domain ?? '';
    for (const e of file?.entries ?? []) {
      this.byTerm.set(e.term.toLowerCase(), e.expansions);
    }
    this.size = this.byTerm.size;
  }

  /**
   * Expand the query by appending lexicon expansions for any terms
   * found. Original query stays first so the embedder still treats it
   * as the primary signal.
   */
  expand(query: string): string {
    if (this.size === 0) return query;
    const lower = query.toLowerCase();
    const matched: string[] = [];
    for (const [term, expansions] of this.byTerm) {
      if (lower.includes(term)) {
        matched.push(...expansions);
      }
    }
    if (matched.length === 0) return query;
    return `${query} ${matched.join(' ')}`;
  }
}

/**
 * Resolve which lexicon to load, in this order:
 *   1. Explicit --lexicon <path> from VizConfig (overrides everything)
 *   2. The default lexicon for the dominant Tier-2 domain in the graph
 *   3. An empty lexicon (no-op expansion)
 */
export function loadLexicon(
  graph: GraphExport,
  explicitPath?: string,
): Lexicon {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      console.warn(`lexicon: --lexicon path not found: ${explicitPath}`);
      return new Lexicon(null);
    }
    try {
      const file = JSON.parse(readFileSync(explicitPath, 'utf-8')) as LexiconFile;
      console.log(`  📖 lexicon loaded: ${file.entries.length} entries (${file.domain}, ${explicitPath})`);
      return new Lexicon(file);
    } catch (err) {
      console.warn(`lexicon: failed to parse ${explicitPath}: ${err}`);
      return new Lexicon(null);
    }
  }

  // Auto-pick by Tier-2 domain.
  const domainCounts: Record<string, number> = {};
  for (const n of graph.nodes) {
    for (const l of n.labels) {
      const dot = l.indexOf('.');
      if (dot > 0) {
        const dom = l.slice(0, dot);
        domainCounts[dom] = (domainCounts[dom] ?? 0) + 1;
      }
    }
  }
  const dominantDomain = Object.entries(domainCounts).sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  if (!dominantDomain) {
    return new Lexicon(null);
  }

  // Built-in defaults ship empty; operators override via --lexicon.
  // Once SI has real jargon in production (e.g. customer engagements
  // use acronyms specific to their domain), they can land here.
  return new Lexicon({
    version: 1,
    domain: dominantDomain,
    entries: [],
  });
}
