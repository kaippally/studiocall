import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../lib/api';
import { ws } from '../ws';
import { ACTIVE_ROW, ACTIVE_PILL } from '../lib/activeStyle';
import { warnIfObsOverlayHidden, showObsOverlayFor } from '../lib/obsOverlay';
import { notify } from '../lib/notices';
import { ModDot } from './ModDot';
import { EmojiPicker } from './EmojiPicker';

/**
 * The Clubhouse room's text chat, as the operator reads it — the admin-side twin of
 * StudioCallChatOverlay, which is the same messages on the OBS canvas.
 *
 * It fills whatever box it is given (`h-full` + `min-h-0`, list scrolls, composer pinned
 * to the floor), because it is mounted three ways: inside the StudioCall tab, in the
 * chat pop-out window, and — one day — in a mosaic panel. Nothing here sets a height.
 *
 * Two things go on air from here and they are different: the MODE (all lines rolling, or
 * one held line) is server state in `/controls`, and the held line itself is `/chat/pin`.
 * Both are server-owned for the usual reason — the surface that obeys them is a browser
 * source, and a click in a tab has no other way to reach it.
 */

export type RoomChatMessage = {
  id: string; at: number; text: string;
  userId: string; author: string; avatar: string | null;
  isModerator: boolean; isSpeaker: boolean; isMe: boolean;
  /** The desk said it by itself — a bridged `[YT][…]` line, the floor rule, a notice. Listed,
   *  never held, no hover powers: its original is already on the canvas from its own feed. */
  auto?: boolean;
  /** A reaction line — "reacted 💯 to Sam": the emoji and who it was aimed at. */
  reaction?: string;
  target?: string;
};

type ChatMode = 'all' | 'selected';
type ChatAnim = string;

// How a line arrives on the canvas and how it leaves — in BOTH modes. A held line is the one
// the audience actually reads, and it used to appear and vanish between two frames; it now
// wears the same pair (StudioCallChatOverlay keeps a released line for its exit). The ids are
// the shared animation library's own, stored verbatim; the same two lists are offered in the
// Overlay tab, and both write the one server setting.
export const CHAT_ANIM_IN: { id: string; label: string }[] = [
  { id: 'riseIn', label: 'Zip in from bottom' },
  { id: 'fadeIn', label: 'Fade' },
  { id: 'blurIn', label: 'Blur' },
  { id: 'zipInRight', label: 'Zip in from right' },
  { id: 'zipInLeft', label: 'Zip in from left' },
];
export const CHAT_ANIM_OUT: { id: string; label: string }[] = [
  { id: 'none', label: 'None — just gone' },
  { id: 'fadeOut', label: 'Fade' },
  { id: 'blurOut', label: 'Blur' },
  { id: 'zipOutRight', label: 'Zip out right' },
  { id: 'zipOutLeft', label: 'Zip out left' },
  { id: 'sinkOut', label: 'Sink out bottom' },
];

const RENDER_MAX = 200;

