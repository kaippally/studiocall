import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { topZIndex } from '../lib/zIndex';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { useEscapeKey } from '../lib/escapeStack';

/**
 * An emoji for the chat composers, picked from a grid rather than typed.
 *
 * The OS picker (Win+.) works, but it is another window on a second monitor mid-show and it
 * does not know which ones this desk actually uses. A short bundled list — no library, no
 * network — with the last-used row on top covers what a live chat reply needs.
 * Portalled with `topZIndex()` and closed by Esc and an outside click, like every pop-up.
 */

const GROUPS: { name: string; list: string }[] = [
  { name: 'Faces', list: '😀😂🤣😊😍🥰😎🤔🙄😴🥳🤯😢😭😡🤬🤫🤗😇🙃😏😬🤡💀👻' },
  { name: 'Hands', list: '👍👎👏🙏🙌👋🤝✌️🤞🤘👌🤌☝️👆👇💪🫡🤷🤦' },
  { name: 'Hearts & marks', list: '❤️🧡💛💚💙💜🖤🤍💔💯✅❌⚠️❓❗🔥⭐✨💡🎯🏆🎉🎁' },
  { name: 'Things', list: '🎤🎧🎬📺📻📢🔔🔇🔊🎵🎶📌📎🔗📖📝✏️💬🗣️👀🧠⏱️🕒📅' },
  { name: 'Symbols', list: '➡️⬅️⬆️⬇️🔁▶️⏸️⏹️🆕🆗🆓🔞🚫🛑♻️➕➖✔️🟢🟡🔴🔵⚪⚫' },
];

const RECENT_KEY = 'chat:recentEmoji';
const RECENT_KEEP = 16;

function splitEmoji(list: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(list), s => s.segment).filter(s => s.trim());
}

function readRecent(): string[] {
  try {
    const raw: unknown = JSON.parse(getUiSetting(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(0, RECENT_KEEP) : [];
  } catch { return []; }
}

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const z = useRef(0);
  useEscapeKey(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    z.current = topZIndex();
    const W = 300;
    const H = 260;
    // Above the composer when it sits at the bottom of a window, below it otherwise.
    const top = r.top - H - 6 >= 8 ? r.top - H - 6 : Math.min(r.bottom + 6, window.innerHeight - H - 8);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), top });
    setRecent(readRecent());
    setOpen(true);
  };

  const pick = (e: string) => {
    const next = [e, ...recent.filter(x => x !== e)].slice(0, RECENT_KEEP);
    setRecent(next);
    setUiSetting(RECENT_KEY, JSON.stringify(next));
    onPick(e);
  };

  const cell = 'flex h-7 w-7 items-center justify-center rounded text-base leading-none hover:bg-slate-700';

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        disabled={disabled}
        title="Insert an emoji"
        aria-label="Emoji"
        className={`shrink-0 rounded border px-1.5 text-sm leading-none transition disabled:opacity-30 ${
          open ? 'border-slate-500 bg-slate-700 text-white' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500'
        }`}
      >
        🙂
      </button>
      {open && pos && createPortal(
        <div
          ref={panel}
          style={{ zIndex: z.current, left: pos.left, top: pos.top }}
          className="fixed flex h-[260px] w-[300px] flex-col overflow-y-auto rounded-lg border border-slate-700 bg-[#0d1117] p-2 shadow-2xl"
        >
          {recent.length > 0 && (
            <div className="mb-1">
              <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Recent</div>
              <div className="flex flex-wrap">{recent.map(e => <button key={e} type="button" onClick={() => pick(e)} className={cell}>{e}</button>)}</div>
            </div>
          )}
          {GROUPS.map(g => (
            <div key={g.name} className="mb-1">
              <div className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">{g.name}</div>
              <div className="flex flex-wrap">{splitEmoji(g.list).map(e => <button key={e} type="button" onClick={() => pick(e)} className={cell}>{e}</button>)}</div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
