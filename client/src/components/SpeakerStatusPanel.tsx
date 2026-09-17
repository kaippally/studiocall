import { useEffect, useState } from 'react';
import { FloatingWindow, type Rect } from './FloatingWindow';
import type { RoomHere } from './StudioCallRooms';
import { setAccountBlock, useSpeakerStatus, type StatusFlag } from '../lib/speakerStatus';
import { useControlNumber } from '../lib/studioCallControls';
import { useEscapeKey } from '../lib/escapeStack';
import { askConfirm, askPrompt } from '../lib/ask';
import { API } from '../lib/api';
import { notify } from '../lib/notices';

/**
 * Speaker Status — one row per person, five standing decisions per row, and what the show has
 * counted about them.
 *
 * A gag, an automute, an autokick or an automod is made once and then outlives the moment on
 * purpose: it is persisted and follows somebody across rooms and renames. That is the whole
 * value of it, and it is also the problem this panel solves: until it existed the only place a
 * gag was visible was a row that person had to speak on first, and a gagged line never arrives.
 * So somebody gagged three shows ago was silent with nothing anywhere saying why, and nothing to
 * click to undo it.
 *
 * The rows are everybody with a flag set, everybody this account has blocked at Clubhouse, and
 * everybody on the stage right now — the stage rows are how a decision is made about somebody
 * who has no flag yet. The block column is Clubhouse's own list, so it can be `null` when that
 * list could not be read, and then the column is drawn disabled rather than wrong.
 *
 * Each row also carries the person's record (`GET /people`): the face,
 * since when, rooms, speech, drops, the follower counts last read, and the operator's note.
 * The 📝 button edits the note; the 📺 button puts their profile on the CHinfocard layer.
 *
 * A FloatingWindow, not a Dialog: it is read against the room — who is talking, what they are
 * typing — so nothing behind it may be dimmed or blocked, and it is dragged and sized to wherever
 * the operator keeps the chat. Esc closes it; there is nothing to accept.
 */

const DEFAULT_RECT: Rect = { x: 120, y: 80, w: 860, h: 600 };

const FLAGS: { flag: StatusFlag; label: string; on: (who: string) => string; off: (who: string) => string }[] = [
  { flag: 'gag', label: 'Gag', on: who => `${who} is gagged — every line of theirs is deleted as it arrives and their mic is shut whenever it opens. Click to let them speak again`, off: who => `Gag ${who}: delete every line they type and shut their mic whenever it opens` },
  { flag: 'autoMute', label: 'Automute', on: who => `${who} is auto-muted — their mic is shut whenever it opens. Click to let them keep it`, off: who => `Automute ${who}: shut their mic whenever it opens, and leave their chat alone` },
];
const KICK = { flag: 'autoKick' as const, label: 'Autokick', on: (who: string, min: number) => `${who} is removed from the room once they have been in it for ${min} min. Click to let them stay`, off: (who: string, min: number) => `Autokick ${who}: remove them from the room once they have been in it for ${min} min` };
// The one column that gives rather than takes, and the one that cannot be undone at Clubhouse:
// there is no /remove_moderator (see /room/moderator on the server), so it asks on the way in.
const MOD = { flag: 'autoMod' as const, label: 'Automod', on: (who: string) => `${who} is made a moderator whenever they are on the stage of a room you moderate. Click to stop promoting them — anybody already promoted stays a moderator`, off: (who: string) => `Automod ${who}: make them a moderator whenever they are on the stage of a room you moderate. Clubhouse cannot take it back` };

const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/** What `GET /people` says about one person — the counted record, never the messages. */
interface Person {
  userId: string; name: string; username: string; photoUrl: string; notes: string;
  followers: number | null; following: number | null;
  firstSeenAt: string; lastSeenAt: string;
  roomsAttended: number; roomsSpoken: number; talkMs: number; messages: number; drops: number;
}

