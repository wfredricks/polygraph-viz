/**
 * Command palette — floating dropdown anchored to an input element.
 *
 * Combo-box semantics:
 *   - User types `/` → palette opens with all commands.
 *   - User keeps typing (e.g. `/b`) → palette filters to matching commands.
 *   - User can click a chevron on the input to open the palette without typing.
 *   - ↑/↓ navigate the list, ↵ runs the highlighted command,
 *     Tab completes the command name into the input,
 *     Esc dismisses the palette.
 *
 * Argument coaching:
 *   - When the input is a known command but missing required args
 *     (e.g. user pressed Space after `/label`), the palette shows an
 *     "argument hint" panel with a graph-grounded example
 *     ("Try: /label sw.feature").
 *   - When an argument value is being typed, the palette shows
 *     auto-complete suggestions from the actual graph (label names,
 *     node ids).
 *
 * One palette can be installed on multiple input elements; each gets
 * its own anchor + visibility. The same command registry serves all.
 */

import type { CommandContext, CommandSpec } from './commands.js';
import {
  COMMANDS,
  filterCommands,
  parseCommand,
  exampleForArg,
} from './commands.js';
import type { GraphExport, VizNode } from '../../types.js';

interface PaletteInstance {
  el: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  open: boolean;
  selectedIndex: number;
  currentList: CommandSpec[];
  reposition: () => void;
}

interface InstallOptions {
  input: HTMLInputElement | HTMLTextAreaElement;
  /**
   * Called when a command is successfully run. The input's existing
   * Enter behavior (search submit / chat send) is suppressed when the
   * palette handled the keystroke.
   */
  onRun: (cmd: CommandSpec, args: string[]) => void;
  /**
   * Context for `run()` invocations. Reused per command; the caller's
   * own state must reach into here.
   */
  ctx: CommandContext;
}

/** Singleton wiring tracked at module scope so we can dispose later. */
const installed: PaletteInstance[] = [];

function makeRowEl(spec: CommandSpec, idx: number, selected: boolean): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'cmd-row' + (selected ? ' cmd-row-selected' : '');
  row.dataset['index'] = String(idx);

  const name = document.createElement('span');
  name.className = 'cmd-row-name';
  const argList = spec.args.map((a) => ` <${a.name}>`).join('');
  name.textContent = spec.name + argList;

  const desc = document.createElement('span');
  desc.className = 'cmd-row-desc';
  desc.textContent = spec.description;

  const cat = document.createElement('span');
  cat.className = `cmd-row-cat cmd-row-cat-${spec.category}`;
  cat.textContent = spec.category;

  row.appendChild(name);
  row.appendChild(desc);
  row.appendChild(cat);
  return row;
}

function makeHintEl(text: string): HTMLElement {
  const hint = document.createElement('div');
  hint.className = 'cmd-hint';
  hint.textContent = text;
  return hint;
}

/**
 * Install the palette on one input element. Returns a teardown function.
 */
