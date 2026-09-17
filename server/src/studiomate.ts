import { Agent, fetch as undiciFetch } from 'undici';
import { env } from './env.js';
import { logger } from './logger.js';
import { onRelayMessage } from './ws.js';

/**
 * StudioMate, when there is one.
 *
 * StudioCall runs on its own; everything here is a feature that only exists because StudioMate
 * does — the OBS headline, the OBS browser-source refresh, the Telegram group, the YouTube chat,
 * the News Desk, the public tunnel. Each call is a no-op with `STUDIOMATE_URL` unset, and a
 * logged no-op when StudioMate is down: none of them is worth failing a room action over.
 *
 * The other direction arrives over the relay socket (ws.ts): YouTube chat lines and the title of
 * whatever StudioMate's pop-out is showing.
 */

// StudioMate serves HTTPS with a local mkcert pair that Node's own CA store does not know.
const localTls = new Agent({ connect: { rejectUnauthorized: false } });

export const studioMateEnabled = (): boolean => !!env.STUDIOMATE_URL;

async function sm(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  if (!env.STUDIOMATE_URL) return null;
  try {
    const res = await undiciFetch(`${env.STUDIOMATE_URL}${path}`, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      dispatcher: localTls,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      logger.warn({ path, status: res.status }, '[StudioMate] call refused');
      return { ...(typeof json === 'object' && json ? json : {}), _status: res.status };
    }
    return json;
  } catch (err) {
    logger.warn({ err, path }, '[StudioMate] not reachable');
    return null;
  }
}

/** Type (or, with '', take down) the OBS headline. */
export async function typeHeadline(opts: { text: string }): Promise<void> {
  await sm('/api/obs/headline', { body: { text: opts.text } });
}

/** The overlay pages that draw the room read it once on mount, so a room change reloads them. */
export function scheduleBrowserRefresh(reason: string): void {
  void sm('/api/studiocall-bridge/browser-refresh', { body: { reason } });
}

export async function telegramAnnounce(text: string): Promise<{ ok: boolean; reachable: boolean; error?: string }> {
  if (!env.STUDIOMATE_URL) return { ok: false, reachable: false, error: 'StudioMate is not configured (STUDIOMATE_URL) — there is no Telegram bot to announce through.' };
  const out = await sm('/api/studiocall-bridge/telegram-announce', { body: { text } });
  if (!out) return { ok: false, reachable: false, error: 'StudioMate is not answering.' };
  if (out._status) return { ok: false, reachable: true, error: out.error ?? `StudioMate refused it (${out._status}).` };
  return { ok: !!out.ok, reachable: out.reachable !== false, error: out.error };
}

export const roomUrl = (channel: string) => `https://www.clubhouse.com/room/${channel}`;

/** The public short link StudioMate's tunnel serves for a room, or the room's own URL. */
export async function roomLink(channel: string): Promise<string> {
  const out = await sm(`/api/studiocall-bridge/room-link?channel=${encodeURIComponent(channel)}`);
  return typeof out?.link === 'string' && out.link ? out.link : roomUrl(channel);
}

export function captureChatLinks(items: { id: string; text: string; author: string; feed: 'clubhouse' }[]): void {
  if (!items.length || !env.STUDIOMATE_URL) return;
  void sm('/api/studiocall-bridge/chat-links', { body: { items } });
}

export async function queueYtChat(text: string): Promise<{ queued: boolean; reason?: string }> {
  if (!env.STUDIOMATE_URL) return { queued: false, reason: 'StudioMate is not configured — there is no YouTube chat.' };
  const out = await sm('/api/studiocall-bridge/yt-chat', { body: { text } });
  if (!out || out._status) return { queued: false, reason: out?.error ?? 'StudioMate is not answering.' };
  return { queued: !!out.queued, reason: out.reason };
}

/** An OBS overlay layer's `duration` in seconds; 0 when StudioMate has no answer. */
export async function layerDuration(id: string): Promise<number> {
  const out = await sm(`/api/studiocall-bridge/layer/${encodeURIComponent(id)}`);
  return Math.max(0, Number(out?.duration ?? 0));
}

// ── pushed by the relay ─────────────────────────────────────────────────────

export interface YtChatMessage { id: string; author: string; text: string; isOwner?: boolean; [k: string]: unknown }

let popoutTitle = '';
const ytListeners: ((items: YtChatMessage[]) => void)[] = [];

onRelayMessage((msg) => {
  if (msg.type === 'popout-content') popoutTitle = String(msg.title ?? '');
  else if (msg.type === 'livechat-messages' && Array.isArray(msg.items)) {
    const items = msg.items as YtChatMessage[];
    for (const cb of ytListeners) cb(items);
  }
});

/** What StudioMate's pop-out window is showing right now, as a title. */
export function popoutContentTitle(): string {
  return popoutTitle;
}

export function onLiveChatMessages(cb: (items: YtChatMessage[]) => void): void {
  ytListeners.push(cb);
}
