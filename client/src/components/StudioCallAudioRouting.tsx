import { useCallback, useEffect, useState } from 'react';
import { API } from '../lib/api';
import { notify } from '../lib/notices';
import { setStudioCallDevices } from '../lib/audioLegs';
import { resetStudioCallAudio } from '../lib/studiocallAudio';

// The Agora leg's two device pins, their meters, and the record of pairings that have worked.
// Lives in the Live Chat window's Settings view — the window that is on screen mid-show — so
// silence in the room is fixed where it is noticed, not a main-window tab away.

interface AudioDevice { name: string; id: string }
interface AudioHealth { ok: boolean; ready: boolean; engineUp: boolean; joined: { channel: string; uid: number } | null; lastError: { err?: number; msg: string } | null; wantRecordingName?: string | null; wantPlaybackName?: string | null; outMuted?: boolean; devices?: { recording: AudioDevice[]; playback: AudioDevice[] } }
interface DeviceMemory { selected: { rec: string | null; play: string | null }; lastWorking?: { rec: string | null; play: string | null; at: string; since?: string; outPeak: number; inSeen: boolean } }
/** A pairing the operator kept, with how long it was proven to be carrying audio. */
interface SavedPair { id: string; rec: string | null; play: string | null; at: string; durationMs: number; outPeak: number; inSeen: boolean }

