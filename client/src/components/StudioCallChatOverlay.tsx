import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDisplayWsMessage, type DisplayMessage } from '../lib/displayWs';
import { useLayerRect, useLayerStyle } from '../lib/overlayLayerContext';
import { effectStyle } from '../lib/animations';

import { API } from '../lib/api';

interface ChatMessage {
  id: string;
  at: number;
  text: string;
  userId: string;
  author: string;
  avatar: string | null;
  isModerator: boolean;
  isSpeaker: boolean;
  isMe: boolean;
  /** Which feed said it. Absent on the room's own rolling messages, which read as the room. */
  source?: 'youtube' | 'clubhouse';
  /** The desk said it by itself (floor rule, notices, bridge, the room link). Never rolled
   *  onto the canvas — the audience is reading the room, not the desk's housekeeping. */
  auto?: boolean;
}

// What the rolling list may show. `auto` is the server's mark; the tag is the bridge's own
// and is checked here as well, so a relayed line stays off the canvas
// even on a row that reached this page without the flag — its original is already here from
// its own feed. Both doors, the hydrate fetch and the live push, go through this.
const rollsOnAir = (m: ChatMessage) => !m.auto && !/^\[(YT|CH)\]\[/.test(m.text);

// Both feeds share this one layer, so a held line has to say where it came from — the same
// comment reads very differently as a YouTube viewer's and as somebody in the room. Named
// and coloured the way the tab names and colours them, so the canvas and the list agree.
const PLATFORM: Record<'youtube' | 'clubhouse', { label: string; bg: string }> = {
  youtube:   { label: 'YouTube', bg: '#dc2626' },
  clubhouse: { label: 'Room',    bg: '#7c3aed' },
};

type ChatMsg = DisplayMessage & { channel: string | null; items: ChatMessage[] };
type ChatMode = 'all' | 'selected';
type ControlsMsg = DisplayMessage & {
  bounce: boolean; chatOverlay: boolean; chatMode?: ChatMode; chatPin?: ChatMessage | null;
  chatAnim?: string; chatAnimOut?: string; chatAnimMs?: number; chatFadeOutMs?: number;
};

// The stored values ARE shared-library effect ids — the same effects L3 and the Clipboard
// board use, so there is one definition of "fade" in the app and no lookup table here to
// drift out of step with the picker.

// One comment at a time. `all` used to stack a rolling column of up to 14 lines, newest at
// the floor; each new line now REPLACES the last, which leaves with the OUT effect while the
// new one plays its IN. The box-fit pass and the dwell sweep still run — with one line they
// only ever retire that line.
const MAX_LINES = 1;

export function StudioCallChatOverlay() {
  const rect = useLayerRect();
  const { color, bodyFontFamily, fontFamily, bodySize, opacity,
          photoScale, photoRadius, photoBorder, duration } = useLayerStyle();
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<ChatMode>('all');
  const [pin, setPin] = useState<ChatMessage | null>(null);
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [anim, setAnim] = useState('fadeIn');
  const [animOut, setAnimOut] = useState('fadeOut');
  const [animMs, setAnimMs] = useState(350);
  const [fadeOutMs, setFadeOutMs] = useState(400);
  // Lines that have fallen off the top and are still playing their exit. Held only for as
  // long as that lasts: a browser source nobody can scroll has no use for them afterwards.
  const [leaving, setLeaving] = useState<ChatMessage[]>([]);
  // The held line that has just been let go, kept on the canvas only for as long as its exit
  // lasts. `selected` is the mode a comment is actually put up in during a show, so without
  // this the one line the audience is reading vanishes between two frames.
  const [pinOut, setPinOut] = useState<ChatMessage | null>(null);

  // The list as it stands, read synchronously by the socket handler — it has to know what
  // the overflow is to hand those lines to `leaving`, and a state updater cannot say.
  const itemsRef = useRef<ChatMessage[]>([]);
  // Auto-hide: how long a comment stays before it goes on its own, seconds. 0 keeps the
  // old behaviour — a line lives until MAX_LINES pushes it off the top. Read from a ref
  // inside the sweep so changing the slider does not restart the interval under a line
  // that is already counting down.
  const dwellRef = useRef(0);
  dwellRef.current = Math.max(0, duration ?? 0);
  const outRef = useRef({ animOut, fadeOutMs });
  outRef.current = { animOut, fadeOutMs };

  /**
   * The arrival style each line was given, kept for as long as the line is up.
   *
   * A rolling chat re-renders constantly — the 250 ms dwell sweep, the layout pass that trims the
   * column, every merge from the pump — and the list used to build a FRESH style object for every
   * line on every one of those. A new object with the same `animation` string is still a new style
   * prop, and the moment anything makes React write it back to the element the CSS animation
   * starts again: one new comment arriving replayed the entrance of every comment already on the
   * canvas, which reads to the audience as the same chat being posted over and over.
   *
   * Caching by id fixes it at the root — the identity is stable, so the attribute is never
   * rewritten and the animation cannot restart. A line therefore plays its entrance exactly once,
   * when it arrives, and then sits still while the ones under it come and go.
   */
  const inStyles = useRef(new Map<string, CSSProperties>());
  const inStyle = (id: string): CSSProperties => {
    const had = inStyles.current.get(id);
    if (had) return had;
    const made = effectStyle(anim, animMs);
    inStyles.current.set(id, made);
    return made;
  };

  // When each line first appeared ON THIS CANVAS. The hold is a dwell, not an age: a comment
  // carries the time it was POSTED, and it reaches the overlay later than that — a YouTube line
  // by however long the poll took, the whole backlog by minutes when the layer is switched on
  // mid-room. Measured off `at`, those lines were already past the cutoff on the first sweep
  // after they rendered, so a 5s hold showed them for a frame and took them away again.
  const shownRef = useRef(new Map<string, number>());

  const setList = (next: ChatMessage[]) => {
    const was = shownRef.current;
    const now = Date.now();
    const seen = new Map<string, number>();
    for (const m of next) seen.set(m.id, was.get(m.id) ?? now);
    shownRef.current = seen;
    // Drop the arrival style of anything no longer on the canvas. A show is thousands of lines
    // and this map would otherwise be one entry per line for the whole of it. A line still
    // playing its EXIT is not in `next` and does not need it — it is wearing the out style.
    for (const id of [...inStyles.current.keys()]) if (!seen.has(id)) inStyles.current.delete(id);
    itemsRef.current = next;
    setItems(next);
  };
  const colRef = useRef<HTMLDivElement>(null);

  // The switch is in the StudioCall tab, so this layer can be parked in the Overlay tab
  // and still show nothing until the operator puts the chat on air.
  useEffect(() => {
    fetch(`${API}/api/studiocall/controls`)
      .then(r => r.json())
      .then(d => {
        setOn(!!d?.chatOverlay);
        setMode(d?.chatMode === 'selected' ? 'selected' : 'all');
        setPin(d?.chatPin ?? null);
        applyAnim(d);
      })
      .catch(() => {});
  }, []);

  useDisplayWsMessage<ControlsMsg>('studiocall-controls', msg => {
    setOn(!!msg.chatOverlay);
    setMode(msg.chatMode === 'selected' ? 'selected' : 'all');
    setPin(msg.chatPin ?? null);
    applyAnim(msg);
  });

  function applyAnim(d: Partial<ControlsMsg> | null | undefined) {
    if (d?.chatAnim) setAnim(d.chatAnim);
    if (d?.chatAnimOut) setAnimOut(d.chatAnimOut);
    if (typeof d?.chatAnimMs === 'number') setAnimMs(d.chatAnimMs);
    if (typeof d?.chatFadeOutMs === 'number') setFadeOutMs(d.chatFadeOutMs);
  }

  // A held line arrives and leaves the same way a rolling one does — the operator picked ONE
  // effect for this layer, and a comment held up is the one the audience actually reads. The
  // exit is played by keeping the released line for its own duration; a line REPLACED by the
  // next pick is simply swapped, because two cards on the canvas is not a transition.
  const prevPin = useRef<ChatMessage | null>(null);
  useEffect(() => {
    const prev = prevPin.current;
    prevPin.current = pin;
    if (pin) { setPinOut(null); return; }
    if (!prev) return;
    const { animOut: a, fadeOutMs: outMs } = outRef.current;
    if (a === 'none' || outMs <= 0) return;
    setPinOut(prev);
    const t = setTimeout(() => setPinOut(p => (p?.id === prev.id ? null : p)), outMs);
    return () => clearTimeout(t);
  }, [pin]);

  // Hydrate the backlog once the chat goes on air: the pump broadcasts only what is new,
  // so a layer that switched on mid-room would otherwise sit empty until someone typed.
  // Only `all` needs it — a held line arrives whole on the controls message.
  useEffect(() => {
    if (!on || mode !== 'all') { setList([]); return; }
    let dead = false;
    fetch(`${API}/api/studiocall/room/chat`)
      .then(r => r.json())
      .then(d => { if (!dead) setList(((d?.messages ?? []) as ChatMessage[]).filter(rollsOnAir).slice(-MAX_LINES)); })
      .catch(() => {});
    return () => { dead = true; };
  }, [on, mode]);

  // A line leaves the same way whichever reason retires it — pushed off the top, or its
  // dwell running out. `none` is an exit too: the line is simply gone, which is what the
  // rolling list did for years and still the right answer for a fast chat.
  const retire = (gone: ChatMessage[]) => {
    const { animOut: a, fadeOutMs: outMs } = outRef.current;
    if (!gone.length || a === 'none' || outMs <= 0) return;
    const ids = new Set(gone.map(m => m.id));
    setLeaving(l => [...l, ...gone]);
    setTimeout(() => setLeaving(l => l.filter(m => !ids.has(m.id))), outMs);
  };

  // One timer for the whole list rather than one per line: a chat is a queue, so the
  // oldest is always the next to go and a single sweep at 250 ms is enough to look instant.
  useEffect(() => {
    const t = setInterval(() => {
      const dwell = dwellRef.current;
      if (!dwell) return;
      const cutoff = Date.now() - dwell * 1000;
      // EVERY line goes when its hold runs out, the newest included — a comment is shown for the
      // time the operator set and then leaves, so a room that goes quiet ends with an empty
      // column rather than one last line parked on the canvas for the rest of the show.
      const all = itemsRef.current;
      const seen = shownRef.current;
      const shownAt = (m: ChatMessage) => seen.get(m.id) ?? m.at;
      const live = all.filter(m => shownAt(m) > cutoff);
      if (live.length === all.length) return;
      retire(all.filter(m => shownAt(m) <= cutoff));
      setList(live);
    }, 250);
    return () => clearInterval(t);
  }, []);

  useDisplayWsMessage<ChatMsg>('studiocall-chat', msg => {
    // A null channel is the room being left. The pump only ever speaks when it has new
    // messages, so without this the last room's lines stay on the canvas for as long as
    // the layer is on — on air, in front of the audience, after the room is gone.
    if (!msg.channel) { setList([]); setLeaving([]); return; }
    const fresh = (Array.isArray(msg.items) ? msg.items : []).filter(rollsOnAir);
    if (!fresh.length) return;
    const known = new Set(itemsRef.current.map(m => m.id));
    const merged = [...itemsRef.current, ...fresh.filter(m => !known.has(m.id))];
    const overflow = merged.length - MAX_LINES;
    // The lines pushed off the top only survive if the method animates them out; the
    // others are gone the moment they overflow, which is what the list always did.
    if (overflow > 0) retire(merged.slice(0, overflow));
    setList(overflow > 0 ? merged.slice(overflow) : merged);
  });

  // The box, not MAX_LINES, is what really bounds the column: lines are whatever length the
  // writer made them, and a column of long ones spills out of the top of the layer box, where
  // the clip leaves only the tail of the newest on the canvas. So after every layout the lines
  // that no longer fit are retired off the top with the OUT effect, and the newest — the one
  // playing its IN effect — always sits whole on the floor. It alone is kept even when it is
  // taller than the box.
  useLayoutEffect(() => {
    const col = colRef.current;
    const live = itemsRef.current;
    if (!col || mode !== 'all' || !live.length) return;
    const gapPx = parseFloat(getComputedStyle(col).rowGap) || 0;
    const max = col.clientHeight;
    let used = 0;
    let keep = live.length;
    for (let i = live.length - 1; i >= 0; i--) {
      const el = col.querySelector<HTMLElement>(`[data-line="${CSS.escape(live[i]!.id)}"]`);
      const need = (el?.offsetHeight ?? 0) + (used ? gapPx : 0);
      if (used + need > max) { keep = live.length - 1 - i; break; }
      used += need;
    }
    keep = Math.max(1, keep);
    if (keep >= live.length) return;
    retire(live.slice(0, live.length - keep));
    setList(live.slice(-keep));
  });

  // One held line, or the rolling list. `selected` with nothing held draws nothing — the
  // operator has said "this one" and has not picked it yet, unless the one just released is
  // still playing its exit. Both modes wear the same two effects: the released line keeps the
  // key of the line it was, so the SAME element swaps its arrival for its exit and plays it
  // where it stands instead of being unmounted mid-air.
  const shown = mode === 'selected' ? (pin ? [pin] : []) : items;
  const outStyle = (ms: number) => effectStyle(animOut === 'none' ? undefined : animOut, ms);
  const rows = mode === 'selected'
    ? pin
      ? [{ m: pin, style: effectStyle(anim, animMs) }]
      : pinOut ? [{ m: pinOut, style: outStyle(fadeOutMs) }] : []
    : [
        ...leaving.map(m => ({ m, style: outStyle(fadeOutMs) })),
        ...shown.map(m => ({ m, style: inStyle(m.id) })),
      ];
  if (!on || !rows.length) return null;

  const accent = color ?? '#38bdf8';
  const font = bodyFontFamily ?? fontFamily ?? "'Segoe UI', system-ui, sans-serif";
  const size = bodySize ?? Math.max(14, Math.round((rect?.height ?? 660) * 0.032));
  // The avatar is sized off the TEXT, not the layer box — a chat line is a face beside a
  // sentence, and the two have to stay in proportion when the font is changed. 190% is the
  // natural pairing. Ring and roundness are shares of the avatar itself.
  const avatar = Math.round(size * ((photoScale ?? 190) / 100));
  const ring = Math.max(0, Math.round(avatar * ((photoBorder ?? 4.3) / 100)));
  const corner = `${photoRadius ?? 50}%`;

  return (
    <div ref={colRef} style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      gap: Math.round(size * 0.5),
      pointerEvents: 'none', fontFamily: font, opacity: opacity ?? 1,
    }}>
      {rows.map(({ m, style }) => (
        <AvatarGate key={m.id} src={m.avatar ? (m.avatar.startsWith('http') ? m.avatar : `${API}${m.avatar}`) : null}>{(src) => (
        <div data-line={m.id} style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0, gap: Math.round(size * 0.6), ...style }}>
          {src
            ? <img src={src} alt="" style={{
                width: avatar, height: avatar, borderRadius: corner, objectFit: 'cover', flexShrink: 0,
                border: ring ? `${ring}px solid ${m.isSpeaker ? accent : 'rgba(255,255,255,0.25)'}` : 'none',
              }} />
            : <div style={{
                width: avatar, height: avatar, borderRadius: corner, flexShrink: 0,
                background: '#1e293b', color: '#94a3b8', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: Math.round(size * 0.9), fontWeight: 700,
              }}>{(m.author || '?').slice(0, 1).toUpperCase()}</div>}
          <div style={{
            minWidth: 0,
            background: 'rgba(10, 12, 18, 0.82)',
            border: `1px solid ${m.isSpeaker ? `${accent}55` : 'rgba(255,255,255,0.12)'}`,
            borderRadius: Math.round(size * 0.9),
            padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.7)}px`,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: Math.round(size * 0.3),
              fontSize: Math.round(size * 0.78), fontWeight: 700, lineHeight: 1.2,
              color: m.isModerator ? accent : 'rgba(255,255,255,0.62)',
            }}>
              <span style={{
                flexShrink: 0, borderRadius: 999, color: '#fff',
                background: PLATFORM[m.source ?? 'clubhouse'].bg,
                fontSize: Math.round(size * 0.5), fontWeight: 800,
                letterSpacing: '0.06em', textTransform: 'uppercase',
                padding: `${Math.round(size * 0.1)}px ${Math.round(size * 0.32)}px`,
              }}>
                {PLATFORM[m.source ?? 'clubhouse'].label}
              </span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.isModerator ? '★ ' : ''}{m.author}
              </span>
            </div>
            <div style={{ fontSize: size, color: '#fff', lineHeight: 1.3, wordBreak: 'break-word' }}>
              {m.text}
            </div>
          </div>
        </div>
        )}</AvatarGate>
      ))}
    </div>
  );
}

// A line is not on the canvas until its face is. The avatar is fetched off the local cache
// at the moment the line is drawn, so for a beat every new line was a ring around nothing —
// on air, in front of the audience. The picture is loaded first, and the line is mounted
// (and plays its arrival) only once it can be drawn whole. A face that will not load falls
// back to the initial rather than holding the line up forever.
function AvatarGate({ src, children }: { src: string | null; children: (src: string | null) => ReactNode }) {
  const [ready, setReady] = useState<string | null | undefined>(src ? undefined : null);
  useEffect(() => {
    if (!src) { setReady(null); return; }
    let dead = false;
    const img = new Image();
    img.onload = () => { if (!dead) setReady(src); };
    img.onerror = () => { if (!dead) setReady(null); };
    img.src = src;
    return () => { dead = true; };
  }, [src]);
  if (ready === undefined) return null;
  return <>{children(ready)}</>;
}
