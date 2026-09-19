/**
 * Generate page — settings form + GSG API call + results display.
 *
 * Flow: user clicks ✦ → settings form → generate → results overlay.
 */

import { getCheckedLabels } from './sidebar.js';

// ─── Configuration ─────────────────────────────────────────────────────────

function getGsgEndpoint(): string {
  return document.body.dataset['gsgEndpoint'] ?? 'http://localhost:4446';
}

function getGraphEndpoint(): string {
  return window.location.origin;
}

// ─── Narrative types with default goals ────────────────────────────────────

interface NarrativePreset {
  label: string;
  goals: string[];
}

const NARRATIVE_PRESETS: Record<string, NarrativePreset> = {
  'story': {
    label: 'Story / Novel',
    goals: [
      'The writing should be vivid and cinematic — show, don\'t tell',
      'Technical concepts must be dramatized through character experience, not explained didactically',
      'The scene should feel lived-in — sensory details, not narration from a distance',
    ],
  },
  'technical': {
    label: 'Technical',
    goals: [
      'The output should be precise and technically accurate',
      'Use proper terminology and cite specific data from the graph',
      'Structure the content with clear sections and logical flow',
    ],
  },
  'professional': {
    label: 'Professional / Business',
    goals: [
      'The tone should be professional and concise',
      'Key findings and recommendations should be clearly stated',
      'All claims should be grounded in the graph data with traceable references',
    ],
  },
  'academic': {
    label: 'Academic',
    goals: [
      'Follow academic conventions — thesis, evidence, analysis, conclusion',
      'Every claim must be supported by graph data with proper citations',
      'Maintain objective, analytical tone throughout',
    ],
  },
  'summary': {
    label: 'Executive Summary',
    goals: [
      'Distill the key points into a concise, scannable overview',
      'Lead with the most important findings',
      'Keep technical detail minimal — link to graph nodes for depth',
    ],
  },
  'custom': {
    label: 'Custom',
    goals: [],
  },
};

const LENGTH_OPTIONS: Record<string, { label: string; value: object | null }> = {
  'short-scene':  { label: 'Short scene (500–1,000 words)', value: { kind: 'qualitative', size: 'short-scene' } },
  'full-scene':   { label: 'Full scene (1,500–2,500 words)', value: { kind: 'qualitative', size: 'full-scene' } },
  'full-chapter': { label: 'Full chapter (3,000–5,000 words)', value: { kind: 'qualitative', size: 'full-chapter' } },
  '500':   { label: '~500 words', value: { kind: 'words', count: 500 } },
  '1000':  { label: '~1,000 words', value: { kind: 'words', count: 1000 } },
  '2000':  { label: '~2,000 words', value: { kind: 'words', count: 2000 } },
  '3000':  { label: '~3,000 words', value: { kind: 'words', count: 3000 } },
};

// ─── Types (mirror of GSG response) ───────────────────────────────────────

interface Citation { nodeId: string; nodeLabel: string; textSpan: string; }
interface GoalResult { text: string; status: 'pass' | 'deficient'; deficiency?: string; }
interface Iteration {
  version: number;
  evaluation: { goals: GoalResult[]; passCount: number; deficiencyCount: number; lengthStatus: string };
  reflection: string;
}
interface GsgResponse {
  draft: { id: string; version: number; content: string; citations: Citation[]; wordCount: number };
  trail: { iterations: Iteration[]; finalVersion: number; converged: boolean };
  error?: string;
}

// ─── Overlay management ───────────────────────────────────────────────────

let overlay: HTMLElement | null = null;

function createOverlay(): HTMLElement {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'generate-overlay';
  overlay.className = 'gen-overlay';
  document.body.appendChild(overlay);
  return overlay;
}

function showOverlay(html: string): void {
  const el = createOverlay();
  el.innerHTML = `
    <div class="gen-container">
      <div class="gen-header">
        <h2>✦ Graph Story Generator</h2>
        <button class="gen-close" aria-label="Close">✕</button>
      </div>
      <div class="gen-body">${html}</div>
    </div>`;
  el.style.display = 'flex';
  el.querySelector('.gen-close')?.addEventListener('click', hideOverlay);
  el.addEventListener('click', (e) => { if (e.target === el) hideOverlay(); });
}

