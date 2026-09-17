import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API, SM_API } from '../lib/api';
import { ACTIVE_ROW, ACTIVE_TINT, ACTIVE_PILL } from '../lib/activeStyle';
import { getUiSetting, setUiSetting, onUiSettingsLoaded } from '../lib/uiSettings';
import { notify } from '../lib/notices';
import { ws } from '../ws';
import { confirmEndRoom, leaveRoom } from '../lib/studioCallRoom';
import type { RosterRoom } from './StudioCallRoster';

/**
 * The hallway: which rooms are up, which one we are in, and the two moves between those states.
 *
 * It lives here rather than inside the StudioCall tab because the tab is not the only surface that
 * needs it. The Live Chat pop-out reads the room's chat all show long and, before this, had no way
 * to say which room that was or to go to a different one — the operator had to go back to the main
 * window for a decision the pop-out was already showing the consequences of.
 *
 * Two exports, because the two callers hold their state differently. `RoomList` is the listing
 * alone, for a caller that already polls the feed. `StudioCallRooms` wraps it with its own loading,
 * polling and leave, for a caller that holds nothing.
 */

export interface FeedRoom {
  channel: string;
  topic: string | null;
  numAll: number;
  numSpeakers: number;
  isPrivate: boolean;
  house: string | null;
  speakers: string[];
}

/**
 * The room we are in, as `/api/studiocall/room` reports it. Identical to the roster's own view of
 * it — one shape, so a caller that has this reading can hand it straight to the roster and to the
 * mic bar without a second fetch or a second type that drifts from it.
 */
export type RoomHere = RosterRoom;

// How full a room has to be to be worth listing. The hallway is a wall of rooms and most of them
// are somebody talking to nobody — the two questions an operator actually asks of it are "is
// anyone in there" and "is anyone TALKING", so those are the two filters. Persisted through
// uiSettings, because a threshold that resets every time the panel mounts is one nobody sets.
const MIN_ALL_KEY = 'studiocall:minInRoom';
const MIN_SPEAKERS_KEY = 'studiocall:minOnStage';
const THRESHOLDS = [0, 5, 10, 25, 50, 100];
const readMin = (key: string): number => {
  const n = Number(getUiSetting(key));
  return THRESHOLDS.includes(n) ? n : 0;
};

// Sort is a KEY plus a separate direction, never a direction baked into the options — the same
// shape every other library in the app wears. `feed` is Clubhouse's own ranking and stays the
// default: it is the one order nothing here can reconstruct, so losing it would be a one-way door.
const SORT_KEY = 'studiocall:sort';
const SORT_DIR_KEY = 'studiocall:sortDir';
const SORTS = [
  { key: 'feed', label: 'Room order' },
  { key: 'house', label: 'Name' },
  { key: 'topic', label: 'Title' },
  { key: 'all', label: 'In room' },
  { key: 'stage', label: 'On stage' },
] as const;
type SortKey = typeof SORTS[number]['key'];
const readSort = (): SortKey => {
  const v = getUiSetting(SORT_KEY);
  return SORTS.some(s => s.key === v) ? (v as SortKey) : 'feed';
};
// Descending by default, because every key here reads best big-end first: the fullest room, the
// busiest stage, and — for the two text keys — a plain A-Z once the toggle is flipped.
const readDir = (): 'asc' | 'desc' => (getUiSetting(SORT_DIR_KEY) === 'asc' ? 'asc' : 'desc');

