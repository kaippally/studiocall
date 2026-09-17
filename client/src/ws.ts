// The one socket to the StudioCall server. Every server broadcast is a `{ type, ... }` message;
// the socket reconnects on its own and reports its connection state after a short debounce.
export type WsBroadcast = Record<string, unknown> & { type: string };

export class WsClient {
  private ws: WebSocket | null = null;
  private broadcastListeners = new Set<(msg: WsBroadcast) => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private attempt = 0;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {}

  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  private notifyConnection(connected: boolean) {
    if (connected) {
      if (this.offlineTimer) { clearTimeout(this.offlineTimer); this.offlineTimer = null; }
      for (const fn of this.connectionListeners) fn(true);
    } else if (!this.offlineTimer) {
      // Only declare offline after 10 s of failed reconnects — silences transient blips.
      this.offlineTimer = setTimeout(() => {
        this.offlineTimer = null;
        for (const fn of this.connectionListeners) fn(false);
      }, 10_000);
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => { this.attempt = 0; this.notifyConnection(true); };
    this.ws.onmessage = (e) => {
      let msg: WsBroadcast;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.type === 'string') for (const l of this.broadcastListeners) l(msg);
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.notifyConnection(false);
      const delay = Math.min(500 * 2 ** this.attempt, 8000);
      this.attempt++;
      setTimeout(() => this.connect(), delay);
    };
  }

  onBroadcast(fn: (msg: WsBroadcast) => void): () => void {
    this.broadcastListeners.add(fn);
    return () => this.broadcastListeners.delete(fn);
  }
}

export const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/studiocall/ws`;

export const ws = new WsClient(WS_URL);
