import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { API, SM_API } from '../lib/api';
import { ACTIVE_BORDER, ACTIVE_PILL } from '../lib/activeStyle';
import { notify } from '../lib/notices';
import { askConfirm } from '../lib/ask';
import { ws } from '../ws';
import { resetStudioCallAudio } from '../lib/studiocallAudio';
import { confirmEndRoom, leaveRoom } from '../lib/studioCallRoom';
import { UplinkDot } from './UplinkDot';
import { ModDot } from './ModDot';
import { MuteCross } from './MuteCross';
import { RetryImg } from './RetryImg';
import { Dialog } from './Dialog';
// One creation form for the whole app. The import is one-way at runtime: the hallway
// takes only `RosterRoom` from here, and that is a type, so nothing circular survives the build.
import { StartRoom } from './StudioCallRooms';
import { ActionChip, PersonTile } from './studiocall/PersonTile';
import { getUiSetting, setUiSetting, onUiSettingsLoaded } from '../lib/uiSettings';
import { openAdminWindow } from '../lib/adminPopout';
import { PhotoHistoryDialog } from './PhotoHistoryDialog';
import { setAccountBlock, useSpeakerStatus } from '../lib/speakerStatus';
import { useHeldMutes } from '../lib/heldMute';
import { RangeRow } from './RangeRow';
import { BarIcon } from '../lib/barIcons';
import { TabIcon } from '../lib/tabIcons';
import { IconMic } from './meet/icons';

/** The dragged height of the On stage band, CSS px, remembered across windows. */
const STAGE_H_KEY = 'studiocall:stageHeight';
/** '1' = both bands uncapped and unscrolled; they take what their tiles need. */
const FIT_KEY = 'studiocall:rosterFit';
const STAGE_H_MIN = 64;
const STAGE_H_MAX = 900;
import { OverlayLayerContext } from '../lib/overlayLayerContext';
import { StudioCallInfoCardOverlay, CARD_EFFECTS, DEFAULT_SEQ, seqFrom, type CardSeq } from './StudioCallInfoCardOverlay';
import { CardFrameCanvas } from './studiocall/CardFrameCanvas';
import { useHistory } from './layout/useHistory';
import { UndoRedo } from './layout/CanvasToolbar';

/**
 * Who is in the room — the stage, the audience, every move you can make on a person, and the
 * two the operator makes on themselves.
 *
 * It lives here rather than inside the StudioCall tab for the same reason the hallway listing
 * does (StudioCallRooms.tsx): the tab is not the only surface that needs it. The Live Chat
 * pop-out reads a room's chat all show long, and the one question it could not answer was who
 * was actually talking — the operator had to go back to the main window, mid-show, for a roster
 * the pop-out was already showing the consequences of.
 *
 * Three exports and one hook, split by who owns the reads. `RoomRoster` is the roster alone, for
 * a caller that already polls the room. `useRoomSpeaking` is the 250ms talk report — ONE per
 * window, because it is the fastest poll in the app and two of them would be two. `RoomMicBar`
 * is the pair of self-directed acts (mute, and on/off the room) that belong in a title bar
 * rather than in a tab. `StudioCallPeople` is the roster plus its own actions and info card.
 */

export interface Participant {
  userId: string;
  name: string;
  username: string;
  isSpeaker: boolean;
  isModerator: boolean;
  isInvitedAsSpeaker: boolean;
  photoUrl: string | null;
}

export interface RosterRoom {
  live: boolean;
  mode?: 'host' | 'guest' | null;
  channel?: string;
  topic?: string | null;
  numAll?: number | null;
  numSpeakers?: number | null;
  speakers?: Participant[];
  listeners?: Participant[];
  onStage?: boolean;
  /** A moderator has answered the raised hand: the stage is offered and waiting to be taken. */
  invitedToSpeak?: boolean;
  /** Is the room's text chat open? Clubhouse opens a new room with it CLOSED — the desk turns it
   *  on at creation (see /room/create), because half of what this app reads is that channel. */
  chatEnabled?: boolean;
  /** Clubhouse only lets a moderator open or close it; false means don't offer the control. */
  canDisableChat?: boolean;
  /** May this account END the room. The server's answer, off our own roster row — never
   *  `mode === 'host'`, which is only true for a room this process itself created. */
  iAmModerator?: boolean;
  /** The room's pinned links. Clubhouse keeps a list; every client shows the last one. */
  links?: PinnedLink[];
  /** Clubhouse's own `is_pinned_links_available` — false means don't offer the control. */
  canPinLinks?: boolean;
  /** Everything `get_channel` says about the room itself — drawn by `RoomDetails`. */
  details?: RoomDetailsInfo;
}

/** A room setting with Clubhouse's own option list, so the labels drawn are Clubhouse's. */
export interface RoomSetting {
  value: number | null;
  options: { value: number; label: string; hint: string | null }[];
  canEdit: boolean;
}

export interface RoomDetailsInfo {
  house: string | null;
  privacy: string | null;
  language: string | null;
  url: string | null;
  createdAt: string | null;
  stage: RoomSetting;
  chat: RoomSetting;
}

/**
 * Open or close the room's text chat.
 *
 * **It matters more here than it looks.** That channel is not a side feature of the room — the desk
 * reads it beside YouTube's chat, puts lines from it on air, and captures the links posted in it.
 * Closed, all three go quiet with nothing to say why, so the state needs to be visible where the
 * operator is reading, not only on the StudioCall tab.
 *
 * One implementation for both surfaces, per the no-duplication rule: `compact` is the title-bar
 * sizing the Live Chat window uses, the default is the tab's full-size button.
 */
export function RoomChatToggle({ room, onChanged, compact }: {
  room: RosterRoom;
  /** Re-read the room — the caller owns the poll, and this act changes its answer. */
  onChanged: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // Clubhouse refuses this to a non-moderator, so an offered button would be a click that comes
  // back as an error for no stated reason. Absent is the honest rendering.
  if (room.canDisableChat === false) return null;

  const on = !!room.chatEnabled;
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !on }),
      });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Clubhouse refused that.');
      onChanged();
    } catch {
      notify.error('Could not reach the server to change the room chat.');
    } finally { setBusy(false); }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      title={on
        ? 'Room chat is open — everyone can post. Click to close it'
        : 'Room chat is CLOSED: nothing arrives in the list, nothing can go on air, no links are captured. Click to open it'}
      className={compact
        ? `flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition disabled:opacity-40 ${
            on ? `${ACTIVE_BORDER} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25`
               : 'border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-900/50'}`
        : 'rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600 disabled:opacity-40'}
    >
      {compact ? <><TabIcon id="chat" />{on ? 'open' : 'closed'}</> : on ? 'Close chat' : 'Open chat'}
    </button>
  );
}

export interface PinnedLink {
  linkId: string | number;
  title: string | null;
  displayLink: string | null;
  targetLink: string | null;
  rootLink: string | null;
  fromName: string | null;
}

/**
 * The room's pinned link — one URL in front of everybody in the room.
 *
 * The show's own link (the stream, the article being discussed, the form) is the thing an operator
 * has always had to read out loud twice and then paste into a chat nobody scrolls back through.
 * Clubhouse pins one per room and every client draws the last one, so this is a single line rather
 * than a list: click it to open, and — as a moderator — Edit replaces it and ✕ takes it down.
 *
 * **Adding one is typing a URL, exactly like the title above it** (`RoomTopic`): Enter saves, Esc
 * drops it, blur saves, because a click away from a pasted URL is "done" far more often than it is
 * "cancel". Clubhouse resolves the page itself and hands back the title and root domain, so what
 * is drawn here is what the room sees, not our own guess at it.
 *
 * One implementation for the tab and for the pop-out. A non-moderator gets the link and
 * no controls, because Clubhouse refuses the write.
 */
export function RoomPinnedLink({ room, iAmModerator, onChanged, compact }: {
  room: RosterRoom;
  iAmModerator: boolean;
  /** Re-read the room — pinning and unpinning change its answer. */
  onChanged: () => void;
  /** Title-bar sizing for the pop-out header. */
  compact?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!room.live || room.canPinLinks === false) return null;

  const link = room.links?.length ? room.links[room.links.length - 1] : null;

  const save = async (raw: string) => {
    setDraft(null);
    const url = raw.trim();
    if (!url || url === (link?.targetLink ?? '')) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/link`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Clubhouse refused that link.');
      onChanged();
    } catch {
      notify.error('Could not reach the server to pin the link.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!link) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/link/remove`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ linkId: link.linkId }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) notify.error(d?.error || 'Clubhouse refused to unpin that.');
      onChanged();
    } catch {
      notify.error('Could not reach the server to unpin the link.');
    } finally { setBusy(false); }
  };

  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void save(draft)}
        onKeyDown={e => {
          if (e.key === 'Enter') void save(draft);
          if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); }
        }}
        placeholder="https://…"
        className={`w-full rounded border border-sky-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 ${compact ? 'min-w-[14rem]' : ''}`}
      />
    );
  }

  if (!link) {
    if (!iAmModerator) return null;
    return (
      <button
        type="button"
        onClick={() => setDraft('')}
        disabled={busy}
        title="Pin a link in the room — everybody in it sees it, and it survives the scroll"
        className={compact
          ? 'flex shrink-0 items-center gap-1 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neutral-400 transition hover:text-sky-300 disabled:opacity-40'
          : 'flex items-center gap-1 text-xs text-sky-400 transition hover:text-sky-300 disabled:opacity-40'}
      >
        <BarIcon id="link" /> Pin a link
      </button>
    );
  }

  return (
    <div className={`flex min-w-0 items-center gap-2 ${compact ? '' : 'rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1'}`}>
      {/* The room sees a card; the desk needs the domain, which is the part that says whether the
          right thing got pinned. Opening it is the desk's own browser, never the room's. */}
      <a
        href={link.targetLink ?? undefined}
        target="_blank"
        rel="noreferrer"
        title={link.targetLink ?? undefined}
        className="min-w-0 flex-1 truncate text-xs text-sky-400 hover:text-sky-300"
      >
        <BarIcon id="link" className="mr-1 inline-block h-3.5 w-3.5 align-[-3px]" />
        {link.title || link.displayLink || link.targetLink}
        {link.rootLink && <span className="ml-1 text-neutral-500">{link.rootLink}</span>}
      </a>
      {iAmModerator && (
        <>
          <button
            type="button"
            onClick={() => setDraft(link.targetLink ?? '')}
            disabled={busy}
            title="Replace the pinned link"
            className="shrink-0 text-[11px] text-neutral-500 transition hover:text-neutral-200 disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            title="Take the pinned link down"
            className="shrink-0 text-[11px] text-rose-400 transition hover:text-rose-300 disabled:opacity-40"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The room's title, and the click that renames it.
 *
 * The title is the one piece of the room a moderator can still change once it is up, and it is
 * read from every surface that shows the room — so the edit lives with the text rather than
 * behind a pencil somewhere else. Click it, type, Enter saves and Esc drops the change; blur
 * saves too, because a click away from a half-typed rename is far more often "done" than
 * "cancel".
 *
 * One implementation for both surfaces: the StudioCall tab and the Live Chat pop-out's
 * People tab draw the same title, and before this only the tab could edit it. Clubhouse refuses
 * `/set_channel_title` to a non-moderator, so a non-moderator gets inert text and a title that
 * says why rather than a click that comes back as an error.
 */
export function RoomTopic({ room, iAmModerator, onChanged, className = 'text-xs text-neutral-400' }: {
  room: RosterRoom;
  iAmModerator: boolean;
  /** Re-read the room — a rename changes its answer. */
  onChanged: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = useCallback(async (next: string) => {
    setDraft(null);
    if (!next.trim() || next.trim() === (room.topic ?? '')) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/topic`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: next.trim() }),
      });
      if (!r.ok) notify.error((await r.json())?.body?.error_message || 'Clubhouse refused the rename.');
      onChanged();
    } catch {
      notify.error('Could not reach the server to rename the room.');
    } finally { setBusy(false); }
  }, [room.topic, onChanged]);

  if (draft !== null) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void save(draft)}
        onKeyDown={e => {
          if (e.key === 'Enter') void save(draft);
          if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); }
        }}
        placeholder="Room title"
        className={`w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => iAmModerator && setDraft(room.topic ?? '')}
      disabled={!iAmModerator || busy}
      title={iAmModerator ? 'Click to rename the room' : 'Only a moderator can rename the room'}
      className={`block w-full truncate text-left enabled:hover:text-neutral-100 disabled:cursor-default ${className}`}
    >
      {room.topic || (iAmModerator ? 'Add a title…' : '(no title)')}
    </button>
  );
}

/**
 * One of the room's two settings with a live setter: who may take the stage, who may post in the
 * chat. Drawn as its current label; a click opens Clubhouse's own option list, a pick saves,
 * blur or Esc drops it — the same gesture as the title above it. A non-moderator gets the text.
 */
function RoomSettingPick({ setting, path, what, onChanged }: {
  setting: RoomSetting;
  path: string;
  what: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = setting.options.find(o => o.value === setting.value);

  const save = async (value: number) => {
    setEditing(false);
    if (value === setting.value) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
      });
      if (!r.ok) notify.error((await r.json().catch(() => null))?.error || `Clubhouse refused the ${what}.`);
      onChanged();
    } catch {
      notify.error(`Could not reach the server to change the ${what}.`);
    } finally { setBusy(false); }
  };

  if (editing) {
    return (
      <select
        autoFocus
        defaultValue={setting.value ?? ''}
        onChange={e => void save(Number(e.target.value))}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }}
        className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-200"
      >
        {setting.options.map(o => <option key={o.value} value={o.value}>{o.label}{o.hint ? ` — ${o.hint}` : ''}</option>)}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setting.canEdit && setEditing(true)}
      disabled={!setting.canEdit || busy}
      title={setting.canEdit ? `Click to change the ${what}` : `Only a moderator can change the ${what}`}
      className="truncate text-left text-xs text-neutral-200 enabled:hover:text-white disabled:cursor-default"
    >
      {current?.label ?? '—'}
      {current?.hint && <span className="ml-1.5 text-neutral-500">{current.hint}</span>}
    </button>
  );
}

