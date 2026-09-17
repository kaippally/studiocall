import { logger } from '../logger.js';

/**
 * The room's live event feed. Clubhouse pushes room events over PubNub: joins, leaves, hand
 * raises, chat lines and reactions. The credential (`pubnub_token`) comes back from
 * `/join_channel` and is good for that room only, so this starts on a join and stops on a leave.
 *
 * Reactions exist ONLY here — `/get_channel_messages` never returns them (500 messages of a live
 * room, none), which is why the chat poll could not show "Alex reacted ❤️ to Sam".
 *
 * Plain HTTPS long-poll against PubNub's subscribe endpoint, no SDK: one GET per cycle that
 * returns when something arrives or after PubNub's own ~5 min idle. The subscribe key is the
 * public one every Clubhouse client carries (Clubdeck's profile.json and bundle both hold it).
 */

const SUB_KEY = process.env.CH_PUBNUB_SUB_KEY || 'sub-c-a4abea84-9ca3-11ea-8e71-f2b83ac9263d';
const SDK = process.env.CH_PUBNUB_SDK || 'PubNub-ObjC-iOS/4.15.11';

export interface RoomEvent { action: string; channel?: string; [k: string]: unknown }

let abort: AbortController | null = null;
let running: { channel: string } | null = null;

export function roomPubsubStatus(): { channel: string | null } {
  return { channel: running?.channel ?? null };
}

/**
 * Subscribe to a room's feed. `joinResponse` is the `/join_channel` answer; `uid` the account's
 * user id. Every event is handed to `onEvent`. A second call replaces the first.
 */
export function startRoomPubsub(joinResponse: any, channel: string, uid: string, onEvent: (e: RoomEvent) => void): boolean {
  const token = joinResponse?.pubnub_token;
  if (!token || joinResponse?.pubnub_enable === false) {
    logger.warn({ channel }, '[StudioCall] join carried no PubNub token — no live room events');
    return false;
  }
  stopRoomPubsub();
  const origin = String(joinResponse?.pubnub_origin || 'clubhouse.pubnub.com');
  const chans = [`channel_all.${channel}`, `channel_user.${channel}.${uid}`, `users.${uid}`].join(',');
  const ctl = new AbortController();
  abort = ctl;
  running = { channel };
  void loop(ctl, origin, chans, uid, String(token), channel, onEvent);
  logger.info({ channel, origin }, '[StudioCall] room events: subscribed');
  return true;
}

export function stopRoomPubsub(): void {
  if (abort) { abort.abort(); abort = null; }
  running = null;
}

async function loop(ctl: AbortController, origin: string, chans: string, uid: string, token: string, channel: string, onEvent: (e: RoomEvent) => void): Promise<void> {
  let tt = '0';
  let tr = '';
  let failures = 0;
  while (!ctl.signal.aborted) {
    const url = `https://${origin}/v2/subscribe/${SUB_KEY}/${encodeURIComponent(chans)}/0?tt=${tt}${tr ? `&tr=${tr}` : ''}`
      + `&uuid=${encodeURIComponent(uid)}&auth=${encodeURIComponent(token)}&pnsdk=${encodeURIComponent(SDK)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(320_000)]) });
    } catch (e) {
      if (ctl.signal.aborted) return;
      failures++;
      logger.warn({ err: e, channel, failures }, '[StudioCall] room events: subscribe failed');
      await sleep(Math.min(30_000, 2_000 * failures), ctl.signal);
      continue;
    }
    if (res.status !== 200) {
      failures++;
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200), channel, failures }, '[StudioCall] room events: subscribe refused');
      // 403 is the token dying with the room; nothing to retry into.
      if (res.status === 403) { running = null; return; }
      await sleep(Math.min(30_000, 2_000 * failures), ctl.signal);
      continue;
    }
    failures = 0;
    let data: any;
    try { data = await res.json(); } catch { continue; }
    tt = String(data?.t?.t ?? tt);
    tr = String(data?.t?.r ?? tr);
    for (const m of Array.isArray(data?.m) ? data.m : []) {
      const d = m?.d;
      if (!d || typeof d !== 'object' || typeof d.action !== 'string') continue;
      try { onEvent(d as RoomEvent); }
      catch (e) { logger.warn({ err: e, action: d.action }, '[StudioCall] room events: handler threw'); }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