/** "4h 12m" / "9s" / "never proven" — a span nobody has to read as a number of milliseconds. */
function spanLabel(ms: number) {
  if (ms < 1000) return 'never proven';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * One direction of the call, drawn directly above the select that chooses its device — so picking a
 * mic and seeing whether it carries anything happen in the same glance. `v` is Agora's own 0..255.
 */
function CallMeter({ label, v, off, why }: { label: string; v: number; off: boolean; why: string | null }) {
  const pct = Math.min(100, Math.round((v / 255) * 100));
  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="whitespace-nowrap text-[11px] text-slate-500">{label}</span>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${off ? 'bg-slate-700' : v > 200 ? 'bg-red-500' : v > 120 ? 'bg-amber-400' : 'bg-emerald-500'}`}
          style={{ width: `${pct}%` }}
        />
        {/* Where the colour changes, so a peak can be read against a mark rather than guessed
            from the hue alone. */}
        <span className="pointer-events-none absolute inset-y-0 left-[47%] w-px bg-slate-950/60" />
        <span className="pointer-events-none absolute inset-y-0 left-[78%] w-px bg-slate-950/60" />
        {why && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] uppercase tracking-wider text-slate-500">
            {why}
          </span>
        )}
      </div>
      {/* Per cent, not the raw 0–255 Agora reports: the number says the same thing as the bar, and
          161 stops looking like a setting somebody could have chosen. */}
      <span className="w-9 text-right text-[11px] tabular-nums text-slate-600">{off ? '—' : `${pct}%`}</span>
    </div>
  );
}

const SMALL_BTN = 'rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-40';
const SELECT = 'mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-[12px] text-slate-200 disabled:opacity-50';

/**
 * `live` gates the meter poll; `publishing` (the roster's `onStage`) is why a `mic → room` meter
 * can sit at zero with nothing wrong — an audience client has no local level to draw.
 */
export function StudioCallAudioRouting({ live, publishing }: { live: boolean; publishing: boolean }) {
  const [audio, setAudio] = useState<AudioHealth | null>(null);
  const [audioDown, setAudioDown] = useState(false);
  const [recName, setRecName] = useState('');
  const [playName, setPlayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<DeviceMemory | null>(null);
  const [pairs, setPairs] = useState<SavedPair[]>([]);
  const [levels, setLevels] = useState({ out: 0, in: 0 });
  const [muted, setMuted] = useState(false);

  const loadAudio = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/studiocall/audio/health`);
      if (!r.ok) { setAudioDown(true); return; }
      const d: AudioHealth = await r.json();
      setAudio(d);
      setAudioDown(false);
      // The engine is the source of truth for what is pinned — hydrate the selects from
      // it, or a reload shows "not set" while the engine holds a pin.
      setRecName(d?.wantRecordingName ?? '');
      setPlayName(d?.wantPlaybackName ?? '');
      try { setMemory(await fetch(`${API}/api/studiocall/audio/memory`).then(x => x.json())); } catch {}
      try { setPairs((await fetch(`${API}/api/studiocall/audio/pairs`).then(x => x.json()))?.pairs ?? []); } catch {}
    } catch { setAudioDown(true); }
  }, []);

  useEffect(() => { void loadAudio(); }, [loadAudio, live]);

  // The two meters, off the same poll the roster's speaking rings use. Only worth it in a room.
  useEffect(() => {
    if (!live) { setLevels({ out: 0, in: 0 }); return; }
    const t = setInterval(async () => {
      try {
        const d = await fetch(`${API}/api/studiocall/audio/speaking`).then(x => x.json());
        setLevels(d?.levels ?? { out: 0, in: 0 });
        if (typeof d?.muted === 'boolean') setMuted(d.muted);
      } catch {}
    }, 250);
    return () => clearInterval(t);
  }, [live]);

  const run = useCallback(async (act: () => Promise<void>) => {
    setBusy(true);
    try { await act(); } finally { setBusy(false); }
  }, []);

  const pinDevices = useCallback((rec: string, play: string) => {
    setRecName(rec);
    setPlayName(play);
    return run(async () => {
      try {
        // Changing a device in a live room rejoins the channel to restart capture, so
        // there is a real gap in the audio here — say so rather than looking frozen.
        const reason = await setStudioCallDevices(rec, play);
        if (reason) notify.error(`Device set, but audio did not come back: ${reason}. Try Reconnect.`);
        await loadAudio();
      } catch {
        notify.error('Could not change the device.');
      }
    });
  }, [loadAudio, run]);

  const restoreDevices = useCallback(() => run(async () => {
    const d = await fetch(`${API}/api/studiocall/audio/memory/restore`, { method: 'POST' }).then(x => x.json());
    if (d?.error) notify.error(d.error);
    await loadAudio();
  }), [loadAudio, run]);

  /**
   * Keep the pair now selected, with the span it has been carrying audio. Not Restore's "last
   * known good", which holds one pair and is overwritten by the next to prove itself: this rig has
   * four near-identical RODECaster endpoints and which of them works changes with what is plugged
   * in, so the useful record is several pairings that worked and how long each lasted.
   */
  const keepPair = useCallback(() => run(async () => {
    try {
      const r = await fetch(`${API}/api/studiocall/audio/pairs`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { notify.error(d?.error ?? 'Could not keep this pairing.'); return; }
      setPairs(d.pairs ?? []);
      notify.info(d.saved?.durationMs
        ? `Kept — it was carrying audio for ${spanLabel(d.saved.durationMs)}.`
        : 'Kept. No audio has been measured on this pair yet, so no span was recorded.');
    } catch {
      notify.error('Could not reach the server.');
    }
  }), [run]);

  const restorePair = useCallback((id: string) => run(async () => {
    const d = await fetch(`${API}/api/studiocall/audio/pairs/${id}/restore`, { method: 'POST' }).then(x => x.json());
    if (d?.error) notify.error(d.error);
    await loadAudio();
  }), [loadAudio, run]);

  const forgetPair = useCallback(async (id: string) => {
    try {
      const d = await fetch(`${API}/api/studiocall/audio/pairs/${id}`, { method: 'DELETE' }).then(x => x.json());
      setPairs(d.pairs ?? []);
    } catch { notify.error('Could not reach the server.'); }
  }, []);

  // Everything about the audio — what is set now, every step taken today and what each did to
  // the meters, who owns :4018, the engine's own log. The path goes to the clipboard
  // because a file you cannot find is not a saved log.
  const saveAudioLog = useCallback(() => run(async () => {
    try {
      const r = await fetch(`${API}/api/studiocall/audio/log`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { notify.error(d?.message ?? d?.error ?? 'Could not write the audio log.'); return; }
      try { await navigator.clipboard.writeText(d.path); } catch {}
      notify.info(`Saved ${d.steps} steps to ${d.file} — path copied. In data/studiocall/audio-logs/.`);
    } catch {
      notify.error('Could not reach the server to write the audio log.');
    }
  }), [run]);

  // The "set both selects to none and pick them again" dance as one button.
  const resetAudio = useCallback(() => run(async () => {
    await resetStudioCallAudio();
    await loadAudio();
  }), [loadAudio, run]);

  if (audioDown) {
    return (
      <div className="border-b border-slate-800 px-3 py-2.5 text-[11px] text-amber-300">
        Audio engine unreachable — the StudioCall service on :4018 is not answering.
      </div>
    );
  }
  if (!audio?.devices) return null;

  const outMuted = !!audio.outMuted;

  return (
    <div className="border-b border-slate-800 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-slate-200">Devices</div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-500">Pinned by name, so they survive Windows renumbering endpoints.</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void keepPair()}
            disabled={busy}
            title="Keep the two devices now selected, together with how long they have been proven to be carrying audio. They join the list below, to be put back after a restart shuffles the endpoints."
            className={`${SMALL_BTN} border-emerald-800/70 bg-emerald-950/40 text-emerald-200 hover:border-emerald-600`}
          >
            Keep pairing
          </button>
          <button
            type="button"
            onClick={() => void saveAudioLog()}
            disabled={busy}
            title="Write out the whole audio picture — what is set now, every step taken today and what each one did to the meters, who owns :4018, and the engine's log. Saved in data/studiocall/audio-logs/."
            className={`${SMALL_BTN} border-slate-700 text-slate-300 hover:bg-slate-800`}
          >
            Save log
          </button>
          <button
            type="button"
            onClick={() => void resetAudio()}
            disabled={busy}
            title="Drop both pins to the Windows default and put these two back — the dance that fixes silence after a restart, without changing what is selected"
            className={`${SMALL_BTN} border-slate-700 text-slate-300 hover:bg-slate-800`}
          >
            {busy ? 'Working…' : 'Reset audio'}
          </button>
        </div>
      </div>
      <div className="mt-2 grid gap-3">
        <label className="block">
          <span className="block text-[11px] text-slate-400">Into the room (your mix)</span>
          <CallMeter label="Mic → room" v={levels.out} off={!publishing || muted}
            why={!publishing ? 'not on stage' : muted ? 'muted' : null} />
          <select value={recName} onChange={e => void pinDevices(e.target.value, playName)} disabled={busy} className={SELECT}>
            <option value="">— not set —</option>
            {/* A pin whose name no device answers to any more has no option to sit on, and a
                select with an unmatched value falls back to the first one — so the panel read
                "— not set —" while the engine was pinned to something. Carry it. */}
            {recName && !audio.devices.recording.some(d => d.name === recName) && (
              <option value={recName}>{recName} — not present</option>
            )}
            {audio.devices.recording.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] text-slate-400">Out of the room (to OBS)</span>
          <CallMeter label="Room → you" v={levels.in} off={outMuted} why={outMuted ? 'muted' : null} />
          <select value={playName} onChange={e => void pinDevices(recName, e.target.value)} disabled={busy} className={SELECT}>
            <option value="">— not set —</option>
            {playName && !audio.devices.playback.some(d => d.name === playName) && (
              <option value={playName}>{playName} — not present</option>
            )}
            {audio.devices.playback.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </label>
      </div>
      {memory?.lastWorking && (
        <div className="mt-3 flex items-center gap-2 rounded border border-emerald-900/50 bg-emerald-950/20 px-2.5 py-1.5 text-[11px] text-emerald-300/90">
          <span className="min-w-0 flex-1">
            Last known good: <span className="text-emerald-200">{memory.lastWorking.rec ?? 'default'}</span>
            {' → '}
            <span className="text-emerald-200">{memory.lastWorking.play ?? 'default'}</span>
            {' · peak '}{memory.lastWorking.outPeak}
            {memory.lastWorking.inSeen ? ' · inbound seen' : ' · inbound never observed'}
          </span>
          {(recName !== (memory.lastWorking.rec ?? '') || playName !== (memory.lastWorking.play ?? '')) && (
            <button
              type="button"
              onClick={() => void restoreDevices()}
              disabled={busy}
              className="shrink-0 rounded bg-emerald-800 px-2 py-0.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Restore
            </button>
          )}
        </div>
      )}
      {pairs.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-slate-400">Kept pairings</div>
          <ul className="mt-1 flex flex-col gap-1">
            {pairs.map(p => {
              const current = (p.rec ?? '') === recName && (p.play ?? '') === playName;
              return (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 rounded border px-2 py-1.5 text-[11px] ${
                    current ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-slate-800 bg-slate-900/40'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-slate-300">
                      {p.rec ?? 'default'} <span className="text-slate-600">→</span> {p.play ?? 'default'}
                    </div>
                    <div className="text-[10px] tabular-nums text-slate-500">
                      worked {spanLabel(p.durationMs)} · peak {p.outPeak}
                      {p.inSeen ? ' · inbound seen' : ''} · kept {p.at.slice(0, 10)}
                    </div>
                  </div>
                  {current ? (
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-emerald-400">In use</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void restorePair(p.id)}
                      disabled={busy}
                      title="Pin these two again and rejoin the room"
                      className="shrink-0 rounded bg-emerald-800 px-2 py-0.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void forgetPair(p.id)}
                    title="Forget this pairing"
                    className="shrink-0 rounded px-1 text-slate-600 hover:bg-slate-800 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {/* A pin that matches no device leaves the engine on whatever it had — on a fresh one, the
          Windows default — so the room plays out of the wrong box while every select here reports
          the right one. The engine names the miss; say it out loud. */}
      {audio.lastError?.msg?.startsWith('no device matches') && (
        <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-300">
          {audio.lastError.msg}. Pick it again from the list above, or Reset audio.
        </div>
      )}
      <div className="mt-2 text-[11px] text-amber-500/80">
        Mix-minus: the inbound mix must not contain the room, or it will howl.
      </div>
    </div>
  );
}
