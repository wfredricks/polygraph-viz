/**
 * Dynamic graph-label sidebar with Core / Overlay grouping.
 *
 * Fetches the label distribution from /api/stats on install and splits
 * labels into two collapsible sections:
 *
 *   - **Core Graph** — labels without a dot prefix (the domain model)
 *   - **Overlays**   — labels with a dot prefix (analysis/structural layers),
 *                       sub-grouped by prefix (data.*, dom.*, sw.*, etc.)
 *
 * Within each section/sub-group, labels are sorted alphabetically.
 *
 * Two gestures per label:
 *   - **Checkbox** — adds/removes that label's nodes on the canvas
 *   - **Click label text** — highlights matching visible nodes (toggle)
 *
 * Wire-up: call installSidebar() after renderForce().
 */

import { addLabelNodes, removeNodes, focusByLabel } from '../views/force.js';
import { autoColor, swatchSvg, seedColorMap } from './palette.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface LabelEntry {
  label: string;
  count: number;
}

interface SubGroup {
  prefix: string;
  displayName: string;
  entries: LabelEntry[];
  totalCount: number;
}

interface TopGroup {
  id: string;
  title: string;
  subGroups: SubGroup[];
  totalLabels: number;
  totalCount: number;
}

// ─── Runtime state ─────────────────────────────────────────────────────────

const itemNodes = new Map<string, string[]>();
const checkedState = new Map<string, boolean>();
const expandedState = new Map<string, boolean>();
let activeHighlight: string | null = null;
let foundationPrefix: string | null = null;
let cachedDist: Record<string, number> = {};
let sidebarContainer: HTMLElement | null = null;

// ─── Data helpers ──────────────────────────────────────────────────────────

/**
 * Split labels into Foundation, Core (no dot), and Overlay (has dot) top groups.
 * When a foundationPrefix is set, that prefix group becomes the Foundation section.
 * Overlays are sub-grouped by dot-prefix; Core is one flat sub-group.
 * Within each sub-group, entries are sorted alphabetically by label.
 */
function buildGroups(dist: Record<string, number>, foundation: string | null): TopGroup[] {
  const coreEntries: LabelEntry[] = [];
  const overlayMap = new Map<string, LabelEntry[]>();

  for (const [label, count] of Object.entries(dist)) {
    if (label.startsWith('meta.')) continue;  // meta-nodes are infrastructure, not content
    const dot = label.indexOf('.');
    if (dot > 0) {
      const prefix = label.slice(0, dot);
      if (!overlayMap.has(prefix)) overlayMap.set(prefix, []);
      overlayMap.get(prefix)!.push({ label, count });
    } else {
      coreEntries.push({ label, count });
    }
  }

  // Sort entries alphabetically within each group
  coreEntries.sort((a, b) => a.label.localeCompare(b.label));
  for (const entries of overlayMap.values()) {
    entries.sort((a, b) => a.label.localeCompare(b.label));
  }

  const groups: TopGroup[] = [];

  // Foundation — the user-selected prefix group
  if (foundation && overlayMap.has(foundation)) {
    const foundationEntries = overlayMap.get(foundation)!;
    groups.push({
      id: 'foundation',
      title: `Foundation: ${foundation}`,
      subGroups: [{
        prefix: foundation,
        displayName: foundation,
        entries: foundationEntries,
        totalCount: foundationEntries.reduce((s, e) => s + e.count, 0),
      }],
      totalLabels: foundationEntries.length,
      totalCount: foundationEntries.reduce((s, e) => s + e.count, 0),
    });
    overlayMap.delete(foundation);
  }

  // Core Graph (undotted labels)
  if (coreEntries.length > 0) {
    groups.push({
      id: 'core',
      title: 'Core Graph',
      subGroups: [{
        prefix: '',
        displayName: '',
        entries: coreEntries,
        totalCount: coreEntries.reduce((s, e) => s + e.count, 0),
      }],
      totalLabels: coreEntries.length,
      totalCount: coreEntries.reduce((s, e) => s + e.count, 0),
    });
  }

  // Overlays — sub-grouped by prefix, sorted alphabetically by prefix
  const overlayPrefixes = [...overlayMap.keys()].sort();
  if (overlayPrefixes.length > 0) {
    const subGroups: SubGroup[] = overlayPrefixes.map((prefix) => {
      const entries = overlayMap.get(prefix)!;
      return {
        prefix,
        displayName: prefix,
        entries,
        totalCount: entries.reduce((s, e) => s + e.count, 0),
      };
    });
    groups.push({
      id: 'overlays',
      title: 'Overlays',
      subGroups,
      totalLabels: subGroups.reduce((s, g) => s + g.entries.length, 0),
      totalCount: subGroups.reduce((s, g) => s + g.totalCount, 0),
    });
  }

  return groups;
}

