/**
 * Chat drawer — left-side slide-out, 1/3 viewport width.
 *
 * UX shape:
 *   - ☰ button in the toolbar opens the drawer.
 *   - When the drawer is open, the toolbar search input + view tabs
 *     stay visible (the user can switch views to see search results
 *     light up), but the literal search box becomes inactive (NL is
 *     active inside the drawer instead).
 *   - The drawer has:
 *       * a "Solution Intel chat" header with a × close button
 *       * a scrolling message log (user / assistant turns)
 *       * an input textarea at the bottom with a send button
 *   - Each assistant message includes:
 *       * narrative text (Markdown rendered minimally)
 *       * inline node-id citations that are clickable buttons; clicking
 *         focuses the constellation on that node
 *       * an "evidence" toggle revealing cited nodes + the embed query
 *       * a "Save This" button that POSTs to /api/kb
 *
 * State:
 *   - conversation messages persist in localStorage keyed by snapshot
 *     hash (a different graph = a different thread)
 *   - drawer-open state persists in localStorage
 */

import type { ViewHandle } from '../views/types.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Only on assistant messages. */
  citedNodes?: string[];
  /** Local id for DOM tracking. */
  id: string;
}

interface ChatState {
  open: boolean;
  snapshotHash: string;
  messages: ChatMessage[];
}

interface ChatBootOptions {
  nlEnabled: boolean;
  snapshotHash: string;
  getCurrentViewHandle: () => ViewHandle;
}

const STORAGE_PREFIX = 'polygraph-viz:chat:';

function loadState(snapshotHash: string): ChatState {
  const key = STORAGE_PREFIX + snapshotHash;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatState;
      return { ...parsed, snapshotHash };
    }
  } catch {
    // Why: a corrupted entry shouldn't break the UI; reset gracefully.
  }
  const drawerOpen = localStorage.getItem(STORAGE_PREFIX + 'open') === '1';
  return { open: drawerOpen, snapshotHash, messages: [] };
}

function saveState(state: ChatState): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + state.snapshotHash, JSON.stringify(state));
    localStorage.setItem(STORAGE_PREFIX + 'open', state.open ? '1' : '0');
  } catch {
    // Why: storage may be blocked under strict iframe sandboxing. Tolerate.
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal Markdown-ish rendering: just enough to render the LLM's
 * answers nicely. Backtick-wrapped tokens become clickable citation
 * buttons. Double-line-breaks become paragraph breaks.
 *
 * Why not a full Markdown lib: would balloon the bundle for 1% gain.
 */
function renderAnswerHtml(
  text: string,
  onCitationClick: (nodeId: string) => void,
  container: HTMLElement,
): void {
  container.innerHTML = '';
  // Split into paragraphs.
  const paras = text.split(/\n\n+/);
  for (const para of paras) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    // Tokenize: keep backtick spans as citations.
    const parts = para.split(/(`[^`]+`)/);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`')) {
        const id = part.slice(1, -1);
        const btn = document.createElement('button');
        btn.className = 'chat-citation';
        btn.type = 'button';
        btn.textContent = id;
        btn.title = `Focus ${id} in the graph view`;
        btn.addEventListener('click', () => onCitationClick(id));
        p.appendChild(btn);
      } else if (part) {
        // Render plain text with light formatting:
        //  - **bold**
        //  - headings (## or # at start of line)
        if (part.startsWith('# ') || part.startsWith('## ') || part.startsWith('### ')) {
          // Heading inside a paragraph — render as <strong> on its own line.
          const headText = part.replace(/^#+\s+/, '');
          const strong = document.createElement('strong');
          strong.className = 'chat-heading';
          strong.textContent = headText;
          p.appendChild(strong);
        } else {
          // **bold** runs
          const boldParts = part.split(/(\*\*[^*]+\*\*)/);
          for (const bp of boldParts) {
            if (bp.startsWith('**') && bp.endsWith('**')) {
              const b = document.createElement('strong');
              b.textContent = bp.slice(2, -2);
              p.appendChild(b);
            } else if (bp) {
              p.appendChild(document.createTextNode(bp));
            }
          }
        }
      }
    }
    container.appendChild(p);
  }
}