function MinSelect({ value, onChange, label, noun }: {
  value: number; onChange: (n: number) => void; label: string; noun: string;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-neutral-500">
      {label}
      <select
        value={String(value)}
        onChange={e => onChange(Number(e.target.value))}
        className={`rounded border bg-neutral-900 px-1.5 py-0.5 text-xs outline-none ${
          value ? 'border-amber-600/60 text-amber-200' : 'border-neutral-700 text-neutral-300'
        }`}
      >
        {THRESHOLDS.map(n => (
          <option key={n} value={String(n)}>{n ? `${n}+` : `Any ${noun}`}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * The listing on its own. Every row is a join; the one we are in wears the live skin.
 *
 * **A room is named by its HOUSE, titled by its topic.** The club is what an operator recognises
 * across a hallway of a hundred rooms — it is the same name week after week, while the topic is
 * written fresh every time and is as often an emoji sentence as a title. So the house leads, the
 * topic sits under it, and the two numbers that say whether a room is worth walking into are
 * chips rather than a run-on line of grey text.
 *
 * **The row you came in through is the row you go out through.** Given `onLeave`, the current
 * room's "In room" badge becomes the way out — the same gesture in the same place, rather than a
 * pill that reports a state and offers nothing to do about it. Without it the badge stays a badge,
 * which is what a caller drawing its own Leave elsewhere wants.
 */
export function RoomList({ feed, currentChannel, busy, onJoin, onLeave }: {
  feed: FeedRoom[];
  currentChannel: string | null;
  busy: boolean;
  onJoin: (channel: string) => void;
  onLeave?: () => void;
}) {
  const [minAll, setMinAll] = useState(() => readMin(MIN_ALL_KEY));
  const [minSpeakers, setMinSpeakers] = useState(() => readMin(MIN_SPEAKERS_KEY));
  const [sort, setSort] = useState<SortKey>(() => readSort());
  const [dir, setDir] = useState<'asc' | 'desc'>(() => readDir());
  useEffect(() => onUiSettingsLoaded(() => {
    setMinAll(readMin(MIN_ALL_KEY));
    setMinSpeakers(readMin(MIN_SPEAKERS_KEY));
    setSort(readSort());
    setDir(readDir());
  }), []);

  // The room we are IN is never filtered away: it is the row that carries Leave, and hiding the
  // way out of a room because it went quiet is how an operator ends up stuck in one.
  // Free text over the title, the house and the names on the stage. Not persisted: a search is
  // about this moment's hallway, and one that came back tomorrow would hide rooms for no reason.
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    const hit = (r: FeedRoom) => !needle
      || (r.topic ?? '').toLocaleLowerCase().includes(needle)
      || (r.house ?? '').toLocaleLowerCase().includes(needle)
      || r.speakers.some(s => s.toLocaleLowerCase().includes(needle));
    const kept = feed.filter(r => r.channel === currentChannel || (r.numAll >= minAll && r.numSpeakers >= minSpeakers && hit(r)));
    if (sort === 'feed') return dir === 'desc' ? kept : [...kept].reverse();
    const name = (r: FeedRoom) => (r.house ?? '').toLocaleLowerCase();
    const title = (r: FeedRoom) => (r.topic ?? '').toLocaleLowerCase();
    const cmp = (a: FeedRoom, b: FeedRoom) =>
      sort === 'house' ? name(b).localeCompare(name(a))
      : sort === 'topic' ? title(b).localeCompare(title(a))
      : sort === 'all' ? a.numAll - b.numAll
      : a.numSpeakers - b.numSpeakers;
    const sorted = [...kept].sort((a, b) => cmp(b, a));
    return dir === 'desc' ? sorted : sorted.reverse();
  }, [feed, currentChannel, minAll, minSpeakers, sort, dir, q]);
  const filtered = minAll > 0 || minSpeakers > 0 || q.trim().length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="relative flex items-center">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
            placeholder="Search rooms, houses, people…"
            aria-label="Search rooms"
            className="w-56 rounded border border-neutral-700 bg-neutral-900 py-0.5 pl-2 pr-6 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} title="Clear the search" aria-label="Clear the search"
              className="absolute right-1 text-xs leading-none text-neutral-500 hover:text-neutral-200">✕</button>
          )}
        </span>
        <MinSelect label="In room" noun="size" value={minAll}
          onChange={n => { setMinAll(n); setUiSetting(MIN_ALL_KEY, String(n)); }} />
        <MinSelect label="On stage" noun="stage" value={minSpeakers}
          onChange={n => { setMinSpeakers(n); setUiSetting(MIN_SPEAKERS_KEY, String(n)); }} />
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          Sort
          <select
            value={sort}
            onChange={e => { const v = e.target.value as SortKey; setSort(v); setUiSetting(SORT_KEY, v); }}
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-300 outline-none"
          >
            {SORTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => { const v = dir === 'desc' ? 'asc' : 'desc'; setDir(v); setUiSetting(SORT_DIR_KEY, v); }}
            title={dir === 'desc' ? 'Biggest and last-named first — click for the other way up' : 'Smallest and first-named first — click for the other way up'}
            aria-label={`Sort ${dir === 'desc' ? 'descending' : 'ascending'}`}
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs leading-none text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100"
          >
            {dir === 'desc' ? '▼' : '▲'}
          </button>
        </label>
        <span className="ml-auto text-xs tabular-nums text-neutral-600">
          {filtered ? `${shown.length}/${feed.length}` : feed.length}
        </span>
      </div>

      <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
      {shown.map(r => {
        const here = r.channel === currentChannel;
        return (
          <div key={r.channel} className={`flex w-full items-start gap-3 px-3 py-2 ${here ? ACTIVE_TINT : 'hover:bg-neutral-800/60'}`}>
            <button
              type="button"
              onClick={() => onJoin(r.channel)}
              disabled={busy || here}
              title={here ? 'You are in this room' : currentChannel ? 'Leave the current room and join this one' : 'Join this room'}
              className={`min-w-0 flex-1 text-left disabled:cursor-default ${here ? '' : 'disabled:opacity-40'}`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-neutral-100">{r.house ?? 'no house'}</span>
                <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-300"
                  title={`${r.numAll} people in the room`}>{r.numAll} in room</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] tabular-nums ${
                  r.numSpeakers ? 'bg-amber-900/40 text-amber-200' : 'bg-neutral-800 text-neutral-500'
                }`} title={`${r.numSpeakers} on stage`}>{r.numSpeakers} on stage</span>
              </div>
              <div className="truncate text-xs text-neutral-400">{r.topic || '(no title)'}</div>
              {!!r.speakers.length && (
                <div className="truncate text-xs text-neutral-600">{r.speakers.join(', ')}</div>
              )}
            </button>
            {here && (onLeave
              ? (
                <button
                  type="button"
                  onClick={onLeave}
                  disabled={busy}
                  title="Walk out of this room"
                  className="shrink-0 rounded bg-rose-700 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-600 disabled:opacity-40"
                >
                  Leave
                </button>
              )
              : <span className={`shrink-0 ${ACTIVE_PILL}`}>In room</span>)}
          </div>
        );
      })}
      {!shown.length && (
        <div className="px-3 py-2 text-xs text-neutral-600">
          {feed.length ? 'No room is this full — lower the filters above.' : 'No live rooms right now.'}
        </div>
      )}
      </div>
    </div>
  );
}

export interface House { id: string; name: string; slug: string; members: number; liveChannels: number; photoUrl: string | null }

type PrivacyLevel = 'house' | 'public' | 'friend_of_friend' | 'friend';

// The two friend levels are Clubhouse's private rooms: no house owns them, so they
// open from the button rather than from a house row.
const PRIVACY_OPTIONS: { value: PrivacyLevel; label: string; hint: string }[] = [
  { value: 'house', label: 'House', hint: 'members of the house' },
  { value: 'public', label: 'Public', hint: 'listed in the hallway' },
  { value: 'friend_of_friend', label: 'Friends of friends', hint: 'private — one hop out' },
  { value: 'friend', label: 'Friends only', hint: 'private — people you follow' },
];

/**
 * Opening a room: a title, who may come in, and — for the two public levels — which house it opens
 * in, because Clubhouse has no houseless public room.
 *
 * Self-contained, because everything it needs is its own: the house list, the show title it offers
 * as a shortcut, and the four fields of the form. `POST /room/create` does the rest server-side —
 * it creates, joins (a room nobody is in is reaped within seconds), starts the host ping, turns
 * text chat on and connects the audio leg — so there is nothing for a caller to sequence.
 */
export function StartRoom({ onCreated }: { onCreated?: () => void }) {
  const [houses, setHouses] = useState<House[]>([]);
  const [topic, setTopic] = useState('');
  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('house');
  // The show on air, else the next one scheduled — the same reading the Scene tab's headline
  // follows, offered as a room title rather than typing it twice.
  const [showTitle, setShowTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const created = useRef(onCreated);
  created.current = onCreated;

  useEffect(() => {
    fetch(`${API}/api/studiocall/houses`).then(x => x.json()).then(d => setHouses(d?.houses ?? [])).catch(() => {});
    fetch(`${SM_API}/api/youtube/show`).then(x => x.json()).then(d => setShowTitle(d?.show?.title ?? null)).catch(() => {});
  }, []);

  const create = useCallback(async (houseId?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ houseId, topic: topic.trim() || undefined, privacyLevel }),
      });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Could not open the room.');
      else created.current?.();
    } catch {
      notify.error('Room request failed.');
    } finally {
      setBusy(false);
    }
  }, [topic, privacyLevel]);

  return (
    <div>
      <div className="text-sm font-medium text-neutral-300">Start a room</div>
      <input
        value={topic}
        onChange={e => setTopic(e.target.value)}
        placeholder="Room title (optional)"
        className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600"
      />
      {showTitle && showTitle !== topic && (
        <button
          type="button"
          onClick={() => setTopic(showTitle)}
          title="The show on air, or the next one scheduled on the channel — the same reading the Scene tab follows"
          className="mt-1 block w-full truncate text-left text-xs text-sky-400 hover:text-sky-300"
        >
          Use the show title: {showTitle}
        </button>
      )}
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-neutral-400">
        {PRIVACY_OPTIONS.map(o => (
          <label key={o.value} className="flex items-center gap-1.5">
            <input type="radio" name="sc-privacy" checked={privacyLevel === o.value} onChange={() => setPrivacyLevel(o.value)} />
            {o.label} — {o.hint}
          </label>
        ))}
      </div>
      {privacyLevel === 'house' || privacyLevel === 'public' ? (
        <div className="mt-3 max-h-72 overflow-auto rounded border border-neutral-800">
          {houses.map(h => (
            <button
              key={h.id}
              type="button"
              onClick={() => void create(h.id)}
              disabled={busy}
              className="flex w-full items-center gap-3 border-b border-neutral-800 px-3 py-2 text-left last:border-b-0 hover:bg-neutral-800/60 disabled:opacity-40"
            >
              {h.photoUrl
                ? <img src={`${API}${h.photoUrl}`} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                : <div className="h-8 w-8 shrink-0 rounded bg-neutral-800" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-neutral-200">{h.name}</span>
                <span className="block text-xs text-neutral-500">{h.members.toLocaleString()} members</span>
              </span>
              <span className="shrink-0 text-xs text-sky-400">Open →</span>
            </button>
          ))}
          {!houses.length && <div className="px-3 py-2 text-xs text-neutral-600">No houses loaded.</div>}
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-xs text-neutral-500">
            A private room belongs to no house — it is open only to
            {privacyLevel === 'friend' ? ' the people you follow' : ' your follows and theirs'}, and does not appear in the hallway.
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="mt-2 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? 'Opening…' : 'Open private room'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The listing plus the room we are in, owning its own reads.
 *
 * `onJoined` fires after a join or a leave has landed, so a surface that shows the room's chat can
 * follow the operator into the room they just picked instead of waiting for the pump to notice.
 *
 * **Leave and End are both here, and only for the room we are in.** Leaving a room we HOST leaves
 * it running — Clubhouse only reaps it once the pings stop — so a host who is done needs the other
 * act, and needing it only ever becomes obvious while reading the room. That was the argument for
 * keeping End on the tab, and it was backwards: this window is where the show's room is watched,
 * and crossing to the main window mid-show to close it is the trip the pop-out exists to save.
 * End is offered to a host alone, because Clubhouse refuses `end_channel` to anybody else.
 */
export function StudioCallRooms({ onJoined, onRoom, reload }: {
  onJoined?: () => void;
  onRoom?: (room: RoomHere) => void;
  /** Bump to re-read now — a caller that just joined, left or took the mic changed the answer. */
  reload?: number;
}) {
  const [feed, setFeed] = useState<FeedRoom[]>([]);
  const [room, setRoom] = useState<RoomHere>({ live: false });
  const [busy, setBusy] = useState(false);

  // Held in refs so `load` keeps one identity: it is the dependency of a 20s interval and of a
  // socket subscription, and a caller passing an inline arrow would otherwise tear both down and
  // rebuild them on every render.
  const cbs = useRef({ onJoined, onRoom });
  cbs.current = { onJoined, onRoom };
  // What the listing believes it is in, readable from the socket handler without making the room
  // a dependency of it.
  const channelRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([
        fetch(`${API}/api/studiocall/room`).then(x => x.json()),
        fetch(`${API}/api/studiocall/feed`).then(x => x.json()),
      ]);
      const here: RoomHere = r ?? { live: false };
      channelRef.current = here.channel ?? null;
      setRoom(here);
      setFeed(f?.rooms ?? []);
      cbs.current.onRoom?.(here);
    } catch { /* the tab says so loudly enough for both of us */ }
  }, []);

  // The hallway is somebody else's state — it changes without us doing anything, and a stale
  // listing offers rooms that have closed.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [load, reload]);

  // Inside a room the counts and the roster move, and callers of `onRoom` draw both — the pop-out's
  // People tab is a list of faces, not a headline, and twenty seconds of it is a different room.
  // The room alone, so the hallway sweep stays at its own pace.
  useEffect(() => {
    if (!room.live) return;
    const t = setInterval(async () => {
      try {
        const here: RoomHere = await fetch(`${API}/api/studiocall/room`).then(x => x.json()) ?? { live: false };
        channelRef.current = here.channel ?? null;
        setRoom(here);
        cbs.current.onRoom?.(here);
      } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [room.live]);

  // A room joined or left from the main tab has to show here within a tick, not on the next
  // 20s sweep: the operator who left in one window must not still be offered Leave in another.
  // Both payloads carry the channel and both go out on the join, so either one is the signal.
  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type !== 'studiocall-chat' && msg.type !== 'studiocall-speakers') return;
    if (((msg.channel as string | null) ?? null) !== channelRef.current) void load();
  }), [load]);

  const join = useCallback(async (channel: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const d = await r.json();
      if (!r.ok) return notify.error(d?.body?.error_message || d?.error || 'Could not join the room.');
      await load();
      cbs.current.onJoined?.();
    } catch {
      notify.error('Join request failed.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  // Through the shared leave, so the door behaves the same here, in the roster and in the status
  // bar: it opens on the press, with no question in the way.
  const leave = useCallback(async () => {
    setBusy(true);
    try {
      if (!await leaveRoom()) return;
      await load();
      cbs.current.onJoined?.();
    } finally {
      setBusy(false);
    }
  }, [load]);

  // The room re-read either way: an end that Clubhouse refused leaves us still in it, and the
  // banner has to say so rather than sitting on the reading it had before the click.
  const end = useCallback(async () => {
    setBusy(true);
    try {
      await confirmEndRoom();
      await load();
      cbs.current.onJoined?.();
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {room.live && (
        <div className={`rounded border px-3 py-2 ${ACTIVE_ROW}`}>
          <div className="flex items-center gap-2">
            <span className={ACTIVE_PILL}>In room</span>
            {room.mode === 'host' && <span className="text-[10px] uppercase tracking-wider text-amber-400">Hosting</span>}
            <button
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              title={room.mode === 'host'
                ? 'Walk out — the room stays up for everybody in it'
                : 'Walk out of this room'}
              className="ml-auto shrink-0 rounded bg-rose-700 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-600 disabled:opacity-40"
            >
              Leave
            </button>
            {/* Moderator only — Clubhouse refuses `end_channel` to anybody else — and read off the
                roster by the server (`iAmModerator`), never from `mode`: `host` means only that
                THIS process created the room, so a room started on the phone or re-joined after a
                restart is a `guest` room to us and hid End from the person who owns it. The two
                acts are different enough to be different buttons: Leave walks out of a room that
                stays up, End closes it on everybody. */}
            {room.iAmModerator && (
              <button
                type="button"
                onClick={() => void end()}
                disabled={busy}
                title="Close the room — everybody in it is dropped"
                className="shrink-0 rounded border border-rose-600 px-3 py-1 text-xs font-semibold text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-40"
              >
                End room
              </button>
            )}
          </div>
          <div className="mt-1 truncate text-sm text-neutral-200">{room.topic || '(no title)'}</div>
          <div className="truncate text-xs text-neutral-500">
            {room.numAll ?? '—'} in room · {room.numSpeakers ?? '—'} on stage
          </div>
        </div>
      )}

      <div className="flex items-center">
        <div className="text-sm font-medium text-neutral-300">Live rooms</div>
        <button type="button" onClick={() => void load()} className="ml-auto text-xs text-sky-400 hover:text-sky-300">
          Refresh
        </button>
      </div>

      <RoomList feed={feed} currentChannel={room.channel ?? null} busy={busy} onJoin={ch => void join(ch)} onLeave={() => void leave()} />

      {!room.live && (
        <>
          <p className="px-1 text-[11px] text-neutral-600">
            Pick a room to join it. Its chat then joins the list on the Chat tab.
          </p>
          {/* Out of a room, opening one is the other half of the hallway — the pop-out could
              only ever join somebody else's, which meant crossing to the main window to start
              the show's own. Absent while in a room: you can only be in one. */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
            <StartRoom onCreated={() => { void load(); cbs.current.onJoined?.(); }} />
          </div>
        </>
      )}
    </div>
  );
}
