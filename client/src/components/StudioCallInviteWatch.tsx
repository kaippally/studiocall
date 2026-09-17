import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API } from '../lib/api';
import { ws } from '../ws';
import { topZIndex } from '../lib/zIndex';
import { notify } from '../lib/notices';
import { CHIME, chime } from '../lib/chime';

interface Invite {
  activityId: string;
  at: string | null;
  from: string;
  fromUserId: string | null;
  fromPhotoUrl: string | null;
  title: string;
  channel: string | null;
  missed: boolean;
}

interface Hand {
  userId: string;
  name: string;
  username: string;
  photoUrl: string | null;
}

// Mounted for the life of the app, not with the StudioCall tab: LazyTab does not
// build a tab until it is first opened, so a watcher living inside it would miss
// every invite that arrived before the operator thought to look.
export function StudioCallInviteWatch() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [hands, setHands] = useState<Hand[]>([]);
  const [busy, setBusy] = useState(false);

  const dismiss = useCallback((id: string) => {
    setInvites(prev => prev.filter(i => i.activityId !== id));
  }, []);

  const dropHand = useCallback((userId: string) => {
    setHands(prev => prev.filter(h => h.userId !== userId));
  }, []);

  useEffect(() => {
    // Asking on mount rather than on the first invite: permission prompts are
    // ignored unless they arrive with a gesture, and by the time an invite lands
    // the answer is needed immediately.
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-hand') {
        const hand = (msg as any).hand as Hand;
        if (!hand?.userId) return;
        // The bell is the whole point: this arrives while the operator is on News Desk with
        // StudioCall not open, and a ✋ in a roster nobody is looking at is not a request.
        chime(CHIME.bell);
        setHands(prev => (prev.some(h => h.userId === hand.userId) ? prev : [...prev, hand]));
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('StudioCall', { body: `${hand.name} is asking to speak.`, silent: false }).onclick = () => {
            window.focus();
          };
        }
        return;
      }
      if (msg.type !== 'studiocall-invite') return;
      const invite = (msg as any).invite as Invite;
      if (!invite?.activityId) return;
      setInvites(prev => (prev.some(i => i.activityId === invite.activityId) ? prev : [...prev, invite]));
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('StudioCall', { body: invite.title, silent: false }).onclick = () => {
          window.focus();
        };
      }
    });
  }, []);

  /** Bring them onto the stage they just asked for. Moderator-only on Clubhouse's side. */
  const stage = useCallback(async (hand: Hand) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/speaker`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: hand.userId, onStage: true }),
      });
      if (!r.ok) return notify.error(`Could not put ${hand.name} on the stage.`);
      dropHand(hand.userId);
    } finally {
      setBusy(false);
    }
  }, [dropHand]);

  /**
   * Ping whoever invited us into the room WE are in — the notification coming back the other way.
   *
   * On the DP rather than a button because that is the thing on the notice that is them: a face
   * is the one control an operator can hit without reading. Double-click, not single, because the
   * notice is transient and a stray click must not fire a notification at somebody.
   */
  const inviteBack = useCallback(async (invite: Invite) => {
    if (!invite.fromUserId) return notify.warn(`No Clubhouse profile on that notice — cannot invite ${invite.from}.`);
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: invite.fromUserId }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) return notify.error(d?.error === 'not in a room'
        ? 'Open a room first — there is nothing to invite them into.'
        : `Could not invite ${invite.from}.`);
      notify.info(`${invite.from} has been pinged into your room.`);
      dismiss(invite.activityId);
    } finally {
      setBusy(false);
    }
  }, [dismiss]);

  /**
   * Walk out of whatever room we are in and into theirs — the server's `/room/join` leaves the
   * current channel in both legs before it joins the new one, so one click is the whole switch.
   *
   * **The answer is read.** This used to fire and forget: a refused join (a room that has already
   * ended, a rate limit, an account Clubhouse will not let in) dismissed the notice, opened the
   * tab and said nothing, so the only evidence was still being in the old room. The notice now
   * survives a failure — the invite is the only place that channel id exists, and throwing it away
   * on the one path where it is still needed left nothing to try again.
   */
  const join = useCallback(async (invite: Invite) => {
    if (!invite.channel) { window.focus(); dismiss(invite.activityId); return; }
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: invite.channel }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.joined !== true) {
        return notify.error(d?.body?.error_message || d?.error || `Could not join ${invite.from}'s room.`);
      }
      if (d?.audio && d.audio.connected === false) notify.warn(`In the room, but the audio leg did not connect: ${d.audio.reason}`);
      window.focus();
      dismiss(invite.activityId);
    } catch {
      notify.error('Could not reach the server to join that room.');
    } finally {
      setBusy(false);
    }
  }, [dismiss]);

  if (!invites.length && !hands.length) return null;

  return createPortal(
    <div className="fixed bottom-10 right-4 flex w-80 flex-col gap-2" style={{ zIndex: topZIndex() }}>
      {hands.map(hand => (
        <div key={hand.userId} className="rounded-lg border border-amber-700 bg-neutral-900 p-3 shadow-lg shadow-black/50">
          <div className="flex items-start gap-2.5">
            {hand.photoUrl
              ? <img src={`${API}${hand.photoUrl}`} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
              : <div className="h-9 w-9 shrink-0 rounded-full bg-neutral-800" />}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-amber-300">✋ Asking to speak</div>
              <div className="mt-0.5 truncate text-xs text-neutral-300">{hand.name}</div>
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void stage(hand)}
              disabled={busy}
              className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Bring on stage
            </button>
            <button
              type="button"
              onClick={() => dropHand(hand.userId)}
              className="ml-auto text-xs text-neutral-500 hover:text-neutral-300"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {invites.map(invite => (
        <div key={invite.activityId} className="rounded-lg border border-sky-800 bg-neutral-900 p-3 shadow-lg shadow-black/50">
          <div className="flex items-start gap-2.5">
            {/* The DP invites them back — see inviteBack. A plain img would give no cursor and no
                reason to try it, so it wears the pointer and says what it does. */}
            <div
              onDoubleClick={() => void inviteBack(invite)}
              title={invite.fromUserId
                ? `Double-click to invite ${invite.from} into your room`
                : 'No Clubhouse profile on this notice'}
              className={`h-9 w-9 shrink-0 rounded-full ${invite.fromUserId ? 'cursor-pointer ring-offset-1 ring-offset-neutral-900 hover:ring-2 hover:ring-sky-400' : ''}`}
            >
              {invite.fromPhotoUrl
                ? <img src={`${API}${invite.fromPhotoUrl}`} alt="" className="h-9 w-9 rounded-full object-cover" />
                : <div className="h-9 w-9 rounded-full bg-neutral-800" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-sky-300">StudioCall invite</div>
              <div className="mt-0.5 text-xs text-neutral-300">{invite.title}</div>
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void join(invite)}
              disabled={busy}
              className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {invite.channel ? 'Join room' : 'Open StudioCall'}
            </button>
            <button
              type="button"
              onClick={() => dismiss(invite.activityId)}
              className="ml-auto text-xs text-neutral-500 hover:text-neutral-300"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
