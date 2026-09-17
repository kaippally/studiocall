import { useCallback, useEffect, useState } from 'react';
import { API } from './api';
import { notify } from './notices';
import { askConfirm, askPrompt } from './ask';
import { getUiSetting, setUiSetting } from './uiSettings';
import { ws } from '../ws';

/** The four standing decisions the server keeps about one person, across rooms. */
export type StatusFlag = 'gag' | 'autoMute' | 'autoKick' | 'autoMod';

/**
 * Somebody with at least one flag set. Each flag holds the ISO time it was set, or is absent.
 * Keyed by Clubhouse user id. `gag` deletes every line they type as it arrives and shuts their
 * mic whenever it opens; `autoMute` only shuts the mic; `autoKick` removes them from the room
 * once they have been in it longer than the `autoKickMinutes` control; `autoMod` makes them a
 * moderator whenever they are on the stage of a room the desk moderates.
 */
export interface StatusEntry { userId: string; name: string; gag?: string; autoMute?: string; autoKick?: string; autoMod?: string }

/** Somebody this account has blocked at Clubhouse — read from Clubhouse, never stored here. */
export interface BlockedEntry { userId: string; name: string }

/**
 * The line the desk offers to post when somebody is gagged. `{username}` is their name.
 *
 * A gag is silent by design — their lines stop arriving and nothing announces it. That is right
 * for the room and wrong for the person: they carry on typing into a channel that deletes them,
 * and never think to ask a moderator, because nobody told them there was anything to ask about.
 * So the act of gagging now offers the sentence that closes that loop, and the operator sends it
 * or presses Esc.
 */
export const GAG_NOTICE_TEMPLATE = '{username} Your chat has been muted till you request the moderators';

const NOTICE_KEY = 'chat:gagNotices';
/** How many previous notices are offered back. Three fills the dialog without becoming a list. */
const NOTICE_KEEP = 3;

/**
 * Stored with `{username}` back in place of the name, never with the last person's name baked
 * in — a remembered line has to be reusable on somebody else, which is the whole point of
 * remembering it.
 */
