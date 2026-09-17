import { useEffect, useRef } from 'react';
import { ws, type WsBroadcast } from '../ws';

// The card preview listens to the same broadcasts StudioMate's OBS page does, over this app's
// one socket.
export type DisplayMessage = WsBroadcast;

export function useDisplayWsMessage<T extends DisplayMessage>(type: string, onMessage: (msg: T) => void) {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => ws.onBroadcast(msg => {
    if (msg.type === type) ref.current(msg as T);
  }), [type]);
}
