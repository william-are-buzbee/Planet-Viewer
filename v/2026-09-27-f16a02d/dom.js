// ══════════════════════════════════════════════════════════════════
// ── dom.js — the only DOM touch the simulation modules are allowed ──
//    Both helpers are no-ops without a document, so planet / hi-res /
//    regional / tile generation can run under Node (see tools/smoke.mjs).
// ══════════════════════════════════════════════════════════════════

export function byId(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

export function setStatus(text) {
  const el = byId('statusText');
  if (el) el.textContent = text;
}
