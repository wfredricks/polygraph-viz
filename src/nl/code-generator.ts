/**
 * code-generator.ts — assign short, unique-across-graph "codes" to nodes.
 *
 * Why this exists: ids like
 *
 *   cs_2026.fn:polygraph-viz:src/client/ui/command-palette.ts:installCommandPalette
 *
 * are necessary for uniqueness and provenance but terrible as the
 * user-facing handle. Chat citations want short tokens. /focus wants
 * something a human can type. Force view labels want something that
 * won't overlap with neighbors.
 *
 * Solution per Bill's 2026-05-20 17:29 EDT call (Option A):
 *   - Every node gets a 'code' property in addition to its id
 *   - Codes are unique across the graph (not just per-label)
 *   - Codes are server-computed at load time
 *   - Users can override the auto-generated code via the CSV portal
 *   - The id remains the canonical identifier; the code is a display
 *     and short-handle convenience
 *
 * Rule table per label class:
 *
 *   intended_behavior → reqId verbatim (REQ-SI-070, REQ-SI2-001)
 *   sw.use_case       → ucId verbatim (UC-3, UC-SI2-2)
 *   sw.feature        → ftId verbatim (FT-SI-09, FT-SI2-01)
 *   sw.repo           → repoName (polygraph-viz, solution-intelligence-graph-adapter)
 *   sw.stage          → "Stage N"
 *   sw.file           → basename (chat.ts) → collisions get #2, #3, ...
 *   sw.function       → function name (installChat) → collisions get #2, ...
 *   sw.alt_flow       → "<parent-fn>.alt<N>" within the parent function
 *   sw.call_out       → target (bedrock.send) → collisions get #2, ...
 *   cs_2026.file      → basename + "~ts" (chat.ts~ts) → collisions get #2, ...
 *   cs_2026.fn        → fn name + "~ts" (installChat~ts) → collisions get #2, ...
 *   cs_2026.try_catch → "<fnCode>.try<N>"
 *   cs_2026.early_return → "<fnCode>.guard<N>"
 *   cs_2026.sdk_call  → "<target>~sdk"
 *   cs_2026.fetch_call → "<target>~fetch"
 *   cs_2026.fs_call   → "<target>~fs"
 *   everything else   → "<labelInitials><index>" sentinel (e.g. M42 for misc)
 *
 * Uniqueness enforcement: as codes are assigned in deterministic order
 * (sorted by id), the first claim wins; subsequent collisions get a
 * "#N" suffix. The user CAN override via CSV — when an upload sets a
 * `code` for a node, we trust it (warn if it collides with an existing
 * code that isn't this node's previous code).
 */

import type { GraphExport, VizNode } from '../types.js';

const UTILITY_LABELS = new Set(['Bookend', 'BuildSIG']);