function hideOverlay(): void {
  if (overlay) overlay.style.display = 'none';
}

// ─── Settings form ────────────────────────────────────────────────────────

function showSettings(labels: string[]): void {
  const presetOptions = Object.entries(NARRATIVE_PRESETS)
    .map(([key, p]) => `<option value="${key}"${key === 'story' ? ' selected' : ''}>${p.label}</option>`)
    .join('');

  const lengthOptions = Object.entries(LENGTH_OPTIONS)
    .map(([key, o]) => `<option value="${key}"${key === 'full-scene' ? ' selected' : ''}>${o.label}</option>`)
    .join('');

  const defaultGoals = NARRATIVE_PRESETS['story']!.goals.join('\n');

  showOverlay(`
    <form id="gen-settings-form" class="gen-settings">
      <div class="gen-field">
        <label>Graph labels (from sidebar)</label>
        <div class="gen-labels">${labels.map((l) => `<span class="gen-label-tag">${l}</span>`).join(' ')}</div>
      </div>

      <div class="gen-field">
        <label for="gen-narrative">Narrative type</label>
        <select id="gen-narrative" class="gen-select">
          ${presetOptions}
        </select>
      </div>

      <div class="gen-field">
        <label for="gen-length">Expected length</label>
        <select id="gen-length" class="gen-select">
          ${lengthOptions}
        </select>
      </div>

      <div class="gen-field">
        <label for="gen-goals">Goals (one per line)</label>
        <textarea id="gen-goals" class="gen-textarea" rows="4">${defaultGoals}</textarea>
      </div>

      <div class="gen-field">
        <label for="gen-backstory">Backstory snippets (one per line, optional)</label>
        <textarea id="gen-backstory" class="gen-textarea" rows="3" placeholder="Optional authored fragments to weave into the narrative…"></textarea>
      </div>

      <div class="gen-field">
        <label for="gen-iterations">Max iterations</label>
        <select id="gen-iterations" class="gen-select">
          <option value="1">1 (no revision)</option>
          <option value="2" selected>2</option>
          <option value="3">3</option>
          <option value="5">5</option>
        </select>
      </div>

      <div class="gen-actions">
        <button type="button" class="gen-btn gen-btn-cancel">Cancel</button>
        <button type="submit" class="gen-btn gen-btn-generate">✦ Generate</button>
      </div>
    </form>`);

  // Wire narrative type → goals preset
  const narrativeSelect = document.getElementById('gen-narrative') as HTMLSelectElement;
  const goalsTextarea = document.getElementById('gen-goals') as HTMLTextAreaElement;
  narrativeSelect?.addEventListener('change', () => {
    const preset = NARRATIVE_PRESETS[narrativeSelect.value];
    if (preset && narrativeSelect.value !== 'custom') {
      goalsTextarea.value = preset.goals.join('\n');
    }
  });

  // Wire cancel
  overlay?.querySelector('.gen-btn-cancel')?.addEventListener('click', hideOverlay);

  // Wire submit
  document.getElementById('gen-settings-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const lengthKey = (document.getElementById('gen-length') as HTMLSelectElement).value;
    const goalsRaw = (document.getElementById('gen-goals') as HTMLTextAreaElement).value;
    const backstoryRaw = (document.getElementById('gen-backstory') as HTMLTextAreaElement).value;
    const maxIterations = parseInt((document.getElementById('gen-iterations') as HTMLSelectElement).value, 10);

    const goals = goalsRaw.split('\n').map((g) => g.trim()).filter(Boolean);
    const backstory = backstoryRaw.split('\n').map((s) => s.trim()).filter(Boolean);
    const expectedLength = LENGTH_OPTIONS[lengthKey]?.value ?? null;

    if (goals.length === 0) {
      alert('At least one goal is required.');
      return;
    }

    void runGenerate(labels, goals, backstory, expectedLength, maxIterations);
  });
}

