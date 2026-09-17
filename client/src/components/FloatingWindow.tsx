import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getUiSetting, setUiSetting } from '../lib/uiSettings';
import { topZIndex } from '../lib/zIndex';

/**
 * A draggable, resizable, position-remembering panel.
 *
 * The alternative — a viewport-anchored overlay — cannot work in a mosaic workspace,
 * because the panel it must not cover is wherever the operator put it. Anchoring left
 * or right is a guess about someone else's layout, and it is wrong half the time
 * (a window anchored right once landed directly on top of another panel).
 * A window the operator places once, and which stays placed, has no such assumption.
 *
 * There is deliberately NO backdrop and no full-screen shell: everything behind stays
 * both visible and clickable, which is the whole point for a panel you read against a
 * live preview.
 *
 * FREEZE (the padlock) is part of that bargain. A window placed against a preview is
 * placed deliberately, and every gesture inside it — scrubbing a cue, dragging a slider,
 * grabbing a word — starts on a surface a few pixels from the title bar or an edge. One
 * miss moves the window instead, and the layout that was tuned to the picture behind it
 * is gone. Locked, the panel takes no move or resize at all: the handles are not rendered
 * and the title bar is inert, so a near-miss does nothing rather than something.
 */

export interface Rect { x: number; y: number; w: number; h: number }

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type Drag =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; edge: Edge; from: Rect; x0: number; y0: number }
  | null;

/** Enough of the window must stay on screen to grab it again. */
const KEEP_VISIBLE = 80;

const clampToViewport = (r: Rect, minW: number, minH: number): Rect => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(minW, Math.min(r.w, vw));
  const h = Math.max(minH, Math.min(r.h, vh));
  // The BOTTOM has to stay on screen, not just the title bar. Height and position were clamped
  // independently, so a window sized on a taller viewport — or on a screen that has since gained a
  // taskbar — kept its height, kept its y, and hung its footer off the bottom edge: the wizard's
  // Back/Next row, and the south resize handle that would have fixed it, were both unreachable.
  // Pulled up rather than shrunk, so a window the operator sized stays the size they chose.
  const y = Math.max(0, Math.min(r.y, vh - h, vh - 32));
  return {
    w, h, y,
    x: Math.max(KEEP_VISIBLE - w, Math.min(r.x, vw - KEEP_VISIBLE)),
  };
};

function readRect(key: string, fallback: Rect, minW: number, minH: number): Rect {
  try {
    const raw = getUiSetting(key);
    if (!raw) return clampToViewport(fallback, minW, minH);
    const p = JSON.parse(raw) as Partial<Rect>;
    if (![p.x, p.y, p.w, p.h].every(n => typeof n === 'number' && Number.isFinite(n))) {
      return clampToViewport(fallback, minW, minH);
    }
    return clampToViewport(p as Rect, minW, minH);
  } catch {
    return clampToViewport(fallback, minW, minH);
  }
}

