import { useEffect, useState } from 'react';
import { API } from './api';

/**
 * "Is a StudioCall room running, and may this account rename it?" — one poll for the whole app.
 *
 * The StudioCall tab and the roster read `/api/studiocall/room` for everything in it; the surfaces
 * that only need to know whether the room exists are chrome — the bottom rail, the Scene panel —
 * and each of them growing its own interval is how the mute chip's 15s poll became three.
 *
 * `iAmModerator` is here because Clubhouse refuses `/set_channel_title` to anybody else, so a
 * rename button drawn without it is a button that always fails.
 */
export interface CallRoomHere {
  live: boolean;
  topic: string | null;
  iAmModerator: boolean;
}

const IDLE: CallRoomHere = { live: false, topic: null, iAmModerator: false };
const POLL_MS = 15_000;

let snapshot: CallRoomHere = IDLE;
const subscribers = new Set<(s: CallRoomHere) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(next: CallRoomHere) {
  if (next.live === snapshot.live && next.topic === snapshot.topic && next.iAmModerator === snapshot.iAmModerator) return;
  snapshot = next;
  subscribers.forEach(fn => fn(next));
}

async function read() {
  try {
    const d = await fetch(`${API}/api/studiocall/room`).then(r => r.json());
    const topic = typeof d?.topic === 'string' ? d.topic.trim() : '';
    publish({ live: !!d?.live, topic: topic || null, iAmModerator: !!d?.iAmModerator });
  } catch {
    publish(IDLE);
  }
}

/**
 * Re-read the room now, rather than waiting out the poll. For the acts that CHANGE what this hook
 * answers — ending the room, above all: a button that closes a room for everybody must not stay on
 * screen for another fifteen seconds after it worked.
 */
export const refreshCallRoom = (): Promise<void> => read();

/** The room as last read — for a caller that has just awaited `refreshCallRoom` and cannot wait for a render. */
export const callRoomNow = (): CallRoomHere => snapshot;

/** The room we are in. Read-only — joining and leaving stay the StudioCall tab's. */
export function useCallRoom(): CallRoomHere {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    subscribers.add(setState);
    setState(snapshot);
    if (!timer) {
      void read();
      timer = setInterval(() => { if (!document.hidden) void read(); }, POLL_MS);
    }
    return () => {
      subscribers.delete(setState);
      if (!subscribers.size && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return state;
}