/**
 * Display name for a label: strip prefix if in a sub-group,
 * replace underscores with spaces.
 */
function displayLabel(label: string, prefix: string): string {
  let display = prefix && label.startsWith(prefix + '.')
    ? label.slice(prefix.length + 1)
    : label;
  return display.replace(/_/g, ' ');
}

// ─── DOM state ─────────────────────────────────────────────────────────────

let sidebarRoot: HTMLElement | null = null;

function setLoading(label: string, loading: boolean): void {
  if (!sidebarRoot) return;
  const row = sidebarRoot.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(label)}"]`);
  if (!row) return;
  if (loading) {
    row.classList.add('sidebar-loading');
    const badge = row.querySelector<HTMLElement>('.sidebar-badge');
    if (badge) badge.textContent = '…';
  } else {
    row.classList.remove('sidebar-loading');
  }
}

function setBadge(label: string, count: number): void {
  if (!sidebarRoot) return;
  const row = sidebarRoot.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(label)}"]`);
  if (!row) return;
  let badge = row.querySelector<HTMLElement>('.sidebar-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'sidebar-badge';
    row.appendChild(badge);
  }
  badge.textContent = String(count);
}

// ─── Check/uncheck handlers ──────────────────────────────────────────────

async function handleLabelCheck(label: string, checked: boolean): Promise<void> {
  if (checked) {
    if (checkedState.get(label)) return;
    checkedState.set(label, true);
    setLoading(label, true);
    try {
      const result = await addLabelNodes([label]);
      if (result.added > 0) {
        const prev = itemNodes.get(label) ?? [];
        const prevSet = new Set(prev);
        const fresh = result.nodeIds.filter((id) => !prevSet.has(id));
        itemNodes.set(label, [...prev, ...fresh]);
      }
      setBadge(label, (itemNodes.get(label) ?? []).length);
    } catch (err) {
      console.error('sidebar handleLabelCheck failed:', err);
    } finally {
      setLoading(label, false);
    }
  } else {
    checkedState.set(label, false);
    const idsToRemove = itemNodes.get(label) ?? [];
    if (idsToRemove.length > 0) {
      removeNodes(idsToRemove);
      itemNodes.delete(label);
      if (sidebarRoot) {
        const row = sidebarRoot.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(label)}"]`);
        const badge = row?.querySelector('.sidebar-badge');
        if (badge) badge.textContent = '0';
      }
    }
  }
}

/** Refresh a parent checkbox to checked / unchecked / indeterminate. */
function refreshParentCb(cbSelector: string, entries: LabelEntry[]): void {
  if (!sidebarRoot) return;
  const cb = sidebarRoot.querySelector<HTMLInputElement>(cbSelector);
  if (!cb) return;
  const on = entries.filter((e) => checkedState.get(e.label));
  if (on.length === 0) { cb.checked = false; cb.indeterminate = false; }
  else if (on.length === entries.length) { cb.checked = true; cb.indeterminate = false; }
  else { cb.checked = false; cb.indeterminate = true; }
}

async function handleGroupCheck(entries: LabelEntry[], checked: boolean): Promise<void> {
  for (const entry of entries) {
    const cb = sidebarRoot?.querySelector<HTMLInputElement>(`[data-sidebar-cb="${CSS.escape(entry.label)}"]`);
    if (cb) cb.checked = checked;
    await handleLabelCheck(entry.label, checked);
  }
}

// ─── Row renderers ─────────────────────────────────────────────────────────

