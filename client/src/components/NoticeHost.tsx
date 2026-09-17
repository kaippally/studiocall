import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { topZIndex } from '../lib/zIndex';
import { hasOpenSurface } from '../lib/escapeStack';
import { dismissNotice, getNotices, subscribeNotices, type Notice, type NoticeLevel } from '../lib/notices';
import {
  CHAT_TOAST_HOLD_MS, dismissChatToast, getChatToastState, setChatToastsMuted,
  subscribeChatToasts, type ChatToast,
} from '../lib/chatToasts';
import { getUiSetting, onUiSettingsLoaded, setUiSetting } from '../lib/uiSettings';

/**
 * The one place a notice is drawn — mounted once by App, fed by notify() from anywhere.
 *
 * A corner card, not a bar across the top of a tab: an error here is almost always transient
 * and already over ("the room closed", "the browser blocked the pop-out"), so it should be
 * readable and then gone, not a permanent stripe pushing the tab down. Portalled and
 * topZIndex()d because a tab lives inside a Mosaic tile that clips its overflow.
 *
 * It draws TWO lanes in the one corner: notices on the floor, and above them the chat lane
 * (lib/chatToasts.ts) — a line said in the room or in the YouTube chat, arriving wherever the
 * operator happens to be. Two queues rather than one, because a busy chat would otherwise push
 * every error off the stack in a second.
 *
 * **The stack slides sideways.** The corner it lived in is the corner OBS captures on some
 * rigs, and it is also where half the app's own controls sit; the grab pill under the stack
 * moves the whole column left and right and the offset is remembered in uiSettings, so it is
 * placed once against whatever layout the operator is running. Horizontal only — the floor is
 * where a transient message belongs, and a stack that can be dragged up is a stack that can be
 * dragged off screen.
 */
const SKIN: Record<NoticeLevel, string> = {
  error: 'border-rose-900/70 bg-rose-950/90 text-rose-200',
  warn:  'border-amber-900/70 bg-amber-950/90 text-amber-200',
  info:  'border-slate-700 bg-slate-900/95 text-slate-300',
};

// Named and coloured the way the Chat tab and the OBS chat layer name and colour them, so the
// three surfaces reading the same two feeds agree.
const FEED: Record<ChatToast['feed'], { label: string; skin: string }> = {
  youtube:   { label: 'YouTube', skin: 'bg-red-600/25 text-red-300' },
  clubhouse: { label: 'Room',    skin: 'bg-violet-500/20 text-violet-300' },
};

// Long enough to read a sentence twice, short enough that a burst does not stack up.
const HOLD_MS = 7000;

/** Distance from the right edge, px. The default is the corner it has always sat in. */
const OFFSET_KEY = 'notices:right';
const DEFAULT_RIGHT = 16;

const clampRight = (v: number) => Math.max(8, Math.min(v, Math.max(8, window.innerWidth - 220)));

