import { useState } from 'react';
import { refreshCallRoom, useCallRoom } from '../lib/callRoom';
import { confirmEndRoom } from '../lib/studioCallRoom';

/**
 * Close the room, from wherever the operator noticed the show was over.
 *
 * **Ending is deliberately redundant.** A room is ended once, at the end of a night, from whatever
 * surface happens to be in front of the operator — the StudioCall tab, the Live Chat pop-out, the
 * QAP's Call group, the top bar beside Quit. A single canonical button means crossing the app at
 * the one moment nobody wants to hunt for a control, so every one of those surfaces draws THIS
 * component and none of them re-implements it.
 *
 * The behaviour lives in one place for the same reason: `confirmEndRoom()` owns the warning, the
 * `r.ok` check and the `reason` a 200 can carry, so a rate-limited End reads identically on
 * every surface. Gated on `iAmModerator` from the app's one room poll — never `mode === 'host'`,
 * which is false for a room started on the phone or re-joined after a restart.
 *
 * It draws NOTHING when there is no room of ours to end, so a caller can mount it unconditionally.
 */
export function EndRoomButton({ className, label = 'End room', onEnded }: {
  className?: string;
  label?: string;
  onEnded?: () => void;
}) {
  const room = useCallRoom();
  const [busy, setBusy] = useState(false);

  if (!room.live || !room.iAmModerator) return null;

  const end = async () => {
    setBusy(true);
    try {
      if (!await confirmEndRoom()) return;
      // Not on the next 15s lap: every copy of this button has to go the moment the room does.
      await refreshCallRoom();
      onEnded?.();
    }
    finally { setBusy(false); }
  };

  return (
    <button
      type="button"
      onClick={() => void end()}
      disabled={busy}
      title="Close the room — everybody in it is dropped and it does not come back"
      // Outlined, never filled: End sits beside Leave on most of these surfaces, and two solid red
      // buttons side by side is how the wrong one gets pressed.
      className={className ?? 'shrink-0 rounded border border-rose-600 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-40'}
    >
      {busy ? 'Ending…' : label}
    </button>
  );
}
