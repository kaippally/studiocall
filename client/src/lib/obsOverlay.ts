import { useCallback, useEffect, useState } from 'react';
import { SM_API } from './api';
import { notify } from './notices';

/**
 * Is the SM_HTML browser source showing in OBS, and the switch that changes it.
 *
 * OBS is the one piece of state in this app that no amount of local bookkeeping can be trusted
 * for: the source can be hidden from OBS itself, from another StudioMate window, or by a scene
 * change, and a button that remembers what it last did would then be lying about what the audience
 * can see. So the answer is always read back from `GET /api/overlay/obs-overlay`, after every
 * toggle and on a slow tick, and `connected` is carried separately — OBS being closed is a
 * different fact from the overlay being off, and only one of them is worth trying to fix.
 *
 * Turning it ON does more than set a flag: the server connects ObsApi, creates SM_HTML and
 * SM_MEDIA in the NDIOutput scene if they are missing, points the browser source at
 * timeline-display.html and shows it. OFF only hides it, leaving OBS alone.
 */
async function setObsOverlay(enabled: boolean): Promise<void> {
  try {
    const r = await fetch(`${SM_API}/api/overlay/obs-overlay`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) notify.error(d?.error ?? 'Could not change the OBS overlay.');
  } catch {
    notify.error('Could not reach the server to change the OBS overlay.');
  }
}

/**
 * For a control that puts something on the canvas: if OBS is not drawing SM_HTML, the click
 * landed on a source nobody can see, so say so and offer to show it.
 */
export async function warnIfObsOverlayHidden(what: string): Promise<void> {
  try {
    const d = await fetch(`${SM_API}/api/overlay/obs-overlay`).then(r => (r.ok ? r.json() : null));
    if (!d || (d.connected && d.visible)) return;
    notify.warn(
      d.connected
        ? `SM_HTML is hidden in OBS — ${what} will not be seen.`
        : `OBS is not connected — ${what} will not be seen until SM_HTML is showing.`,
      { acceptLabel: 'Enable SM_HTML', onAccept: () => void setObsOverlay(true) },
    );
  } catch { /* the server being down is reported by everything else */ }
}

/**
 * For a click that IS the on-air act — holding a chat line — a warning that asks first is one
 * step too many: the operator already decided. If SM_HTML is hidden, show it and say so; if OBS
 * is not connected, turning the overlay on connects it as well, so the same call is tried.
 */
export async function showObsOverlayFor(what: string): Promise<void> {
  try {
    const d = await fetch(`${SM_API}/api/overlay/obs-overlay`).then(r => (r.ok ? r.json() : null));
    if (!d || (d.connected && d.visible)) return;
    await setObsOverlay(true);
    notify.info(d.connected
      ? `SM_HTML was hidden in OBS — showing it so ${what} goes on air.`
      : `OBS was not connected — connecting and showing SM_HTML so ${what} goes on air.`);
  } catch { /* the server being down is reported by everything else */ }
}

export function useObsOverlay(pollMs = 15_000) {
  const [visible, setVisible] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const d = await fetch(`${SM_API}/api/overlay/obs-overlay`).then(r => (r.ok ? r.json() : null));
      if (!d) return;
      setConnected(!!d.connected);
      setVisible(!!d.connected && !!d.visible);
    } catch { /* OBS is somebody else's process; a failed read is not news */ }
  }, []);

  useEffect(() => {
    void read();
    if (!pollMs) return;
    const t = setInterval(() => void read(), pollMs);
    return () => clearInterval(t);
  }, [read, pollMs]);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      await setObsOverlay(!visible);
      await read();
    } finally { setBusy(false); }
  }, [visible, read]);

  return { visible, connected, busy, toggle, refresh: read };
}