function primaryLabel(labels: string[]): string {
  for (const l of labels) if (!UTILITY_LABELS.has(l)) return l;
  return labels[0] ?? 'Node';
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Generate the default code for a single node, ignoring uniqueness.
 * The caller is responsible for collision suffixing.
 */
function defaultCodeFor(node: VizNode): string {
  const p = primaryLabel(node.labels);
  const props = node.properties as Record<string, unknown>;
  const str = (k: string): string => (typeof props[k] === 'string' ? (props[k] as string) : '');

  switch (p) {
    case 'intended_behavior':
      return str('reqId') || node.id.replace(/^req:/, '');
    case 'sw.use_case':
      return str('ucId') || node.id.replace(/^uc:/, '');
    case 'sw.feature':
      return str('ftId') || node.id.replace(/^ft:/, '');
    case 'sw.repo':
      return str('repoName') || node.id.replace(/^repo:/, '');
    case 'sw.stage': {
      const num = props['stageNumber'];
      return `Stage ${typeof num === 'number' ? num : num ?? '?'}`;
    }
    case 'sw.file': {
      // id format: file:repo:filepath
      // Try bare basename first; if it would collide across repos
      // (e.g. every Stage 1a sibling has src/index.ts), the caller's
      // collision suffixer will append # but produces ugly
      // index.ts#2/#3/#4 codes. We pre-empt that by checking the
      // node id: if the basename appears uniquely in this repo,
      // emit it bare; otherwise prefix with the repo name so each
      // index.ts gets a distinct, readable code.
      // The uniqueness check is best-effort — we don't have the
      // full graph here, so we always emit <repo>/<basename> when
      // basename is one of the known multi-repo collision names.
      // Practical heuristic: short, generic basenames (index.ts,
      // types.ts, server.ts, cli.ts, main.ts) tend to repeat;
      // qualify them up front. Specific names rarely repeat.
      const path = str('path') || node.id.replace(/^file:[^:]+:/, '');
      const bn = basename(path);
      const repo = str('repo') || (node.id.split(':')[1] ?? '');
      const GENERIC = new Set([
        'index.ts', 'index.js', 'types.ts', 'server.ts', 'cli.ts',
        'main.ts', 'config.ts', 'utils.ts', 'README.md',
      ]);
      if (repo && GENERIC.has(bn)) return `${repo}/${bn}`;
      return bn;
    }
    case 'sw.function': {
      // id format: fn:repo:filepath:fnName
      // Bare function names collide across files (e.g. two parseCsv
      // functions in different files). Pre-empt by qualifying with
      // the file basename whenever the function name is generic.
      // For specific names (installChat, generateCodes), bare wins.
      const name = str('name') || node.id.split(':').pop() || node.id;
      const idParts = node.id.split(':');
      // file basename lives in idParts[2] (repo at [1])
      const fileBn = idParts.length >= 3 ? basename(idParts[2]) : '';
      const GENERIC_FN = new Set([
        'parseCsv', 'readCsv', 'main', 'init', 'start', 'stop',
        'run', 'load', 'save', 'parse', 'render', 'handle',
        'process', 'walk', 'build', 'create', 'update', 'delete',
      ]);
      if (fileBn && GENERIC_FN.has(name)) {
        // strip extension for readability: csv-loader.ts -> csv-loader.parseCsv
        const fileStem = fileBn.replace(/\.[mc]?[tj]sx?$/, '');
        return `${fileStem}.${name}`;
      }
      return name;
    }
    case 'sw.alt_flow': {
      // id format: af:repo:filepath:fnName:kind[-N]
      // We want: <fnName>.<kind><N> where N is the ordinal baked
      // into the id by inventory.mts' uniqueId() (1 when bare, 2..M
      // when suffixed). That makes every alt-flow in a kitchen-sink
      // function get a stable, unique, human-readable code rather
      // than relying on the post-hoc # collision suffixer.
      // Why not source line: alt-flow nodes do carry line info, but
      // tier-3 cs_2026.* progenitors don't, and we want one rule
      // that works for both tiers. Ordinals are present on both.
      const idParts = node.id.split(':');
      if (idParts.length < 4 || idParts[0] !== 'af') {
        // Defensive: malformed id (e.g. inventory.mts AST extraction
        // glitches with garbled function names). Fall back to a
        // sentinel; the collision suffixer takes it from there.
        return 'alt';
      }
      const kindTail = idParts[idParts.length - 1] ?? 'alt';
      const fnName = idParts[idParts.length - 2] ?? 'fn';
      const m = /^(try|guard|return)(?:-(\d+))?$/.exec(
        kindTail.replace(/^early[_-]?return/, 'return'),
      );
      const baseKind = m ? (m[1] === 'return' ? 'guard' : m[1]) : kindTail;
      const ordinal = m && m[2] ? m[2] : '1';
      return `${fnName}.${baseKind}${ordinal}`;
    }
    case 'sw.call_out': {
      // id format: co:repo:filepath:fnName:kind[-N]
      // We want: <target>@<fnName><N> where N is the ordinal baked
      // into the id (same rationale as sw.alt_flow above). Two
      // fetches in installChat now read fetch@installChat1 and
      // fetch@installChat2 instead of fetch@installChat / #2.
      const idParts = node.id.split(':');
      if (idParts.length < 4 || idParts[0] !== 'co') {
        return str('target') || 'co';
      }
      const target = str('target') || idParts[idParts.length - 1] || 'co';
      const kindTail = idParts[idParts.length - 1] ?? '';
      const fnName = idParts[idParts.length - 2] ?? '';
      const ordMatch = /-(\d+)$/.exec(kindTail);
      const ordinal = ordMatch ? ordMatch[1] : '1';
      if (fnName) return `${target}@${fnName}${ordinal}`;
      return `${target}${ordinal}`;
    }
  }

  // Tier-3 cs_2026.*
  // Id shapes:
  //   cs_2026.file:repo:filepath
  //   cs_2026.fn:repo:filepath:fnName
  //   cs_2026.try_catch|early_return|sdk_call|fetch_call|fs_call:
  //       repo:filepath:fnName:kind[-N]
  //
  // The OLD rule emitted a bare `guard~ts`/`try~ts`/`fetch~ts` for
  // every Tier-3 progeny regardless of function, producing massive
  // # suffix runs (`guard~ts#83` etc.). The NEW rule mirrors the
  // Tier-2 fix: prefix with the parent function code so each
  // structural form is uniquely identifiable by its progenitor.
  if (p.startsWith('cs_2026.')) {
    const tail = p.slice('cs_2026.'.length);
    const idTail = node.id.split(':').slice(1).join(':'); // strip cs_2026.<kind>:
    const idTailParts = idTail.split(':');

    if (tail === 'file') {
      // Mirror the Tier-2 sw.file rule: qualify generic basenames
      // with the repo so cs_2026 progeny don't collide either.
      const repo = idTailParts[0] ?? '';
      const filepath = idTailParts.slice(1).join(':') || idTail;
      const bn = basename(filepath);
      const GENERIC = new Set([
        'index.ts', 'index.js', 'types.ts', 'server.ts', 'cli.ts',
        'main.ts', 'config.ts', 'utils.ts',
      ]);
      if (repo && GENERIC.has(bn)) return `${repo}/${bn}~ts`;
      return `${bn}~ts`;
    }
    if (tail === 'fn') {
      // Mirror the Tier-2 sw.function rule: qualify generic names
      // with the file basename.
      const fnName = idTailParts[idTailParts.length - 1] ?? 'fn';
      const fileBn = idTailParts.length >= 2 ? basename(idTailParts[1]) : '';
      const GENERIC_FN = new Set([
        'parseCsv', 'readCsv', 'main', 'init', 'start', 'stop',
        'run', 'load', 'save', 'parse', 'render', 'handle',
        'process', 'walk', 'build', 'create', 'update', 'delete',
      ]);
      if (fileBn && GENERIC_FN.has(fnName)) {
        const fileStem = fileBn.replace(/\.[mc]?[tj]sx?$/, '');
        return `${fileStem}.${fnName}~ts`;
      }
      return `${fnName}~ts`;
    }
    // try_catch / early_return / sdk_call / fetch_call / fs_call
    // parts: repo, filepath, fnName, kindTail[-N]
    if (idTailParts.length < 4) {
      // Defensive: malformed; fall back to the tier name.
      return `${tail}~ts`;
    }
    const kindTail = idTailParts[idTailParts.length - 1];
    const fnName = idTailParts[idTailParts.length - 2];
    const ordMatch = /-(\d+)$/.exec(kindTail);
    const ordinal = ordMatch ? ordMatch[1] : '1';
    const kindAbbrev: Record<string, string> = {
      try_catch: 'try',
      early_return: 'guard',
      sdk_call: 'sdk',
      fetch_call: 'fetch',
      fs_call: 'fs',
    };
    const kind = kindAbbrev[tail] ?? tail;
    return `${fnName}.${kind}${ordinal}~ts`;
  }

  // Sentinel for unclassified.
  return p.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || 'N';
}

export interface CodeAssignment {
  /** node id -> assigned code */
  codes: Map<string, string>;
  /** code -> node id (the inverse map; used for /focus CODE resolution) */
  byCode: Map<string, string>;
  /** how many nodes got a # suffix because of a collision */
  collisions: number;
}

/**
 * Generate codes for every node in the graph. Existing codes (already
 * stored on nodes' `code` property) are honored — the function only
 * mints new codes for nodes that lack one. Collisions across honored
 * codes are surfaced via the `collisions` count.
 *
 * Deterministic: nodes are processed in id-sorted order so the same
 * graph always produces the same codes.
 */
export function generateCodes(graph: GraphExport): CodeAssignment {
  const codes = new Map<string, string>();
  const byCode = new Map<string, string>();
  let collisions = 0;

  const claim = (nodeId: string, base: string): string => {
    let code = base;
    let n = 2;
    while (byCode.has(code) && byCode.get(code) !== nodeId) {
      code = `${base}#${n}`;
      n++;
      collisions++;
    }
    codes.set(nodeId, code);
    byCode.set(code, nodeId);
    return code;
  };

  const sorted = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

  // First pass: honor existing user-set codes.
  for (const n of sorted) {
    const existing = n.properties['code'];
    if (typeof existing === 'string' && existing.length > 0) {
      claim(n.id, existing);
    }
  }

  // Second pass: assign defaults to nodes that don't yet have one.
  for (const n of sorted) {
    if (codes.has(n.id)) continue;
    const def = defaultCodeFor(n);
    claim(n.id, def);
  }

  return { codes, byCode, collisions };
}

/**
 * Resolve a user-supplied token to a node id. Accepts:
 *   - a full id (e.g. "ft:FT-SI-09")
 *   - a code (e.g. "FT-SI-09")
 *   - a property like "name" or "reqId" matching exactly one node
 *
 * Returns null if the token is ambiguous or unknown.
 */
export function resolveTokenToId(
  graph: GraphExport,
  assignment: CodeAssignment,
  token: string,
): string | null {
  if (!token) return null;
  // Exact id match
  if (graph.nodes.some((n) => n.id === token)) return token;
  // Code match
  if (assignment.byCode.has(token)) return assignment.byCode.get(token)!;
  // ReqId / UcId / FtId / repoName direct property match
  for (const n of graph.nodes) {
    for (const k of ['reqId', 'ucId', 'ftId', 'repoName', 'name']) {
      if (n.properties[k] === token) return n.id;
    }
  }
  return null;
}
