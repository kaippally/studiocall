// H2 session readiness gate.
// spdy's SETTINGS handshake isn't complete until after the first
// round-trip response. main.tsx calls markH2Ready() after the warmup fetch.
// Call `await h2Ready` inside a useEffect before `new EventSource(...)`.

let _resolve: () => void;
export const h2Ready: Promise<void> = new Promise(r => { _resolve = r; });
export function markH2Ready() { _resolve?.(); }
