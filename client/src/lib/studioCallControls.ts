import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from './api';
import { ws } from '../ws';

/**
 * One numeric StudioCall control. Read once, followed on the broadcast, written when the field
 * is left — the server clamps, and its answer is what the field then shows.
 */
export function useControlNumber(key: 'unmuteDropCount' | 'autoKickMinutes'): [number, (v: number) => void, () => void] {
  const [n, setN] = useState(0);
  const editing = useRef(false);
  useEffect(() => {
    fetch(`${API}/api/studiocall/controls`).then(r => r.json()).then(d => setN(Number(d?.[key]) || 0)).catch(() => {});
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-controls' && !editing.current) setN(Number((msg as Record<string, unknown>)[key]) || 0);
    });
  }, [key]);
  const edit = useCallback((v: number) => { editing.current = true; setN(v); }, []);
  const save = useCallback(() => {
    editing.current = false;
    setN(v => {
      fetch(`${API}/api/studiocall/controls`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: v }),
      }).then(r => r.json()).then(d => setN(Number(d?.[key]) || v)).catch(() => {});
      return v;
    });
  }, [key]);
  return [n, edit, save];
}
