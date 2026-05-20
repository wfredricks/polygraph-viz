/**
 * Toolbar controller — view tabs + search box.
 *
 * Theme toggle lives in theme.ts because it owns its own storage; toolbar
 * here only owns view selection and search debouncing.
 *
 * Slash-prefix carve-out: when the search input starts with `/`, the
 * command palette intercepts. The literal-substring onSearch handler
 * does not fire. This keeps the parser logic in commands.ts (the single
 * source of truth) and the toolbar dumb about commands.
 */

export type ViewKey = 'force' | 'chord' | 'sankey';

export interface ToolbarHandlers {
  onViewChange: (view: ViewKey) => void;
  onSearch: (query: string) => void;
}

function isViewKey(v: string): v is ViewKey {
  return v === 'force' || v === 'chord' || v === 'sankey';
}

export function installToolbar(handlers: ToolbarHandlers): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(
    '#view-tabs button[data-view]',
  );
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset['view'];
      if (!view || !isViewKey(view)) return;
      tabs.forEach((b) => b.classList.toggle('active', b === btn));
      handlers.onViewChange(view);
    });
  });

  const search = document.getElementById('search') as HTMLInputElement | null;
  if (search) {
    let t: number | undefined;
    search.addEventListener('input', () => {
      // Slash carve-out: when the input starts with /, the command
      // palette owns the input. Clear any active search filter and
      // skip the substring handler.
      if (search.value.startsWith('/')) {
        handlers.onSearch('');
        if (t !== undefined) window.clearTimeout(t);
        return;
      }
      // Why: debounce so we do not run a filter on every keystroke
      // when a graph has thousands of nodes.
      if (t !== undefined) window.clearTimeout(t);
      t = window.setTimeout(() => handlers.onSearch(search.value), 120);
    });
  }
}
