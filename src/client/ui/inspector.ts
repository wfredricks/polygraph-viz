/**
 * Right-side inspector panel.
 *
 * One shared implementation across all three views. Each renderer
 * calls showNode() with a VizNode (or a group, see showGroup) and the
 * panel takes care of formatting.
 */

import type { VizNode, VizEdge } from '../../types.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(): HTMLElement | null {
  return document.getElementById('inspector');
}

export function clearInspector(): void {
  const aside = el();
  if (!aside) return;
  aside.hidden = true;
  aside.innerHTML = '';
}

/**
 * Display a node's full property table.
 */
export function showNode(node: VizNode): void {
  const aside = el();
  if (!aside) return;
  aside.hidden = false;

  const propsList = Object.entries(node.properties)
    .map(
      ([k, v]) =>
        `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(formatValue(v))}</td></tr>`,
    )
    .join('');

  const titleText = pickDisplayName(node);

  aside.innerHTML = `
    <header>
      <h2>${escapeHtml(titleText)}</h2>
      <p class="labels">${node.labels.map(escapeHtml).join(' · ')}</p>
    </header>
    <table class="props">
      <thead><tr><th>key</th><th>value</th></tr></thead>
      <tbody>${propsList || '<tr><td colspan="2"><em>(no properties)</em></td></tr>'}</tbody>
    </table>
  `;
}

/**
 * Display a chord group: label + member nodes.
 */
export function showGroup(label: string, members: VizNode[]): void {
  const aside = el();
  if (!aside) return;
  aside.hidden = false;

  const items = members
    .slice(0, 50)
    .map((n) => `<li><code>${escapeHtml(n.id)}</code> ${escapeHtml(pickDisplayName(n))}</li>`)
    .join('');
  const overflow =
    members.length > 50
      ? `<li class="muted">… and ${members.length - 50} more</li>`
      : '';

  aside.innerHTML = `
    <header>
      <h2>${escapeHtml(label)}</h2>
      <p class="labels">${members.length} member node${members.length === 1 ? '' : 's'}</p>
    </header>
    <ul class="group-members">${items}${overflow}</ul>
  `;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function pickDisplayName(node: VizNode): string {
  const p = node.properties as Record<string, unknown>;
  const candidate = p['name'] ?? p['label'] ?? p['summary'] ?? p['title'];
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate.length > 80 ? candidate.slice(0, 77) + '…' : candidate;
  }
  return node.id;
}

/**
 * Display an edge: type + source/target ids + property table.
 */
export function showEdge(
  edge: VizEdge,
  source: VizNode | undefined,
  target: VizNode | undefined,
): void {
  const aside = el();
  if (!aside) return;
  aside.hidden = false;

  const props = edge.properties
    ? Object.entries(edge.properties)
        .map(
          ([k, v]) =>
            `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(formatValue(v))}</td></tr>`,
        )
        .join('')
    : '';

  const srcName = source ? pickDisplayName(source) : edge.fromId;
  const tgtName = target ? pickDisplayName(target) : edge.toId;

  aside.innerHTML = `
    <header>
      <h2 class="edge-title">${escapeHtml(edge.type)}</h2>
      <p class="edge-endpoints">
        <code>${escapeHtml(edge.fromId)}</code>
        <span class="arrow">→</span>
        <code>${escapeHtml(edge.toId)}</code>
      </p>
      <p class="edge-endpoints-friendly">
        ${escapeHtml(srcName)} → ${escapeHtml(tgtName)}
      </p>
    </header>
    <table class="props">
      <thead><tr><th>key</th><th>value</th></tr></thead>
      <tbody>${props || '<tr><td colspan="2"><em>(no edge properties)</em></td></tr>'}</tbody>
    </table>
  `;
}

/**
 * Display a group-to-group aggregate: header + counts + sample of
 * underlying edges. Used by the Chord view since ribbons are
 * aggregates and there is no single "edge" to inspect.
 */
export function showAggregate(
  fromGroup: string,
  toGroup: string,
  edges: VizEdge[],
  vizById: Map<string, VizNode>,
): void {
  const aside = el();
  if (!aside) return;
  aside.hidden = false;

  // Count edges by type.
  const byType: Record<string, number> = {};
  for (const e of edges) byType[e.type] = (byType[e.type] ?? 0) + 1;
  const typeRows = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([t, n]) =>
        `<tr><td><code>${escapeHtml(t)}</code></td><td>${n}</td></tr>`,
    )
    .join('');

  // List up to 30 sample edges so the user can see what's behind the ribbon.
  const sample = edges.slice(0, 30);
  const sampleRows = sample
    .map((e) => {
      const s = vizById.get(e.fromId);
      const t = vizById.get(e.toId);
      const sName = s ? pickDisplayName(s) : e.fromId;
      const tName = t ? pickDisplayName(t) : e.toId;
      return `<li><code>${escapeHtml(e.type)}</code> ${escapeHtml(sName)} → ${escapeHtml(tName)}</li>`;
    })
    .join('');
  const overflow =
    edges.length > sample.length
      ? `<li class="muted">… and ${edges.length - sample.length} more</li>`
      : '';

  aside.innerHTML = `
    <header>
      <h2>${escapeHtml(fromGroup)} ↔ ${escapeHtml(toGroup)}</h2>
      <p class="labels">${edges.length} edge${edges.length === 1 ? '' : 's'}</p>
    </header>
    <table class="props">
      <thead><tr><th>edge type</th><th>count</th></tr></thead>
      <tbody>${typeRows || '<tr><td colspan="2"><em>(none)</em></td></tr>'}</tbody>
    </table>
    <h3 class="sample-header">Edges</h3>
    <ul class="group-members">${sampleRows}${overflow}</ul>
  `;
}

/**
 * Substring search across id, labels, and stringifiable property values.
 * Case-insensitive.
 */
export function nodeMatches(node: VizNode, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (node.id.toLowerCase().includes(q)) return true;
  if (node.labels.some((l) => l.toLowerCase().includes(q))) return true;
  for (const v of Object.values(node.properties)) {
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v : formatValue(v);
    if (s.toLowerCase().includes(q)) return true;
  }
  return false;
}