export function installCommandPalette(opts: InstallOptions): () => void {
  const { input, onRun, ctx } = opts;

  // Build the floating panel.
  const palette = document.createElement('div');
  palette.className = 'cmd-palette';
  palette.setAttribute('role', 'listbox');
  palette.hidden = true;
  document.body.appendChild(palette);

  // Build the chevron button that opens the palette on click.
  // Anchored as a sibling of the input via absolute position.
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'cmd-chevron';
  chevron.title = 'Slash commands';
  chevron.textContent = '/';
  chevron.setAttribute('aria-label', 'Open slash command palette');

  // Find a sensible parent for the chevron — the input's offsetParent
  // works for both the toolbar search and the chat input row.
  const parent = input.parentElement;
  if (parent) {
    parent.appendChild(chevron);
    parent.classList.add('has-cmd-chevron');
  }

  const instance: PaletteInstance = {
    el: palette,
    input,
    open: false,
    selectedIndex: 0,
    currentList: COMMANDS,
    reposition: () => {
      const rect = input.getBoundingClientRect();
      // Open above the input when there's not enough room below.
      const spaceBelow = window.innerHeight - rect.bottom;
      const desiredHeight = 280;
      if (spaceBelow < desiredHeight + 12 && rect.top > desiredHeight) {
        palette.style.top = `${rect.top - desiredHeight - 4}px`;
        palette.style.maxHeight = `${desiredHeight}px`;
      } else {
        palette.style.top = `${rect.bottom + 4}px`;
        palette.style.maxHeight = `${Math.max(160, spaceBelow - 12)}px`;
      }
      palette.style.left = `${rect.left}px`;
      palette.style.width = `${Math.max(rect.width, 380)}px`;
    },
  };
  installed.push(instance);

  function rebuild(): void {
    const text = input.value;
    const trimmed = text.trim();

    palette.innerHTML = '';

    // Argument coaching: if the user has typed a complete known command
    // name followed by space (or by another token), and that command
    // requires args, show an argument hint + auto-complete.
    if (trimmed.startsWith('/') && trimmed.includes(' ')) {
      const tokens = trimmed.split(/\s+/);
      const cmdName = tokens[0]!.toLowerCase();
      const spec = COMMANDS.find((c) => c.name === cmdName);
      if (spec) {
        const userArgs = tokens.slice(1);
        const argIdx = Math.max(0, userArgs.length - 1);
        const currentArg = spec.args[argIdx];
        if (currentArg) {
          const partial = userArgs[argIdx] ?? '';
          const example = exampleForArg(currentArg, ctx.graph);
          palette.appendChild(
            makeHintEl(
              `${spec.name} <${currentArg.name}> — ${spec.description}\nTry: ${example}`,
            ),
          );
          // Auto-complete: filter actual graph values by `partial`.
          const suggestions = argumentSuggestions(
            currentArg.exampleSourceKind,
            partial,
            ctx.graph,
          );
          if (suggestions.length > 0) {
            instance.currentList = []; // arg suggestions, not commands
            const list = document.createElement('div');
            list.className = 'cmd-list';
            suggestions.forEach((s, i) => {
              const row = document.createElement('button');
              row.type = 'button';
              row.className =
                'cmd-row cmd-arg-row' + (i === instance.selectedIndex ? ' cmd-row-selected' : '');
              row.dataset['index'] = String(i);
              row.dataset['mode'] = 'arg';
              row.textContent = s;
              row.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                completeArg(s);
              });
              list.appendChild(row);
            });
            palette.appendChild(list);
            // Track suggestions so up/down/enter works on them.
            (instance as PaletteInstance & {
              argSuggestions?: string[];
              mode?: 'cmd' | 'arg';
            }).argSuggestions = suggestions;
            (instance as PaletteInstance & {
              mode?: 'cmd' | 'arg';
            }).mode = 'arg';
            // Clamp selectedIndex.
            instance.selectedIndex = Math.min(instance.selectedIndex, suggestions.length - 1);
          } else {
            (instance as PaletteInstance & { mode?: 'cmd' | 'arg' }).mode = 'arg';
            instance.currentList = [];
            (instance as PaletteInstance & { argSuggestions?: string[] }).argSuggestions = [];
          }
          show();
          return;
        }
      }
    }

    // Otherwise, command-name dropdown.
    const prefix = trimmed.startsWith('/') ? trimmed.split(/\s+/)[0]! : '';
    const list = prefix ? filterCommands(prefix) : COMMANDS;
    instance.currentList = list;
    (instance as PaletteInstance & { mode?: 'cmd' | 'arg' }).mode = 'cmd';
    if (instance.selectedIndex >= list.length) instance.selectedIndex = 0;

    if (list.length === 0) {
      palette.appendChild(makeHintEl('No command matches.'));
      show();
      return;
    }

    // Group by category but render as a flat list with category badges.
    const listEl = document.createElement('div');
    listEl.className = 'cmd-list';
    list.forEach((spec, i) => {
      const row = makeRowEl(spec, i, i === instance.selectedIndex);
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault(); // keep focus on input
        selectAndRun(i);
      });
      listEl.appendChild(row);
    });
    palette.appendChild(listEl);

    const footer = document.createElement('div');
    footer.className = 'cmd-footer';
    footer.innerHTML = `<span>↑↓ navigate · ↵ run · tab complete · esc cancel</span><span>${list.length} command${list.length === 1 ? '' : 's'}</span>`;
    palette.appendChild(footer);

    show();
  }

  function argumentSuggestions(
    kind: string | undefined,
    partial: string,
    graph: GraphExport,
  ): string[] {
    const p = partial.toLowerCase();
    if (kind === 'nodeId') {
      return graph.nodes
        .map((n) => n.id)
        .filter((id) => id.toLowerCase().includes(p))
        .slice(0, 20);
    }
    if (kind === 'label') {
      const labels = new Set<string>();
      for (const n of graph.nodes) for (const l of n.labels) labels.add(l);
      return [...labels]
        .filter((l) => l !== 'Bookend' && l !== 'BuildSIG')
        .filter((l) => l.toLowerCase().includes(p))
        .sort()
        .slice(0, 20);
    }
    if (kind === 'segment') {
      return ['biz', 'dom', 'imp', 'meta'].filter((s) => s.startsWith(p));
    }
    return [];
  }

  function show(): void {
    instance.open = true;
    palette.hidden = false;
    instance.reposition();
  }

  function hide(): void {
    instance.open = false;
    palette.hidden = true;
  }

  function selectAndRun(index: number): void {
    const list = instance.currentList;
    if (list.length === 0 || index < 0 || index >= list.length) return;
    const spec = list[index]!;
    // Insert the command name into the input if it isn't already there.
    if (!input.value.trim().startsWith(spec.name)) {
      input.value = spec.name + (spec.args.length > 0 ? ' ' : '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (spec.args.some((a) => a.required)) {
      // Don't run yet — leave focus + show argument hint.
      input.focus();
      rebuild();
      return;
    }
    runFromInput();
  }

  function completeArg(value: string): void {
    const tokens = input.value.trim().split(/\s+/);
    tokens[tokens.length - 1] = value;
    input.value = tokens.join(' ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    rebuild();
  }

  function runFromInput(): boolean {
    const parsed = parseCommand(input.value);
    if (!parsed) return false;
    // Don't run if required args are missing.
    const missingRequired = parsed.spec.args.some(
      (a, i) => a.required && !parsed.args[i],
    );
    if (missingRequired) return false;
    try {
      void parsed.spec.run(ctx, parsed.args);
      onRun(parsed.spec, parsed.args);
    } catch (err) {
      console.error('command failed:', err);
      ctx.echoSystem(`Command failed: ${String(err)}`);
    }
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    hide();
    return true;
  }

  // Wire events.
  function onInputChange(): void {
    const trimmed = input.value.trim();
    if (trimmed.startsWith('/')) {
      rebuild();
    } else {
      hide();
    }
  }

  function onKey(ev: KeyboardEvent): void {
    if (!instance.open) {
      if (ev.key === '/' && input.value === '') {
        // Pre-emptively open on the very first / character.
        setTimeout(() => rebuild(), 0);
      }
      return;
    }
    const mode =
      (instance as PaletteInstance & { mode?: 'cmd' | 'arg' }).mode ?? 'cmd';
    const argSugs =
      (instance as PaletteInstance & { argSuggestions?: string[] }).argSuggestions ?? [];
    const total = mode === 'arg' ? argSugs.length : instance.currentList.length;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      instance.selectedIndex = Math.min(instance.selectedIndex + 1, Math.max(0, total - 1));
      rebuild();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      instance.selectedIndex = Math.max(0, instance.selectedIndex - 1);
      rebuild();
    } else if (ev.key === 'Tab') {
      // Tab inserts the highlighted command or arg suggestion.
      ev.preventDefault();
      if (mode === 'arg') {
        const s = argSugs[instance.selectedIndex];
        if (s) completeArg(s);
      } else {
        const spec = instance.currentList[instance.selectedIndex];
        if (spec) {
          input.value = spec.name + (spec.args.length > 0 ? ' ' : '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (ev.key === 'Enter') {
      if (mode === 'arg') {
        const s = argSugs[instance.selectedIndex];
        if (s) {
          ev.preventDefault();
          completeArg(s);
          return;
        }
      }
      // If the input is a complete, runnable command, run it.
      // Otherwise treat Enter as command-selection.
      const ran = runFromInput();
      if (ran) {
        ev.preventDefault();
        return;
      }
      if (mode === 'cmd') {
        const spec = instance.currentList[instance.selectedIndex];
        if (spec) {
          ev.preventDefault();
          selectAndRun(instance.selectedIndex);
        }
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      hide();
    }
  }

  function onChevronClick(ev: MouseEvent): void {
    ev.preventDefault();
    if (instance.open) {
      hide();
      return;
    }
    if (!input.value.startsWith('/')) {
      input.value = '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      rebuild();
    }
    input.focus();
  }

  function onBlur(): void {
    // Defer the hide so mousedown on a row can run first.
    setTimeout(() => {
      if (document.activeElement !== input) hide();
    }, 150);
  }

  function onWindowResize(): void {
    if (instance.open) instance.reposition();
  }

  input.addEventListener('input', onInputChange);
  input.addEventListener('keydown', onKey as EventListener);
  input.addEventListener('blur', onBlur);
  chevron.addEventListener('click', onChevronClick);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('scroll', onWindowResize, true);

  return () => {
    input.removeEventListener('input', onInputChange);
    input.removeEventListener('keydown', onKey as EventListener);
    input.removeEventListener('blur', onBlur);
    chevron.removeEventListener('click', onChevronClick);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('scroll', onWindowResize, true);
    chevron.remove();
    palette.remove();
    parent?.classList.remove('has-cmd-chevron');
    const idx = installed.indexOf(instance);
    if (idx !== -1) installed.splice(idx, 1);
  };
}