export function installChat(opts: ChatBootOptions): void {
  // If NL is off on the server, don't render anything.
  if (!opts.nlEnabled) return;

  // ── Mount the drawer + the toolbar toggle button ──────────────
  const app = document.getElementById('app');
  if (!app) return;

  const drawer = document.createElement('aside');
  drawer.id = 'chat-drawer';
  drawer.setAttribute('aria-label', 'Chat with the graph');
  drawer.innerHTML = `
    <header>
      <h2>Chat</h2>
      <button type="button" class="chat-close" aria-label="Close chat">×</button>
    </header>
    <div class="chat-log" role="log" aria-live="polite"></div>
    <form class="chat-input-row">
      <textarea
        class="chat-input"
        rows="2"
        placeholder="Ask about the graph…"
        aria-label="Chat input"></textarea>
      <button type="submit" class="chat-send" disabled>Send</button>
    </form>
  `;
  app.appendChild(drawer);

  // Toolbar toggle (☰) — inserted at the very left of the toolbar.
  const toolbar = document.getElementById('toolbar');
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'chat-toggle';
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', 'Toggle chat drawer');
  toggleBtn.textContent = '☰';
  toolbar?.insertBefore(toggleBtn, toolbar.firstChild);

  const state = loadState(opts.snapshotHash);

  function applyOpen(open: boolean): void {
    state.open = open;
    document.body.classList.toggle('chat-open', open);
    drawer.classList.toggle('open', open);
    saveState(state);
  }

  toggleBtn.addEventListener('click', () => applyOpen(!state.open));
  drawer.querySelector('.chat-close')?.addEventListener('click', () => applyOpen(false));

  const logEl = drawer.querySelector<HTMLDivElement>('.chat-log')!;
  const inputEl = drawer.querySelector<HTMLTextAreaElement>('.chat-input')!;
  const sendBtn = drawer.querySelector<HTMLButtonElement>('.chat-send')!;
  const formEl = drawer.querySelector<HTMLFormElement>('.chat-input-row')!;

  inputEl.addEventListener('input', () => {
    sendBtn.disabled = inputEl.value.trim().length === 0;
  });

  function focusNode(nodeId: string): void {
    const handle = opts.getCurrentViewHandle();
    handle.focus(nodeId);
  }

  function renderMessage(msg: ChatMessage): HTMLElement {
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg-${msg.role}`;
    el.dataset['id'] = msg.id;

    if (msg.role === 'user') {
      const text = document.createElement('div');
      text.className = 'chat-msg-body';
      text.textContent = msg.content;
      el.appendChild(text);
    } else {
      const body = document.createElement('div');
      body.className = 'chat-msg-body';
      renderAnswerHtml(msg.content, focusNode, body);
      el.appendChild(body);

      if (msg.citedNodes && msg.citedNodes.length > 0) {
        const tools = document.createElement('div');
        tools.className = 'chat-msg-tools';

        const evidenceBtn = document.createElement('button');
        evidenceBtn.type = 'button';
        evidenceBtn.className = 'chat-tool';
        evidenceBtn.textContent = `Evidence (${msg.citedNodes.length})`;
        const evidencePanel = document.createElement('div');
        evidencePanel.className = 'chat-evidence';
        evidencePanel.hidden = true;
        evidencePanel.innerHTML = `<p>Cited nodes (click to focus):</p>`;
        const ul = document.createElement('ul');
        for (const nid of msg.citedNodes) {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'chat-citation';
          btn.textContent = nid;
          btn.addEventListener('click', () => focusNode(nid));
          li.appendChild(btn);
          ul.appendChild(li);
        }
        evidencePanel.appendChild(ul);
        evidenceBtn.addEventListener('click', () => {
          evidencePanel.hidden = !evidencePanel.hidden;
        });

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'chat-tool';
        saveBtn.textContent = 'Save This';
        saveBtn.title = 'Save this answer as canonical for future queries';
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          try {
            // Find the prior user message; that's the query.
            const idx = state.messages.findIndex((m) => m.id === msg.id);
            const prior = idx > 0 ? state.messages[idx - 1] : null;
            const query = prior?.role === 'user' ? prior.content : '';
            const r = await fetch('/api/kb', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query,
                answer: msg.content,
                citedNodes: msg.citedNodes ?? [],
              }),
            });
            if (r.ok) {
              saveBtn.textContent = 'Saved ✓';
            } else {
              saveBtn.textContent = 'Save failed';
              saveBtn.disabled = false;
            }
          } catch {
            saveBtn.textContent = 'Save failed';
            saveBtn.disabled = false;
          }
        });

        tools.appendChild(evidenceBtn);
        tools.appendChild(saveBtn);
        el.appendChild(tools);
        el.appendChild(evidencePanel);
      }
    }

    return el;
  }

  function rerenderAll(): void {
    logEl.innerHTML = '';
    for (const msg of state.messages) {
      logEl.appendChild(renderMessage(msg));
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendMessage(msg: ChatMessage): HTMLElement {
    state.messages.push(msg);
    const el = renderMessage(msg);
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    saveState(state);
    return el;
  }

  function updateMessageText(id: string, content: string, citedNodes: string[]): void {
    const msg = state.messages.find((m) => m.id === id);
    if (!msg) return;
    msg.content = content;
    msg.citedNodes = citedNodes;
    const el = logEl.querySelector<HTMLDivElement>(`[data-id="${id}"]`);
    if (el) {
      el.replaceWith(renderMessage(msg));
      logEl.scrollTop = logEl.scrollHeight;
    }
    saveState(state);
  }

  async function send(query: string): Promise<void> {
    sendBtn.disabled = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    const userMsg: ChatMessage = {
      role: 'user',
      content: query,
      id: `m-${Date.now()}-u`,
    };
    appendMessage(userMsg);

    const assistantId = `m-${Date.now()}-a`;
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      citedNodes: [],
      id: assistantId,
    };
    appendMessage(assistantMsg);

    // Build the history that goes to /api/chat: all messages except the
    // one just appended. We exclude the empty assistant placeholder.
    const history = state.messages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content && m.content.length > 0);

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          history: history.slice(0, -1), // drop the just-appended user message; it's `query`
        }),
      });
      if (!r.ok || !r.body) {
        updateMessageText(
          assistantId,
          `_Sorry — chat failed: HTTP ${r.status}_`,
          [],
        );
        return;
      }
      // SSE parser. Read text chunks; each event-block is separated by
      // double newline.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumText = '';
      let citedNodes: string[] = [];
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        // Process all complete events.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = raw.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (event === 'meta') {
            try {
              const obj = JSON.parse(data) as { citedNodes?: string[] };
              if (obj.citedNodes) citedNodes = obj.citedNodes;
            } catch {
              // Why: tolerate the rare malformed frame
            }
          } else if (event === 'token') {
            try {
              const obj = JSON.parse(data) as { text?: string };
              if (obj.text) {
                accumText += obj.text;
                updateMessageText(assistantId, accumText, citedNodes);
              }
            } catch {
              // see above
            }
          } else if (event === 'done') {
            done = true;
            break;
          } else if (event === 'error') {
            try {
              const obj = JSON.parse(data) as { detail?: string };
              accumText += `\n\n_(stream error: ${obj.detail ?? 'unknown'})_`;
              updateMessageText(assistantId, accumText, citedNodes);
            } catch {
              // see above
            }
          }
        }
      }
      // Final ensured update.
      updateMessageText(assistantId, accumText, citedNodes);
    } catch (err) {
      updateMessageText(
        assistantId,
        `_Sorry — chat failed: ${String(err)}_`,
        [],
      );
    } finally {
      sendBtn.disabled = inputEl.value.trim().length === 0;
    }
  }

  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = inputEl.value.trim();
    if (!v) return;
    void send(v);
  });

  // Submit on Enter (Shift+Enter = newline).
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const v = inputEl.value.trim();
      if (v) void send(v);
    }
  });

  // Initial render of saved messages.
  rerenderAll();
  applyOpen(state.open);
}
