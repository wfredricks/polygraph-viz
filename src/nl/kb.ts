/**
 * Knowledge Base — per-graph file-backed JSON store of Save This entries.
 *
 * Honors the sig-mcp pattern (2026-03-25): user clicks "Save This" on an
 * answer; the entry lands here; future queries include matching entries
 * as context for the LLM.
 *
 * Format:
 *   {
 *     "version": 1,
 *     "entries": [
 *       {
 *         "id": "kb_2026-05-20_001",
 *         "createdAt": "2026-05-20T18:45:00.000Z",
 *         "query": "...",
 *         "answer": "...",
 *         "citedNodes": ["req:REQ-SI-070", "ft:FT-SI-10"]
 *       }
 *     ]
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface KBEntry {
  id: string;
  createdAt: string;
  query: string;
  answer: string;
  citedNodes: string[];
}

interface KBFile {
  version: number;
  entries: KBEntry[];
}

export class KnowledgeBase {
  private entries: KBEntry[] = [];
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf-8')) as KBFile;
      this.entries = data.entries ?? [];
    } catch (err) {
      console.warn(`kb: failed to load ${this.path}: ${err}`);
    }
  }

  private save(): void {
    const data: KBFile = { version: 1, entries: this.entries };
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  size(): number {
    return this.entries.length;
  }

  add(entry: Omit<KBEntry, 'id' | 'createdAt'>): KBEntry {
    const full: KBEntry = {
      ...entry,
      id: `kb_${new Date().toISOString().replace(/[:.]/g, '-')}_${this.entries.length + 1}`,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(full);
    this.save();
    return full;
  }

  /**
   * Keyword-overlap search. Cheap, good enough at v0.3 volume.
   * Returns up to `k` entries, ranked by overlapping-word count.
   */
  search(query: string, k = 3): KBEntry[] {
    const qWords = new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    if (qWords.size === 0) return [];
    const scored = this.entries.map((e) => {
      const text = `${e.query} ${e.answer}`.toLowerCase();
      let hits = 0;
      for (const w of qWords) {
        if (text.includes(w)) hits++;
      }
      return { entry: e, score: hits };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.entry);
  }
}