// Module-level on purpose: declared inside RoomDetails it would be a new component every poll,
// and React would remount the row — dropping the half-typed title in it.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="pt-1 text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="min-w-0 py-0.5">{children}</div>
    </>
  );
}

/**
 * The room's details, opened by a click on its name in the live-room card. Clubhouse rooms have
 * no description — this is what `get_channel` says about the room rather than who is in it —
 * and every row a moderator can change is edited in place: the title, the pinned link, who may
 * take the stage, who may post in the chat. The rest is read and shown.
 */
export function RoomDetails({ room, iAmModerator, onChanged }: {
  room: RosterRoom;
  iAmModerator: boolean;
  onChanged: () => void;
}) {
  const d = room.details;
  const link = room.links?.length ? room.links[room.links.length - 1] : null;
  const started = d?.createdAt ? new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const copyLink = async () => {
    if (!d?.url) return;
    try { await navigator.clipboard.writeText(d.url); notify.info('Room link copied'); }
    catch { notify.error('Could not copy the room link.'); }
  };

  return (
    <div className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2">
      <Row label="Title">
        <RoomTopic room={room} iAmModerator={iAmModerator} onChanged={onChanged} className="text-sm text-neutral-100" />
      </Row>
      <Row label="Link">
        {link || iAmModerator
          ? <RoomPinnedLink room={room} iAmModerator={iAmModerator} onChanged={onChanged} compact />
          : <span className="text-xs text-neutral-500">none</span>}
      </Row>
      {d && (
        <>
          <Row label="Stage">
            <RoomSettingPick setting={d.stage} path="/api/studiocall/room/stage" what="stage setting" onChanged={onChanged} />
          </Row>
          <Row label="Chat">
            {room.chatEnabled === false && <span className="mr-1.5 text-xs text-amber-400">closed ·</span>}
            <RoomSettingPick setting={d.chat} path="/api/studiocall/room/chat-permission" what="chat permission" onChanged={onChanged} />
          </Row>
          <Row label="House">
            <span className="text-xs text-neutral-200">{d.house ?? '—'}</span>
            {d.privacy && <span className="ml-1.5 text-xs text-neutral-500">{d.privacy}</span>}
          </Row>
          <Row label="Room">
            <span className="text-xs text-neutral-200">{room.channel}</span>
            <span className="ml-1.5 text-xs text-neutral-500">
              {room.mode === 'host' ? 'hosting' : iAmModerator ? 'moderating' : 'listening'}
              {d.language ? ` · ${d.language}` : ''}
              {started ? ` · since ${started}` : ''}
            </span>
            {d.url && (
              <button type="button" onClick={() => void copyLink()} title={d.url} className="ml-2 text-[11px] text-sky-400 hover:text-sky-300">
                Copy link
              </button>
            )}
          </Row>
        </>
      )}
    </div>
  );
}

/**
 * The talk report: which Agora uids are above the threshold right now, and whether our own mic
 * is muted. 250ms because the blinking ring is the only thing on screen that has to keep up
 * with a voice; dead while there is no room, so an idle window costs nothing.
 *
 * `muted` rides along on the same poll rather than costing a second one — it is the engine's
 * own reading, so an optimistic toggle is corrected within a tick if the engine disagrees.
 */
export function useRoomSpeaking(live: boolean): {
  speakingIds: Set<string>;
  /** How long each person has held the floor in this room, in ms. Server-kept — see /audio/speaking. */
  talkMs: Record<string, number>;
  /** The room's clock: when it started, and the last Lap press (0 = none). Server-kept too. */
  talk: { since: number; lapAt: number };
  muted: boolean;
  setMuted: (v: boolean) => void;
  /** Whose mic is OPEN right now, from Agora's mute callbacks — before a word is said. `null`
   *  from an engine too old to report it, so a surface can tell "nobody" from "no data". */
  openMicIds: Set<string> | null;
} {
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set());
  const [openMicIds, setOpenMicIds] = useState<Set<string> | null>(null);
  const [talkMs, setTalkMs] = useState<Record<string, number>>({});
  const [talk, setTalk] = useState({ since: 0, lapAt: 0 });
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!live) { setSpeakingIds(new Set()); setOpenMicIds(null); setTalkMs({}); setTalk({ since: 0, lapAt: 0 }); return; }
    const t = setInterval(async () => {
      try {
        const d = await fetch(`${API}/api/studiocall/audio/speaking`).then(r => r.json());
        setSpeakingIds(new Set((d?.active ?? []).map((s: { uid: string }) => String(s.uid))));
        setOpenMicIds(prev => {
          if (!Array.isArray(d?.openMics)) return null;
          const next = new Set<string>(d.openMics.map(String));
          return prev && prev.size === next.size && [...next].every(x => prev.has(x)) ? prev : next;
        });
        // The tally rides on this poll rather than costing one of its own — it is the same
        // question one derivative apart. The SERVER owns the clock; nothing is counted here.
        if (d?.talk?.totals) setTalkMs(d.talk.totals as Record<string, number>);
        if (d?.talk) setTalk(prev => (prev.since === (d.talk.since ?? 0) && prev.lapAt === (d.talk.lapAt ?? 0)) ? prev : { since: d.talk.since ?? 0, lapAt: d.talk.lapAt ?? 0 });
        if (typeof d?.muted === 'boolean') setMuted(d.muted);
      } catch {}
    }, 250);
    return () => clearInterval(t);
  }, [live]);

  return { speakingIds, talkMs, talk, muted, setMuted, openMicIds };
}

/** A running clock: `12:07`, or `1:02:07` past the hour. */
export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * The room's clock in the bar: the total since the desk's clock started, and the lap since the
 * last **Lap** press — a segment timer for "how long has this topic run", which the total cannot
 * answer. Both are the server's (`/audio/speaking` → `talk`), so the docked tile and the pop-out
 * read the same lap; only the ticking is local.
 */
export function RoomClock({ since, lapAt }: { since: number; lapAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const lap = () => { void fetch(`${API}/api/studiocall/audio/talk/lap`, { method: 'POST' }).catch(() => {}); };
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums" title="Time in the room · the current lap. Lap starts the second clock again; the first keeps going">
      <span className="text-slate-400">{clockLabel(now - since)}</span>
      <span className="text-slate-600">·</span>
      <span className="text-amber-300">{clockLabel(now - (lapAt || since))}</span>
      <button
        type="button"
        onClick={lap}
        className="rounded bg-slate-800 px-1.5 py-0.5 font-bold uppercase tracking-wider text-slate-400 transition hover:bg-slate-700 hover:text-slate-200"
      >
        Lap
      </button>
    </span>
  );
}

/**
 * Floor time, as a moderator reads it: `4:07`, and `12s` under a minute because at that end the
 * seconds are the whole point. Nothing at all below three seconds — a cough is not a turn, and a
 * roster full of `0:01` badges is noise where the eye is meant to be finding the long one.
 */
