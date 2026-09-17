import { useEffect, useState } from 'react';
import { API } from '../lib/api';

/**
 * Is your audio actually reaching Clubhouse's server?
 *
 * **The talking ring on your own face does not answer that.** It runs off Agora's
 * `onAudioVolumeIndication` for local uid 0, which is the *capture* level — a meter bouncing off a
 * healthy microphone looks exactly the same whether the encoded frames are leaving the machine or
 * piling up against a dead transport. That is the failure worth a light of its own: you are
 * talking, everything on screen reads normal, and the room hears nothing.
 *
 * The proof is bytes. `RtcStats.txAudioBytes` is cumulative audio sent on the connection, so the
 * engine watches it *grow* rather than reading its value, and reports `sending` with two stats
 * intervals of slack (see renderer.js in the StudioCall engine). A stats stream that stops reads as
 * not sending, rather than freezing on its last true value.
 *
 * **Deliberate silence and broken silence never draw the same.** Muted and audience-role both stop
 * the bytes legitimately and are amber; a live connection carrying nothing is rose and pulses,
 * because that is the one nobody else will tell you about.
 */

/** Slower than the speaking poll: this is a health light, and the stats behind it land every ~2s. */
const POLL_MS = 2000;

interface Uplink {
  sending: boolean;
  connected: boolean;
  /** Agora ConnectionStateType — 1 disconnected · 2 connecting · 3 connected · 4 reconnecting · 5 failed. */
  state: number;
  kbps: number;
  lossPct: number;
  rttMs: number;
  asSpeaker: boolean;
}

type Look = { cls: string; pulse: boolean; title: string };

function look(u: Uplink | null, muted: boolean): Look {
  if (!u) return { cls: 'bg-slate-600', pulse: false, title: 'No reading from the audio engine' };
  if (!u.connected) {
    const how = u.state === 4 ? 'reconnecting to' : u.state === 5 ? 'failed to reach' : u.state === 2 ? 'connecting to' : 'not connected to';
    return { cls: 'bg-rose-500', pulse: u.state === 2 || u.state === 4, title: `${how[0]!.toUpperCase()}${how.slice(1)} Clubhouse's server — the room cannot hear you` };
  }
  if (muted) return { cls: 'bg-amber-400', pulse: false, title: 'Muted — connected, but nothing is being sent' };
  if (!u.asSpeaker) return { cls: 'bg-amber-400', pulse: false, title: 'In the audience — an audience client publishes nothing, whatever the mute button says' };
  if (!u.sending) return { cls: 'bg-rose-500', pulse: true, title: 'Connected to Clubhouse but no audio is leaving this machine — the room cannot hear you' };
  const loss = u.lossPct > 0 ? ` · ${u.lossPct}% loss` : '';
  const rtt = u.rttMs > 0 ? ` · ${u.rttMs}ms` : '';
  return { cls: 'bg-emerald-400', pulse: false, title: `Reaching Clubhouse · ${u.kbps} kbps${loss}${rtt}` };
}

/**
 * Sits on your own avatar and nowhere else. It owns its own read rather than taking a prop: the
 * two surfaces that draw the roster poll different things, and a health light that works on one of
 * them and silently reads "no data" on the other is worse than none.
 */
export function UplinkDot() {
  const [u, setU] = useState<Uplink | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const d = await fetch(`${API}/api/studiocall/audio/speaking`).then(r => r.json());
        if (!alive) return;
        setMuted(!!d?.muted);
        setU(d?.uplink ?? null);
      } catch {
        // The engine being unreachable is the answer, not an error — a dot that held its last
        // green while the engine was gone would be the exact lie this exists to prevent.
        if (alive) setU(null);
      }
    };
    void read();
    const t = setInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const { cls, pulse, title } = look(u, muted);
  return (
    <span
      title={title}
      className={`pointer-events-none absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-neutral-900 ${cls} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}
