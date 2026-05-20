/**
 * Slash-command registry + parser.
 *
 * Single source of truth for the 11 v0.3.2 commands. Read by:
 *   - the command palette (dropdown shows names + descriptions)
 *   - the input parsers (toolbar search + chat textarea)
 *   - the /help runner (future v0.3.3)
 *
 * Each command declares its name, description, argument shape, and a
 * runner function that receives a CommandContext bag of references it
 * needs (graph data, view handle, helpers for echoing into chat, etc).
 *
 * Why a registry pattern (not switch-on-string): the dropdown filters
 * over `COMMANDS` directly; adding a new command never requires editing
 * the dropdown widget. The widget knows about command shape, not command
 * identity.
 */

import type { GraphExport, VizNode } from '../../types.js';
import type { ViewHandle } from '../views/types.js';
import type { Segment } from '../../nl/segment.js';
import { segmentForNode, sliceSegment, tallySegments } from '../../nl/segment.js';

export interface CommandContext {
  graph: GraphExport;
  /** Returns the currently-mounted view handle. Live; recomputed on each call. */
  getView: () => ViewHandle;
  /** Echo a system-style line into the chat drawer when it's open. No-op if chat is off. */
  echoSystem: (text: string) => void;
  /** Switch the active view (force / chord / sankey) — reserved for future view commands. */
  switchView: (view: 'force' | 'chord' | 'sankey') => void;
  /** Active filter state; commands set this so the palette can show a "Filter: biz" pill. */
  setActiveFilter: (label: string | null) => void;
}

export interface CommandArg {
  name: string;
  /** When set, the palette uses this to build "Try: ..." example hints based on graph data. */
  exampleSourceKind?: 'nodeId' | 'label' | 'segment' | 'integer';
  required: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  category: 'slice' | 'focus' | 'reflect' | 'manage';
  args: CommandArg[];
  run: (ctx: CommandContext, args: string[]) => Promise<void> | void;
}

/**
 * Build the "Try: ..." example string for a missing argument, grounded
 * in the actual graph. The palette renders this when the user has typed
 * a command but not its required argument.
 */
export function exampleForArg(
  arg: CommandArg,
  graph: GraphExport,
): string {
  switch (arg.exampleSourceKind) {
    case 'segment': {
      return 'biz, dom, imp, meta';
    }
    case 'label': {
      const labelSet = new Set<string>();
      for (const n of graph.nodes) {
        for (const l of n.labels) labelSet.add(l);
      }
      const sample = [...labelSet]
        .filter((l) => l !== 'Bookend' && l !== 'BuildSIG')
        .sort()
        .slice(0, 4)
        .join(', ');
      return sample || 'no labels in graph';
    }
    case 'nodeId': {
      const sample = graph.nodes
        .slice(0, 3)
        .map((n) => n.id)
        .join(', ');
      return sample || 'no nodes in graph';
    }
    case 'integer':
      return '5, 10, 20';
    default:
      return '';
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function nodesInSliceOfSegment(
  graph: GraphExport,
  seg: Segment,
): { ids: string[]; coreCount: number; sliceCount: number } {
  const { nodeIds, segmentMemberCount } = sliceSegment(graph, seg);
  return {
    ids: [...nodeIds],
    coreCount: segmentMemberCount,
    sliceCount: nodeIds.size,
  };
}

function nodesByLabel(graph: GraphExport, label: string): string[] {
  return graph.nodes
    .filter((n) => n.labels.includes(label))
    .map((n) => n.id);
}

function findNode(graph: GraphExport, id: string): VizNode | null {
  return graph.nodes.find((n) => n.id === id) ?? null;
}

/**
 * Shortest path (BFS) from src to dst over outgoing edges. Returns the
 * node ids along the path, or empty array if no path exists.
 */
function shortestPath(
  graph: GraphExport,
  srcId: string,
  dstId: string,
): string[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.fromId)) adj.set(e.fromId, []);
    adj.get(e.fromId)!.push(e.toId);
  }
  const visited = new Set<string>([srcId]);
  const parent = new Map<string, string>();
  const queue: string[] = [srcId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === dstId) {
      // Reconstruct.
      const path: string[] = [cur];
      let p = parent.get(cur);
      while (p !== undefined) {
        path.unshift(p);
        p = parent.get(p);
      }
      return path;
    }
    for (const next of adj.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, cur);
      queue.push(next);
    }
  }
  return [];
}