export function talkLabel(ms: number | undefined): string | null {
  const s = Math.floor((ms ?? 0) / 1000);
  if (s < 3) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Mute, and the way in and out of the room — the two acts that are about the operator rather
 * than about somebody in the roster, which is why they sit in the pop-out's title bar instead
 * of inside a tab: they have to be one click away from whatever is being read.
 *
 * **One button, two states.** Off the stage it asks to join; on it, the only move Clubhouse
 * actually offers is to walk out, because `/leave_speaker` and self-`/uninvite_speaker` are
 * unverified and a button that silently no-ops is worse than no button. Both directions ask
 * first: one puts a live microphone on a stage, the other drops the room's audio entirely.
 */
export function RoomMicBar({ room, muted, onMuted, onChanged, compact }: {
  room: RosterRoom;
  muted: boolean;
  onMuted: (v: boolean) => void;
  /** Re-read the room — the caller owns the poll, and these two acts change its answer. */
  onChanged: () => void;
  /** Title-bar sizing: icons and short labels rather than the tab's full-width buttons. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const onStage = room.onStage ?? room.mode === 'host';
  // The request has been answered — the button stops asking and starts accepting.
  const invited = !onStage && !!room.invitedToSpeak;

  const toggleMute = useCallback(async () => {
    const next = !muted;
    onMuted(next); // optimistic; the speaking poll corrects it if the engine disagrees
    try {
      const d = await fetch(`${API}/api/studiocall/audio/mute`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ muted: next }),
      }).then(r => r.json());
      if (typeof d?.muted === 'boolean') onMuted(d.muted);
    } catch {
      onMuted(!next);
      notify.error('Could not reach the audio engine to mute.');
    }
  }, [muted, onMuted]);

  // Silence in the room is discovered while READING the room, not while looking at the Audio
  // routing card in the other window — so the dance that fixes it is offered here too.
  // It never changes the routing: it re-applies the pair the server already remembers.
  const resetAudio = useCallback(async () => {
    setBusy(true);
    try { await resetStudioCallAudio(); onChanged(); } finally { setBusy(false); }
  }, [onChanged]);

  /**
   * Ask for the stage — or, once a moderator has said yes, take it.
   *
   * Same endpoint either way: `/room/mic` sends `/become_speaker`, which is both "step up in an
   * open room" and "take up the invitation I have been given". Accepting an answered request asks
   * nothing first — the operator raised the hand, agreed to the terms then, and a second dialog
   * between the moderator's yes and the stage is one the room is waiting through.
   */
  const takeMic = useCallback(async () => {
    if (!invited && !await askConfirm({
      title: 'Request to join the stage?',
      body: 'An open room puts you on straight away; a moderated one queues your raised hand. There is no way back down — leaving the stage means leaving the room.',
      confirmLabel: 'Request',
    })) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/mic`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) notify.error(d?.body?.error_message || d?.error || 'Could not take the mic.');
      else if (d?.queued) notify.info('Your hand is up — the moderators have it.');
      else if (d?.audio && d.audio.connected === false) notify.error(`On the stage, but the audio leg did not rejoin: ${d.audio.reason}`);
      else notify.info('On the stage.');
      onChanged();
    } catch { notify.error('Mic request failed.'); } finally { setBusy(false); }
  }, [invited, onChanged]);

  // The shared leave (lib/studioCallRoom.ts): it goes on the press, and — the reason this stopped
  // being its own copy — one place checks the reply. The bare fetch here swallowed a refusal
  // whole, so a 429 read as a leave that had worked.
  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await leaveRoom();
      onChanged();
    } finally { setBusy(false); }
  }, [onChanged]);

  // The other half of the way out, and the one that only a moderator is offered. It sits in the
  // bar rather than a tab away because the bar is what is on screen when the show ends.
  const end = useCallback(async () => {
    setBusy(true);
    try {
      await confirmEndRoom();
      onChanged();
    } finally { setBusy(false); }
  }, [onChanged]);

  if (!room.live) return null;
  const pad = `flex items-center justify-center gap-1 ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs'}`;

  return (
    <>
      <button
        type="button"
        onClick={() => void toggleMute()}
        title={muted ? 'Unmute your microphone' : 'Mute your microphone'}
        className={`shrink-0 rounded font-semibold text-white transition ${pad} ${
          muted ? 'bg-amber-600 hover:bg-amber-500' : 'bg-neutral-700 hover:bg-neutral-600'
        }`}
      >
        <IconMic off={muted} />{muted ? 'Muted' : 'Mute'}
      </button>
      <button
        type="button"
        onClick={() => void resetAudio()}
        disabled={busy}
        title="Room gone silent? Drop both device pins to the Windows default and put the same two back, rejoining each time — the only thing that reopens capture after a restart. Nothing about the routing changes."
        className={`shrink-0 rounded border border-neutral-700 bg-neutral-800 font-semibold text-neutral-300 transition hover:bg-neutral-700 disabled:opacity-40 ${pad}`}
      >
        <BarIcon id="reset" className={`h-3.5 w-3.5 shrink-0 ${busy ? 'animate-spin' : ''}`} />Audio
      </button>
      {/* Leave is always on offer — in the audience as much as on the stage. The pop-out's bar
          is the only way out of a room without going back to the main window, mid-show. */}
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        title={room.mode === 'host' ? 'Walk out — the room stays up for everybody in it' : 'Walk out of this room'}
        className={`shrink-0 rounded bg-rose-700 font-semibold text-white transition hover:bg-rose-600 disabled:opacity-40 ${pad}`}
      >
        <BarIcon id="leave" />Leave room
      </button>
      {/* Outlined, not filled: two solid red buttons side by side is how the wrong one gets
          clicked, and only one of them is the irreversible act. */}
      {room.iAmModerator && (
        <button
          type="button"
          onClick={() => void end()}
          disabled={busy}
          title="Close the room — everybody in it is dropped and it does not come back"
          className={`shrink-0 rounded border border-rose-600 font-semibold text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-40 ${pad}`}
        >
          <BarIcon id="end" />End room
        </button>
      )}
      {!onStage && (
        <button
          type="button"
          onClick={() => void takeMic()}
          disabled={busy}
          title={invited
            ? 'Your request was accepted — take the stage'
            : 'Ask Clubhouse to put you on the stage — an open room promotes you straight away'}
          className={`shrink-0 rounded font-semibold transition disabled:opacity-40 ${pad} ${
            invited
              ? 'border border-emerald-600 bg-emerald-600/15 text-emerald-300 hover:bg-emerald-600/30'
              : 'bg-sky-700 text-white hover:bg-sky-600'
          }`}
        >
          <BarIcon id="hand" />{invited ? 'Join room' : 'Request to join'}
        </button>
      )}
    </>
  );
}

export interface Profile {
  userId: string;
  name: string;
  username: string;
  /** They follow the operator. */
  followsMe?: boolean;
  /** The operator follows them. The two together are the mutual follow the card reports. */
  iFollow?: boolean;
  /** How many people follow both of us. */
  mutualFollows?: number | null;
  /** Clubhouse's own answer to "may this account wave at them". The Wave button is drawn off THIS,
   *  not off a relationship worked out here — see the server's readProfile. */
  canWave?: boolean;
  /** This account has blocked them. `null` = Clubhouse would not say, so no button is drawn. */
  blocked?: boolean | null;
  /** Epoch ms since the room has been hearing THEM — `null` when somebody else has the turn. */
  speakingSince?: number | null;
  photoUrl: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  twitter: string | null;
  instagram: string | null;
  role: string;
}

const count = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  : String(n);

/** The overlay layer this dialog draws and drives: `photoScale` and `nameScale` are the shares of
 *  the card its image and name strip take, and the profile text gets what is left. */
const CARD_LAYER = 'CHinfocard';

/**
 * Say why the canvas did not get a card, or got only a face.
 *
 * The card is three bands and the third is the profile text; plenty of Clubhouse profiles have no
 * bio and no counts at all, so there is nothing to put in it. The overlay draws the picture large
 * instead of an empty box, which is right on air and silent here — the operator clicked expecting
 * a card and has to be told they got a photo, or they read the difference as a bug and click again.
 */
export function warnThin(d: any): void {
  if (d?.refused) { notify.warn(String(d.refused)); return; }
  if (!d?.card?.thin) return;
  const who = d.card.name || d.card.username || 'This profile';
  notify.info(`${who} has no bio or follower counts — not enough for an info card, so the picture is up on its own.`);
}
/** Floors under each band, in % of the card. A band dragged to nothing is a card that has silently
 *  lost a third of itself, with no handle left to get it back. */
const IMG_MIN = 10;
const IMG_MAX = 88;
const NAME_MIN = 5;
const TEXT_MIN = 5;

/** The profile card's split: how wide its controls column is, dragged and remembered. */
const PANEL_W_KEY = 'studiocall:cardPanel';
const PANEL_W_DEFAULT = 240;
const PANEL_W_MIN = 160;
const PANEL_W_MAX = 520;
const clampPanelW = (w: number) => Math.max(PANEL_W_MIN, Math.min(PANEL_W_MAX, w));

/**
 * Somebody's profile, read where the operator is standing.
 *
 * A click on a face used to go straight on air, which made the roster a live surface: the
 * gesture that answers "who IS that?" was the same gesture that showed a stranger's bio to the
 * audience, and the only way to read one was to broadcast it. So the click now opens the card
 * **here** — the picture large enough to actually look at, the bio, the counts — and putting it
 * on air is a second, deliberate button inside it.
 *
 * `GET /user/:id` reads the profile without touching what is on air; `POST /infocard` is the
 * only thing that broadcasts, and it toggles, so the same button takes the card back down.
 *
 * The photo zooms because that is what it is for: Clubhouse serves a face at the size it feels
 * like, and half of recognising a caller is being able to look closer. Wheel or the slider to
 * zoom, drag to move, double-click back to fit.
 */
/** Clubhouse's room reactions, aimed at a person. The room reads "you reacted 👏 to them". */
const REACTIONS = ['👏', '❤️', '💯', '😂', '🙏', '👍', '🔥'];

async function sendReaction(userId: string, emoji: string, name: string): Promise<void> {
  try {
    const r = await fetch(`${API}/api/studiocall/react`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, emoji }),
    });
    const d = await r.json();
    if (!r.ok || !d?.ok) notify.error(d?.body?.error_message || d?.error || 'Clubhouse refused the reaction.');
    else notify.info(`Reacted ${emoji} to ${name || 'them'}.`);
  } catch {
    notify.error('Could not reach the server to react.');
  }
}

/** How long a press has to last before it is a hold, not a click. */
const HOLD_MS = 450;

/** A reaction landing on a face: rises out of the photo and fades, gone by `until`. */
interface TileFloater { id: string; emoji: string; targetUid: string; until: number; ttlMs: number }
const TILE_REACT_KEYFRAMES = `@keyframes sc-tile-react {
  0% { opacity: 0; transform: translate(-50%, 30%) scale(0.4); }
  15% { opacity: 1; transform: translate(-50%, -10%) scale(1.2); }
  70% { opacity: 1; transform: translate(-50%, -80%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -140%) scale(0.9); }
}`;

export function ProfileCard({ userId, onAirUserId, onAirChange, onClose, fill, mine }: {
  userId: string;
  /** This is the operator's own profile — the one whose picture can be changed from here. */
  mine?: boolean;
  /** Who is on the CHinfocard layer right now — the button reads off this, not off a guess. */
  onAirUserId: string | null;
  onAirChange: (userId: string | null) => void;
  onClose: () => void;
  /** Take the whole window — the pop-out has nothing behind this to look at. */
  fill?: boolean;
}) {
  const [p, setP] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * The framing, in the card's own terms: zoom, and pan as a **share of the image band**.
   *
   * Not pixels, and no longer a share of some other box either. The preview below IS the card, so
   * the band the operator drags in and the band OBS draws are the same shape — a fraction lands in
   * exactly the same place at either size, and the preview stops being an approximation of the
   * thing and becomes the thing.
   */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number; was: { zoom: number; pan: { x: number; y: number } } } | null>(null);
  /** A press that travelled is a pan; only a still one is a click. */
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  /** The box the card is drawn into, scaled down. Every measurement is taken through it. */
  const previewRef = useRef<HTMLDivElement>(null);

  /**
   * The `CHinfocard` layer row — the card's whole look, and the box it is drawn in.
   *
   * The preview renders the real overlay component under the real layer style, at the layer's true
   * pixel size, and then CSS-scales the lot into whatever room the dialog has. Scaling the finished
   * card rather than re-deriving every number at preview size is what makes it exact: there is no
   * second implementation to drift, and a font size in px means the same thing in both.
   */
  const [layer, setLayer] = useState<Record<string, any> | null>(null);
  /**
   * Which of the CHinfocard layer's two frames the Frame canvas and the Perspective sliders are
   * both pointed at. Held here rather than inside the canvas because both surfaces write the same
   * tilt columns — → CardFrameCanvas.
   */
  const [frameOri, setFrameOri] = useState<'landscape' | 'portrait'>('landscape');
  const tiltCols = frameOri === 'portrait'
    ? { rx: 'portraitThreedRotX', ry: 'portraitThreedRotY', fov: 'portraitThreedFov' }
    : { rx: 'threedRotX', ry: 'threedRotY', fov: 'threedFov' };
  const [shares, setShares] = useState<{ img: number; name: number } | null>(null);
  const [k, setK] = useState(0);
  const sharesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`${SM_API}/api/overlay/layers`)
      .then(r => r.json())
      .then((rows: any[]) => {
        const l = (Array.isArray(rows) ? rows : []).find(x => x?.id === CARD_LAYER);
        if (!l) return;
        setLayer(l);
        setShares({ img: Math.round(l.photoScale ?? 55), name: Math.round(l.nameScale ?? 12) });
      })
      .catch(() => {});
    return () => { if (sharesTimer.current) clearTimeout(sharesTimer.current); };
  }, []);

  // How far the card has to shrink to fit the dialog. Watched rather than measured once: the
  // pop-out is resized constantly, and the separators are positioned in these coordinates.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !layer?.width) return;
    const measure = () => setK(el.clientWidth / layer.width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layer?.width]);

  /**
   * Where the two separators are, in preview pixels — **measured off the card, never computed**.
   *
   * The bands carry padding, gaps and a border, so a handle placed at "photoScale% of the box"
   * would sit a few pixels off the seam it claims to be. Reading the rendered bands' own rects
   * (`data-infocard-band`) means the handle is on the seam by construction, whatever the card's
   * layout does next.
   */
  const [seams, setSeams] = useState<{ y1: number; y2: number } | null>(null);
  const bandEl = useCallback((which: string) =>
    previewRef.current?.querySelector<HTMLElement>(`[data-infocard-band="${which}"]`) ?? null, []);

  useLayoutEffect(() => {
    const wrap = previewRef.current, img = bandEl('image'), name = bandEl('name');
    if (!wrap || !img || !name) return;
    const w = wrap.getBoundingClientRect();
    const y1 = img.getBoundingClientRect().bottom - w.top;
    const y2 = name.getBoundingClientRect().bottom - w.top;
    setSeams(s => (s && Math.abs(s.y1 - y1) < 0.5 && Math.abs(s.y2 - y2) < 0.5 ? s : { y1, y2 }));
  });

  /**
   * **The picture cannot leave its band.**
   *
   * `object-fit: cover` scales the photo by `max(bw/nw, bh/nh)`, so at a given zoom it overhangs
   * the band by `(rendered − band) / 2` on each axis: pan is free inside that and refused outside
   * it. Which is also why panning works at 1× — along whichever axis `cover` is already cropping,
   * a portrait photo in a wide band has a whole head of travel that a "no pan below 1×" rule hid.
   */
  const clampPan = useCallback((q: { x: number; y: number }, z: number) => {
    const band = bandEl('image');
    const img = band?.querySelector('img');
    if (!band || !img?.naturalWidth || !img.naturalHeight) return q;
    const bw = band.clientWidth, bh = band.clientHeight;
    const cover = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
    // In shares of the band, so the limits mean the same thing at preview scale and on air.
    const mx = Math.max(0, (img.naturalWidth * cover * z - bw) / 2) / bw;
    const my = Math.max(0, (img.naturalHeight * cover * z - bh) / 2) / bh;
    return { x: Math.min(mx, Math.max(-mx, q.x)), y: Math.min(my, Math.max(-my, q.y)) };
  }, [bandEl]);

  /**
   * Undo for the framing — the one part of the canvas contract this surface was
   * missing.
   *
   * It matters more here than on a designer canvas: the framing is pushed to the server as it
   * changes, so the picture on air moves with the drag. Before this, the only way back from a
   * mis-drag was double-click, which resets to fit and throws away the framing that was right —
   * and a minute of lining somebody's face up is not something to spend on a slipped pointer.
   *
   * **A gesture banks one slot, on pointer-up, and only if it moved**: a bare click on the
   * picture is how the card goes on air, and an undo slot spent on that is one the operator does
   * not get back. The wheel and the slider coalesce, so a burst of notches is one step.
   */
  const framing = useHistory<{ zoom: number; pan: { x: number; y: number } }>(10);
  const adopt = useCallback((f: { zoom: number; pan: { x: number; y: number } } | null) => {
    if (!f) return;
    setZoom(f.zoom);
    setPan(f.pan);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z') { e.preventDefault(); adopt(framing.undo({ zoom, pan })); }
      if (e.key === 'y') { e.preventDefault(); adopt(framing.redo({ zoom, pan })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adopt, framing, zoom, pan]);

  // Read through a ref so `zoomAt` stays a stable callback — the native wheel listener is bound
  // once against it, and a changing identity would rebind it on every notch.
  const framingRef = useRef(framing);
  framingRef.current = framing;

  const live = useRef({ zoom, pan, shares });
  live.current = { zoom, pan, shares };
  /** What the server stores about the framing — already in the card's own terms. */
  const view = useCallback(() => {
    const { zoom: z, pan: q } = live.current;
    return { zoom: z, panX: q.x, panY: q.y };
  }, []);

  /**
   * Zoom **at the pointer**: the thing under the cursor stays under the cursor.
   *
   * Centre-anchored zoom is why a wheel used to need a drag after every notch — you aimed at an
   * eye, zoomed, and the eye left the frame. `p' = o − (o − p)·z₁/z₀` holds the point at pointer
   * offset `o` still across the scale change, in band shares throughout.
   */
  const zoomAt = useCallback((z: number, clientX?: number, clientY?: number) => {
    const band = bandEl('image');
    const { zoom: z0, pan: p0 } = live.current;
    const z1 = Math.min(5, Math.max(1, z));
    if (z1 === z0) return;
    // Coalesced: a wheel gesture is thirty events and a slider drag one per pixel, and thirty
    // undo slots for one motion is an undo stack with nothing older than the last second in it.
    framingRef.current.commit({ zoom: z0, pan: p0 }, true);
    let next = p0;
    if (band) {
      const r = band.getBoundingClientRect();
      const ox = clientX == null ? 0 : (clientX - r.left - r.width / 2) / r.width;
      const oy = clientY == null ? 0 : (clientY - r.top - r.height / 2) / r.height;
      const f = z1 / z0;
      next = { x: ox - (ox - p0.x) * f, y: oy - (oy - p0.y) * f };
    }
    setZoom(z1);
    setPan(clampPan(next, z1));
  }, [bandEl, clampPan]);

  /**
   * **Ctrl + wheel zooms; a bare wheel is left alone.**
   *
   * A bare wheel used to zoom, which made the picture a trap: a scroll aimed at the bio underneath
   * landed on the face and threw the framing, live. Ctrl is the modifier every map and canvas uses
   * for this. It has to be a native listener — React registers `wheel` on the root as **passive**,
   * so `preventDefault()` from an `onWheel` prop is a no-op, and without it Ctrl+wheel is the
   * browser's own page zoom scaling the whole pop-out.
   */
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const band = bandEl('image')?.getBoundingClientRect();
      if (!band || e.clientY < band.top || e.clientY > band.bottom) return;
      e.preventDefault();
      zoomAt(live.current.zoom - e.deltaY * 0.003, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, bandEl]);

  // Bumped after the operator changes their own picture, so the card re-reads the profile.
  const [gen, setGen] = useState(0);
  /** The photo grid is up — the operator's own (pickable) or this person's (a reading). */
  const [photos, setPhotos] = useState(false);

  /**
   * How wide the controls column is, dragged and remembered (`studiocall:cardPanel`).
   *
   * Measured from the RIGHT edge of the row rather than from the pointer's x, so the handle stays
   * under the cursor whatever the dialog is doing about its own width — the same arithmetic the
   * roster's stage-height drag uses, on the other axis.
   */
  const [panelW, setPanelW] = useState(PANEL_W_DEFAULT);
  const splitRef = useRef<HTMLDivElement | null>(null);
  // Read once the settings are IN: profile.html mounts this card before its `loadAllUiSettings()`
  // has answered, and a read on mount found nothing every time.
  useEffect(() => onUiSettingsLoaded(() => {
    const raw = Number(getUiSetting(PANEL_W_KEY));
    if (Number.isFinite(raw) && raw > 0) setPanelW(clampPanelW(raw));
  }), []);
  const editPanelW = useCallback((w: number) => {
    const next = clampPanelW(w);
    setPanelW(next);
    setUiSetting(PANEL_W_KEY, String(Math.round(next)));
  }, []);
  const startSplit = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const row = splitRef.current;
    if (!row) return;
    const right = row.getBoundingClientRect().right;
    const onMove = (m: MouseEvent) => editPanelW(right - m.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [editPanelW]);
  /** The gag list is the server's; this only mirrors it, so two surfaces can never disagree. */
  const { gagged, setGag } = useSpeakerStatus();
  const [speakingSince, setSpeakingSince] = useState<number | null>(null);
  useEffect(() => {
    setP(null); setFailed(false); setZoom(1); setPan({ x: 0, y: 0 });
    let alive = true;
    fetch(`${API}/api/studiocall/user/${userId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('no profile'))))
      .then(d => { if (alive) { setP(d); setSpeakingSince(d?.speakingSince ?? null); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [userId, gen]);

  /**
   * The turn clock: seeded by the profile read, kept current by the speaker pump's broadcast, so
   * the button is drawn only while the room is actually hearing this person and its count is live.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type !== 'studiocall-speakers') return;
    const turn = (msg as any).turn as { uid: string; since: number } | null | undefined;
    setSpeakingSince(turn && String(turn.uid) === userId ? turn.since : null);
  }), [userId]);
  useEffect(() => {
    if (speakingSince == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [speakingSince]);
  const speakingMins = speakingSince == null ? null : Math.floor((now - speakingSince) / 60_000);

  const saySpeakingTime = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/chat/speaking-time`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) notify.error(String(d?.error ?? 'Could not post to the room'));
      else notify.info(String(d?.message ?? 'Posted'));
    } catch { notify.error('Could not post to the room'); }
    finally { setBusy(false); }
  }, [userId]);

  const wave = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/wave`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }),
      });
      const d = await r.json();
      if (!r.ok || !d?.ok) notify.error(d?.body?.error_message || d?.error || 'Clubhouse refused the wave.');
      else notify.info(`Waved at ${p?.name ?? 'them'}.`);
    } catch {
      notify.error('Could not reach the server to wave.');
    } finally { setBusy(false); }
  }, [userId, p?.name]);

  const react = useCallback(async (emoji: string) => {
    setBusy(true);
    try { await sendReaction(userId, emoji, p?.name ?? ''); } finally { setBusy(false); }
  }, [userId, p?.name]);

  /**
   * Block them, or let them back in — the ACCOUNT-level block, not the room's. The act itself
   * (the question on the way in, the call, the notices) is `setAccountBlock`, shared with the
   * Speaker Status dialog's block column; the card only re-reads the profile afterwards.
   */
  const toggleBlock = useCallback(async () => {
    setBusy(true);
    try {
      if (await setAccountBlock(userId, p?.name ?? '', !p?.blocked)) setGen(g => g + 1);
    } finally { setBusy(false); }
  }, [userId, p?.blocked, p?.name]);

  /**
   * Follow, or stop following — the operator's own account, not a moderator act, so it works on
   * anybody the card can show whether or not there is a room.
   *
   * `on` is sent rather than toggled server-side: the card re-reads the profile after every change
   * (`gen`), and a toggle raced against that read turns a second press into the opposite of what
   * the button said. No confirmation either way — both directions are one press to undo, which is
   * the test a confirm has to fail before it is worth interrupting somebody for.
   */
  const follow = useCallback(async () => {
    const on = !p?.iFollow;
    const who = p?.name || 'this person';
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/user/follow`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, on }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) return notify.error(d?.error ?? 'Clubhouse refused that.');
      notify.info(on ? `Following ${who}.` : `No longer following ${who}.`);
      setGen(g => g + 1);
    } catch {
      notify.error('Could not reach the server.');
    } finally { setBusy(false); }
  }, [userId, p?.iFollow, p?.name]);

  const onAir = onAirUserId === userId;

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const d = await fetch(`${API}/api/studiocall/infocard`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ...view() }),
      }).then(r => r.json());
      onAirChange(d?.card?.userId ?? null);
      warnThin(d);
    } catch {
      notify.error('Could not reach the server to put that card on air.');
    } finally { setBusy(false); }
  }, [onAirChange, view]);

  const toggleAir = useCallback(() => post({ userId }), [post, userId]);
  /** The picture's own gesture: show THIS one. Never a toggle — see the click handler. */
  const showAir = useCallback(() => post({ userId, on: true }), [post, userId]);

  /**
   * **Closing the card takes it off the canvas.** The dialog is the thing being held up: the
   * operator opens somebody, puts their picture on screen, talks about them, and closes it — and
   * the overlay has no other timer than the layer's own auto-hide, so a card left standing after
   * the dialog went is a bio on air for a conversation that has moved on. Only ours comes down;
   * a card somebody else's dialog put up is not this one's to clear.
   */
  const closeCard = useCallback(() => {
    if (onAirUserId === userId) {
      void fetch(`${API}/api/studiocall/infocard`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: null }),
      }).catch(() => {});
      onAirChange(null);
    }
    onClose();
  }, [onAirUserId, userId, onAirChange, onClose]);

  /**
   * **While the card is on air, framing it here frames it there.**
   *
   * Zoom and drag are how the operator says which part of a picture is the picture — Clubhouse
   * serves a face at whatever size it feels like, and a card put up untouched is as likely to be a
   * shoulder as a face. So every change is posted at the card already up, which the server reads as
   * a reframe and nothing else: no profile re-read, and the layer's auto-hide is not re-armed by it.
   *
   * Trailing by 100ms because a wheel gesture is thirty events and a drag is one per frame; the
   * cleanup cancels the pending one, so a drag posts once, when it stops.
   */
  useEffect(() => {
    if (onAirUserId !== userId) return;
    const t = setTimeout(() => {
      void fetch(`${API}/api/studiocall/infocard`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, on: true, ...view() }),
      }).catch(() => {});
    }, 100);
    return () => clearTimeout(t);
  }, [onAirUserId, userId, zoom, pan.x, pan.y, view]);

  /**
   * The two separators write the two bands' shares onto the layer.
   *
   * `photoScale` and `nameScale` are the same columns the Overlay tab edits — one value,
   * two places to reach it. This is the place that matters mid-show: the caller's bio is three
   * lines or thirty, and the card that was right a minute ago is wrong now. The patch carries only
   * these keys, which the server treats as live style, so the canvas re-renders instead of the
   * browser source reloading under the drag.
   */
  const setShareLive = useCallback((next: { img: number; name: number }) => {
    const img = Math.max(IMG_MIN, Math.min(IMG_MAX, Math.round(next.img)));
    const name = Math.max(NAME_MIN, Math.min(Math.max(NAME_MIN, 100 - img - TEXT_MIN), Math.round(next.name)));
    setShares({ img, name });
    if (sharesTimer.current) clearTimeout(sharesTimer.current);
    sharesTimer.current = setTimeout(() => {
      void fetch(`${SM_API}/api/overlay/layers/${CARD_LAYER}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photoScale: img, nameScale: name }),
      }).catch(() => {});
    }, 100);
  }, []);

  /**
   * The rest of the card's framing — roundness, ring, margin and the 3D tilt — set here against
   * the card rather than in the Overlay tab against a box. Same columns, live on the canvas: the
   * preview re-renders off `layer` under the finger and the PATCH follows a beat later.
   */
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, number | string>>({});
  const patchLayer = useCallback((patch: Record<string, number | string>) => {
    setLayer(l => (l ? { ...l, ...patch } : l));
    Object.assign(pendingPatch.current, patch);
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = setTimeout(() => {
      const body = pendingPatch.current;
      pendingPatch.current = {};
      void fetch(`${SM_API}/api/overlay/layers/${CARD_LAYER}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => {});
    }, 100);
  }, []);

  // The card's play — style, holds, effects — is a server control the overlay follows on the
  // controls broadcast; the preview here is handed the same record so a slider moves both.
  const [seq, setSeqState] = useState<CardSeq>(DEFAULT_SEQ);
  const [playKey, setPlayKey] = useState(0);
  useEffect(() => {
    fetch(`${API}/api/studiocall/controls`).then(r => r.json()).then(d => setSeqState(seqFrom(d))).catch(() => {});
  }, []);
  const setSeq = useCallback((patch: Partial<CardSeq>) => {
    setSeqState(s => ({ ...s, ...patch }));
    const body: Record<string, unknown> = {};
    if (patch.style !== undefined) body.cardStyle = patch.style;
    if (patch.imageHold !== undefined) body.cardImageHold = patch.imageHold;
    if (patch.imageEffect !== undefined) body.cardImageEffect = patch.imageEffect;
    if (patch.textHold !== undefined) body.cardTextHold = patch.textHold;
    if (patch.textEffect !== undefined) body.cardTextEffect = patch.textEffect;
    void fetch(`${API}/api/studiocall/controls`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
  }, []);

  /**
   * Dragging a seam. The card's three bands sum to the height they are laid out in, so a drag of
   * `dy` preview pixels is `dy / cardHeight` of the whole — measured off the card again rather
   * than assumed, because the scale `k` changes with the window.
   */
  const seamDrag = useRef<{ which: 1 | 2; y: number; img: number; name: number } | null>(null);
  const onSeamMove = useCallback((e: PointerEvent) => {
    const d = seamDrag.current;
    const wrap = previewRef.current;
    if (!d || !wrap) return;
    const total = wrap.getBoundingClientRect().height;
    if (!total) return;
    const dShare = ((e.clientY - d.y) / total) * 100;
    if (d.which === 1) setShareLive({ img: d.img + dShare, name: d.name });
    else setShareLive({ img: d.img, name: d.name + dShare });
  }, [setShareLive]);

  const startSeam = useCallback((which: 1 | 2) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const s = live.current.shares;
    if (!s) return;
    seamDrag.current = { which, y: e.clientY, img: s.img, name: s.name };
    const up = () => {
      seamDrag.current = null;
      window.removeEventListener('pointermove', onSeamMove);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', onSeamMove);
    window.addEventListener('pointerup', up);
  }, [onSeamMove]);

  const photo = p?.photoUrl ? (p.photoUrl.startsWith('http') ? p.photoUrl : `${API}${p.photoUrl}`) : null;

  return (
    <Dialog
      open
      title={p?.name || (failed ? 'Profile' : 'Loading…')}
      level="info"
      width={520}
      fill={fill}
      onCancel={closeCard}
      onConfirm={() => void toggleAir()}
      footer={
        <div className="mt-4 flex items-center gap-2">
          {onAir && <span className={ACTIVE_PILL}>On air</span>}
          {/* Follow. Not emerald when on: the active skin is for what is LIVE right now, and
              a following relationship is a standing fact — dressing it as "on air" would spend the
              one colour that has to mean that. The tick carries it instead, and the label says
              which press does what. */}
          {!mine && p && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void follow()}
              title={p.iFollow
                ? `You follow ${p.name || 'them'} — click to unfollow${p.followsMe ? '. They follow you back.' : ''}`
                : `Follow ${p.name || 'them'}${p.followsMe ? ' — they already follow you' : ''}`}
              className={`rounded border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${
                p.iFollow
                  ? 'border-slate-700 text-slate-500 hover:border-rose-700 hover:text-rose-300'
                  : 'border-slate-600 text-slate-200 hover:border-sky-600 hover:text-sky-300'
              }`}
            >
              {p.iFollow ? '✓ Following' : 'Follow'}
            </button>
          )}
          {/* Wave — Clubhouse's "come talk". Drawn off `canWave`, which is CLUBHOUSE'S answer and
              already weighs the mutual follow, their wave settings and either side's block; a
              button drawn off `follows_me` alone offered waves that came back refused. */}
          {!mine && p?.canWave && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void wave()}
              title={`Wave — invite them into a private room with you. They see a notification; if they decline you never hear.${
                p.followsMe && p.iFollow ? '\n\nYou follow each other.' : ''}`}
              className="rounded border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40"
            >
              👋 Wave
            </button>
          )}
          {/* Reactions — aimed at this person, and the whole room sees who sent it. Only in a
              room: the route refuses without one, and says so. */}
          {!mine && REACTIONS.map(e => (
            <button
              key={e}
              type="button"
              disabled={busy}
              onClick={() => void react(e)}
              title={`React ${e} to ${p?.name ?? 'them'} — the room sees it`}
              className="rounded border border-slate-700 px-2 py-1.5 text-[15px] leading-none hover:border-slate-500 disabled:opacity-40"
            >
              {e}
            </button>
          ))}
          {/* Every face this account has worn. Theirs is a reading — recognising a caller who has
              changed their picture since you last spoke; yours is the picker that changes it. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => setPhotos(true)}
            title={mine
              ? 'Your profile pictures — pick one to wear. A NEW picture has to go up from the Clubhouse phone app.'
              : 'Every picture they have worn — for recognising a caller who has changed their face'}
            className="rounded border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40"
          >
            {mine ? 'Change photo' : 'Their pictures'}
          </button>
          {/* Tell the room how long they have held the turn. Drawn only while the room is hearing
              them — the server refuses it about anybody else. */}
          {!mine && speakingMins != null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void saySpeakingTime()}
              title="Post to the room chat how long they have been speaking"
              className="rounded border border-slate-700 px-3 py-1.5 text-[13px] font-semibold tabular-nums text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40"
            >
              ⏱ Say {speakingMins < 1 ? '<1' : speakingMins} min
            </button>
          )}
          {/* Gag — every line of theirs deleted as it arrives. Room-scoped and reversible, so it
              is a press; block below is the one that outlives the show and asks. */}
          {!mine && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void setGag(userId, p?.name ?? '', !gagged.has(userId))}
              title={gagged.has(userId)
                ? 'Let them speak again — their chat lines stop being deleted'
                : 'Gag — every chat line of theirs is deleted as it arrives, and what is already up is swept'}
              className={`rounded border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${
                gagged.has(userId)
                  ? 'border-amber-600/60 bg-amber-950/30 text-amber-300 hover:border-amber-400'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'}`}
            >
              {gagged.has(userId) ? 'Ungag' : 'Gag'}
            </button>
          )}
          {/* Only on a real answer: `blocked === null` means Clubhouse would not say, and a button
              that guesses which way it points is worse than no button. */}
          {!mine && p?.blocked != null && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggleBlock()}
              title={p.blocked
                ? 'Unblock — they can reach this account again'
                : 'Block this Clubhouse account — it outlasts this room, unlike a gag'}
              className={`rounded border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${
                p.blocked
                  ? 'border-rose-700/60 bg-rose-950/40 text-rose-200 hover:border-rose-500'
                  : 'border-slate-700 text-slate-400 hover:border-rose-600/60 hover:text-rose-300'}`}
            >
              {p.blocked ? 'Unblock' : 'Block'}
            </button>
          )}
          <button
            type="button"
            onClick={closeCard}
            title={onAir ? 'Close — and take the card off the overlay' : 'Close'}
            className="ml-auto rounded border border-slate-700 px-3 py-1.5 text-[13px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-200"
          >
            Close <span className="opacity-60">esc</span>
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => void toggleAir()}
            title={onAir ? 'Take the card off the CHinfocard layer' : 'Hold this profile up on the CHinfocard layer'}
            className={`rounded border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-40 ${
              onAir ? 'border-rose-700/60 bg-rose-950/40 text-rose-200 hover:border-rose-500'
                    : `${ACTIVE_BORDER} bg-emerald-950/40 text-emerald-200 hover:border-emerald-400`}`}
          >
            {onAir ? 'Take off air' : 'Show in overlay'} <span className="opacity-60">↵</span>
          </button>
        </div>
      }
    >
      {failed && <div className="text-amber-300">Clubhouse would not give up that profile.</div>}
      {photos && (
        <PhotoHistoryDialog
          userId={mine ? null : userId}
          who={p?.name ?? null}
          current={p?.photoUrl ?? null}
          onClose={() => setPhotos(false)}
          onPicked={() => setGen(g => g + 1)}
        />
      )}

      {/* Two panels: the card and its bio on the left, every control on the right. */}
      <div ref={splitRef} className="flex min-h-0 flex-1 gap-2">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
        **This is the card, not a picture of it.** The same `StudioCallInfoCardOverlay` OBS draws,
        under the same layer style, at the layer's true pixel size, CSS-scaled into whatever room
        the dialog has. The operator was previously framing a face in a square box and hoping; now
        the thing being adjusted and the thing going out are one component, so what is seen here is
        what goes out — including a bio that overflows, which is exactly the case the split exists
        to fix.

        Three gestures, all on the card itself:
        - **Drag the picture** to pan it, at any zoom, clamped so it can never leave its band.
        - **Ctrl + wheel over the picture** to zoom at the pointer.
        - **Drag either separator** to give the image, the name strip or the text more of the card.
        And a click on the picture, when the card is not up, still puts it up — that is what the
        dialog is for, and a click that travelled is a pan, so a drag never airs anybody.
      */}
      <div
        className={`relative w-full overflow-hidden rounded-lg border bg-neutral-950 ${
          fill ? 'min-h-0 shrink-0' : ''
        } ${onAir ? 'border-emerald-500' : 'border-slate-800'}`}
        style={layer ? { aspectRatio: `${layer.width} / ${layer.height}` } : undefined}
        ref={previewRef}
        onDoubleClick={() => {
          framing.commit({ zoom, pan });
          setZoom(1); setPan({ x: 0, y: 0 });
        }}
        onPointerDown={e => {
          const band = bandEl('image')?.getBoundingClientRect();
          if (!band || e.clientY < band.top || e.clientY > band.bottom) return;
          press.current = { x: e.clientX, y: e.clientY, moved: false };
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, was: { zoom, pan } };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const q = press.current;
          if (q && (Math.abs(e.clientX - q.x) > 4 || Math.abs(e.clientY - q.y) > 4)) q.moved = true;
          const d = drag.current;
          const band = bandEl('image');
          if (!d || !band) return;
          // The drag is in preview pixels; the pan is in shares of the band, which is what the
          // card on air is drawn with.
          setPan(clampPan({
            x: d.px + (e.clientX - d.x) / band.clientWidth,
            y: d.py + (e.clientY - d.y) / band.clientHeight,
          }, zoom));
        }}
        onPointerUp={() => {
          // One slot per gesture, banked only if it travelled — a still press is the click
          // that puts the card on air, not an edit.
          if (drag.current && press.current?.moved) framing.commit(drag.current.was);
          drag.current = null;
        }}
        onClick={() => {
          const q = press.current;
          press.current = null;
          if (q?.moved || busy || onAir || !p?.photoUrl) return;
          void showAir();
        }}
        title={onAir
          ? 'On air — drag the picture to reframe it, Ctrl+wheel to zoom, drag a separator to divide the card. The footer takes it down'
          : 'Click the picture to put this card on the CHinfocard layer · drag to reframe · Ctrl+wheel to zoom'}
      >
        {layer && k > 0 && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: layer.width, height: layer.height, transform: `scale(${k})` }}
          >
            <OverlayLayerContext.Provider
              value={{
                ...(layer as any),
                x: 0, y: 0, width: layer.width, height: layer.height,
                // The two shares come from the drag in progress, not from the row that was
                // fetched — the separator has to move under the finger, not after the PATCH.
                photoScale: shares?.img ?? layer.photoScale,
                nameScale: shares?.name ?? layer.nameScale,
              }}
            >
              <StudioCallInfoCardOverlay card={p ? { ...p, zoom, panX: pan.x, panY: pan.y } : null} seq={seq} playKey={playKey} />
            </OverlayLayerContext.Provider>
          </div>
        )}

        {/* The separators. Sitting ON the seam they name, measured off the rendered bands, and
            invisible until the pointer is near — the card underneath is the thing being judged
            and two permanent rules across it would be two lines that are not going out. */}
        {seams && shares && [
          { y: seams.y1, which: 1 as const, label: 'Photo' },
          { y: seams.y2, which: 2 as const, label: 'Name' },
        ].map(s => (
          <div
            key={s.which}
            onPointerDown={startSeam(s.which)}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            title={`Drag to set how much of the card the ${s.which === 1 ? 'picture' : 'name strip'} gets`}
            className="group absolute inset-x-0 z-10 flex h-3 -translate-y-1/2 cursor-row-resize items-center"
            style={{ top: s.y }}
          >
            <div className="h-0.5 w-full bg-sky-400/0 transition-colors group-hover:bg-sky-400/80" />
            <span className="absolute right-1 rounded bg-sky-500 px-1 text-[9px] font-bold uppercase tracking-wider text-white opacity-0 transition-opacity group-hover:opacity-100">
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {/* The bio in full, under the card — the card clips it (nothing on a canvas scrolls), and
          reading the whole thing is half of why the operator opened this. */}
      {p && (
        <div className={`mt-3 ${fill ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
          <div className="flex gap-4 text-xs text-neutral-500">
            {p.followers != null && <span><span className="text-neutral-300">{count(p.followers)}</span> followers</span>}
            {p.following != null && <span><span className="text-neutral-300">{count(p.following)}</span> following</span>}
            {!!p.twitter && <span>𝕏 {p.twitter}</span>}
            {!!p.instagram && <span>ig {p.instagram}</span>}
          </div>
          {!!p.bio && <p className={`mt-2 whitespace-pre-wrap text-xs text-neutral-400 ${fill ? '' : 'max-h-32 overflow-y-auto'}`}>{p.bio}</p>}
        </div>
      )}
      </div>

      {/* Right: the controls. The framing, against the card it frames — roundness and margin
          are px (a finish, not a proportion), ring a share of the image's short side, the tilt
          trio the Video Player's own transform; and the play — bands, or the two-act sequence
          with each act's hold and effect. ▶ runs the sequence once in the preview. */}
      {/* The split. The controls column used to be a fixed `w-60`, which is the wrong width in
          both directions: the sliders crowd on a laptop, and on the studio monitor the card is
          kept small by a column of empty space. Drag this to divide it. */}
      <div
        onMouseDown={startSplit}
        onDoubleClick={() => editPanelW(PANEL_W_DEFAULT)}
        title="Drag to divide the card and its controls · double-click to reset"
        className="group -mx-1 flex w-2 shrink-0 cursor-col-resize items-center justify-center"
      >
        <span className="h-16 w-px rounded bg-slate-700 transition-colors group-hover:bg-sky-500" />
      </div>
      <div style={{ width: panelW }} className="flex shrink-0 flex-col gap-4 overflow-y-auto pr-1">
        {layer && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Framing</span>
              {/* The same pair every layout designer wears, because this is the same contract — and the framing goes to air as it is dragged, so the way back has to be
                  visible rather than a keystroke nobody was told about. */}
              <span className="ml-auto flex items-center gap-1">
                <UndoRedo canUndo={framing.canUndo} canRedo={framing.canRedo} depth={framing.depth}
                  limit={10}
                  onUndo={() => adopt(framing.undo({ zoom, pan }))}
                  onRedo={() => adopt(framing.redo({ zoom, pan }))} />
              </span>
            </div>
            {/* Zoom is the picture's own crop, not the layer's — the same 1–5× the wheel and the
                drag write, so the slider, the gesture and the card on air are one number. Pan is
                re-clamped as it moves, which is why it goes through `zoomAt` rather than setZoom. */}
            <RangeRow label="Zoom" suffix="×" min={1} max={5} step={0.01}
              value={zoom} onChange={v => zoomAt(v)} hint="The picture's own crop inside its band" />
            {/* Card size used to sit here. It is the same `cardScale` the FRAME section's **Frame
                zoom** now drives, and two sliders on one value two rows apart read as two settings
                that disagree. It moved rather than being duplicated — it belongs beside the canvas
                it visibly changes. */}
            {/* Percent, read as CSS reads it: 50% is a full ellipse, so a square picture becomes a
                circle. The Overlay tab has always sent this column as a percentage. */}
            <RangeRow label="Roundness" suffix="%" min={0} max={50} step={1}
              value={layer.photoRadius ?? 50} onChange={v => patchLayer({ photoRadius: Math.round(v) })} />
            <RangeRow label="Ring" suffix="%" min={0} max={15} step={0.5}
              value={layer.photoBorder ?? 0} onChange={v => patchLayer({ photoBorder: v })} />
            <label className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="w-16 shrink-0">Ring colour</span>
              <input type="color" value={layer.borderColor || layer.color || '#38bdf8'}
                onChange={e => patchLayer({ borderColor: e.target.value })}
                className="h-6 w-10 cursor-pointer rounded border border-slate-700 bg-slate-900" />
            </label>
            <RangeRow label="Margin" suffix="px" min={0} max={80} step={1}
              value={layer.cardMargin ?? 10} onChange={v => patchLayer({ cardMargin: Math.round(v) })} />
            {/* The name strip's own gap. The card's Margin above is the frame around EVERYTHING;
                this is the inset inside the strip, and without it the name starts hard against
                the left edge and the role badge is cut off by the right one. A share of the
                strip's height, so it survives both the Name seam and the card being resized. */}
            <RangeRow label="Name gap" suffix="%" min={0} max={40} step={1}
              value={layer.nameMargin ?? 16} onChange={v => patchLayer({ nameMargin: Math.round(v) })} />
            {/* The two type sizes, on the same columns and the same ranges the Overlay tab drives
                (one value, two views). They are here because the bio is the band that
                overflows: it is whatever length the person wrote, in PIXELS against a fixed box,
                and nothing scales it to fit — `autoFitFont` is read by FactBox and Fallacy, not by
                this card. So when a long bio runs out of the band, this is the control that fixes
                it, and it should be beside the card it is being judged against. */}
            <RangeRow label="Name size" suffix="px" min={8} max={140} step={1}
              value={layer.titleSize ?? Math.round((layer.height || 340) * 0.075)}
              onChange={v => patchLayer({ titleSize: Math.round(v) })}
              hint="The name and @handle at the top of the card" />
            <RangeRow label="Body size" suffix="px" min={8} max={90} step={1}
              value={layer.bodySize ?? Math.round((layer.height || 340) * 0.05)}
              onChange={v => patchLayer({ bodySize: Math.round(v) })}
              hint="The bio and the follower counts — turn this down when a long bio runs past the band" />
            {/* Sequence only: how big the face is once it has settled into the corner of the text
                act. Percent of the card's height, so it holds at any layer size. */}
            {seq.style === 'sequence' && (
              <RangeRow label="DP size" suffix="%" min={8} max={60} step={1}
                value={layer.cardDpSize ?? 22} onChange={v => patchLayer({ cardDpSize: Math.round(v) })} />
            )}
          </div>
        )}
        {/* Where the card SITS, as opposed to what it looks like. It is the layer's own box, so
            this is the Overlay tab's canvas on the same columns — put here because the
            operator sizing a card is already looking at it, and leaving StudioCall to nudge a
            rectangle is the trip this saves. Corners only: a layer row has no crop. */}
        {layer && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Frame</span>
            <CardFrameCanvas layer={layer} onChange={patchLayer} tint={layer.color}
              orientation={frameOri} onOrientationChange={setFrameOri} />
          </div>
        )}
        {/* The tilt sliders and the canvas's Ctrl+drag write the SAME two columns, so they follow
            the canvas's Landscape/Portrait switch. A slider left on the landscape column while the
            canvas dragged the portrait one would be two controls for one value, disagreeing. */}
        {layer && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
              Perspective <span className="font-normal normal-case tracking-normal text-slate-500">· {frameOri === 'portrait' ? 'portrait' : 'landscape'}</span>
            </span>
            <RangeRow label="Rotate X" suffix="°" min={-45} max={45} step={0.1}
              value={layer[tiltCols.rx] ?? 0} onChange={v => patchLayer({ [tiltCols.rx]: v })} />
            <RangeRow label="Rotate Y" suffix="°" min={-45} max={45} step={0.1}
              value={layer[tiltCols.ry] ?? 0} onChange={v => patchLayer({ [tiltCols.ry]: v })} />
            <RangeRow label="FOV" suffix="°" min={30} max={120} step={0.5}
              value={layer[tiltCols.fov] ?? 90} onChange={v => patchLayer({ [tiltCols.fov]: v })} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Style</span>
          <div className="flex gap-0.5 rounded bg-slate-900 p-0.5">
            {([['bands', 'Card'], ['sequence', 'Image → Text']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setSeq({ style: k })}
                className={`flex-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition ${
                  seq.style === k ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                }`}>{label}</button>
            ))}
          </div>
          {seq.style === 'sequence' && (
            <>
              <span className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">Act 1 — the picture</span>
              <RangeRow label="Hold" suffix="s" min={1} max={60} step={1}
                value={seq.imageHold} onChange={v => setSeq({ imageHold: Math.round(v) })} />
              <select value={seq.imageEffect} onChange={e => setSeq({ imageEffect: e.target.value })}
                className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
                {CARD_EFFECTS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <span className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">Act 2 — the text</span>
              <RangeRow label="Hold" suffix="s" min={1} max={60} step={1}
                value={seq.textHold} onChange={v => setSeq({ textHold: Math.round(v) })} />
              <select value={seq.textEffect} onChange={e => setSeq({ textEffect: e.target.value })}
                className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 focus:outline-none">
                {CARD_EFFECTS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <button type="button" onClick={() => setPlayKey(k => k + 1)}
                className="mt-1 rounded border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:text-white">
                ▶ Preview the sequence
              </button>
              <p className="text-[10px] leading-relaxed text-slate-600">
                On air: the picture alone for {seq.imageHold}s, out; the text alone for {seq.textHold}s, out.
                The in/out speed is the layer's Speed in the Overlay tab.
              </p>
            </>
          )}
        </div>
      </div>
      </div>
    </Dialog>
  );
}

/** The stage and the audience, and nothing about how the caller got them. */
export function RoomRoster({
  room, meUserId, speakingIds, openMicIds, myMuted, talkMs, cardUserId, selected, busy, iAmModerator,
  onProfile, onSelect, onAct, onMakeMod,
}: {
  room: RosterRoom;
  meUserId: string | number | undefined;
  speakingIds: Set<string>;
  /** Whose mic is open, from the engine (useRoomSpeaking). Absent or null = no data, draw nothing. */
  openMicIds?: Set<string> | null;
  /** Your own mic, from the same hook — the engine does not list the local user in `openMics`. */
  myMuted?: boolean;
  /** Floor time per person, ms. Drawn for a MODERATOR only — see the badge below. */
  talkMs: Record<string, number>;
  cardUserId: string | null;
  selected: string | null;
  busy: boolean;
  iAmModerator: boolean;
  /** Open this person's profile card. The face is the button, and reading it is local —
   *  putting it on air is a second click inside the card. */
  onProfile: (userId: string) => void;
  onSelect: (userId: string | null) => void;
  onAct: (path: string, body: unknown) => void;
  onMakeMod: (u: Participant) => void;
}) {
  const modOnly = (what: string) => (iAmModerator ? what : `${what} — moderators only`);
  /** Who the desk is holding muted. The server's list; this only mirrors it. */
  const { held, setHeld } = useHeldMutes();
  const { gagged, autoMuted } = useSpeakerStatus();
  // Press and hold a face on the stage: a strip of reactions opens where the finger is, and one
  // tap sends it. A plain click still opens the profile; the hold swallows the click that
  // follows it so the card does not open on top of the strip.
  const [reactAt, setReactAt] = useState<{ userId: string; name: string; x: number; y: number } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holdFired = useRef(false);
  const holdStart = (u: { userId: string; name?: string }, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    holdFired.current = false;
    const { clientX: x, clientY: y } = e;
    holdTimer.current = window.setTimeout(() => {
      holdFired.current = true;
      setReactAt({ userId: u.userId, name: u.name ?? '', x, y });
    }, HOLD_MS);
  };
  const holdEnd = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };
  // Reactions land on the face they were aimed at, here as on the canvas: the server's
  // `studiocall-reaction` carries the target and Clubhouse's display time, and the emoji rises out
  // of the photo and is gone when that time is up.
  const [floaters, setFloaters] = useState<TileFloater[]>([]);
  useEffect(() => ws.onBroadcast((msg: any) => {
    if (msg?.type !== 'studiocall-reaction' || !msg.emoji || !msg.targetUid) return;
    const ttlMs = Math.max(1500, Math.min(10_000, Number(msg.ttlMs) || 4000));
    setFloaters(f => [...f.filter(x => x.until > Date.now()).slice(-11),
      { id: String(msg.id ?? Date.now()), emoji: String(msg.emoji), targetUid: String(msg.targetUid), until: Date.now() + ttlMs, ttlMs }]);
  }), []);
  useEffect(() => {
    if (!floaters.length) return;
    const t = setTimeout(() => setFloaters(f => f.filter(x => x.until > Date.now())), Math.max(50, Math.min(...floaters.map(x => x.until)) - Date.now() + 20));
    return () => clearTimeout(t);
  }, [floaters]);
  const shutWhy = (userId: string) =>
    gagged.has(userId) ? 'Gagged — the desk shuts this mic whenever it opens'
    : autoMuted.has(userId) ? 'Auto-muted — the desk shuts this mic whenever it opens'
    : held.has(userId) ? 'Held muted this room — the desk shuts this mic whenever it opens'
    : null;

  // The split between the stage and the floor is a handle, not a guess: a panel of six speakers
  // wants the stage tall, a room of sixty listeners wants the floor. Dragged, remembered.
  const [stageH, setStageH] = useState(() => Number(getUiSetting(STAGE_H_KEY)) || 256);
  const startSplit = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = stageH;
    const clamp = (h: number) => Math.round(Math.min(STAGE_H_MAX, Math.max(STAGE_H_MIN, h)));
    const move = (ev: PointerEvent) => setStageH(clamp(h0 + ev.clientY - y0));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      setUiSetting(STAGE_H_KEY, String(clamp(h0 + ev.clientY - y0)));
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [stageH]);

  // Fit: neither band is capped and neither scrolls — both take the height their tiles need and
  // the panel itself is what scrolls. The split handle has nothing to do then, so it goes.
  const [fit, setFit] = useState(() => getUiSetting(FIT_KEY) === '1');
  const toggleFit = () => { const next = !fit; setFit(next); setUiSetting(FIT_KEY, next ? '1' : '0'); };

  return (
    <div className="mt-4">
      <style>{TILE_REACT_KEYFRAMES}</style>
      <div className="flex items-center text-xs font-medium text-neutral-400">
        <span>On stage ({room.speakers?.length ?? 0})</span>
        <button
          type="button"
          onClick={toggleFit}
          title={fit ? 'Fit: both bands show everyone, no inner scrollbars' : 'Cap the bands and scroll inside them'}
          className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition ${
            fit ? 'bg-emerald-600 text-white' : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300'
          }`}
        >Fit</button>
      </div>
      <div className={`mt-2 flex flex-wrap gap-3 pr-1 ${fit ? '' : 'overflow-y-auto'}`} style={fit ? undefined : { maxHeight: stageH }}>
        {(room.speakers ?? []).map(u => {
          const talking = speakingIds.has(u.userId);
          const isMe = String(u.userId) === String(meUserId);
          const pick = selected === u.userId;
          // Mic state straight off Agora's mute callbacks, four times a second: an unmute shows
          // here before the first word, not on the roster's next TTL refresh. Nothing is drawn
          // when the engine cannot say (`null`), so an old engine does not paint everyone muted.
          const micKnown = openMicIds != null;
          const micOpen = isMe ? (typeof myMuted === 'boolean' ? !myMuted : null) : micKnown ? openMicIds!.has(u.userId) : null;
          return (
            <PersonTile
              key={u.userId}
              selected={pick}
              railCols={2}
              onName={() => onSelect(pick ? null : u.userId)}
              nameTitle={pick ? 'Deselect' : 'Select — keeps the controls up'}
              name={<>
                <span className="truncate">{u.isModerator ? '★ ' : ''}{gagged.has(u.userId) ? '🚫 ' : ''}{autoMuted.has(u.userId) ? '🔇 ' : ''}{u.name}</span>
                {/* Only a moderator gets this. It is the number you act on — bringing somebody
                    in, or winding somebody up — and to anyone who cannot do either it is a
                    scoreboard on a conversation. Amber past five minutes: not an error, just the
                    turn that has gone long enough to be worth noticing. */}
                {iAmModerator && talkLabel(talkMs[String(u.userId)]) && (
                  <span
                    title={`Has held the floor for ${talkLabel(talkMs[String(u.userId)])} in this room`}
                    className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold tabular-nums ${
                      (talkMs[String(u.userId)] ?? 0) >= 5 * 60_000
                        ? 'bg-amber-900/50 text-amber-300' : 'bg-neutral-800 text-neutral-400'
                    }`}
                  >{talkLabel(talkMs[String(u.userId)])}</span>
                )}
              </>}
              face={
                /* The face IS the button — but it opens the card HERE (see ProfileCard),
                   it does not broadcast. Reading a stranger's bio and showing it to the
                   audience were the same gesture until this, which made looking somebody
                   up an on-air act. Emerald still marks whoever IS on air. */
                <button
                  type="button"
                  title={cardUserId === u.userId ? 'On air — open the card to take it down' : `Open this profile${isMe ? '' : ' — press and hold to react'}`}
                  onClick={() => { if (holdFired.current) { holdFired.current = false; return; } onProfile(u.userId); }}
                  onPointerDown={e => { if (!isMe) holdStart(u, e); }}
                  onPointerUp={holdEnd}
                  onPointerLeave={holdEnd}
                  onPointerCancel={holdEnd}
                  onContextMenu={e => { if (!isMe) { e.preventDefault(); setReactAt({ userId: u.userId, name: u.name ?? '', x: e.clientX, y: e.clientY }); } }}
                  className={`relative shrink-0 select-none rounded-full p-0.5 ${cardUserId === u.userId ? 'bg-emerald-500' : pick ? 'bg-sky-400' : 'bg-transparent hover:bg-neutral-700'}`}
                  style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                >
                  {/* The ring blinks, not the photo — pulsing the avatar itself makes the
                      face hard to read, and it is the face the operator is checking. Your
                      own is included: the engine maps Agora's local uid 0 onto the real
                      user id, so this is how you see that you are getting through. */}
                  {talking && (
                    <span className="pointer-events-none absolute -inset-0.5 animate-pulse rounded-full ring-2 ring-emerald-400 shadow-[0_0_14px_2px_rgba(52,211,153,0.55)]" />
                  )}
                  {/* Careful with the ring's promise on your OWN face: it is the local capture
                      level, so it proves the microphone is heard HERE, not that anything leaves.
                      The uplink dot is what proves delivery. */}
                  {u.photoUrl
                    ? <RetryImg src={`${API}${u.photoUrl}`} alt="" className={`h-[3.6rem] w-[3.6rem] rounded-full object-cover transition-[filter,opacity] duration-150 ${micOpen === false ? 'opacity-55 grayscale-[40%]' : ''}`} />
                    : <div className={`h-[3.6rem] w-[3.6rem] rounded-full bg-neutral-800 ${micOpen === false ? 'opacity-55' : ''}`} />}
                  {micOpen === false && (
                    <span title="Mic is off" className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-neutral-950 bg-neutral-800 text-[11px] leading-none">🔇</span>
                  )}
                  {/* Your face only. The ring above says the microphone is being HEARD by this
                      machine; this says the bytes are reaching Clubhouse's server, which is the
                      half nothing else in the app can tell you. */}
                  {isMe && <UplinkDot />}
                  {u.isModerator && <ModDot corner="bl" />}
                  {!isMe && shutWhy(u.userId) && <MuteCross why={shutWhy(u.userId)!} />}
                  {floaters.filter(f => f.targetUid === u.userId).map((f, i) => (
                    <span
                      key={f.id}
                      className="pointer-events-none absolute z-10 text-2xl leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)]"
                      style={{ left: `${50 + ((i % 3) - 1) * 22}%`, bottom: '40%', animation: `sc-tile-react ${f.ttlMs}ms ease-out forwards` }}
                    >{f.emoji}</span>
                  ))}
                </button>
              }
              left={<>
                {/* Reading somebody up is not a moderator act (only roster CHANGES are), and it
                    works on your own tile too — that is where your photo picker lives. So it is
                    outside both guards the others carry. The face opens the same card; this is the
                    labelled way in, for when the face is not obviously a button. */}
                <ActionChip glyph="i" title={`View ${u.name || 'this'} profile`}
                  onClick={() => onProfile(u.userId)} />
                {!isMe && <>
                  {/* A latch, not a one-shot: Clubhouse hands every speaker their own unmute, so
                      a plain mute is undone a second later and pressed again, and again, by an
                      operator who is talking. Lit = the desk is holding this mic shut; pressing it
                      again is the release, and it opens the mic in the same request. */}
                  <ActionChip glyph={held.has(u.userId) ? '🔇' : '🔈'} tone={held.has(u.userId) ? 'kill' : 'neutral'}
                    title={modOnly(held.has(u.userId)
                      ? `Let ${u.name || 'them'} unmute again — the desk stops shutting their mic`
                      : `Mute ${u.name || 'them'}, and keep them muted if they unmute`)}
                    disabled={busy || !iAmModerator}
                    onClick={() => void setHeld(u.userId, u.name ?? '', !held.has(u.userId))} />
                  <ActionChip glyph="↓" title={modOnly('Move off stage')} disabled={busy || !iAmModerator}
                    onClick={() => onAct('room/speaker', { userId: u.userId, onStage: false })} />
                  {!u.isModerator && (
                    <ActionChip glyph="★" tone="mod" title={modOnly('Make moderator')} disabled={busy || !iAmModerator}
                      onClick={() => onMakeMod(u)} />
                  )}
                </>}
              </>}
              right={!isMe && (
                <ActionChip glyph="✕" tone="kill" title={modOnly('Remove from room')} disabled={busy || !iAmModerator}
                  onClick={() => onAct('room/remove', { userId: u.userId })} />
              )}
            />
          );
        })}
        {!(room.speakers ?? []).length && <span className="text-xs text-neutral-600">nobody on stage</span>}
      </div>

      {fit ? <div className="mt-4" /> : (
        <div
          onPointerDown={startSplit}
          title="Drag to give the stage more or less room"
          className="group my-2 flex h-3 cursor-row-resize items-center touch-none select-none"
        >
          <div className="h-0.5 w-full rounded bg-neutral-800 transition group-hover:bg-neutral-600" />
        </div>
      )}

      <div className="text-xs font-medium text-neutral-400">
        Listeners ({room.listeners?.length ?? 0})
      </div>
      <div className={`mt-2 flex flex-wrap gap-3 pr-1 ${fit ? '' : 'max-h-56 overflow-y-auto'}`}>
        {(room.listeners ?? []).map(u => {
          const pick = selected === u.userId;
          return (
            <PersonTile
              key={u.userId}
              selected={pick}
              onName={() => onSelect(pick ? null : u.userId)}
              nameTitle={pick ? 'Deselect' : 'Select — keeps the controls up'}
              name={<span className="truncate">{u.isInvitedAsSpeaker ? '✋ ' : ''}{gagged.has(u.userId) ? '🚫 ' : ''}{autoMuted.has(u.userId) ? '🔇 ' : ''}{u.name}</span>}
              face={
                <button
                  type="button"
                  title={cardUserId === u.userId ? 'On air — open the card to take it down' : 'Open this profile'}
                  onClick={() => onProfile(u.userId)}
                  className={`shrink-0 rounded-full p-0.5 ${cardUserId === u.userId ? 'bg-emerald-500' : pick ? 'bg-sky-400' : 'bg-transparent hover:bg-neutral-700'}`}
                >
                  {u.photoUrl
                    ? <RetryImg src={`${API}${u.photoUrl}`} alt="" className="h-12 w-12 rounded-full object-cover opacity-80" />
                    : <div className="h-12 w-12 rounded-full bg-neutral-800" />}
                </button>
              }
              left={<>
                <ActionChip glyph="i" title={`View ${u.name || 'this'} profile`}
                  onClick={() => onProfile(u.userId)} />
                <ActionChip glyph="↑" tone="go" title={modOnly('Invite to stage')} disabled={busy || !iAmModerator}
                  onClick={() => onAct('room/speaker', { userId: u.userId, onStage: true })} />
              </>}
              right={
                <ActionChip glyph="✕" tone="kill" title={modOnly('Remove from room')} disabled={busy || !iAmModerator}
                  onClick={() => onAct('room/remove', { userId: u.userId })} />
              }
            />
          );
        })}
        {!(room.listeners ?? []).length && <span className="text-xs text-neutral-600">no listeners yet</span>}
      </div>
      {reactAt && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => setReactAt(null)} />
          <div
            role="menu"
            className="fixed z-50 flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900/95 px-2 py-1 shadow-xl"
            style={{ left: Math.max(8, Math.min(window.innerWidth - 8, reactAt.x)), top: reactAt.y - 12, transform: 'translate(-50%, -100%)' }}
          >
            {REACTIONS.map(e => (
              <button
                key={e}
                type="button"
                title={`React ${e} to ${reactAt.name || 'them'}`}
                className="rounded-full px-1.5 py-1 text-xl leading-none transition hover:scale-125 hover:bg-neutral-800"
                onClick={() => { const { userId, name } = reactAt; setReactAt(null); void sendReaction(userId, e, name); }}
              >{e}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The roster as a pop-out tab: the caller supplies the room and the talk report it already
 * polls, this owns the acts — the info card, the four moderator moves, and the one
 * confirmation among them that cannot be taken back.
 */
export function StudioCallPeople({ room, speakingIds, openMicIds, myMuted, talkMs = {}, onChanged }: {
  room: RosterRoom;
  speakingIds: Set<string>;
  openMicIds?: Set<string> | null;
  myMuted?: boolean;
  /** Floor time per person, ms — from `useRoomSpeaking`. Absent is simply no badges. */
  talkMs?: Record<string, number>;
  onChanged: () => void;
}) {
  const [meUserId, setMeUserId] = useState<string | undefined>();
  const [cardUserId, setCardUserId] = useState<string | null>(null);
  // Whose profile is open in front of the operator. Local reading only — `cardUserId` is the
  // one that is on air, and the two are deliberately different things.
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/studiocall/infocard`)
      .then(r => r.json())
      .then(d => setCardUserId(d?.card?.userId ?? null))
      .catch(() => {});
  }, []);

  // The card comes down on its own when the CHinfocard layer's duration runs out, and the
  // server says so on the same broadcast the overlay obeys. Without this the button in the
  // profile still reads "Take off air" against an empty canvas.
  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type === 'studiocall-infocard') setCardUserId((msg as any).card?.userId ?? null);
  }), []);

  useEffect(() => {
    fetch(`${API}/api/studiocall/session`)
      .then(r => r.json())
      .then(d => setMeUserId(d?.me?.userId === undefined ? undefined : String(d.me.userId)))
      .catch(() => {});
  }, []);

  const act = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/studiocall/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d?.ok === false) notify.error(d?.body?.error_message || d?.error || d?.message || 'That did not work.');
      else onChanged();
    } catch { notify.error('Request failed.'); } finally { setBusy(false); }
  }, [onChanged]);

  const makeMod = useCallback(async (u: Participant) => {
    if (await askConfirm({
      title: 'Make moderator?',
      body: `Make ${u.name} a moderator? This cannot be undone from here.`,
      confirmLabel: 'Make moderator',
    })) void act('room/moderator', { userId: u.userId });
  }, [act]);

  // Clubhouse refuses every roster action to a non-moderator, so the buttons say so rather
  // than coming back as an error with no stated reason.
  const iAmModerator = room.mode === 'host'
    || (room.speakers ?? []).some(u => String(u.userId) === String(meUserId) && u.isModerator);

  // Out of a room the useful next act is opening one, not being told where else to look. The
  // form is the same `StartRoom` the hallway draws — the operator lands here whenever a room
  // ends, and a dead-end message meant crossing to the other window to start the next one.
  if (!room.live) {
    return (
      <div className="h-full overflow-y-auto p-3">
        <div className="mb-3 text-xs text-neutral-600">
          No room open — start one here, or join one from Rooms.
        </div>
        <StartRoom onCreated={onChanged} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-4">
      <div className="sticky top-0 z-10 bg-neutral-950 pt-3">
        <RoomTopic room={room} iAmModerator={iAmModerator} onChanged={onChanged} className="text-sm text-neutral-200" />
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>{room.numAll ?? 0} in room · {room.numSpeakers ?? 0} on stage</span>
          {(room.onStage ?? room.mode === 'host') && <span className={ACTIVE_PILL}>On stage</span>}
        </div>
      </div>

      <RoomRoster
        room={room}
        meUserId={meUserId}
        speakingIds={speakingIds}
        openMicIds={openMicIds}
        myMuted={myMuted}
        talkMs={talkMs}
        cardUserId={cardUserId}
        selected={selected}
        busy={busy}
        iAmModerator={iAmModerator}
        onProfile={id => { openAdminWindow('profile', { user: id }); }}
        onSelect={setSelected}
        onAct={(path, body) => void act(path, body)}
        onMakeMod={u => void makeMod(u)}
      />
    </div>
  );
}