function recentNotices(): string[] {
  try {
    const raw: unknown = JSON.parse(getUiSetting(NOTICE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(0, NOTICE_KEEP) : [];
  } catch {
    return [];
  }
}

function rememberNotice(template: string) {
  const next = [template, ...recentNotices().filter(s => s !== template)].slice(0, NOTICE_KEEP);
  setUiSetting(NOTICE_KEY, JSON.stringify(next));
}

/**
 * Offer to tell somebody they have just been gagged, and post it to the room if the operator
 * says so. Esc says nothing, which is the old behaviour and stays one keystroke away.
 */
async function offerGagNotice(name: string) {
  const who = name.trim() || 'They';
  const fill = (t: string) => t.split('{username}').join(who);

  const answer = await askPrompt({
    title: `Tell ${who} they are muted?`,
    body: 'Posted in the room chat, where everybody can read it — Clubhouse has no private reply. Esc sends nothing.',
    initial: fill(GAG_NOTICE_TEMPLATE),
    suggestions: recentNotices().filter(t => t !== GAG_NOTICE_TEMPLATE).map(fill),
    confirmLabel: 'Send',
    cancelLabel: 'Say nothing',
    validate: v => v.trim().length > 0,
  });
  if (answer === null) return;

  const text = answer.trim();
  try {
    const r = await fetch(`${API}/api/studiocall/room/chat/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    if (!r.ok) return notify.error(d?.body?.error_message ?? d?.error ?? 'Could not post to the room.');
    rememberNotice(who === 'They' ? text : text.split(who).join('{username}'));
    notify.info(`Told ${who} in the room.`);
  } catch {
    notify.error('Could not reach the server.');
  }
}

const FLAG_SAID: Record<StatusFlag, (who: string, on: boolean) => string> = {
  gag: (who, on) => on ? `${who} are gagged — every line of theirs is deleted as it arrives.` : `${who} can speak again.`,
  autoMute: (who, on) => on ? `${who} are auto-muted — their mic is shut whenever it opens.` : `${who} keep their mic from now on.`,
  autoKick: (who, on) => on ? `${who} will be removed from the room once their minutes run out.` : `${who} can stay.`,
  autoMod: (who, on) => on ? `${who} are made a moderator whenever they are on the stage.` : `${who} are no longer promoted on arrival.`,
};

/**
 * The speaker status list, mirrored from the server.
 *
 * The list itself is the server's — it holds it, persists it, deletes the lines, shuts the mics
 * and does the kicking. Every surface that shows it only ever mirrors, and
 * `studiocall-speaker-status` is what moves them all, so a gag made in the chat row greys the same
 * person out in the panel and vice versa. `blocked` rides on the same message: the block column
 * is Clubhouse's list, re-read after every block change, and `null` when it could not be read.
 */
export function useSpeakerStatus() {
  const [people, setPeople] = useState<StatusEntry[]>([]);
  const [blocked, setBlocked] = useState<BlockedEntry[] | null>(null);

  useEffect(() => {
    const take = (d: any) => {
      setPeople(Array.isArray(d?.people) ? d.people : []);
      setBlocked(Array.isArray(d?.blocked) ? d.blocked : null);
    };
    fetch(`${API}/api/studiocall/speaker-status`).then(r => r.json()).then(take).catch(() => {});
    return ws.onBroadcast(msg => {
      if (msg.type === 'studiocall-speaker-status') take(msg);
    });
  }, []);

  /**
   * Set or clear one flag. `on` is explicit rather than a toggle: several surfaces show this
   * list, and a toggle racing a broadcast releases somebody nobody asked to release.
   */
  const setFlag = useCallback(async (userId: string, name: string, flag: StatusFlag, on: boolean) => {
    try {
      const r = await fetch(`${API}/api/studiocall/speaker-status`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, name, flag, on }),
      });
      const d = await r.json();
      if (!r.ok) return notify.error(d?.error ?? 'Could not change their status.');
      notify.info(FLAG_SAID[flag](name || 'They', on));
      // Only on the way in. Letting somebody speak again needs no announcement, and a dialog
      // on every release would be a box to dismiss in the middle of clearing an old list.
      if (flag === 'gag' && on) await offerGagNotice(name);
    } catch {
      notify.error('Could not reach the server.');
    }
  }, []);

  const setGag = useCallback((userId: string, name: string, on: boolean) => setFlag(userId, name, 'gag', on), [setFlag]);

  const gagged = new Set(people.filter(p => p.gag).map(p => String(p.userId)));
  const autoMuted = new Set(people.filter(p => p.autoMute).map(p => String(p.userId)));
  return { people, blocked, gagged, autoMuted, setGag, setFlag };
}

/**
 * Block somebody at Clubhouse, or let them back in — the ACCOUNT-level block, not the room's.
 *
 * It asks on the way in, because it is the one act here that outlives the show: a block stands
 * until it is undone. Unblocking does not ask — putting something back is not the direction that
 * needs a guard. Resolves true when the change was made; the server then re-broadcasts the list.
 */
export async function setAccountBlock(userId: string, name: string, on: boolean): Promise<boolean> {
  const who = name || 'this person';
  if (on && !await askConfirm({
    title: `Block ${who}?`,
    body: 'A Clubhouse account block, not a room ban — it outlasts this room and every room after it. They stop being able to reach this account until it is undone.',
    confirmLabel: 'Block',
    level: 'warn',
  })) return false;
  try {
    const r = await fetch(`${API}/api/studiocall/user/block`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, on }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) { notify.error(d?.error ?? 'Clubhouse refused that.'); return false; }
    notify.info(on ? `${who} is blocked.` : `${who} is unblocked.`);
    return true;
  } catch {
    notify.error('Could not reach the server.');
    return false;
  }
}