function clockOf(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function merge(prev: RoomChatMessage[], items: RoomChatMessage[]): RoomChatMessage[] {
  const known = new Set(prev.map(m => m.id));
  const fresh = items.filter(m => !known.has(m.id));
  if (!fresh.length) return prev;
  const next = [...prev, ...fresh].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return next.length > RENDER_MAX ? next.slice(-RENDER_MAX) : next;
}

export function StudioCallChatPanel({ onPopout }: { onPopout?: () => void }) {
  const [messages, setMessages] = useState<RoomChatMessage[]>([]);
  const [room, setRoom] = useState<{ live: boolean; channel: string | null }>({ live: false, channel: null });
  const [onAir, setOnAir] = useState(false);
  const [mode, setMode] = useState<ChatMode>('all');
  const [pinId, setPinId] = useState<string | null>(null);
  const [anim, setAnim] = useState<ChatAnim>('fadeIn');
  const [animOut, setAnimOut] = useState('fadeOut');
  const [animMs, setAnimMs] = useState(350);
  const [fadeOutMs, setFadeOutMs] = useState(400);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;
  // Which room the list on screen belongs to, read inside the socket handler — which is
  // subscribed once and would otherwise close over the channel as it was at mount.
  const channelRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API}/api/studiocall/room/chat`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        channelRef.current = d.channel ?? null;
        setRoom({ live: !!d.live, channel: d.channel ?? null });
        setMessages(Array.isArray(d.messages) ? d.messages.slice(-RENDER_MAX) : []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const loadControls = useCallback(() => {
    fetch(`${API}/api/studiocall/controls`)
      .then(r => r.json())
      .then(d => {
        setOnAir(!!d?.chatOverlay);
        setMode(d?.chatMode === 'selected' ? 'selected' : 'all');
        setPinId(d?.chatPin?.id ?? null);
        applyAnim(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadControls(); }, [loadControls]);

  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type === 'studiocall-chat') {
      const channel = (msg as any).channel as string | null;
      const items = Array.isArray((msg as any).items) ? (msg as any).items as RoomChatMessage[] : [];
      // A different channel is a different conversation, so it replaces the list rather
      // than merging into it: null is the room being left (the list empties), and a new
      // channel is a switch, where merging would stack the new room on the old one's lines.
      if (channelRef.current !== channel) setMessages(items);
      else if (items.length) setMessages(m => merge(m, items));
      channelRef.current = channel;
      setRoom({ live: !!channel, channel });
      return;
    }
    // A line deleted from the room — by this panel, another window, or the gag — leaves here too.
    if (msg.type === 'studiocall-chat-remove') {
      const ids = new Set(((msg as any).ids as string[] | undefined) ?? []);
      if (ids.size) setMessages(prev => prev.filter(m => !ids.has(m.id)));
      return;
    }
    if (msg.type === 'studiocall-controls') {
      const m = msg as any;
      setOnAir(!!m.chatOverlay);
      setMode(m.chatMode === 'selected' ? 'selected' : 'all');
      setPinId(m.chatPin?.id ?? null);
      applyAnim(m);
    }
  }), []);

  // Follow the tail, but never yank the list while it is being read back.
  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // The engine of record is the server, the same as the mode: the surface that obeys these
  // is a browser source, and a click in a tab has no other way to reach it. A slider commits
  // 120 ms after the hand stops rather than per pixel, and the broadcast that comes back is
  // ignored while that commit is pending — otherwise the older value lands back under the
  // operator's thumb mid-drag.
  const animCommit = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyAnim(d: any) {
    if (animCommit.current) return;
    if (d?.chatAnim) setAnim(d.chatAnim);
    if (d?.chatAnimOut) setAnimOut(d.chatAnimOut);
    if (typeof d?.chatAnimMs === 'number') setAnimMs(d.chatAnimMs);
    if (typeof d?.chatFadeOutMs === 'number') setFadeOutMs(d.chatFadeOutMs);
  }

  const postControls = useCallback((patch: Record<string, unknown>) => {
    fetch(`${API}/api/studiocall/controls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  const commitAnimSoon = useCallback((patch: Record<string, unknown>) => {
    if (animCommit.current) clearTimeout(animCommit.current);
    animCommit.current = setTimeout(() => { animCommit.current = null; postControls(patch); }, 120);
  }, [postControls]);

  const setMode_ = useCallback(async (next: ChatMode) => {
    setMode(next);
    void warnIfObsOverlayHidden('the chat overlay');
    try {
      const d = await fetch(`${API}/api/studiocall/controls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatMode: next }),
      }).then(x => x.json());
      setMode(d?.chatMode === 'selected' ? 'selected' : 'all');
    } catch { loadControls(); }
  }, [loadControls]);

  // Hold one line on air. The same click on the same line lets it go.
  //
  // A pin is resolved server-side against the room history it last read, so a line the
  // server has aged out (or lost to a reload) answers 404. Say so — silently clearing the
  // pin would read as "the click did nothing" on the one control that is going on air.
  const pick = useCallback(async (m: RoomChatMessage) => {
    try {
      const r = await fetch(`${API}/api/studiocall/chat/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: m.id }),
      });
      const d = await r.json();
      if (!r.ok) {
        setFlash(d?.error ?? 'Could not hold that line.');
        setTimeout(() => setFlash(null), 4000);
        return;
      }
      setPinId(d?.chatPin?.id ?? null);
      // Holding a line is the on-air act itself, so a hidden SM_HTML is shown rather than
      // warned about — a click that lands on a source nobody can see reads as a failed click.
      if (d?.chatPin?.id === m.id) void showObsOverlayFor('the held line');
    } catch { loadControls(); }
  }, [loadControls]);

  // Delete one line from the room, for everybody in it. Moderators only at Clubhouse; the
  // server broadcasts the removal, so the list drops it on the way back.
  const remove = useCallback(async (m: RoomChatMessage) => {
    try {
      const r = await fetch(`${API}/api/studiocall/room/chat/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: m.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.body?.error_message ?? d?.error ?? 'delete failed');
      setMessages(prev => prev.filter(x => x.id !== m.id));
    } catch (err: any) {
      notify.error(`Could not remove that line — ${err.message}`);
    }
  }, []);

  const send = useCallback(async () => {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`${API}/api/studiocall/room/chat/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.body?.error_message ?? d?.error ?? 'send failed');
      setReply('');
      setFlash('Sent to the room');
    } catch (err: any) {
      setFlash(err.message);
    } finally {
      setSending(false);
      setTimeout(() => setFlash(null), 4000);
    }
  }, [reply, sending]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-200">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="text-sm font-medium text-neutral-300">Room chat</span>
        {onAir && <span className={ACTIVE_PILL}>On air</span>}
        <div className="ml-auto flex overflow-hidden rounded border border-neutral-700">
          {(['all', 'selected'] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => void setMode_(v)}
              title={v === 'all' ? 'Every comment goes on air as it arrives, one at a time' : 'Only the line you click goes on air'}
              className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition ${
                mode === v ? 'bg-neutral-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {v === 'all' ? 'All' : 'Selected'}
            </button>
          ))}
        </div>
        {onPopout && (
          <button
            type="button"
            onClick={onPopout}
            title="Open the room chat in its own window"
            className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            ⧉
          </button>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-neutral-800 px-3 py-1.5">
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">In</span>
          <select
            value={anim}
            onChange={e => { const v = e.target.value; setAnim(v); postControls({ chatAnim: v }); }}
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-200"
          >
            {CHAT_ANIM_IN.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">Out</span>
          <select
            value={animOut}
            onChange={e => { const v = e.target.value; setAnimOut(v); postControls({ chatAnimOut: v }); }}
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-200"
          >
            {CHAT_ANIM_OUT.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <Speed
          label="In"
          value={animMs}
          onChange={v => { setAnimMs(v); commitAnimSoon({ chatAnimMs: v }); }}
        />
        {animOut !== 'none' && (
          <Speed
            label="Out"
            value={fadeOutMs}
            onChange={v => { setFadeOutMs(v); commitAnimSoon({ chatFadeOutMs: v }); }}
          />
        )}
      </div>

      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2"
      >
        {!messages.length && (
          <p className="px-2 py-6 text-center text-xs text-neutral-600">
            {room.live ? 'Nothing said yet.' : 'No room open — the chat appears once you are in one.'}
          </p>
        )}
        {messages.map(m => {
          const held = pinId === m.id;
          // A div, not a button: the row holds the line on air and carries its own ✕, and one
          // button cannot live inside another.
          // A relayed or automated line is listed and nothing more — not a button, no hover
          // skin, no ✕ — the same as the Live Chat list (ChatTab), so the two lists agree.
          if (m.auto) {
            return (
              <div
                key={m.id}
                title="Posted by the desk itself — never put on air"
                className="relative flex w-full cursor-default gap-2 rounded border border-transparent px-2 py-1.5 text-left opacity-60"
              >
                <div className="relative mt-0.5 shrink-0">
                  {m.avatar
                    ? <img src={`${API}${m.avatar}`} alt="" className="h-6 w-6 rounded-full object-cover" />
                    : <div className="h-6 w-6 rounded-full bg-neutral-800" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-semibold text-amber-300">{m.author}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{clockOf(m.at)}</span>
                  </div>
                  <div className="break-words text-xs text-neutral-400">{m.text}</div>
                </div>
              </div>
            );
          }
          return (
            <div
              key={m.id}
              role="button"
              tabIndex={0}
              onClick={() => void pick(m)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void pick(m); } }}
              title={held ? 'Click to let this line go' : mode === 'selected' ? 'Click to hold this line on air' : 'Click to hold this line — it goes on air in Selected mode'}
              className={`group relative flex w-full cursor-pointer gap-2 rounded border px-2 py-1.5 text-left transition ${
                held ? ACTIVE_ROW : 'border-transparent hover:border-violet-700/60 hover:bg-violet-500/5'
              }`}
            >
              <div className="relative mt-0.5 shrink-0">
                {m.avatar
                  ? <img src={`${API}${m.avatar}`} alt="" className="h-6 w-6 rounded-full object-cover" />
                  : <div className="h-6 w-6 rounded-full bg-neutral-800" />}
                {m.isModerator && <ModDot size="sm" />}
              </div>
              <div className="min-w-0 flex-1 pr-6">
                <div className="flex items-baseline gap-1.5">
                  <span className={`truncate text-xs font-semibold ${m.isMe ? 'text-amber-300' : m.isModerator ? 'text-sky-300' : 'text-neutral-300'}`}>
                    {m.isModerator ? '★ ' : ''}{m.author}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{clockOf(m.at)}</span>
                </div>
                <div className="break-words text-xs text-neutral-200">{m.text}</div>
              </div>
              {/* Removal sits right, furthest out, and only shows on hover — the same law as the
                  roster tile. Deleting a line is not the same act as holding it, so the ✕ stops
                  the click from reaching the row. */}
              <button
                type="button"
                title="Delete this line from the room — moderators only"
                aria-label="Delete this line from the room"
                onClick={e => { e.stopPropagation(); void remove(m); }}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded border border-rose-900 bg-neutral-900/80 text-[11px] leading-none text-rose-400 opacity-0 transition hover:border-rose-500 hover:bg-rose-950/60 focus:opacity-100 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; setPinned(true); }}
          className="z-10 mx-auto -mt-8 mb-2 rounded-full bg-neutral-700 px-3 py-1 text-xs text-white shadow-lg hover:bg-neutral-600"
        >
          Jump to latest
        </button>
      )}

      <div className="flex shrink-0 gap-2 border-t border-neutral-800 p-2">
        <EmojiPicker disabled={!room.live} onPick={e => setReply(r => r + e)} />
        <input
          value={reply}
          onChange={e => setReply(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={room.live ? 'Message the room…' : 'No room open'}
          disabled={!room.live}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 disabled:opacity-40"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!room.live || !reply.trim() || sending}
          className="rounded bg-violet-600 px-3 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-30"
        >
          Send
        </button>
      </div>
      {flash && <p className="shrink-0 px-3 pb-2 text-[11px] text-neutral-400">{flash}</p>}
    </div>
  );
}

// A duration in milliseconds, read as a speed: the slider runs left-to-right from slow to
// fast, so dragging right does what "faster" looks like. The number stays in ms because
// that is what the server stores and what the overlay animates over.
function Speed({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const MIN = 100;
  const MAX = 2000;
  return (
    <label className="flex items-center gap-1.5" title={`${value} ms`}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">{label}</span>
      <input
        type="range"
        min={MIN}
        max={MAX}
        step={50}
        value={MAX + MIN - value}
        onChange={e => onChange(MAX + MIN - Number(e.target.value))}
        className="h-1 w-24 accent-emerald-500"
      />
      <span className="w-10 text-right text-[10px] tabular-nums text-neutral-500">{value}ms</span>
    </label>
  );
}