function renderLabelRow(entry: LabelEntry, prefix: string, depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sidebar-node-row';
  row.setAttribute('data-sidebar-row', entry.label);
  row.style.paddingLeft = `${8 + depth * 14}px`;

  // Spacer
  const spacer = document.createElement('span');
  spacer.className = 'sidebar-chevron-spacer';
  row.appendChild(spacer);

  // Checkbox
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'sidebar-checkbox';
  cb.setAttribute('data-sidebar-cb', entry.label);
  cb.addEventListener('change', () => {
    void handleLabelCheck(entry.label, cb.checked);
  });
  row.appendChild(cb);

  // Color+shape swatch
  const swatch = document.createElement('span');
  swatch.className = 'sidebar-swatch';
  swatch.innerHTML = swatchSvg(entry.label, 11);
  row.appendChild(swatch);

  // Label text — clickable to highlight
  const lbl = document.createElement('span');
  lbl.className = 'sidebar-label sidebar-label-clickable';
  lbl.textContent = displayLabel(entry.label, prefix);
  lbl.title = `${entry.label} (${entry.count} nodes) — click to highlight`;
  lbl.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = activeHighlight === entry.label;
    if (sidebarRoot) {
      sidebarRoot.querySelectorAll('.sidebar-label-active').forEach((el) =>
        el.classList.remove('sidebar-label-active'),
      );
    }
    if (wasActive) {
      activeHighlight = null;
      focusByLabel(null);
    } else {
      activeHighlight = entry.label;
      lbl.classList.add('sidebar-label-active');
      focusByLabel(entry.label);
    }
  });
  row.appendChild(lbl);

  // Count badge
  const badge = document.createElement('span');
  badge.className = 'sidebar-badge';
  badge.textContent = String(entry.count);
  row.appendChild(badge);

  return row;
}

/**
 * Render a sub-group (prefix group within Overlays, or the flat list in Core).
 * When `showHeader` is true, renders a collapsible header row.
 */
function renderSubGroup(
  sub: SubGroup,
  depth: number,
  showHeader: boolean,
  allEntries: LabelEntry[],  // all entries in the top group (for parent cb refresh)
  topCbSelector: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'sidebar-node';

  if (!showHeader) {
    // Flat: just render label rows
    for (const entry of sub.entries) {
      const row = renderLabelRow(entry, sub.prefix, depth);
      const cb = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      cb?.addEventListener('change', () => refreshParentCb(topCbSelector, allEntries));
      wrapper.appendChild(row);
    }
    return wrapper;
  }

  // Header row with chevron + group checkbox
  const header = document.createElement('div');
  header.className = 'sidebar-node-row';
  header.style.paddingLeft = `${8 + depth * 14}px`;
  wrapper.appendChild(header);

  const stateKey = `sub:${sub.prefix}`;
  expandedState.set(stateKey, false);

  // Chevron
  const chev = document.createElement('span');
  chev.className = 'sidebar-chevron';
  chev.textContent = '▶';
  chev.addEventListener('click', (e) => {
    e.stopPropagation();
    const was = expandedState.get(stateKey) ?? false;
    expandedState.set(stateKey, !was);
    chev.textContent = !was ? '▼' : '▶';
    children.style.display = !was ? 'block' : 'none';
  });
  header.appendChild(chev);

  // Sub-group checkbox
  const subCbId = `sub-cb:${sub.prefix}`;
  const gcb = document.createElement('input');
  gcb.type = 'checkbox';
  gcb.className = 'sidebar-checkbox';
  gcb.setAttribute('data-sidebar-group-cb', sub.prefix);
  gcb.addEventListener('change', () => {
    void handleGroupCheck(sub.entries, gcb.checked).then(() => {
      refreshParentCb(`[data-sidebar-group-cb="${CSS.escape(sub.prefix)}"]`, sub.entries);
      refreshParentCb(topCbSelector, allEntries);
    });
  });
  header.appendChild(gcb);

  // Sub-group label
  const lbl = document.createElement('span');
  lbl.className = 'sidebar-label';
  lbl.style.fontWeight = '600';
  lbl.textContent = sub.displayName;
  lbl.title = `${sub.entries.length} label types, ${sub.totalCount} total nodes`;
  header.appendChild(lbl);

  // Count
  const badge = document.createElement('span');
  badge.className = 'sidebar-badge';
  badge.textContent = String(sub.totalCount);
  header.appendChild(badge);

  // Children
  const children = document.createElement('div');
  children.className = 'sidebar-children';
  children.style.display = 'none';
  for (const entry of sub.entries) {
    const row = renderLabelRow(entry, sub.prefix, depth + 1);
    const cb = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    cb?.addEventListener('change', () => {
      refreshParentCb(`[data-sidebar-group-cb="${CSS.escape(sub.prefix)}"]`, sub.entries);
      refreshParentCb(topCbSelector, allEntries);
    });
    children.appendChild(row);
  }
  wrapper.appendChild(children);

  return wrapper;
}

