import { useEffect, useRef, useState } from 'react';
import type { DragHandle } from './snap';

/**
 * The two modifiers every framing gesture answers to, read once here so no canvas invents its own.
 *, "The handle contract".
 *
 *   `uniform` (Ctrl / Cmd) — a corner scales on both axes at once, an edge takes the same bite
 *   out of the opposite one.
 *   `pan` (Shift) — a body drag moves the PICTURE inside its crop instead of moving the frame.
 */
export interface DragMods { uniform: boolean; pan: boolean }

/**
 * The one drag gesture every layout canvas makes: mouse down on a body or a handle, deltas
 * while it moves, one settle on mouse-up. Deltas arrive in CANVAS pixels — the screen distance
 * divided by `cpx` — so the model behind the canvas never sees a CSS pixel.
 *
 * `S` is whatever the caller snapshots at mouse-down (the box, the transform) and gets handed
 * back on every frame, so a gesture is always computed from where it STARTED, never from the
 * last frame — that is what keeps a snap from accumulating.
 *
 * The callbacks are read through refs, so the listeners are bound once per gesture and still
 * see the latest rules and scale.
 */
export function useBoxDrag<S>(opts: {
  cpx: number;
  onMove: (handle: DragHandle, dx: number, dy: number, mods: DragMods, start: S) => void;
  onEnd: (start: S, moved: boolean) => void;
}) {
  const optsRef = useRef(opts); optsRef.current = opts;
  const gesture = useRef<{ handle: DragHandle; sx: number; sy: number; start: S; moved: boolean } | null>(null);
  const [active, setActive] = useState<DragHandle | null>(null);

  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      const g = gesture.current;
      if (!g) return;
      g.moved = true;
      const cpx = Math.max(1e-6, optsRef.current.cpx);
      optsRef.current.onMove(g.handle, (e.clientX - g.sx) / cpx, (e.clientY - g.sy) / cpx,
        { uniform: e.ctrlKey || e.metaKey, pan: e.shiftKey }, g.start);
    };
    const onUp = () => {
      const g = gesture.current;
      gesture.current = null;
      setActive(null);
      if (g) optsRef.current.onEnd(g.start, g.moved);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [active]);

  const begin = (e: React.MouseEvent, handle: DragHandle, start: S) => {
    e.preventDefault(); e.stopPropagation();
    gesture.current = { handle, sx: e.clientX, sy: e.clientY, start, moved: false };
    setActive(handle);
  };

  /** Is a gesture in flight right now — readable from any callback without a re-render. */
  const inFlight = () => gesture.current !== null;

  return { begin, active, inFlight };
}
