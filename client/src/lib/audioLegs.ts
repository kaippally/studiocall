import { API } from './api';

/**
 * ── The two bidirectional audio legs ─────────────────────────────────────────
 *
 * Everything else on this rig is one-way: a mic arrives, a bed leaves, a strip feeds a mix.
 * **StudioCall** and **StudioMeet** are the only two places where the studio both sends and
 * receives over the same connection, which is what makes them the two easiest things to get
 * half right — a leg whose send is correct and whose receive is not looks, from behind the
 * desk, exactly like a leg that is simply dead.
 *
 * So each is modelled as one object with an `input` and an `output`, from the studio's point of
 * view, and this module is the only place either is read or written:
 *
 * | Leg | input — what the far end hears | output — where it comes back |
 * |---|---|---|
 * | **StudioCall** | the mic pinned into the Agora engine | the Windows device the room plays out of |
 * | **StudioMeet** | the mic the Studio frame publishes into the room | OBS's monitoring device for the `Meet-*` sources |
 *
 * The asymmetry in the second row is not an oversight and is worth stating once: guest audio
 * arrives inside **OBS browser sources**, not on a Windows endpoint, so the only way it leaves
 * this machine for anything but the stream is OBS monitoring. That is why the StudioMeet output
 * is an OBS setting while its input is a browser device label — two different vocabularies for
 * one leg, because two different systems own the halves.
 */

export interface LegDevice {
  /** What the writer needs. Windows name for StudioCall, browser label for the guest mic, OBS id for the monitor. */
  value: string;
  label: string;
  /** OBS needs both a name and an id to set a monitoring device; the name alone will not do. */
  name?: string;
}

export interface LegState {
  input: string;
  output: string;
  inputs: LegDevice[];
  outputs: LegDevice[];
  /** Reachable at all? A leg whose service is down must not draw as "nothing selected". */
  up: boolean;
  /** The one line worth printing under the boxes — the far end's own complaint, verbatim. */
  note: string | null;
  /** Emerald only when this leg can actually carry audio both ways right now. */
  live: boolean;
}

const EMPTY: LegState = { input: '', output: '', inputs: [], outputs: [], up: false, note: null, live: false };

// ── StudioCall ───────────────────────────────────────────────────────────────

/**
 * The engine is the source of truth for what is pinned, never the last thing this app sent: a
 * pin can resolve to a name spelled differently from the one requested, because Windows renumbers
 * an endpoint inside its own name. Reading back what the engine ENDED with is what stops the
 * selects reading "not set" over a leg that is working.
 */
export async function readStudioCallLeg(): Promise<LegState> {
  try {
    const r = await fetch(`${API}/api/studiocall/audio/health`, { credentials: 'include' });
    if (!r.ok) return { ...EMPTY, note: 'The StudioCall audio engine is not answering on :4018.' };
    const d = await r.json();
    const dev = (list: any[]): LegDevice[] =>
      (list ?? []).map(x => ({ value: String(x.name ?? ''), label: String(x.name ?? '') }));
    // `asSpeaker: false` is the one that matters more than any level: an audience client
    // publishes nothing however its mute button reads, so the leg is not live in either
    // direction that counts.
    const joined = !!d?.joined;
    return {
      input: String(d?.wantRecordingName ?? ''),
      output: String(d?.wantPlaybackName ?? ''),
      inputs: dev(d?.devices?.recording),
      outputs: dev(d?.devices?.playback),
      up: !!d?.engineUp,
      note: d?.lastError ? String(d.lastError)
        : !joined ? 'Not in a room — the pins apply on the next join.'
          : d?.asSpeaker === false ? 'In the room as AUDIENCE — this leg publishes nothing until the role is fixed.'
            : null,
      live: joined && d?.asSpeaker !== false,
    };
  } catch {
    return { ...EMPTY, note: 'The StudioCall audio engine is not answering on :4018.' };
  }
}

/**
 * Pinning a device on a JOINED channel changes the setting and leaves the running capture on the
 * old endpoint — meters fall to zero or audio garbles, and `/audio/health` still reports joined,
 * unmuted, no error. The server's route therefore rejoins, which is the only thing that restarts
 * capture, and that rejoin is a real gap in the audio. Callers must say so before they call this.
 */
export async function setStudioCallDevices(recordingName: string, playbackName: string): Promise<string | null> {
  const d = await fetch(`${API}/api/studiocall/audio/devices`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recordingName: recordingName || null, playbackName: playbackName || null }),
  }).then(x => x.json());
  return d?.reason ? String(d.reason) : null;
}