/** Handles are children of the window, so they scale with it and need no maths. */
const HANDLES: { edge: Edge; className: string }[] = [
  { edge: 'n', className: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
];

export function FloatingWindow({
  storageKey, defaultRect, minW = 320, minH = 200, hidden = false, title, actions, onClose, children,
}: {
  /** uiSettings key the position and size are remembered under. */
  storageKey: string;
  defaultRect: Rect;
  minW?: number;
  minH?: number;
  /**
   * Take it off screen without closing it. Portalled to `document.body`, a window escapes
   * the CSS class that hides an inactive tab, so its owner has to say when it does not
   * apply. Kept MOUNTED — scroll position and a half-typed correction survive the trip to
   * another tab and back, which unmounting would throw away.
   */
  hidden?: boolean;
  /** Left-hand side of the title bar — the drag surface. */
  title: React.ReactNode;
  /** Right-hand side of the title bar. Controls here never start a drag. */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [z] = useState(() => topZIndex(10));
  const [rect, setRect] = useState<Rect>(() => readRect(storageKey, defaultRect, minW, minH));
  const [frozen, setFrozen] = useState(() => getUiSetting(`${storageKey}:frozen`) === '1');
  const drag = useRef<Drag>(null);

  const freeze = (v: boolean) => { setFrozen(v); setUiSetting(`${storageKey}:frozen`, v ? '1' : '0'); };

  // Written on release rather than per pointermove: a settings write per frame would
  // queue hundreds of PATCHes across one drag.
  const persist = useCallback((r: Rect) => setUiSetting(storageKey, JSON.stringify(r)), [storageKey]);

  useEffect(() => {
    const onResize = () => setRect(r => clampToViewport(r, minW, minH));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [minW, minH]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setRect(prev => {
        if (d.kind === 'move') {
          return clampToViewport({ ...prev, x: e.clientX - d.dx, y: e.clientY - d.dy }, minW, minH);
        }
        const { edge, from, x0, y0 } = d;
        const ddx = e.clientX - x0;
        const ddy = e.clientY - y0;
        let { x, y, w, h } = from;
        // A west/north drag moves the origin as well as the size, and the min-size clamp
        // has to hold the far edge still — otherwise the window walks away from the cursor.
        if (edge.includes('e')) w = Math.max(minW, from.w + ddx);
        if (edge.includes('s')) h = Math.max(minH, from.h + ddy);
        if (edge.includes('w')) { w = Math.max(minW, from.w - ddx); x = from.x + from.w - w; }
        if (edge.includes('n')) { h = Math.max(minH, from.h - ddy); y = from.y + from.h - h; }
        return clampToViewport({ x, y, w, h }, minW, minH);
      });
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      setRect(r => { persist(r); return r; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [minW, minH, persist]);

  const startMove = (e: React.PointerEvent) => {
    // A control in the title bar is a control, not a grip.
    if (frozen || (e.target as HTMLElement).closest('button, input, select, textarea, [data-nodrag]')) return;
    e.preventDefault();
    drag.current = { kind: 'move', dx: e.clientX - rect.x, dy: e.clientY - rect.y };
  };

  const startResize = (edge: Edge) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { kind: 'resize', edge, from: { ...rect }, x0: e.clientX, y0: e.clientY };
  };

  return createPortal(
    <div
      className={`fixed flex-col rounded-lg border border-slate-700 bg-[#0d1117] shadow-2xl overflow-hidden
        ${hidden ? 'hidden' : 'flex'}`}
      style={{ zIndex: z, left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div
        onPointerDown={startMove}
        onDoubleClick={() => {
          if (frozen) return;
          const next = clampToViewport(defaultRect, minW, minH);
          setRect(next);
          persist(next);
        }}
        title={frozen ? 'Frozen in place — unlock to move it' : 'Drag to move · double-click to reset the position'}
        className={`shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800 select-none
          ${frozen ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
      >
        <div className="flex items-center gap-2 min-w-0">{title}</div>
        <div className="flex items-center gap-1.5 shrink-0">
          {actions}
          <button
            type="button" onClick={() => freeze(!frozen)}
            title={frozen ? 'Frozen — click to allow moving and resizing again' : 'Freeze this panel where it is'}
            className={`px-1.5 rounded hover:bg-slate-700/60 ${frozen ? 'text-amber-400' : 'text-slate-500 hover:text-slate-200'}`}
          >
            {frozen ? '🔒' : '🔓'}
          </button>
          <button type="button" onClick={onClose} title="Close"
            className="px-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-700/60">✕</button>
        </div>
      </div>

      <div className="flex-1 min-h-0">{children}</div>

      {!frozen && HANDLES.map(h => (
        <div key={h.edge} onPointerDown={startResize(h.edge)} className={`absolute ${h.className}`} />
      ))}
    </div>,
    document.body,
  );
}
