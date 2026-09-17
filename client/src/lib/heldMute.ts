import { useCallback, useEffect, useState } from 'react';
import { API } from './api';
import { notify } from './notices';
import { ws } from '../ws';

/** Somebody the desk muted and is holding muted. Keyed by Clubhouse user id. */
export interface HeldMute { userId: string; name: string; at: string }

/**
 * The held-mute list, mirrored from the server.
 *
 * Muting on Clubhouse is a one-shot and every speaker owns their own unmute, so the desk's Mute
 * is a latch: the server shuts the mic now and shuts it again each time it opens. This is only
 * the mirror — the list, the pump and the re-mutes are all the server's, and
 * `studiocall-held-mutes` is what keeps every surface showing the same people.
 *
 * Deliberately the same shape as `useSpeakerStatus`, and deliberately a different list: a gag also
 * deletes what they type and follows them into the next room. This is about one microphone in
 * this room, and it dies with it.
 */
export function useHeldMutes() {
  const [people, setPeople] = useState<HeldMute[]>([]);

  useEffect(() => {
    fetch(`${API}/api/studiocall/room/held-mutes`)
      .then(r => r.json())
      .then(d => setPeople(Array.isArray(d?.people) ? d.people : []))
      .catch(() => {});
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-held-mutes') setPeople(((msg as any).people as HeldMute[]) ?? []);
    });
  }, []);

  /**
   * Mute somebody and hold them, or let them speak again. `muted` is stated rather than toggled,
   * for the reason the gag states `on`: several surfaces draw this list, and a toggle raced
   * against the broadcast opens a mic nobody asked to open.
   */
  const setHeld = useCallback(async (userId: string, name: string, muted: boolean) => {
    try {
      const r = await fetch(`${API}/api/studiocall/room/mute-user`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, name, muted }),
      });
      const d = await r.json();
      if (!r.ok) return notify.error(d?.error ?? 'Could not change the mute.');
      notify.info(muted
        ? `${name || 'They'} are muted, and stay muted until you release it.`
        : `${name || 'They'} can unmute again.`);
    } catch {
      notify.error('Could not reach the server.');
    }
  }, []);

  const held = new Set(people.map(p => String(p.userId)));
  return { people, held, setHeld };
}
