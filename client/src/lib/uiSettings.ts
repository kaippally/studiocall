import { API } from './api';
import { ws } from '../ws';

// UI settings persisted by the StudioCall server (/api/studiocall/ui/settings).
// In-memory cache only. DB is the single source of truth.

let cache: Record<string, string> = {};
let settingsLoaded = false;
const loadListeners = new Set<() => void>();

/**
 * A write made in ANOTHER window lands here as it happens (the server broadcasts every patch it
 * stores), so a Move Layout saved in the main window is in live-preview.html's cache at once
 * rather than at its next reload. A key this window is still about to flush is left
 * alone — the newer value is ours. Listeners hear `ui-settings-changed` with the keys that moved.
 */
export const UI_SETTINGS_CHANGED = 'ui-settings-changed';
ws.onBroadcast((msg: any) => {
  if (msg?.type !== 'ui-settings' || !msg.patch) return;
  const changed: string[] = [];
  for (const [k, v] of Object.entries(msg.patch as Record<string, string>)) {
    if (k in pendingFlush || cache[k] === v) continue;
    cache[k] = v;
    changed.push(k);
  }
  if (changed.length) window.dispatchEvent(new CustomEvent(UI_SETTINGS_CHANGED, { detail: changed }));
});

export function onUiSettingsLoaded(cb: () => void): () => void {
  if (settingsLoaded) { cb(); return () => {}; }
  loadListeners.add(cb);
  return () => loadListeners.delete(cb);
}

export async function loadAllUiSettings(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API}/api/studiocall/ui/settings`);
      if (res.ok) {
        cache = await res.json() as Record<string, string>;
        break;
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  settingsLoaded = true;
  for (const cb of loadListeners) cb();
  loadListeners.clear();
}

export function getUiSetting(key: string): string | null {
  return cache[key] ?? null;
}

// Re-read ONE key from the DB into the cache. The cache is filled once at boot, so a value
// another tab (or another window on the same rig) has changed since then stays stale here
// until a reload — which is how a picker ends up offering names that no longer exist. Only
// the named key is merged, and never over one of our own writes that hasn't flushed yet.
export async function refreshUiSetting(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/api/studiocall/ui/settings`);
    if (res.ok && !(key in pendingFlush)) {
      const all = await res.json() as Record<string, string>;
      if (all[key] === undefined) delete cache[key];
      else cache[key] = all[key];
    }
  } catch { /* offline — the cached value is the best we have */ }
  return cache[key] ?? null;
}

const pendingFlush: Record<string, string> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setUiSetting(key: string, value: string) {
  cache[key] = value;
  pendingFlush[key] = value;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 300);
}

function flush() {
  flushTimer = null;
  const patch = { ...pendingFlush };
  for (const k of Object.keys(patch)) delete pendingFlush[k];
  if (Object.keys(patch).length === 0) return;
  fetch(`${API}/api/studiocall/ui/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

// Flush all pending writes immediately — call before tab change or page unload.
// Uses sendBeacon so the request survives page teardown.
export function flushUiSettings() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const patch = { ...pendingFlush };
  for (const k of Object.keys(patch)) delete pendingFlush[k];
  if (Object.keys(patch).length === 0) return;
  const body = JSON.stringify(patch);
  const sent = typeof navigator !== 'undefined' && navigator.sendBeacon
    ? navigator.sendBeacon(`${API}/api/studiocall/ui/settings/beacon`, body)
    : false;
  if (!sent) {
    fetch(`${API}/api/studiocall/ui/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => {});
  }
}
