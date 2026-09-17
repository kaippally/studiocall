import { API } from './api';
import { notify } from './notices';

/**
 * The dropdown dance, as one call — clear both pins, rejoin, put the same pair back, rejoin
 * again. See `POST /audio/reset` on the server for why re-picking the same pair from a select
 * fixes nothing. It lives here because two surfaces offer it: the StudioCall tab's Audio
 * routing card, and the Live Chat pop-out's bar, which is where the operator actually is when
 * the room goes silent mid-show.
 */
export async function resetStudioCallAudio(): Promise<void> {
  try {
    const r = await fetch(`${API}/api/studiocall/audio/reset`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) notify.error(d?.message ?? d?.error ?? 'Could not reset the audio.');
    else notify.info(d.rejoined ? 'Audio reset — devices re-pinned and the room rejoined.' : 'Audio reset — devices re-pinned.');
  } catch {
    notify.error('Could not reach the audio engine to reset it.');
  }
}
