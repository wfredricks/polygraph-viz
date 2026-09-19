/**
 * Theme controller — light ↔ dark, persisted in localStorage.
 *
 * Why a single attribute (`<html data-theme="...">`): CSS custom
 * properties cascade from :root, so flipping one attribute swaps the
 * entire palette atomically. No DOM rewalk, no FOUC.
 *
 * Why explicit (not "auto"): the v0.2 plan calls for two named themes.
 * We still respect `prefers-color-scheme` on FIRST load (no preference
 * stored yet), but after the user toggles once, their choice wins.
 */

const STORAGE_KEY = 'polygraph-viz:theme';

export type Theme = 'light' | 'dark';

function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
    return null;
  } catch {
    // Why: localStorage may throw under file:// or strict iframe
    // sandboxing. Fall back to OS preference.
    return null;
  }
}

function detectOsTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function installTheme(): void {
  const initial: Theme = readStoredTheme() ?? detectOsTheme();
  applyTheme(initial);

  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const current =
      (document.documentElement.getAttribute('data-theme') as Theme) ?? 'dark';
    const next: Theme = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Why: storage might be blocked; theme still applies for this
      // session.
    }
  });
}
