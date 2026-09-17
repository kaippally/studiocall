import { useEffect, useState } from 'react';
import { API } from '../lib/api';
import { Dialog } from './Dialog';
import { notify } from '../lib/notices';
import { ACTIVE_BORDER } from '../lib/activeStyle';

interface HistoryPhoto { photoKey: string; thumbnailUrl: string | null; fullUrl: string | null }

/**
 * Every face this account has worn, and the click that puts one back on.
 *
 * **Changing the display picture is a PICK now, not an upload.** Clubhouse retired `/update_photo`
 * for every caller — the desk sends the current Android app's request byte for byte and is still
 * refused — and replaced it with a photo history: each picture has a
 * `photo_key`, and `set_profile_photo` selects one. So a genuinely new face has to go up from the
 * Clubhouse phone app once; after that it is in this grid forever and the desk can switch to it
 * mid-show without touching a phone.
 *
 * That is why this dialog says so out loud at the bottom rather than offering a file picker that
 * cannot work: an upload button whose only outcome is an error notice is worse than no button.
 */
export function PhotoHistoryDialog({ current, userId, who, onPicked, onClose }: {
  /** The photo in use, as a local `/api/media/...` path — so the one being worn is marked. */
  current?: string | null;
  /**
   * Whose history to read. Absent means the operator's own, which is the only one that can be
   * WORN — `set_profile_photo` writes to this account and nowhere else. With a userId the grid is
   * somebody else's and the tiles are inert: it is a way of recognising a caller who has changed
   * their face since you last spoke, not a way of editing them.
   */
  userId?: string | null;
  /** Their name, for the title — a grid of strangers' faces needs to say whose it is. */
  who?: string | null;
  onPicked: (photoUrl: string | null) => void;
  onClose: () => void;
}) {
  const [photos, setPhotos] = useState<HistoryPhoto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const theirs = !!userId;

  useEffect(() => {
    setPhotos(null);
    fetch(`${API}/api/studiocall/profile/photos${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`)
      .then(r => r.json())
      .then(d => setPhotos(d?.photos ?? []))
      .catch(() => { notify.error(`Could not read ${theirs ? 'their' : 'your'} photo history.`); setPhotos([]); });
  }, [userId]);

  const pick = async (p: HistoryPhoto) => {
    if (theirs) return;
    setBusy(p.photoKey);
    try {
      const r = await fetch(`${API}/api/studiocall/profile/photo/select`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photoKey: p.photoKey }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) return notify.error(d?.error ?? 'Clubhouse refused that photo.');
      onPicked(d?.photoUrl ?? p.fullUrl);
      onClose();
    } catch {
      notify.error('Could not reach the server to change the photo.');
    } finally { setBusy(null); }
  };

  // The width belongs to the DIALOG, not to a box inside it. A `w-[30rem]` child under the shell's
  // default 440px cap overflowed it: the fourth column of faces was sliced down the middle, the
  // paragraph below lost its right-hand words, and the panel grew a horizontal scrollbar — a grid
  // of pictures you have to scroll sideways to see is not a picker.
  return (
    <Dialog open title={theirs ? `${who?.trim() || 'Their'} profile pictures` : 'Your profile pictures'}
      onCancel={onClose} cancelLabel="Close" width={560}>
      <div>
        {photos === null ? (
          <div className="py-6 text-center text-sm text-neutral-500">Reading the photo history…</div>
        ) : photos.length ? (
          <div className="grid max-h-[50vh] grid-cols-4 gap-2 overflow-y-auto pr-1">
            {photos.map(p => {
              const worn = !!current && (p.fullUrl === current || p.thumbnailUrl === current);
              return (
                <button
                  key={p.photoKey}
                  type="button"
                  onClick={() => void pick(p)}
                  disabled={!!busy || theirs}
                  title={theirs ? 'A picture they have worn before' : worn ? 'This is the one you are wearing' : 'Wear this one'}
                  className={`relative aspect-square overflow-hidden rounded border transition ${
                    theirs ? 'cursor-default border-neutral-700' : 'disabled:opacity-40'
                  } ${worn && !theirs ? ACTIVE_BORDER : theirs ? '' : 'border-neutral-700 hover:border-sky-500'}`}
                >
                  {p.thumbnailUrl
                    ? <img src={`${API}${p.thumbnailUrl}`} alt="" className="h-full w-full object-cover" />
                    : <div className="h-full w-full bg-neutral-800" />}
                  {busy === p.photoKey && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-white">
                      setting…
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-neutral-500">
            {theirs ? 'They have worn only the picture they have now.' : 'No photos on this account yet.'}
          </div>
        )}
        <p className="mt-3 border-t border-neutral-800 pt-2 text-[11px] leading-relaxed text-neutral-500">
          {theirs ? (
            <>Every picture this person has worn, newest first — for recognising a caller who has
              changed their face since you last spoke. Nothing here is clickable: it is somebody
              else&rsquo;s account.</>
          ) : (
            <>A <strong className="text-neutral-400">new</strong> picture has to be uploaded from the
              Clubhouse phone app — Clubhouse retired the upload API for every desktop client, and this
              account is not on the newer photo-history upload. Once it is up there it appears here and
              can be switched to from the desk.</>
          )}
        </p>
      </div>
    </Dialog>
  );
}