export function NoticeHost() {
  const notices = useSyncExternalStore(subscribeNotices, getNotices);
  const { items: chats, muted } = useSyncExternalStore(subscribeChatToasts, getChatToastState);
  const newest = notices[notices.length - 1];

  const [right, setRight] = useState(DEFAULT_RIGHT);
  useEffect(() => onUiSettingsLoaded(() => {
    const v = Number(getUiSetting(OFFSET_KEY));
    if (Number.isFinite(v) && v > 0) setRight(clampRight(v));
  }), []);

  const drag = useRef<{ x: number; right: number } | null>(null);
  const onDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, right };
  }, [right]);
  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (d) setRight(clampRight(d.right - (e.clientX - d.x)));
  }, []);
  const onUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setUiSetting(OFFSET_KEY, String(right));
  }, [right]);

  // Esc dismisses, Enter runs the newest notice's action — but only when nothing else is
  // open. A dialog outranks a toast, and a keystroke aimed at a text field is never ours.
  // With no notice up, Esc clears the chat lane instead: same key, same meaning.
  const top = useRef<Notice | undefined>(newest);
  top.current = newest;
  const chatTop = useRef<ChatToast | undefined>(chats[chats.length - 1]);
  chatTop.current = chats[chats.length - 1];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      const n = top.current;
      const c = chatTop.current;
      if ((!n && !c) || hasOpenSurface()) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!n) {
        if (e.key !== 'Escape' || !c) return;
        e.preventDefault();
        dismissChatToast(c.id);
        return;
      }
      e.preventDefault();
      if (e.key === 'Enter') n.onAccept?.();
      dismissNotice(n.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!notices.length && !chats.length && !muted) return null;

  return createPortal(
    <div className="fixed bottom-4 flex flex-col items-end gap-2" style={{ zIndex: topZIndex(), right }}>
      {chats.map(t => <ChatCard key={t.id} toast={t} />)}
      {notices.map(n => <NoticeCard key={n.id} notice={n} />)}
      {/* Last in the column so it sits on the floor: the one thing in the stack that does not
          move as cards come and go, which is what makes it grabbable mid-show. */}
      <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/90 px-1 py-0.5 text-[10px] shadow backdrop-blur-sm">
        <span
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          title="Drag sideways to move the stack"
          className="cursor-ew-resize select-none px-1.5 leading-none tracking-[0.2em] text-slate-500 hover:text-slate-300"
        >
          ⣿
        </span>
        <button
          type="button"
          onClick={() => setChatToastsMuted(!muted)}
          title={muted ? 'Chat lines are being dropped — click to let them through' : 'Stop chat lines popping up here'}
          className={`rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ${
            muted ? 'bg-amber-950/70 text-amber-300 hover:bg-amber-900/60' : 'text-slate-500 hover:bg-white/10 hover:text-slate-300'
          }`}
        >
          {muted ? 'Chat muted' : 'Mute chat'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

function NoticeCard({ notice }: { notice: Notice }) {
  useEffect(() => {
    const t = setTimeout(() => dismissNotice(notice.id), HOLD_MS);
    return () => clearTimeout(t);
  }, [notice.id]);

  return (
    <div
      role="status"
      className={`max-w-sm rounded-lg border px-3 py-2 text-xs leading-snug shadow-lg backdrop-blur-sm ${SKIN[notice.level]}`}
    >
      <div>{notice.message}</div>
      <div className="mt-1.5 flex items-center gap-2">
        {notice.onAccept && (
          <button type="button" onClick={() => { notice.onAccept?.(); dismissNotice(notice.id); }}
            className="rounded bg-white/10 px-2 py-0.5 font-semibold hover:bg-white/20">
            {notice.acceptLabel ?? 'OK'} <span className="opacity-60">↵</span>
          </button>
        )}
        <button type="button" onClick={() => dismissNotice(notice.id)}
          className="rounded px-2 py-0.5 opacity-70 hover:bg-white/10 hover:opacity-100">
          Dismiss <span className="opacity-60">esc</span>
        </button>
      </div>
    </div>
  );
}

/** A chat line, read the way the Chat tab draws one: face, who, what they said. */
function ChatCard({ toast }: { toast: ChatToast }) {
  useEffect(() => {
    const t = setTimeout(() => dismissChatToast(toast.id), CHAT_TOAST_HOLD_MS);
    return () => clearTimeout(t);
  }, [toast.id]);

  const feed = FEED[toast.feed];
  return (
    <div
      role="status"
      onClick={() => dismissChatToast(toast.id)}
      title="Click to dismiss"
      className="flex max-w-sm cursor-pointer items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm hover:border-slate-600"
    >
      {toast.avatar
        ? <img src={toast.avatar} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded-full object-cover" />
        : <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-slate-700" />}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wider ${feed.skin}`}>
            {feed.label}
          </span>
          <span className="truncate font-semibold text-slate-300">{toast.author}</span>
          {toast.badge && (
            <span className="shrink-0 rounded bg-slate-700/50 px-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
              {toast.badge}
            </span>
          )}
        </div>
        <div className="mt-0.5 break-words leading-snug text-slate-200">{toast.text}</div>
      </div>
    </div>
  );
}