const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K` : String(n));
const speech = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.floor(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

interface Row { userId: string; name: string; photoUrl: string | null; gag?: string; autoMute?: string; autoKick?: string; autoMod?: string; blocked: boolean; onStage: boolean }

function Toggle({ on, label, title, disabled, tone = 'rose', onClick }: { on: boolean; label: string; title: string; disabled?: boolean; tone?: 'rose' | 'emerald'; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`w-[88px] shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40 ${
        on
          ? tone === 'emerald'
            ? 'border-emerald-700/70 bg-emerald-950/50 text-emerald-200 hover:border-emerald-500'
            : 'border-rose-700/70 bg-rose-950/50 text-rose-200 hover:border-rose-500'
          : 'border-slate-700 bg-slate-900 text-slate-500 hover:border-slate-500 hover:text-slate-300'
      }`}
    >
      {label}
    </button>
  );
}

function IconButton({ on, glyph, title, onClick }: { on?: boolean; glyph: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border text-xs leading-none transition ${
        on ? 'border-amber-600/70 bg-amber-950/40 text-amber-200 hover:border-amber-400' : 'border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
      }`}
    >
      {glyph}
    </button>
  );
}

export function SpeakerStatusPanel({ open, onClose, room }: { open: boolean; onClose: () => void; room: RoomHere }) {
  const { people, blocked, setFlag } = useSpeakerStatus();
  const [minutes, editMinutes, saveMinutes] = useControlNumber('autoKickMinutes');
  useEscapeKey(open, onClose);

  const rows = new Map<string, Row>();
  const row = (userId: string, name: string, photoUrl?: string | null): Row => {
    const r = rows.get(userId) ?? { userId, name, photoUrl: null, blocked: false, onStage: false };
    if (!r.name && name) r.name = name;
    if (!r.photoUrl && photoUrl) r.photoUrl = photoUrl;
    rows.set(userId, r);
    return r;
  };
  for (const p of people) Object.assign(row(String(p.userId), p.name), { gag: p.gag, autoMute: p.autoMute, autoKick: p.autoKick, autoMod: p.autoMod });
  for (const b of blocked ?? []) row(String(b.userId), b.name).blocked = true;
  for (const s of room.speakers ?? []) row(String(s.userId), s.name, s.photoUrl).onStage = true;
  const sorted = [...rows.values()].sort((a, b) => Number(b.onStage) - Number(a.onStage) || (a.name || a.userId).localeCompare(b.name || b.userId));

  // The counted record for every row, in one call, re-read when the rows change or a note is
  // saved. Keyed on the id list rather than the array so a poll that changes nothing costs nothing.
  const ids = open ? sorted.map(r => r.userId).join(',') : '';
  const [met, setMet] = useState<Record<string, Person>>({});
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    fetch(`${API}/api/studiocall/people?ids=${encodeURIComponent(ids)}`)
      .then(r => r.json())
      .then(d => { if (alive) setMet(d?.people ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, [ids, gen]);

  if (!open) return null;

  const editNote = async (r: Row) => {
    const who = r.name || r.userId;
    const text = await askPrompt({
      title: `Note on ${who}`,
      body: 'Kept with their record on this desk only — nothing is posted anywhere.',
      initial: met[r.userId]?.notes ?? '',
      confirmLabel: 'Save',
    });
    if (text === null) return;
    try {
      const res = await fetch(`${API}/api/studiocall/people/${r.userId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: text }),
      });
      if (!res.ok) throw new Error();
      setGen(g => g + 1);
    } catch { notify.error('Could not save the note.'); }
  };

  const showProfile = async (r: Row) => {
    const who = r.name || r.userId;
    try {
      const res = await fetch(`${API}/api/studiocall/infocard`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: r.userId, on: true }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? 'refused');
      if (d?.refused) return notify.warn(d.refused);
      notify.info(`${who}'s profile is on the CHinfocard layer.`);
    } catch { notify.error(`Could not put ${who}'s profile on air.`); }
  };

  return (
    <FloatingWindow
      storageKey="studiocall:speakerStatusRect"
      defaultRect={DEFAULT_RECT}
      minW={760}
      minH={280}
      onClose={onClose}
      title={<span className="text-[13px] font-semibold text-slate-200">Speaker Status{people.length ? ` · ${people.length}` : ''}</span>}
    >
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <label className="flex shrink-0 items-center gap-3 rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-slate-200">Autokick after</div>
            <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
              Somebody with Autokick on is removed from the room once they have been in it this long. The clock restarts if they come back.
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={600}
            value={minutes || ''}
            onChange={e => editMinutes(Number(e.target.value))}
            onBlur={saveMinutes}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-16 shrink-0 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-[12px] tabular-nums text-slate-200 focus:border-slate-500 focus:outline-none"
          />
          <span className="text-[11px] text-slate-500">min</span>
        </label>
        {!sorted.length ? (
          <p className="py-6 text-center text-xs text-slate-500">Nobody has a status, and nobody is on the stage.</p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {sorted.map(r => {
              const who = r.name || r.userId;
              const p = met[r.userId];
              const photo = r.photoUrl || p?.photoUrl || '';
              const marks = [
                r.onStage ? 'on stage' : '',
                r.gag ? `gagged ${stamp(r.gag)}` : '',
                r.autoMute ? `automute ${stamp(r.autoMute)}` : '',
                r.autoKick ? `autokick ${stamp(r.autoKick)}` : '',
                r.autoMod ? `automod ${stamp(r.autoMod)}` : '',
                r.blocked ? 'blocked' : '',
              ].filter(Boolean).join(' · ');
              const record = p ? [
                `since ${p.firstSeenAt.slice(0, 10)}`,
                `${p.roomsAttended} rooms`,
                `${p.roomsSpoken} on stage`,
                `${speech(p.talkMs)} speech`,
                `${p.messages} lines`,
                `${p.drops} drops`,
                p.followers != null ? `${count(p.followers)} followers` : '',
                p.following != null ? `${count(p.following)} following` : '',
              ].filter(Boolean).join(' · ') : 'never met';
              return (
                <li key={r.userId} className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5">
                  {photo
                    ? <img src={photo} alt="" className="h-9 w-9 shrink-0 rounded-full bg-slate-800 object-cover" />
                    : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm text-slate-500">{who.slice(0, 1).toUpperCase()}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-slate-200">{who}{p?.username ? <span className="text-slate-500"> @{p.username}</span> : null}</div>
                    <div className="truncate text-[10px] tabular-nums text-slate-500">{marks || '—'}</div>
                    <div className="truncate text-[10px] tabular-nums text-slate-400" title={p?.notes || undefined}>{record}{p?.notes ? ` · 📝 ${p.notes}` : ''}</div>
                  </div>
                  <IconButton glyph="📝" on={!!p?.notes} title={p?.notes ? `Note: ${p.notes}\nClick to edit` : `Write a note on ${who}`} onClick={() => void editNote(r)} />
                  <IconButton glyph="📺" title={`Put ${who}'s profile on the CHinfocard layer for the audience`} onClick={() => void showProfile(r)} />
                  {FLAGS.map(f => (
                    <Toggle
                      key={f.flag}
                      on={!!r[f.flag]}
                      label={f.label}
                      title={r[f.flag] ? f.on(who) : f.off(who)}
                      onClick={() => void setFlag(r.userId, r.name, f.flag, !r[f.flag])}
                    />
                  ))}
                  <Toggle
                    on={r.blocked}
                    label="Block"
                    disabled={blocked === null}
                    title={blocked === null
                      ? 'The blocked list could not be read from Clubhouse, so nothing here can be changed'
                      : r.blocked
                        ? `${who} is blocked at Clubhouse — they cannot enter a room of yours. Click to let them back in`
                        : `Block ${who} at Clubhouse: they cannot enter a room of yours until it is undone`}
                    onClick={() => void setAccountBlock(r.userId, r.name, !r.blocked)}
                  />
                  <Toggle
                    on={!!r.autoKick}
                    label={KICK.label}
                    title={r.autoKick ? KICK.on(who, minutes) : KICK.off(who, minutes)}
                    onClick={() => void setFlag(r.userId, r.name, KICK.flag, !r.autoKick)}
                  />
                  <Toggle
                    on={!!r.autoMod}
                    label={MOD.label}
                    tone="emerald"
                    title={r.autoMod ? MOD.on(who) : MOD.off(who)}
                    onClick={async () => {
                      if (!r.autoMod && !await askConfirm({
                        title: `Make ${who} a moderator whenever they are on the stage?`,
                        body: 'They are promoted the moment they are a speaker in a room you moderate — now, if they already are. Clubhouse has no way to take a moderator badge back, so turning this off later only stops future promotions.',
                        confirmLabel: 'Automod',
                        level: 'warn',
                      })) return;
                      await setFlag(r.userId, r.name, MOD.flag, !r.autoMod);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FloatingWindow>
  );
}