/**
 * Render a top-level group (Core Graph or Overlays).
 */
function renderTopGroup(group: TopGroup): HTMLElement {
  const section = document.createElement('div');
  section.className = 'sidebar-section';

  const stateKey = `top:${group.id}`;
  expandedState.set(stateKey, true); // top groups start expanded

  // Section header
  const header = document.createElement('div');
  header.className = 'sidebar-section-header';
  section.appendChild(header);

  // Chevron
  const chev = document.createElement('span');
  chev.className = 'sidebar-chevron';
  chev.textContent = '▼';
  chev.addEventListener('click', (e) => {
    e.stopPropagation();
    const was = expandedState.get(stateKey) ?? true;
    expandedState.set(stateKey, !was);
    chev.textContent = !was ? '▼' : '▶';
    body.style.display = !was ? 'block' : 'none';
  });
  header.appendChild(chev);

  // Top-group checkbox
  const allEntries = group.subGroups.flatMap((sg) => sg.entries);
  const topCbSelector = `[data-sidebar-top-cb="${group.id}"]`;
  const tcb = document.createElement('input');
  tcb.type = 'checkbox';
  tcb.className = 'sidebar-checkbox';
  tcb.setAttribute('data-sidebar-top-cb', group.id);
  tcb.addEventListener('change', () => {
    void handleGroupCheck(allEntries, tcb.checked).then(() => {
      refreshParentCb(topCbSelector, allEntries);
      // Also refresh sub-group checkboxes
      for (const sg of group.subGroups) {
        if (sg.prefix) {
          refreshParentCb(`[data-sidebar-group-cb="${CSS.escape(sg.prefix)}"]`, sg.entries);
        }
      }
    });
  });
  header.appendChild(tcb);

  // Title
  const title = document.createElement('span');
  title.className = 'sidebar-section-title';
  title.textContent = group.title;
  title.title = `${group.totalLabels} label types, ${group.totalCount} total nodes`;
  header.appendChild(title);

  // Count
  const badge = document.createElement('span');
  badge.className = 'sidebar-badge';
  badge.textContent = String(group.totalCount);
  header.appendChild(badge);

  // Body
  const body = document.createElement('div');
  body.className = 'sidebar-section-body';
  section.appendChild(body);

  // Core has one flat sub-group (no sub-headers); Overlays have named sub-groups
  const showSubHeaders = group.subGroups.length > 1 || (group.subGroups.length === 1 && group.subGroups[0]!.prefix !== '');
  for (const sub of group.subGroups) {
    body.appendChild(renderSubGroup(sub, showSubHeaders ? 1 : 0, showSubHeaders, allEntries, topCbSelector));
  }

  return section;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Extract unique dot-prefixes from a label distribution.
 */
function extractPrefixes(dist: Record<string, number>): string[] {
  const prefixes = new Set<string>();
  for (const label of Object.keys(dist)) {
    const dot = label.indexOf('.');
    if (dot > 0) prefixes.add(label.slice(0, dot));
  }
  return [...prefixes].sort();
}

/**
 * Render the Foundation selector dropdown.
 */
function renderFoundationSelector(prefixes: string[], onChange: (prefix: string | null) => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'sidebar-foundation';
  wrapper.style.padding = '8px 12px';
  wrapper.style.borderBottom = '1px solid var(--border)';

  const label = document.createElement('label');
  label.style.fontSize = '11px';
  label.style.fontWeight = '600';
  label.style.color = 'var(--muted)';
  label.style.textTransform = 'uppercase';
  label.style.letterSpacing = '0.05em';
  label.style.display = 'block';
  label.style.marginBottom = '4px';
  label.textContent = 'Foundation';
  wrapper.appendChild(label);

  const select = document.createElement('select');
  select.style.width = '100%';
  select.style.padding = '4px 6px';
  select.style.fontSize = '12px';
  select.style.borderRadius = '4px';
  select.style.border = '1px solid var(--border)';
  select.style.background = 'var(--surface)';
  select.style.color = 'var(--text)';
  select.style.cursor = 'pointer';

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none — all groups equal)';
  select.appendChild(noneOpt);

  for (const prefix of prefixes) {
    const opt = document.createElement('option');
    opt.value = prefix;
    opt.textContent = prefix;
    if (prefix === foundationPrefix) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    const val = select.value || null;
    onChange(val);
  });

  wrapper.appendChild(select);
  return wrapper;
}

