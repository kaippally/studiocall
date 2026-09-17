/**
 * Operator pop-outs — the app, or one profile card, in its own window for a second screen.
 *
 * Same-origin, so the handle survives and re-opening focuses the window the operator already
 * placed instead of making a new one.
 */
type View = 'studiocall' | 'profile';

const BASE = import.meta.env.BASE_URL;

const WINDOWS: Record<View, { name: string; url: string; features: string }> = {
  studiocall: { name: 'smStudioCall', url: `${BASE}index.html?popout=1`, features: 'width=760,height=1000,scrollbars=yes,resizable=yes' },
  // One profile card, sized to the card. Re-opened for another person it is navigated in
  // place, so there is one profile window, not one per face clicked.
  profile:    { name: 'smProfile',    url: `${BASE}profile.html`, features: 'width=560,height=900,scrollbars=no,resizable=yes' },
};

const open: Partial<Record<View, Window>> = {};

export function isAdminWindowOpen(view: View): boolean {
  const held = open[view];
  return !!held && !held.closed;
}

/** Call straight from a click — after an await the popup blocker refuses. `query` is appended
 *  to the page URL, and a window already open is sent to the new URL rather than focused as is. */
export function openAdminWindow(view: View, query?: Record<string, string>): Window | null {
  const spec = WINDOWS[view];
  const sep = spec.url.includes('?') ? '&' : '?';
  const url = query ? `${spec.url}${sep}${new URLSearchParams(query)}` : spec.url;
  const held = open[view];
  if (held && !held.closed) {
    if (query) held.location.href = url;
    held.focus();
    return held;
  }
  const w = window.open(url, spec.name, spec.features);
  if (!w) return null;
  open[view] = w;
  w.focus();
  return w;
}
