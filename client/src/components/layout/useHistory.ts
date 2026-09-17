import { useCallback, useRef, useState } from 'react';

/**
 * Undo / redo for a designer's working value. The caller owns the value; this keeps the last
 * `limit` states banked before a change and the ones undone off the top.
 *
 * A drag commits ONCE, on mouse-up — the ~10/s frames of one gesture are one change. `coalesce`
 * folds a burst into the state it started from: typing "1920" into X fires onChange per
 * keystroke, and four of the ten slots must not go to one number.
 */
export function useHistory<T>(limit = 10) {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);
  const lastRef = useRef(0);

  const commit = useCallback((before: T | null | undefined, coalesce = false) => {
    if (before == null) return;
    const merge = coalesce && Date.now() - lastRef.current < 700;
    lastRef.current = Date.now();
    setPast(p => (merge && p.length ? p : [...p, before].slice(-limit)));
    setFuture([]);
  }, [limit]);

  /** Step back. Hands over the state to adopt, or null when there is none. */
  const undo = useCallback((current: T): T | null => {
    const prev = past[past.length - 1];
    if (prev === undefined) return null;
    setPast(past.slice(0, -1));
    setFuture([current, ...future].slice(0, limit));
    return prev;
  }, [past, future, limit]);

  const redo = useCallback((current: T): T | null => {
    const [next, ...rest] = future;
    if (next === undefined) return null;
    setFuture(rest);
    setPast([...past, current].slice(-limit));
    return next;
  }, [past, future, limit]);

  const reset = useCallback(() => { setPast([]); setFuture([]); }, []);

  return { commit, undo, redo, reset, canUndo: past.length > 0, canRedo: future.length > 0, depth: past.length };
}
