import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from './logger.js';

/**
 * One socket path, two kinds of client.
 *
 * - **A StudioCall window** (the app, a pop-out, an embedded panel) — an admin client. The chat
 *   pump runs only while somebody is reading, and the room is walked out of when the last one is
 *   gone (onAdminIdle).
 * - **StudioMate** (`?role=studiomate`) — the relay. It re-broadcasts every `studiocall-*` event
 *   to its own overlays and panels, and pushes the StudioMate facts this server cannot read
 *   itself: how many StudioMate admin windows are open, the YouTube chat, the pop-out's title.
 */
export const WS_PATH = '/api/studiocall/ws';

type Relayed = { type: string; [k: string]: unknown };

let wss: WebSocketServer | null = null;
const relays = new Map<WebSocket, number>();
const connectListeners: ((send: (msg: object) => void) => void)[] = [];
const idleListeners: (() => void | Promise<void>)[] = [];
const relayListeners: ((msg: Relayed) => void)[] = [];

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== WS_PATH) { socket.destroy(); return; }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      const relay = url.searchParams.get('role') === 'studiomate';
      if (relay) relays.set(ws, 0);
      const send = (msg: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
      connectListeners.forEach(cb => { try { cb(send); } catch {} });
      ws.on('message', (raw) => {
        if (!relay) return;
        let msg: Relayed;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg?.type === 'studiomate-admins') { relays.set(ws, Number(msg.n) || 0); adminCountChanged(); return; }
        relayListeners.forEach(cb => { try { cb(msg); } catch (err) { logger.warn({ err, type: msg.type }, '[ws] relay listener threw'); } });
      });
      ws.on('close', () => { relays.delete(ws); adminCountChanged(); });
      adminCountChanged();
    });
  });
}

/** StudioCall windows plus the StudioMate admin windows the relay reports. */
export function adminClientCount(): number {
  if (!wss) return 0;
  let n = 0;
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN && !relays.has(c)) n++;
  for (const count of relays.values()) n += count;
  return n;
}

export function broadcast(msg: object): void {
  if (!wss) return;
  const raw = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(raw);
}

/** Replay current state to a client that has just connected — it missed every broadcast before. */
export function onDisplayConnect(cb: (send: (msg: object) => void) => void): void {
  connectListeners.push(cb);
}

/** A message pushed by StudioMate's relay (`livechat-messages`, `popout-content`). */
export function onRelayMessage(cb: (msg: Relayed) => void): void {
  relayListeners.push(cb);
}

export function studioMateConnected(): boolean {
  return relays.size > 0;
}

/**
 * The last admin window has been gone for the grace window — the operator closed the browser, as
 * against reloading it (a reload reconnects in well under a second).
 */
export function onAdminIdle(cb: () => void | Promise<void>): void {
  idleListeners.push(cb);
}

const ADMIN_IDLE_GRACE_MS = 15_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let hadAdmin = false;

function adminCountChanged(): void {
  const n = adminClientCount();
  if (n > 0) {
    hadAdmin = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    return;
  }
  if (!hadAdmin || idleTimer) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (adminClientCount() > 0) return;
    for (const cb of idleListeners) {
      try { await cb(); } catch (err) { logger.warn({ err }, '[admin-idle] listener failed'); }
    }
  }, ADMIN_IDLE_GRACE_MS);
}
