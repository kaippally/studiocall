/**
 * notices.ts — the app's one channel for "something happened that the operator should read".
 *
 * Before this, a message could arrive as a native alert() (blocking, unstyled, and in a
 * window capture it is invisible to OBS), as a full-width red bar welded into one tab, or as
 * a per-panel toast with its own timer. Three shapes for one idea, and half of them stayed on
 * screen forever. Everything now goes through notify(): a card in the bottom-right corner
 * that sizes to its text, retires on a timer, and stacks when a burst arrives.
 *
 * The bus lives outside React on purpose — lib/ code (api helpers, ws handlers, the media
 * deleter) has no component to hang a useState off, and those are exactly the places that
 * used to reach for alert().
 */
export type NoticeLevel = 'error' | 'warn' | 'info';

export interface Notice {
  id: number;
  level: NoticeLevel;
  message: string;
  /** Names the action Enter runs. Omit and Enter just dismisses. */
  acceptLabel?: string;
  onAccept?: () => void;
}

/** More than this on screen at once is a wall, not a message — the oldest makes room. */
const MAX_VISIBLE = 4;
/** A retry loop firing the same failure ten times should read as one notice. */
const DEDUPE_MS = 2000;

let seq = 0;
let notices: Notice[] = [];
const listeners = new Set<() => void>();
const lastSeen = new Map<string, number>();

function emit() {
  for (const fn of listeners) fn();
}

export function subscribeNotices(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getNotices(): Notice[] {
  return notices;
}

export function dismissNotice(id: number): void {
  const next = notices.filter(n => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

function push(level: NoticeLevel, message: string, opts?: { acceptLabel?: string; onAccept?: () => void }): void {
  const text = String(message ?? '').trim();
  if (!text) return;

  const key = `${level}:${text}`;
  const now = Date.now();
  const seen = lastSeen.get(key);
  if (seen !== undefined && now - seen < DEDUPE_MS) return;
  lastSeen.set(key, now);

  notices = [...notices, { id: ++seq, level, message: text, ...opts }].slice(-MAX_VISIBLE);
  emit();
}

/**
 * Raise a notice. `error` is something that failed, `warn` is something that will bite
 * later, `info` is a confirmation the operator asked for. Nothing here blocks — if the
 * answer changes what happens next, it is a dialog (lib/ask.tsx), not a notice.
 */
export const notify = {
  error: (message: string, opts?: { acceptLabel?: string; onAccept?: () => void }) => push('error', message, opts),
  warn:  (message: string, opts?: { acceptLabel?: string; onAccept?: () => void }) => push('warn', message, opts),
  info:  (message: string, opts?: { acceptLabel?: string; onAccept?: () => void }) => push('info', message, opts),
};