// ─── Generate + results ───────────────────────────────────────────────────

function showLoading(): void {
  showOverlay(`
    <div class="gen-loading">
      <div class="gen-spinner"></div>
      <p>Generating from graph context…</p>
      <p class="gen-loading-detail">Assembling context → Generating draft → Evaluating goals</p>
    </div>`);
}

function showError(message: string): void {
  showOverlay(`<div class="gen-error"><h3>Generation Failed</h3><p>${message}</p></div>`);
}

function formatDraftContent(content: string): string {
  return content.replace(/\[([a-zA-Z0-9._-]+)\]/g, (_match, nodeId) => {
    return `<span class="gen-inline-cite" title="Graph node: ${nodeId}">[${String(nodeId).slice(0, 8)}]</span>`;
  });
}

function renderGoal(g: GoalResult): string {
  const icon = g.status === 'pass' ? '✅' : '⚠️';
  const deficiency = g.deficiency ? `<div class="gen-deficiency">${g.deficiency}</div>` : '';
  return `<div class="gen-goal">${icon} ${g.text}${deficiency}</div>`;
}

function showResult(data: GsgResponse): void {
  const draft = data.draft;
  const trail = data.trail;
  const convergedBadge = trail.converged
    ? '<span class="gen-badge gen-badge-pass">Converged</span>'
    : `<span class="gen-badge gen-badge-warn">v${trail.finalVersion} (max iterations)</span>`;

  const trailHtml = trail.iterations.map((it) => {
    const ev = it.evaluation;
    return `<div class="gen-iteration">
      <div class="gen-iteration-header">v${it.version}: ${ev.passCount}/${ev.goals.length} goals passed, length=${ev.lengthStatus}</div>
      ${ev.goals.map(renderGoal).join('')}
    </div>`;
  }).join('');

  showOverlay(`
    <div class="gen-result">
      <div class="gen-meta">
        ${convergedBadge}
        <span class="gen-meta-item">${draft.wordCount} words</span>
        <span class="gen-meta-item">${draft.citations.length} citations</span>
        <span class="gen-meta-item">${trail.iterations.length} iteration${trail.iterations.length !== 1 ? 's' : ''}</span>
      </div>

      <div class="gen-draft">
        ${formatDraftContent(draft.content).split('\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('')}
      </div>

      <details class="gen-details">
        <summary>Evaluation Trail</summary>
        ${trailHtml}
      </details>

      <details class="gen-details">
        <summary>Citations (${draft.citations.length})</summary>
        <div class="gen-citations">
          ${draft.citations.map((c) =>
            `<div class="gen-cite-row"><span class="gen-citation">[${c.nodeId.slice(0, 8)}]</span> <span class="gen-cite-label">${c.nodeLabel}</span></div>`
          ).join('')}
        </div>
      </details>
    </div>`);
}

async function runGenerate(
  labels: string[],
  goals: string[],
  backstory: string[],
  expectedLength: object | null,
  maxIterations: number,
): Promise<void> {
  showLoading();

  const request: Record<string, unknown> = {
    graphEndpoint: getGraphEndpoint(),
    queries: labels.map((label) => ({ labels: [label], hops: 1 })),
    backstory,
    goals,
    maxIterations,
  };
  if (expectedLength) request['expectedLength'] = expectedLength;

  try {
    const resp = await fetch(`${getGsgEndpoint()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      showError((err as { error?: string }).error ?? `HTTP ${resp.status}`);
      return;
    }

    const data = (await resp.json()) as GsgResponse;
    if (data.error) { showError(data.error); return; }
    showResult(data);
  } catch (err) {
    showError(String(err));
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function openGenerate(): Promise<void> {
  const labels = getCheckedLabels();
  if (labels.length === 0) {
    showError('No labels checked in the sidebar. Check some labels first to provide graph context for generation.');
    return;
  }
  showSettings(labels);
}
