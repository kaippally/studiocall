import { API } from './api';
import { ws } from '../ws';
import { getUiSetting, onUiSettingsLoaded, setUiSetting } from './uiSettings';

/**
 * chatToasts.ts — the chat lane of the corner toast stack.
 *
 * A line said in the StudioCall room or in the YouTube live chat arrives in the corner the
 * moment it is said, wherever the operator is: on News Desk, in the Overlay tab, halfway
 * through a Move — anywhere but the Chat tab, which is exactly when a comment is missed.
 *
 * It is a SEPARATE lane from notify() on purpose. A notice is a failure or a confirmation and
 * must not be buried, and a busy chat would push four of them off the stack in a second. Same
 * corner, same card language, same host (NoticeHost draws both) — different queue, its own cap
 * and its own mute.
 *
 * Fed off the admin socket, from the two broadcasts the Chat tab already merges:
 * `livechat-messages` (YouTube's reader) and `studiocall-chat` (the room's poll). Both are
 * server-paced batches, so nothing here polls.
 */
export type ChatFeed = 'youtube' | 'clubhouse';

export interface ChatToast {
  id: string;
  at: number;
  feed: ChatFeed;
  author: string;
  /** Absolute url, ready for an <img>. YouTube's is Google's CDN, the room's is ours. */
  avatar: string;
  text: string;
  /** Host / Mod / Member — whatever the feed says about them, or nothing. */
  badge: string | null;
}

/** More than this in the lane and the notices under it are off the screen. */
const MAX_VISIBLE = 3;
/** Long enough to read a sentence, short enough that a busy chat does not become a wall. */
export const CHAT_TOAST_HOLD_MS = 9000;
/**
 * A batch is only news if it is fresh. Both readers re-broadcast their whole backlog after a
 * server restart (the seen-set is in memory), and a hundred toasts for messages from an hour
 * ago is the one way this feature could ruin a show.
 */
const FRESH_MS = 60_000;
const MUTE_KEY = 'chatToast:muted';

interface ChatToastState { items: ChatToast[]; muted: boolean }

let state: ChatToastState = { items: [], muted: false };
const listeners = new Set<() => void>();
const seen = new Set<string>();

function commit(next: Partial<ChatToastState>) {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function subscribeChatToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getChatToastState(): ChatToastState {
  return state;
}

export function dismissChatToast(id: string): void {
  const items = state.items.filter(t => t.id !== id);
  if (items.length !== state.items.length) commit({ items });
}

/** Muted the lane keeps taking messages and drops them — it is a "not now", not a pause. */
export function setChatToastsMuted(muted: boolean): void {
  setUiSetting(MUTE_KEY, muted ? '1' : '0');
  commit({ muted, items: muted ? [] : state.items });
}

function push(fresh: ChatToast[]): void {
  if (state.muted || !fresh.length) return;
  const cutoff = Date.now() - FRESH_MS;
  const keep = fresh.filter(t => t.text && t.at > cutoff && !seen.has(t.id));
  if (!keep.length) return;
  for (const t of keep) seen.add(t.id);
  if (seen.size > 800) for (const id of [...seen].slice(0, 400)) seen.delete(id);
  commit({ items: [...state.items, ...keep].slice(-MAX_VISIBLE) });
}

// YouTube's reader hands the tab the raw author details; the room's pump hands it a local
// avatar path, because the OBS page resolves a face against its own host.
function fromYouTube(m: any): ChatToast {
  return {
    id: `yt:${m.id}`,
    at: Number(m.at) || Date.now(),
    feed: 'youtube',
    author: String(m.author ?? 'viewer'),
    avatar: String(m.avatar ?? ''),
    text: String(m.text ?? ''),
    badge: m.isOwner ? 'Host' : m.isModerator ? 'Mod' : m.isMember ? 'Member' : null,
  };
}

function fromRoom(m: any): ChatToast {
  return {
    id: `ch:${m.id}`,
    at: Number(m.at) || Date.now(),
    feed: 'clubhouse',
    author: String(m.author ?? ''),
    avatar: m.avatar ? `${API}${m.avatar}` : '',
    text: String(m.text ?? ''),
    badge: m.isModerator ? 'Mod' : m.isSpeaker ? 'Speaker' : null,
  };
}

let started = false;

/**
 * Wire the lane to the admin socket. Called once by App — the SMChat pop-out deliberately does
 * not, because it is already the whole list and would be toasting what it is showing.
 */
export function startChatToasts(): () => void {
  if (started) return () => {};
  started = true;

  onUiSettingsLoaded(() => {
    if (getUiSetting(MUTE_KEY) === '1') commit({ muted: true });
  });

  const off = ws.onBroadcast(msg => {
    if (msg.type === 'livechat-messages') {
      const items = (msg as any).items;
      // The host's own lines are the auto-prompts and thank-yous this app sent.
      if (Array.isArray(items)) push(items.filter((m: any) => !m?.isOwner).map(fromYouTube));
      return;
    }
    if (msg.type !== 'studiocall-chat') return;
    // A null channel is the room being left; whatever is still up belongs to a room
    // that is gone.
    if (!(msg as any).channel) { commit({ items: [] }); return; }
    const items = (msg as any).items;
    if (Array.isArray(items)) push(items.filter((m: any) => !m?.isMe).map(fromRoom));
  });

  return () => { off(); started = false; };
}