function topHubs(graph: GraphExport, n: number): string[] {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
    degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
  }
  return [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

// ── Command registry ─────────────────────────────────────────────────

export const COMMANDS: CommandSpec[] = [
  // ── SLICE ─────────────────────────────────────────────────────────
  {
    name: '/all',
    description: 'restore the full graph (clear all filters + focus)',
    category: 'slice',
    args: [],
    run: (ctx) => {
      const v = ctx.getView();
      v.focus(null);
      v.setFilter(null);
      ctx.setActiveFilter(null);
      ctx.echoSystem('Filters cleared. Showing full graph.');
    },
  },
  {
    name: '/biz',
    description: 'biz layer: requirements → features + outbound boundary',
    category: 'slice',
    args: [],
    run: (ctx) => {
      const r = nodesInSliceOfSegment(ctx.graph, 'biz');
      const v = ctx.getView();
      v.focus(null);
      v.setFilter(r.ids);
      ctx.setActiveFilter('biz');
      ctx.echoSystem(
        `Filtered to biz slice: ${r.coreCount} core nodes (REQs/UCs/features) + outbound boundary = ${r.sliceCount} total.`,
      );
    },
  },
  {
    name: '/dom',
    description: 'dom layer: features → leaves + outbound boundary',
    category: 'slice',
    args: [],
    run: (ctx) => {
      const r = nodesInSliceOfSegment(ctx.graph, 'dom');
      const v = ctx.getView();
      v.focus(null);
      v.setFilter(r.ids);
      ctx.setActiveFilter('dom');
      ctx.echoSystem(
        `Filtered to dom slice: ${r.coreCount} core nodes (features/repos/stages/...) + outbound boundary = ${r.sliceCount} total.`,
      );
    },
  },
  {
    name: '/imp',
    description: 'imp layer: paradigm-bound targets (cs_2026, sn_, next_, ...)',
    category: 'slice',
    args: [],
    run: (ctx) => {
      const r = nodesInSliceOfSegment(ctx.graph, 'imp');
      if (r.coreCount === 0) {
        ctx.echoSystem(
          'No implementation nodes yet — Tier-3 (cs_2026.* etc) gets populated in build Stage 4+.',
        );
        return;
      }
      const v = ctx.getView();
      v.focus(null);
      v.setFilter(r.ids);
      ctx.setActiveFilter('imp');
      ctx.echoSystem(
        `Filtered to imp slice: ${r.coreCount} core nodes + outbound boundary = ${r.sliceCount} total.`,
      );
    },
  },
  {
    name: '/label',
    description: 'filter to a single label class (e.g. /label sw.use_case)',
    category: 'slice',
    args: [{ name: 'name', exampleSourceKind: 'label', required: true }],
    run: (ctx, args) => {
      const label = args[0];
      if (!label) {
        ctx.echoSystem('Try: /label sw.use_case');
        return;
      }
      const ids = nodesByLabel(ctx.graph, label);
      if (ids.length === 0) {
        ctx.echoSystem(`No nodes with label "${label}".`);
        return;
      }
      const v = ctx.getView();
      v.focus(null);
      v.setFilter(ids);
      ctx.setActiveFilter(`label:${label}`);
      ctx.echoSystem(`Filtered to "${label}" (${ids.length} nodes).`);
    },
  },

  // ── FOCUS ─────────────────────────────────────────────────────────
  {
    name: '/focus',
    description: '1-hop constellation around a node id',
    category: 'focus',
    args: [{ name: 'id', exampleSourceKind: 'nodeId', required: true }],
    run: (ctx, args) => {
      const id = args[0];
      if (!id) {
        ctx.echoSystem('Try: /focus req:REQ-SI-001');
        return;
      }
      const node = findNode(ctx.graph, id);
      if (!node) {
        ctx.echoSystem(`Node "${id}" not found.`);
        return;
      }
      const v = ctx.getView();
      v.setFilter(null);
      v.focus(id);
      ctx.setActiveFilter(`focus:${id}`);
      ctx.echoSystem(`Focused on ${id}.`);
    },
  },
  {
    name: '/trace',
    description: 'transitive subgraph in both directions from a node',
    category: 'focus',
    args: [{ name: 'id', exampleSourceKind: 'nodeId', required: true }],
    run: (ctx, args) => {
      const id = args[0];
      if (!id) {
        ctx.echoSystem('Try: /trace req:REQ-SI-001');
        return;
      }
      const node = findNode(ctx.graph, id);
      if (!node) {
        ctx.echoSystem(`Node "${id}" not found.`);
        return;
      }
      const v = ctx.getView();
      v.setFilter(null);
      v.focus(id, { transitive: true });
      ctx.setActiveFilter(`trace:${id}`);
      ctx.echoSystem(`Tracing reachable subgraph from ${id}.`);
    },
  },
  {
    name: '/path',
    description: 'shortest path between two nodes',
    category: 'focus',
    args: [
      { name: 'from', exampleSourceKind: 'nodeId', required: true },
      { name: 'to', exampleSourceKind: 'nodeId', required: true },
    ],
    run: (ctx, args) => {
      const [from, to] = args;
      if (!from || !to) {
        ctx.echoSystem('Try: /path ft:FT-SI-04 ft:FT-SI-10');
        return;
      }
      if (!findNode(ctx.graph, from) || !findNode(ctx.graph, to)) {
        ctx.echoSystem(`One of those ids is not in the graph.`);
        return;
      }
      const path = shortestPath(ctx.graph, from, to);
      if (path.length === 0) {
        ctx.echoSystem(`No outgoing-edge path from ${from} to ${to}.`);
        return;
      }
      const v = ctx.getView();
      v.setFilter(null);
      v.focus(path);
      ctx.setActiveFilter(`path:${from}→${to}`);
      ctx.echoSystem(
        `Path (${path.length} hops): ${path.map((p) => `\`${p}\``).join(' → ')}`,
      );
    },
  },
  {
    name: '/hubs',
    description: 'top-N most-connected nodes (default 10)',
    category: 'focus',
    args: [{ name: 'n', exampleSourceKind: 'integer', required: false }],
    run: (ctx, args) => {
      const n = args[0] ? Math.max(1, Math.min(50, parseInt(args[0], 10))) : 10;
      const ids = topHubs(ctx.graph, n);
      const v = ctx.getView();
      v.setFilter(null);
      v.focus(ids);
      ctx.setActiveFilter(`hubs:${n}`);
      ctx.echoSystem(`Top ${n} most-connected nodes focused.`);
    },
  },

  // ── REFLECT ───────────────────────────────────────────────────────
  {
    name: '/stats',
    description: 'node counts, edge counts, segment + label distribution',
    category: 'reflect',
    args: [],
    run: (ctx) => {
      const seg = tallySegments(ctx.graph.nodes);
      const labelCounts = new Map<string, number>();
      for (const n of ctx.graph.nodes) {
        for (const l of n.labels) {
          if (l === 'Bookend' || l === 'BuildSIG') continue;
          labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
        }
      }
      const top = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([l, n]) => `${l}: ${n}`)
        .join(', ');
      ctx.echoSystem(
        `**Graph stats** — ${ctx.graph.nodes.length} nodes, ${ctx.graph.edges.length} edges. ` +
          `Segment members: biz ${seg.biz}, dom ${seg.dom}, imp ${seg.imp}, meta ${seg.meta} ` +
          `(${seg.seams} are seam nodes living in 2 segments). ` +
          `Top labels: ${top}.`,
      );
    },
  },
  {
    name: '/csv',
    description: 'list (and download links for) the management CSVs',
    category: 'manage',
    args: [],
    run: async (ctx) => {
      try {
        const r = await fetch('/api/csv/list');
        if (!r.ok) {
          ctx.echoSystem(`/api/csv/list returned ${r.status}`);
          return;
        }
        const data = (await r.json()) as {
          csvs: Array<{ name: string; description: string; kind: string }>;
        };
        const lines = ['**Available management CSVs** (click to download)'];
        for (const c of data.csvs) {
          lines.push(`[\`${c.name}.csv\`](/api/csv/${c.name}) — ${c.description}`);
        }
        lines.push('');
        lines.push('To merge an edited CSV back into the graph, use `/csv-merge`.');
        ctx.echoSystem(lines.join('\n\n'));
      } catch (err) {
        ctx.echoSystem(`/csv failed: ${String(err)}`);
      }
    },
  },
  {
    name: '/csv-merge',
    description: 'upload an edited CSV and additive-merge it into the graph',
    category: 'manage',
    args: [],
    run: (ctx) => {
      // The actual file picker + preview UI lives in chat.ts; this
      // runner just signals the chat layer to mount the picker.
      const ev = new CustomEvent('polygraph-viz:csv-merge-request', { bubbles: true });
      document.dispatchEvent(ev);
      ctx.echoSystem('Opening file picker — choose one of the downloaded CSVs after editing.');
    },
  },
  {
    name: '/help',
    description: 'list all commands',
    category: 'reflect',
    args: [],
    run: (ctx) => {
      const lines = COMMANDS.map((c) => {
        const argList = c.args.map((a) => `<${a.name}>`).join(' ');
        return `\`${c.name}${argList ? ' ' + argList : ''}\` — ${c.description}`;
      });
      ctx.echoSystem(lines.join('\n\n'));
    },
  },
];

// ── Parser ────────────────────────────────────────────────────────

export interface ParsedCommand {
  spec: CommandSpec;
  args: string[];
}

/**
 * Parse a leading "/" input. Returns null when the input is not a slash
 * command or the command name is unknown.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const tokens = trimmed.split(/\s+/);
  const name = tokens[0]!.toLowerCase();
  const spec = COMMANDS.find((c) => c.name === name);
  if (!spec) return null;
  return { spec, args: tokens.slice(1) };
}

/**
 * Filter commands by a prefix-match against name. Used by the dropdown's
 * type-ahead. Empty prefix returns all commands.
 */
export function filterCommands(prefix: string): CommandSpec[] {
  const p = prefix.toLowerCase();
  if (p === '' || p === '/') return COMMANDS;
  return COMMANDS.filter((c) => c.name.startsWith(p));
}