/**
 * Rebuild the sidebar tree with current foundation selection.
 * Preserves checked/expanded state across rebuilds.
 */
function rebuildTree(): void {
  if (!sidebarContainer) return;
  const dist = cachedDist;
  if (Object.keys(dist).length === 0) return;

  // Remove existing tree (but keep header and foundation selector)
  const oldTree = sidebarContainer.querySelector('.sidebar-tree');
  if (oldTree) oldTree.remove();

  const groups = buildGroups(dist, foundationPrefix);

  const tree = document.createElement('div');
  tree.className = 'sidebar-tree';
  for (const group of groups) {
    tree.appendChild(renderTopGroup(group));
  }
  sidebarContainer.appendChild(tree);

  // Re-check any previously checked labels
  for (const [label, checked] of checkedState.entries()) {
    if (checked) {
      const cb = sidebarContainer.querySelector<HTMLInputElement>(
        `[data-sidebar-cb="${CSS.escape(label)}"]`
      );
      if (cb) cb.checked = true;
    }
  }
}

/** Return the labels currently checked in the sidebar. */
export function getCheckedLabels(): string[] {
  const labels: string[] = [];
  for (const [label, checked] of checkedState.entries()) {
    if (checked) labels.push(label);
  }
  return labels.sort();
}

export async function installSidebar(container: HTMLElement): Promise<void> {
  sidebarRoot = container;
  sidebarContainer = container;
  container.innerHTML = '';
  container.className = 'sidebar';

  // Header
  const header = document.createElement('div');
  header.className = 'sidebar-header';
  header.textContent = 'Node Labels';
  container.appendChild(header);

  // Loading
  const loading = document.createElement('div');
  loading.style.padding = '12px';
  loading.style.color = 'var(--muted)';
  loading.style.fontSize = '12px';
  loading.textContent = 'Loading labels…';
  container.appendChild(loading);

  try {
    const resp = await fetch('/api/stats');
    if (!resp.ok) throw new Error(`/api/stats returned ${resp.status}`);
    const stats = await resp.json() as { labelDistribution?: Record<string, number> };
    const dist = stats.labelDistribution ?? {};

    if (Object.keys(dist).length === 0) {
      loading.textContent = 'No labels found in this graph.';
      return;
    }

    loading.remove();
    cachedDist = dist;

    // Seed the color cache with golden-ratio stepping for maximum
    // visual separation within each label group.
    seedColorMap(dist);

    // Foundation selector
    const prefixes = extractPrefixes(dist);
    if (prefixes.length > 1) {
      const selector = renderFoundationSelector(prefixes, (prefix) => {
        foundationPrefix = prefix;
        rebuildTree();
      });
      container.appendChild(selector);
    }

    // Initial tree build
    const groups = buildGroups(dist, foundationPrefix);

    const tree = document.createElement('div');
    tree.className = 'sidebar-tree';
    for (const group of groups) {
      tree.appendChild(renderTopGroup(group));
    }
    container.appendChild(tree);

  } catch (err) {
    loading.textContent = `Failed to load labels: ${String(err)}`;
    console.error('sidebar installSidebar failed:', err);
  }
}
