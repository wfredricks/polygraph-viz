/**
 * Right-side inspector panel.
 *
 * One shared implementation across all three views. Each renderer
 * calls showNode() with a VizNode (or a group, see showGroup) and the
 * panel takes care of formatting.
 */

import type { VizNode } from '../../types.js';

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
