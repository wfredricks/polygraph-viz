/*
 * polygraph-viz — client bootstrap (placeholder).
 *
 * Step B ships this tiny stub so the shell loads end-to-end without 404s.
 * The real client bundle is produced by `npm run build:client` (step C)
 * out of src/client/main.ts and overwrites this file.
 */

(async () => {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const s = await r.json();
    const el = document.getElementById('stats-counts');
    if (el) el.textContent = `${s.nodeCount} nodes · ${s.edgeCount} edges`;
  } catch (err) {
    console.warn('polygraph-viz: stats fetch failed', err);
  }
})();
