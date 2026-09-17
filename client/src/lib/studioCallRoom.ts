import { API } from './api';
import { askConfirm } from './ask';
import { notify } from './notices';

/**
 * Walking out of a StudioCall room, from wherever the operator noticed they were in one.
 *
 * The room is joined from four surfaces — the hallway listing, the invite notice, the tab and the
 * Live Chat pop-out — and until now the way OUT lived only in the listing, the tab and the pop-out.
 * A join made from a notice while the desk was on another tab could only be undone by crossing to
 * StudioCall and finding the red button, which is the trip the notice existed to save. So the leave
 * lives here, once, and any surface that can say "you are in a room" can also end it.
 *
 * **It does NOT ask. Leave means leave, on the press.** It used to put a question in the way, on
 * the reasoning that the chat feed and the microphone go with it — but leaving is reversible
 * (rejoining is one press from the same four surfaces), it is what the operator came to this
 * button to do, and the moment it is actually wanted is the moment a room has gone wrong and is
 * being walked out of. A dialog between that press and the door is a dialog in a hurry.
 *
 * **End is a different question and still asks** — see `confirmEndRoom`. That one closes the room
 * for everybody and cannot be undone, which is exactly the difference.
 *
 * The notice is here rather than at the four call sites: the press is now silent by design, so the
 * one thing that says the door opened has to be the same wherever it was pressed.
 */
export async function leaveRoom(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/studiocall/room/leave`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({} as any)))?.error ?? `HTTP ${r.status}`);
    notify.info('Left the room.');
    return true;
  } catch (e: any) {
    notify.error(`Could not leave the room — ${e.message}`);
    return false;
  }
}

/**
 * Ending a room we host, from wherever the operator is holding it.
 *
 * The other half of `leaveRoom`, and it lives beside it for the same reason: the room can be
 * ended from the tab and from the Live Chat pop-out, and a second copy of the question is a second
 * chance for the two to disagree about what ending does.
 *
 * **It reports a refusal.** A bare fetch made a rate-limited end look exactly like a room that
 * would not die — the click landed, nothing happened, and nothing said why. A `reason`
 * in a 200 body is the other shape of no: the server found no live room of ours to end.
 */
export async function confirmEndRoom(): Promise<boolean> {
  if (!await askConfirm({
    title: 'End the room?',
    body: 'Everybody in it is dropped and the room closes for good. Walking out instead leaves it up — that is Leave, not End.',
    confirmLabel: 'End room',
    level: 'warn',
  })) return false;
  try {
    const r = await fetch(`${API}/api/studiocall/room/end`, { method: 'POST' });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      notify.error(`Could not end the room — ${d?.error ?? `HTTP ${r.status}`}.`);
      return false;
    }
    if (d?.reason) {
      notify.error(d.reason);
      return false;
    }
    return true;
  } catch {
    notify.error('Could not reach the server to end the room.');
    return false;
  }
}

