import express, { Router } from 'express';
import multer from 'multer';
import {
  hasSession, publicSession, call,
  importFromClubdeck, startPhoneAuth, completePhoneAuth,
  CLUBDECK_PROFILE, ClubhouseError, cacheOwnAvatar, localAvatar, isRateLimited,
} from '../studiocall/client.js';
import { getAgoraKey, callMultipart, refreshOwnPhoto } from '../studiocall/client.js';
import { startRoomPubsub, stopRoomPubsub, type RoomEvent } from '../studiocall/pubsub.js';
import {
  audioHealth, audioDevices, audioSpeaking, audioJoin, audioLeave, audioMute,
  audioOutput, audioSetDevices, AudioEngineUnreachableError,
} from '../studiocall/audioClient.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { logger } from '../logger.js';
import { broadcast, adminClientCount, onDisplayConnect, onAdminIdle } from '../ws.js';
import {
  typeHeadline, scheduleBrowserRefresh, popoutContentTitle, telegramAnnounce, roomLink,
  onLiveChatMessages, queueYtChat, captureChatLinks, layerDuration as smLayerDuration, type YtChatMessage,
} from '../studiomate.js';
import { env } from '../env.js';
import { splitMessage } from '../chatSplit.js';
import { bridgeLine, isBridged } from '../chatBridge.js';
import { addTalk, bumpDrops, bumpMessages, getPeople, noteProfile, resetPeopleRoom, setNotes, touchPeople } from '../studiocall/people.js';

export const studiocallRouter: Router = express.Router();

function sendErr(res: express.Response, e: unknown) {
  if (e instanceof AudioEngineUnreachableError) return res.status(503).json({ error: 'audio-engine', message: e.message });
  if (e instanceof ClubhouseError) return res.status(e.status === 401 ? 401 : 502).json({ error: 'clubhouse', status: e.status, body: e.body });
  logger.error({ err: e }, 'studiocall route error');
  return res.status(500).json({ error: String((e as Error)?.message || e) });
}

// Who am I, and am I logged in. The one endpoint the tab polls on load.
studiocallRouter.get('/session', async (_req, res) => {
  if (!hasSession()) return res.json({ loggedIn: false, clubdeckAvailable: existsSync(CLUBDECK_PROFILE) });
  try {
    // Prove the stored token still authenticates rather than trusting the file.
    const settings = await call('/get_settings');
    await cacheOwnAvatar();
    res.json({ loggedIn: true, me: publicSession(), verified: settings?.success !== false });
  } catch (e) {
    if (e instanceof ClubhouseError && e.status === 401) return res.json({ loggedIn: false, expired: true });
    sendErr(res, e);
  }
});

// Log in by adopting the credential Clubdeck already holds on this machine.
studiocallRouter.post('/login/clubdeck', async (req, res) => {
  try {
    const path = req.body?.profilePath || CLUBDECK_PROFILE;
    if (!existsSync(path)) return res.status(404).json({ error: 'no Clubdeck profile.json found', path });
    importFromClubdeck(path);
    const settings = await call('/get_settings');
    await cacheOwnAvatar();
    res.json({ loggedIn: true, me: publicSession(), verified: settings?.success !== false });
  } catch (e) { sendErr(res, e); }
});

// SMS auth path (no Clubdeck needed).
studiocallRouter.post('/login/phone/start', async (req, res) => {
  try { res.json(await startPhoneAuth(req.body?.phoneNumber)); } catch (e) { sendErr(res, e); }
});
studiocallRouter.post('/login/phone/complete', async (req, res) => {
  try {
    await completePhoneAuth(req.body?.phoneNumber, req.body?.code);
    res.json({ loggedIn: true, me: publicSession() });
  } catch (e) { sendErr(res, e); }
});

// The Houses this account can open a room in. IDs stay strings all the way to the
// browser — they are snowflakes past MAX_SAFE_INTEGER and a JS number mangles them.
studiocallRouter.get('/houses', async (_req, res) => {
  try {
    const data = await call('/get_create_channel_targets', {});
    const targets = Array.isArray(data?.targets) ? data.targets : [];
    const houses = await Promise.all(
      targets
        .filter((t: any) => t?.social_club)
        .map(async (t: any) => ({
          id: String(t.social_club.social_club_id),
          name: t.social_club.name,
          slug: t.social_club.slug,
          members: t.social_club.num_members,
          liveChannels: t.social_club.num_live_channels,
          photoUrl: await localAvatar(t.social_club.photo_url),
        })),
    );
    res.json({ houses });
  } catch (e) { sendErr(res, e); }
});

// The four audiences Clubhouse will open a room to. Read out of the shipping
// desktop client's own create-channel form, which maps its picker to exactly
// these privacy_level values — 'private' is not one of them; the private tiers
// are the two friend levels. is_private is vestigial: every live house room
// reports it true while being open to everyone, so it is not sent.
const PRIVACY_LEVELS = ['public', 'house', 'friend_of_friend', 'friend'] as const;
type PrivacyLevel = typeof PRIVACY_LEVELS[number];

// Open a room. Outward-facing: members can see it and may be notified, so nothing
// here runs on its own — only on an explicit request from the tab.
studiocallRouter.post('/room/create', async (req, res) => {
  try {
    const { houseId, topic } = req.body ?? {};
    const privacyLevel: PrivacyLevel = PRIVACY_LEVELS.includes(req.body?.privacyLevel) ? req.body.privacyLevel : 'house';
    // A friend-level room belongs to nobody's house — it is scoped to who follows
    // you — so it is the one case that opens without a house to open it in.
    const inHouse = privacyLevel === 'house' || privacyLevel === 'public';
    if (inHouse && !houseId) return res.status(400).json({ error: 'houseId required' });
    // One room at a time, in BOTH legs — the same tear-down /room/join has always done, and its
    // absence here is what left the operator's face standing in the room they had just walked out
    // of. `startPing()` below calls `stopPing()`, which stops our pumps and nothing
    // else: Clubhouse is never told, so the old room keeps showing you, and the audio engine is
    // never told, so it is still holding that channel's Agora connection. `connectAudio()` then
    // joins the NEW channel on the SAME account uid, Agora sees one uid on two connections and
    // bans one of them (error 123) — which is the "I was dropped from a room" that follows.
    const previous = liveChannel;
    if (previous) {
      await call('/leave_channel', { channel: previous }).catch(() => {});
      await audioLeave().catch(() => {});
    }
    const data = await call('/create_channel', {
      ...(inHouse ? { social_club_id: String(houseId) } : {}),
      privacy_level: privacyLevel,
      topic: topic || null,
    });
    const channel = String(data?.channel);
    // Creating a room does not put you in it. Without a join the room has no
    // occupants and Clubhouse reaps it within seconds, so join immediately.
    const joined = await call('/join_channel', { channel }).catch(() => null);
    startPing(channel, 'host');
    subscribeRoomEvents(joined, channel);
    // Chat on, always. Clubhouse opens a new room with text chat DISABLED, and this desk reads the
    // room's chat next to YouTube's, puts lines on air and captures the links in them — every one
    // of which is dead until somebody remembers to open it. A host who wants it shut has the toggle;
    // a host who forgets used to lose the whole channel for the length of the show.
    // Best-effort by design: the room exists and is joined by this point, and a chat setting is not
    // worth failing a room creation over.
    const chatEnabled = await call('/enable_channel_messages', { channel })
      .then(() => true)
      .catch(e => { logger.warn({ err: e, channel }, 'studiocall: could not enable room chat on create'); return false; });
    // The host is a speaker. Failure here must not undo the room — report it.
    const audio = await connectAudio(joined, channel, true);
    res.json({
      channel,
      channelId: data?.channel_id ? String(data.channel_id) : null,
      privacyLevel,
      joined: !!joined?.success,
      hasRtcToken: !!(joined?.token ?? data?.token),
      chatEnabled,
      audio,
      left: previous ?? null,
    });
  } catch (e) { sendErr(res, e); }
});

// Clubhouse reaps a room whose creator stops pinging.
let pingTimer: NodeJS.Timeout | null = null;
let liveChannel: string | null = null;
let liveMode: 'host' | 'guest' | null = null;
/**
 * Are we on the stage of the room we are in?
 *
 * NOT the same thing as `liveMode`. Hosting a room means starting on the stage, but a guest who
 * takes the mic is a speaker in a room they did not create — and the Agora role is fixed at
 * join time, so every rejoin path has to know this rather than re-deriving it from `mode === host`.
 * Derived that way, one device change put a speaking guest back in the audience with no error and
 * no sound.
 */
let liveSpeaker = false;

/**
 * `/get_channel` behind a short cache, because the desk asks for it far harder than it looks.
 *
 * `GET /room` polls every 5s **per admin client**, and every pop-out is a full admin
 * client — three of them open plus the speaker pump's roster refresh put close to one call a
 * second on a single Clubhouse endpoint, and Clubhouse answered **429**. Which would only have
 * been noise, except that a failed poll used to be read as a dead room (see the catch below).
 * One upstream call now serves every caller inside the window.
 */
const CHANNEL_TTL_MS = 3_000;
let channelCache: { channel: string; at: number; data: any } | null = null;
// Who this desk just promoted, and when. /make_moderator answers before `get_channel` shows the
// change, so for a few seconds the roster is overlaid with what the desk KNOWS it did — the star
// and the green dot land on the click, not on the next refresh that happens to agree.
const PROMOTED_HOLD_MS = 15_000;
const promotedAt = new Map<string, number>();
function recentlyPromoted(userId: string): boolean {
  const at = promotedAt.get(userId);
  if (!at) return false;
  if (Date.now() - at > PROMOTED_HOLD_MS) { promotedAt.delete(userId); return false; }
  return true;
}
let channelInFlight: { channel: string; p: Promise<any> } | null = null;

function getChannel(channel: string): Promise<any> {
  if (channelCache?.channel === channel && Date.now() - channelCache.at < CHANNEL_TTL_MS) {
    return Promise.resolve(channelCache.data);
  }
  if (channelInFlight?.channel === channel) return channelInFlight.p;
  const p = call('/get_channel', { channel })
    .then((d) => { channelCache = { channel, at: Date.now(), data: d }; return d; })
    .finally(() => { if (channelInFlight?.p === p) channelInFlight = null; });
  channelInFlight = { channel, p };
  return p;
}

/** The last answer `GET /room` gave, so a failed poll can repeat it instead of inventing one. */
let lastRoomBody: Record<string, unknown> | null = null;

/**
 * The roster is the authority on who is on stage; `liveSpeaker` is a cache of it. Agora fixes the
 * role at join, so when the two disagree the RTC leg has to be rebuilt with the roster's answer —
 * once per flip, never per poll. Two consecutive polls have to agree before acting, because
 * `/get_channel` lags `/become_speaker` by a beat and a single stale read would demote a real
 * speaker back to audience.
 */
let roleDisagreeStreak = 0;
let roleRejoinInFlight = false;
function reconcileStageRole(onStage: boolean) {
  if (onStage === liveSpeaker) { roleDisagreeStreak = 0; return; }
  if (roleRejoinInFlight || ++roleDisagreeStreak < 2) return;
  roleDisagreeStreak = 0;
  liveSpeaker = onStage;
  saveRoom();
  roleRejoinInFlight = true;
  journal(onStage ? 'roster put us on stage — rejoining as speaker' : 'roster took us off stage — rejoining as audience', { channel: liveChannel }, true);
  rejoinLiveRoom()
    .catch(e => logger.warn({ err: e }, 'studiocall role reconcile rejoin failed'))
    .finally(() => { roleRejoinInFlight = false; });
}

/**
 * The room this desk is in, for other modules — the announce panel needs it to build the short
 * link and to say whether there is a room to announce at all. A getter rather than exporting
 * `liveChannel`, because a live binding read from another module would go stale the moment this
 * one reassigns it.
 */
export function currentRoom(): { channel: string | null; mode: 'host' | 'guest' | null } {
  return { channel: liveChannel, mode: liveMode };
}

/** The room this desk is in, with no Clubhouse call behind it — for StudioMate's announce panel. */
studiocallRouter.get('/room/current', (_req, res) => res.json(currentRoom()));

// Which room we are in has to outlive this process. content-server reloads on every
// server edit, and an in-memory-only channel meant a reload orphaned a live room:
// the pings stopped and End room had nothing to end while the room stayed up on
// Clubhouse with people in it.
const ROOM_STATE = join(env.DATA_DIR, 'room.json');

// The room's live-feed credential (PubNub), minted by /join_channel and saved with the room so a
// server restart can pick the feed back up WITHOUT joining again — a second /join_channel makes
// Clubhouse ban the engine's Agora leg (error 123, "banned by server"), and the room goes silent.
let liveFeed: { token: string; origin: string } | null = null;

function saveRoom() {
  try {
    mkdirSync(dirname(ROOM_STATE), { recursive: true });
    writeFileSync(ROOM_STATE, JSON.stringify({ channel: liveChannel, mode: liveMode, speaker: liveSpeaker, feed: liveFeed }));
  } catch {}
}

function restoreRoom() {
  try {
    const r = JSON.parse(readFileSync(ROOM_STATE, 'utf8'));
    if (r?.channel) {
      liveChannel = String(r.channel);
      liveMode = r.mode ?? 'host';
      liveSpeaker = r.speaker ?? liveMode === 'host';
      resumePing();
      // Once the server is up. Module load is too early for a Clubhouse round-trip, and the
      // engine may be restarting alongside us.
      const feed = r.feed?.token ? { token: String(r.feed.token), origin: String(r.feed.origin || '') } : null;
      setTimeout(() => {
        if (liveChannel !== String(r.channel)) return;
        // The saved feed token resumes the subscription with no join and no audio gap. Only a
        // room saved before there was a token takes the full rejoin, once.
        if (feed) subscribeRoomEvents({ pubnub_token: feed.token, pubnub_origin: feed.origin || undefined }, String(r.channel));
        else void rejoinAfterRestart(String(r.channel));
      }, 3_000);
    }
  } catch {}
}

/**
 * After a server reload the room is still ours — the engine held the audio and the ping resumes —
 * but everything the join minted is gone: the PubNub token, and, if the engine was restarted too,
 * the RTC leg. So come back in properly: a fresh /join_channel, subscribe to the room's events,
 * and re-attach audio only when the engine is not already in this channel (a rejoin on a joined
 * engine is an audible gap for nothing). Nothing here can end the room: a failed rejoin is logged
 * and the polls carry on as before.
 */
async function rejoinAfterRestart(channel: string): Promise<void> {
  if (liveChannel !== channel) return;
  try {
    const data = await call('/join_channel', { channel });
    subscribeRoomEvents(data, channel);
    // Always re-attach: the join above has already invalidated the engine's leg (error 123),
    // so "keeping" a joined engine keeps a leg that is about to go silent.
    const audio = await connectAudio(data, channel, liveSpeaker);
    logger.info({ channel, audio }, '[StudioCall] rejoined the room after restart');
  } catch (e) {
    logger.warn({ err: e, channel }, '[StudioCall] could not rejoin the room after restart');
  }
}

function resumePing() {
  if (pingTimer || !liveChannel) return;
  const channel = liveChannel;
  pingTimer = setInterval(() => {
    call('/active_ping', { channel }).catch(e => logger.warn({ err: e }, 'studiocall active_ping failed'));
    void syncHeadline('ping');
  }, 20_000);
  startSpeakerPump();
  startChatPump();
  startHandPump();
  void syncHeadline('joined');
}

function startPing(channel: string, mode: 'host' | 'guest') {
  stopPing();
  liveChannel = channel;
  liveMode = mode;
  // Opening a room puts you on its stage; arriving from the hallway does not.
  liveSpeaker = mode === 'host';
  saveRoom();
  pingTimer = setInterval(() => {
    call('/active_ping', { channel }).catch(e => logger.warn({ err: e }, 'studiocall active_ping failed'));
  }, 20_000);
  startSpeakerPump();
  startChatPump();
  startHandPump();
  // The three room layers (Speakers, SharedChatDisplay, CHinfocard) read the room once, when the
  // overlay page mounts them. A room opened after that page loaded never reaches them, which is
  // why SM_HTML had to be refreshed by hand on every room. → server/src/obsRefresh.ts
  scheduleBrowserRefresh('StudioCall room joined');
}

// The headline follows the room. The topic is read off `get_channel` (the only place it lives),
// once on join, on every 20 s ping, and on a rename from here; typed only when it has changed,
// because typing is a take — a typewriter re-running every ping would never stop. Off, or on
// leave, the headline is taken down only if this is what put it up.
let headlineShown: string | null = null;
async function syncHeadline(why: string): Promise<void> {
  const channel = liveChannel;
  if (!controls.autoHeadline || !channel) {
    if (headlineShown !== null) {
      headlineShown = null;
      await typeHeadline({ text: '' }).catch(e => logger.warn({ err: e, why }, 'auto headline: clear failed'));
    }
    return;
  }
  try {
    const data = await getChannel(channel);
    const topic = String(data?.topic ?? '').trim();
    if (!topic || topic === headlineShown) return;
    headlineShown = topic;
    await typeHeadline({ text: topic });
  } catch (e) {
    logger.warn({ err: e, why }, 'auto headline failed');
  }
}

/**
 * Leaving is the one room event the overlay never hears about on its own — every pump only
 * broadcasts when it HAS something, so they simply go quiet and the canvas keeps the room's last
 * state up as if it were still there. So teardown says the room is gone, out loud, to each of the
 * three surfaces it owns: the speaker roster, the chat, and the info card.
 */
function stopPing() {
  const wasLive = !!liveChannel;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  liveChannel = null;
  liveMode = null;
  liveSpeaker = false;
  stopSpeakerPump();
  stopChatPump();
  stopRoomPubsub();
  liveFeed = null;
  clearInfoCard();
  void syncHeadline('left');
  stopHandPump();
  // Both caches are answers ABOUT a room that no longer exists. Left set, the stale path in
  // GET /room would go on repeating a dead room's roster to every client.
  lastRoomBody = null;
  channelCache = null;
  autoInvited.clear();
  droppedFromStage.clear();
  topicTold.clear();
  // The lock belongs to the room it was armed in. Left set, the next room would open with every
  // mic being shut by a decision nobody in it could see anyone make.
  if (keepMuted) { keepMuted = false; broadcast({ type: 'studiocall-keep-muted', on: false } as any); }
  // Same reason, one person at a time: a hold is about somebody's microphone in the room it was
  // made in. The speaker status flags are the ones that deliberately outlive a room.
  if (heldMuted.size) { heldMuted.clear(); publishHeld(); }
  gagMutedAt.clear();
  // The auto-kick clock is "how long in THIS room"; the next room starts everybody from zero.
  roomSeenAt.clear();
  autoKickedAt.clear();
  resetPeopleRoom();
  anonKicked.clear();
  autoModdedAt.clear();
  // Who has been introduced is a fact about THIS room. Carried into the next one it would leave
  // the first speakers silently un-introduced.
  autoCardShownAt.clear();
  autoCandidate = null;
  saveRoom();
  // Only when a room actually ended — startPing calls this first, and a teardown with nothing to
  // tear down is not an event the overlay needs to hear about.
  if (wasLive) scheduleBrowserRefresh('StudioCall room left');
}

/**
 * Consecutive polls answered with `should_leave`. Two in a row is the threshold: one is a
 * possibility, two seconds apart is Clubhouse stating a fact. Reset by any other outcome —
 * including a good answer, which is what makes it consecutive rather than cumulative.
 */
let shouldLeaveStreak = 0;
const SHOULD_LEAVE_CONFIRM = 2;

/**
 * Auto-invite: everybody in the room gets asked up to the stage.
 *
 * **It rides on the room poll rather than owning one.** A second `/get_channel` loop is exactly
 * what ended a live room once — Clubhouse rate-limited the burst and the 429 was read as "the room
 * is gone" — and the roster this needs has already been fetched and parsed one line
 * above the call. So the price of the feature is zero extra Clubhouse calls when it is off, and
 * only the invites themselves when it is on.
 *
 * `autoInvited` is what stops it from re-inviting the same person every five seconds. Someone who
 * declines is not asked again while the room lasts: a toggle that pesters is worse than no toggle.
 * It is cleared when the room changes and when the switch is turned on.
 *
 * `INVITES_PER_TICK` keeps a full room from becoming a burst of forty calls — Clubhouse throttles
 * a burst, and the rest simply go on the next tick a few seconds later.
 */
const autoInvited = new Set<string>();
/**
 * Whoever was sent DOWN from the stage this room — by the unmute-drop rule or by a moderator's
 * own move — is not asked back up by the switch. A drop is a decision about that person,
 * and a tick that reverses it five seconds later makes the decision impossible to take. Only a
 * moderator's invite lifts it; it lasts the room, and it survives the switch being toggled, which
 * `autoInvited` does not.
 */
const droppedFromStage = new Set<string>();
const INVITES_PER_TICK = 3;

/**
 * Who has already been told what is being discussed, so each arrival hears it once. Seeded with
 * the whole roster when the switch goes on (POST /controls) and cleared with the room.
 */
const topicTold = new Set<string>();
let topicNoticeBusy = false;

/** What `{title}` stands for right now: the pop-out's content, else the room's own topic. */
function topicTitle(): string {
  return popoutContentTitle() || String(lastRoomBody?.topic ?? '').trim();
}

function topicNoticeTick(channel: string, roster: { userId: string; name: string; username?: string }[]): void {
  if (!controls.topicNotice || !controls.topicMessage || topicNoticeBusy) return;
  const me = String(publicSession()?.userId ?? '');
  const fresh = roster.filter(u => u.userId !== me && !topicTold.has(u.userId));
  if (!fresh.length) return;
  // Nothing to name yet — leave them untold, so they hear it once there is a title.
  if (!topicTitle()) return;
  topicNoticeBusy = true;
  void (async () => {
    for (const u of fresh.slice(0, INVITES_PER_TICK)) {
      topicTold.add(u.userId);
      await sayInRoom(channel, controls.topicMessage, u.userId, 'the topic notice', { name: u.name, username: u.username });
    }
  })().finally(() => { topicNoticeBusy = false; });
}
let autoInviteBusy = false;

function autoInviteTick(channel: string, roster: { userId: string; name: string; username?: string; isSpeaker: boolean; isInvitedAsSpeaker: boolean }[]): void {
  if (!controls.autoInvite || autoInviteBusy) return;
  const me = String(publicSession()?.userId ?? '');
  const waiting = roster.filter(u =>
    !u.isSpeaker && !u.isInvitedAsSpeaker && u.userId !== me && !autoInvited.has(u.userId) && !droppedFromStage.has(u.userId));
  if (!waiting.length) return;
  autoInviteBusy = true;
  void (async () => {
    for (const u of waiting.slice(0, INVITES_PER_TICK)) {
      autoInvited.add(u.userId);
      try {
        await call('/invite_speaker', { channel, user_id: Number(u.userId) });
        logger.info({ channel, name: u.name }, '[StudioCall] auto-invited to the stage');
        broadcast({ type: 'studiocall-auto-invited', channel, userId: u.userId, name: u.name } as any);
        // The roster map is refreshed on its own clock and may not know this arrival yet, so the
        // name comes from the poll that found them rather than from the map.
        if (controls.inviteMessage) await sayInRoom(channel, controls.inviteMessage, u.userId, 'the auto invite', { name: u.name, username: u.username });
      } catch (e) {
        // A refusal is per-person (blocked, already leaving, not invitable) — keep them in the
        // set so a room full of them does not retry forever, and carry on with the rest.
        logger.warn({ err: e, name: u.name }, '[StudioCall] auto-invite refused');
      }
    }
    autoInviteBusy = false;
  })();
}

studiocallRouter.get('/room', async (_req, res) => {
  if (!liveChannel) return res.json({ live: false });
  try {
    const data = await getChannel(liveChannel);
    // A room that has been reaped answers with success:false / should_leave rather
    // than an HTTP error. Reporting that as a live room with zero people is how a
    // dead room kept showing as "Hosting · 0 in room".
    if (data?.success === false || data?.should_leave) {
      const dead = liveChannel;
      // The room is gone, so there is nothing to tell Clubhouse — but the audio engine is a
      // separate process that heard none of this and is still holding that channel's Agora
      // connection. Left there it collides with the next room on the same account uid and Agora
      // bans one of the two (error 123) — the "I was dropped from a room".
      await audioLeave().catch(() => {});
      stopPing();
      return res.json({ live: false, ended: dead, reason: data?.error_message || 'the room no longer exists' });
    }
    // get_channel carries no num_all / num_speakers — the counts come from users[].
    // Reading the absent fields is why a room with four people showed "0 in room".
    shouldLeaveStreak = 0;
    const users = Array.isArray(data?.users) ? data.users : [];
    const roster = await Promise.all(users.map(async (u: any) => ({
      userId: String(u.user_id),
      name: u.name,
      username: u.username,
      isSpeaker: !!u.is_speaker,
      isModerator: !!u.is_moderator || recentlyPromoted(String(u.user_id)),
      isInvitedAsSpeaker: !!u.is_invited_as_speaker,
      photoUrl: await localAvatar(u.photo_url),
      // Read off Clubhouse's own field, not `photoUrl`: a face that failed to download is still
      // a face, and must not read as "no photo" to the anonymous-account rule.
      hasPhoto: !!u.photo_url,
    })));
    lastRoomBody = {
      live: true,
      mode: liveMode,
      channel: liveChannel,
      topic: data?.topic ?? null,
      numAll: roster.length,
      numSpeakers: roster.filter(u => u.isSpeaker).length,
      // Whether the room's text chat is open, and what this account may do in it —
      // the toggle used to assume "on" and drift out of step with the real room.
      chatEnabled: !!data?.is_chat_enabled,
      canPostToChat: data?.user_capabilities?.can_post_to_chat !== false,
      canDisableChat: !!data?.user_capabilities?.can_disable_room_chat,
      // The mic. `can_speak` is the room's own answer to "may this account take the stage" —
      // read it rather than guessing from moderator status, because an open room says yes to
      // everyone and a closed one says no to a moderator's guest.
      canSpeak: data?.user_capabilities?.can_speak === true,
      onStage: roster.some(u => u.userId === String(publicSession()?.userId) && u.isSpeaker),
      /**
       * May this account CLOSE the room — the gate on End room, everywhere it is drawn.
       *
       * Not `mode === 'host'`, which is the wrong question and was the bug: `liveMode` is only
       * ever `host` for a room THIS PROCESS created, so a room started on the phone, opened before
       * a restart, or re-joined from the hallway reads `guest` and hid End from the person who
       * owns it. What Clubhouse actually gates `end_channel` on is moderator, and it says so on
       * our own roster row. `liveMode` stays in the OR for the moment between creating a room and
       * the first roster arriving.
       */
      iAmModerator: liveMode === 'host'
        || roster.some(u => u.userId === String(publicSession()?.userId) && u.isModerator),
      // The pinned link, as every client draws it: Clubhouse keeps a list and shows the last one.
      links: (Array.isArray(data?.links) ? data.links : []).map((l: any) => ({
        linkId: l.link_id,
        title: l.title ?? null,
        displayLink: l.display_link ?? null,
        targetLink: l.target_link ?? null,
        rootLink: l.root_link ?? null,
        fromName: l.from_name ?? null,
      })),
      canPinLinks: data?.is_pinned_links_available !== false,
      // **The answer to a raised hand.** `is_invited_as_speaker` on our OWN row is the moderator
      // saying yes — the invitation is issued and waiting to be taken up, and nothing happens
      // until this account acts on it (it is the moderator's invitation coming back, not
      // somebody asking). It is what turns the ✋ button into **Join Room**.
      invitedToSpeak: roster.some(u => u.userId === String(publicSession()?.userId) && u.isInvitedAsSpeaker && !u.isSpeaker),
      handraiseEnabled: !!data?.is_handraise_enabled,
      // Who has actually asked for the stage. Not derivable from the roster — see the
      // handraise pump — and moderator-only, so an empty list in a room we do not moderate
      // means "cannot see", which is why the tab reads `handsVisible` before drawing a count.
      hands,
      handsVisible: !handsRefused,
      speakers: roster.filter(u => u.isSpeaker),
      listeners: roster.filter(u => !u.isSpeaker),
      // The room's details, for the card that opens under its name. Clubhouse rooms have no
      // description: this is everything `get_channel` says ABOUT the room rather than who is in
      // it, and the two settings with a live setter carry their option lists so the tab
      // draws Clubhouse's own labels, not ours.
      details: {
        house: data?.social_club?.name ?? data?.privacy_settings?.display_text ?? null,
        privacy: data?.privacy_settings?.tooltip_text ?? data?.privacy_settings?.type ?? null,
        language: data?.language ?? null,
        url: data?.url ?? null,
        createdAt: data?.time_created ?? null,
        stage: {
          value: typeof data?.handraise_queue_setting === 'number' ? data.handraise_queue_setting : null,
          options: (Array.isArray(data?.handraise_queue_options) ? data.handraise_queue_options : [])
            .map((o: any) => ({ value: o.value, label: o.label, hint: o.sub_label ?? null })),
          canEdit: data?.user_capabilities?.can_edit_handraise_queue === true,
        },
        chat: {
          value: typeof data?.chat_permission === 'number' ? data.chat_permission : null,
          options: (Array.isArray(data?.chat_permission_options) ? data.chat_permission_options : [])
            .map((o: any) => ({ value: o.value, label: o.label, hint: o.sub_label ?? null })),
          canEdit: data?.user_capabilities?.can_disable_room_chat === true,
        },
      },
    };
    // Moderator-gated for the same reason the buttons are: Clubhouse refuses the call to anybody
    // else, and a refusal per person per tick is a rate limit waiting to happen.
    reconcileStageRole(!!lastRoomBody.onStage);
    if (lastRoomBody.iAmModerator) autoInviteTick(liveChannel, roster);
    autoKickTick(liveChannel, roster, !!lastRoomBody.iAmModerator);
    // Who was here, counted — attendance per room, and "spoken" per room the desk moderates.
    void touchPeople(liveChannel, roster, !!lastRoomBody.iAmModerator);
    kickAnonTick(liveChannel, roster, !!lastRoomBody.iAmModerator);
    autoModTick(liveChannel, roster, !!lastRoomBody.iAmModerator);
    // Any member MAY post a line, which is why this used not to be gated — and in a 79-person room
    // the desk was only listening to, that meant a "We are discussing: <their topic>" at every
    // arrival, a 400 or 429 for each, and the account under Cloudflare's limit for the whole show,
    // which is what refused the operator's own raised hand. The desk's automations
    // speak only in rooms the desk runs; `sayInRoom` holds the same line for the floor rule.
    if (lastRoomBody.iAmModerator) topicNoticeTick(liveChannel, roster);
    res.json(lastRoomBody);
  } catch (e) {
    /**
     * A FAILED ASK IS NOT A DEAD ROOM. This catch used to call `stopPing()`, and that did not
     * merely misreport — `stopPing()` stops the creator's 20s `active_ping`, and Clubhouse reaps
     * a room whose creator stops pinging. So one transient error ENDED a room that was alive, and
     * then told the operator "the room no longer exists", which is why it read as the room ending
     * on its own. The trigger was our own poll rate: HTTP 429 on `/get_channel`.
     *
     * What means reaped is the BODY, not the status. `should_leave` / `success:false` arrives on
     * a 200 — handled above — and it also arrives on a **400**, which used to land here and be
     * reported as "could not reach Clubhouse", so the tab sat on a stale roster of a room this
     * account was no longer in, polling it forever. That is the state the logs caught: 21
     * `/get_channel_messages` and 15 `/get_channel` in a row, every one of them 400 carrying
     * `should_leave:true, "Invalid request."`, under a banner saying the room was still up.
     *
     * It is read on the SECOND consecutive one, never the first. Acting on it stops the creator's
     * 20s `active_ping`, and a room whose creator stops pinging is reaped by Clubhouse — so a
     * single spurious answer must not be able to end a live room. That is the reaped-room bug from the other
     * side, and why this is a counter rather than a branch.
     *
     * Everything else — 429, 5xx, a socket error — means we could not ask, so the room stands,
     * the ping keeps running, and the last good answer is repeated with `stale` set. `ended` is
     * deliberately NOT set there: it is what the tab raises a notice on.
     */
    const status = e instanceof ClubhouseError ? e.status : 0;
    const body = e instanceof ClubhouseError ? (e.body as any) : null;
    if (body?.should_leave || body?.success === false) {
      shouldLeaveStreak++;
      if (shouldLeaveStreak >= SHOULD_LEAVE_CONFIRM) {
        const dead = liveChannel;
        logger.warn(`[StudioCall] Clubhouse answered should_leave ${shouldLeaveStreak}x for ${dead} — this account is not in that channel any more.`);
        await audioLeave().catch(() => {});
        stopPing();
        return res.json({ live: false, ended: dead, reason: body?.error_message || 'Clubhouse says this account is no longer in the room' });
      }
    } else {
      shouldLeaveStreak = 0;
    }
    logger.warn({ err: e, channel: liveChannel, status }, '[StudioCall] room poll failed — the room stands, the ping keeps running');
    const reason = status === 429
      ? 'Clubhouse is rate-limiting us — the room is still up'
      : `Could not reach Clubhouse${status ? ` (${status})` : ''} — the room is still up`;
    res.json({ ...(lastRoomBody ?? { live: true, mode: liveMode, channel: liveChannel }), stale: true, staleReason: reason });
  }
});

// Ends the tracked room, an explicitly named one, or — if this process has lost
// track — whichever live room this account created.
studiocallRouter.post('/room/end', async (req, res) => {
  const channel = req.body?.channel ? String(req.body.channel) : (liveChannel ?? await findMyLiveChannel());
  if (!channel) return res.json({ live: false, reason: 'no live room found for this account' });
  try {
    await call('/end_channel', { channel });
    await audioLeave().catch(() => {});
    stopPing();
    res.json({ live: false, ended: channel });
  } catch (e) { stopPing(); sendErr(res, e); }
});

// The hallway is the only way back to a room this process forgot.
async function findMyLiveChannel(): Promise<string | null> {
  try {
    const me = String(publicSession()?.userId ?? '');
    const data = await call('/get_feed_v3', {});
    const mine = (Array.isArray(data?.items) ? data.items : [])
      .map((i: any) => i?.channel)
      .filter(Boolean)
      .find((c: any) => String(c.creator_user_profile_id) === me);
    return mine ? String(mine.channel) : null;
  } catch { return null; }
}

// Re-adopt a room this process lost, so End room and the roster work again.
studiocallRouter.post('/room/recover', async (_req, res) => {
  try {
    const channel = await findMyLiveChannel();
    if (!channel) return res.json({ live: false, reason: 'no live room found for this account' });
    startPing(channel, 'host');
    res.json({ live: true, recovered: channel });
  } catch (e) { sendErr(res, e); }
});

// The hallway. /get_channels is retired (404) — /get_feed_v3 is the live listing.
// Avatars are deliberately not pulled here: a feed is dozens of faces and each one
// costs a fetch + writeImageFile. They are cached on join, where they are needed.
studiocallRouter.get('/feed', async (_req, res) => {
  try {
    const data = await call('/get_feed_v3', {});
    const rooms = (Array.isArray(data?.items) ? data.items : [])
      .map((i: any) => i?.channel)
      .filter(Boolean)
      .map((c: any) => ({
        channel: String(c.channel),
        topic: c.topic ?? null,
        numAll: c.num_all ?? 0,
        numSpeakers: c.num_speakers ?? 0,
        isPrivate: !!c.is_private,
        house: c.social_club?.name ?? c.club?.name ?? null,
        speakers: (c.users ?? []).filter((u: any) => u.is_speaker).map((u: any) => u.name).slice(0, 4),
      }));
    res.json({ rooms });
  } catch (e) { sendErr(res, e); }
});

// Join a room. Outward-facing — you appear in the room to everyone in it — so this
// only runs on an explicit request.
studiocallRouter.post('/room/join', async (req, res) => {
  try {
    const channel = req.body?.channel;
    if (!channel) return res.status(400).json({ error: 'channel required' });
    // One room at a time, in both legs. Agora rejects a joinChannel on a client that is
    // already in a channel, so the RTC leg has to be torn down before the new join — and
    // Clubhouse has to be told too, or the hallway keeps showing you in the old room.
    // A hosted room is LEFT, not ended: whoever else is in it keeps talking (it lives
    // until Clubhouse reaps it for want of a ping).
    const previous = liveChannel;
    const switching = !!previous && previous !== String(channel);
    if (switching) {
      await call('/leave_channel', { channel: previous }).catch(() => {});
      await audioLeave().catch(() => {});
    }
    // `attribution_source` is not optional-with-a-default: sent on its own it makes
    // /join_channel answer 400 with an EMPTY error_message, which is Clubhouse's way of
    // saying the request shape is wrong. The pair has to travel together —
    // attribution_details is base64 of {"is_explore":false,"rank":1}, exactly what the
    // mobile client sends when you tap a room in the hallway.
    /**
     * A join that fails after the old room was left leaves us in NEITHER — and the tracked room
     * still names the one we walked out of, so the tab goes on drawing its roster, its chat and
     * its Leave button for a room this account is no longer in. Tear the tracking down on the way
     * out, so the failure reads as "you are in no room, here is why" rather than as nothing having
     * happened. Nothing is torn down when the join was not a switch: there, the old room is the
     * one we tried to rejoin and it is still ours.
     */
    const data = await call('/join_channel', {
      channel: String(channel),
      attribution_source: 'feed',
      attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwicmFuayI6MX0=',
    }).catch(async (e) => {
      if (switching) { await audioLeave().catch(() => {}); stopPing(); }
      throw e;
    });
    startPing(String(channel), 'guest');
    // Joining from the hallway starts as audience — unless the room already has us on its
    // stage. A moderator walking back into their own room is a speaker from the first frame,
    // and the join response says so; joining the RTC leg as audience there is the audience trap by
    // another door: on stage in Clubhouse, publishing nothing.
    const me = String(publicSession()?.userId ?? '');
    const alreadyOnStage = (Array.isArray(data?.users) ? data.users : [])
      .some((u: any) => String(u.user_id) === me && u.is_speaker);
    if (alreadyOnStage) { liveSpeaker = true; saveRoom(); }
    subscribeRoomEvents(data, String(channel));
    const audio = await connectAudio(data, String(channel), alreadyOnStage);
    const users = await Promise.all(
      (data?.users ?? []).map(async (u: any) => ({
        userId: String(u.user_id),
        name: u.name,
        username: u.username,
        isSpeaker: !!u.is_speaker,
        isModerator: !!u.is_moderator,
        photoUrl: await localAvatar(u.photo_url),
      })),
    );
    res.json({
      joined: true,
      channel: String(channel),
      topic: data?.topic ?? null,
      users,
      // Proof the audio leg has what it needs, without exposing the token itself.
      hasRtcToken: !!data?.token,
      audio,
      left: previous && previous !== String(channel) ? previous : null,
    });
  } catch (e) { sendErr(res, e); }
});

/** Walk out of whatever room we are in: Clubhouse first, then the RTC leg, then the pings. */
async function leaveLiveRoom(): Promise<string | null> {
  const channel = liveChannel;
  if (!channel) return null;
  try {
    await call('/leave_channel', { channel });
    await audioLeave().catch(() => {});
    stopPing();
    return channel;
  } catch (e) { stopPing(); throw e; }
}

studiocallRouter.post('/room/leave', async (_req, res) => {
  if (!liveChannel) return res.json({ live: false });
  try {
    res.json({ live: false, left: await leaveLiveRoom() });
  } catch (e) { sendErr(res, e); }
});

/**
 * Close the browser and you walk out of the room — the same bargain the BLE lights already make.
 * The Agora leg lives in the engine on :4018, not in the tab, so without this the room stays
 * joined with the microphone unmuted and no UI anywhere to show it or stop it.
 *
 * ONLY ROOMS WE JOINED. A room we RUN is left alone: Clubhouse reaps a room whose creator stops
 * pinging, so leaving one would throw everybody in it out because the operator shut a laptop.
 * Walking out of someone else's room costs nothing and can be undone by walking back in.
 *
 * "We run it" is the roster's `iAmModerator`, not `liveMode === 'host'` — `host` is only ever true
 * for a room THIS PROCESS created, so a room started on the phone or re-adopted across a restart
 * read `guest` and was abandoned by this watchdog. That is not hypothetical: a `tsx watch` reload
 * while the operator's own room was live closed every admin socket, and 15 s later this walked the
 * desk out of a room it was moderating, mid-show.
 *
 * Warn, then go: the log says what happened and the broadcast lets a tab that comes back later
 * say so out loud, because by the time this runs there is no browser left to ask.
 */
onAdminIdle(async () => {
  if (!liveChannel) return;
  if (liveMode === 'host' || lastRoomBody?.iAmModerator) {
    logger.warn(`[StudioCall] browser closed while RUNNING ${liveChannel} — staying in, leaving could end the room`);
    return;
  }
  if (!(await leaveOnCloseEnabled())) {
    logger.warn(`[StudioCall] browser closed while in ${liveChannel} — auto-leave disabled, still joined with a live mic`);
    return;
  }
  const channel = liveChannel;
  logger.warn(`[StudioCall] browser closed — leaving ${channel} (joined as ${liveMode ?? 'guest'})`);
  broadcast({ type: 'studiocall-auto-left', channel, reason: 'browser-closed' } as any);
  await leaveLiveRoom().catch(err => logger.error({ err }, `[StudioCall] auto-leave of ${channel} FAILED — still in the room`));
});

/** `STUDIOCALL_LEAVE_ON_ADMIN_CLOSE=0` keeps the room when the browser goes. Default on. */
async function leaveOnCloseEnabled(): Promise<boolean> {
  return env.LEAVE_ON_ADMIN_CLOSE;
}

// ── audio engine (StudioCall service on :4018) ──────────────────────────────

// Hand the RTC credential from Clubhouse's /join_channel to the audio engine. The
// token never reaches the browser. Returns a status object rather than throwing:
// a room that opened but has no audio is still a room, and the UI should say so.
async function connectAudio(joinResponse: any, channel: string, asSpeaker: boolean) {
  const token = joinResponse?.token;
  const appId = getAgoraKey();
  const uid = Number(joinResponse?.rtc_uid ?? publicSession()?.userId ?? 0);
  if (!token) return { connected: false, reason: 'Clubhouse returned no RTC token' };
  if (!appId) return { connected: false, reason: 'no Agora app id in the session' };
  try {
    // A fresh or restarted engine has no pins; put the known-good pair back before
    // joining, since the engine applies devices at join time.
    await applyRememberedDevices();
    await audioJoin({ appId, token, channel, uid, asSpeaker });
    startWorkingWatch();
    return { connected: true, uid, asSpeaker };
  } catch (e) {
    return { connected: false, reason: (e as Error).message };
  }
}

/**
 * Restart capture on the room we are in.
 *
 * A device or audio-profile change does not take on a joined channel — the setting moves and
 * the running capture stays on the old endpoint — so every one of them ends in a rejoin. The
 * RTC token cannot be reused, which is why this has to go back to Clubhouse for a fresh one
 * rather than asking the engine to reconnect itself.
 */
async function rejoinLiveRoom(): Promise<{ rejoined: boolean; reason?: string }> {
  if (!liveChannel) return { rejoined: false };
  await audioLeave().catch(() => {});
  const data = await call('/join_channel', { channel: liveChannel });
  subscribeRoomEvents(data, liveChannel);
  const audio = await connectAudio(data, liveChannel, liveSpeaker);
  return { rejoined: audio.connected, reason: audio.connected ? undefined : audio.reason };
}

/**
 * The room's live feed (studiocall/pubsub.ts), started on every join because the token it needs
 * is minted by that join. Today it carries one thing the polls cannot: reactions — Clubhouse never
 * writes them into the message history. A reaction becomes a chat line ("reacted ❤️ to Sam") for
 * the lists and the chat overlay, and a `studiocall-reaction` for the speaker overlay, which
 * floats the emoji over the target's face for the time Clubhouse gives it.
 */
function subscribeRoomEvents(joinResponse: any, channel: string): void {
  const me = String(publicSession()?.userId ?? '');
  if (startRoomPubsub(joinResponse, channel, me, e => { void onRoomEvent(e, channel, me); })) {
    liveFeed = { token: String(joinResponse.pubnub_token), origin: String(joinResponse.pubnub_origin || '') };
    if (liveChannel === channel) saveRoom();
  }
}

/**
 * A line in the desk's chat list from StudioMate itself — "<host> muted X", "X was muted, not by
 * this desk". Never posted to the room and never on air (`auto`): it is the operator's record of
 * who did what to whose microphone, answering "who muted them?" without opening the journal.
 */
let deskLineN = 0;
function deskLine(text: string, channel: string): void {
  const id = `desk-${Date.now()}-${++deskLineN}`;
  chatSeen.add(id);
  broadcast({ type: 'studiocall-chat', channel, items: [{
    id, at: Date.now(), text, userId: '', author: 'StudioCall', avatar: null,
    isModerator: false, isSpeaker: false, isMe: false, auto: true,
  } satisfies RoomChatMessage] } as any);
}

// When this desk last shut each mic. The room announces every mute as `mute_speaker` with no
// actor, so the desk tells its own apart by time: a mute it issued in the last few seconds is
// its own, anything else came from another moderator's phone (or the speaker themselves).
const DESK_MUTE_WINDOW_MS = 8_000;
const deskMutedAt = new Map<string, number>();
const deskMutedRecently = (userId: string) => Date.now() - (deskMutedAt.get(userId) ?? 0) < DESK_MUTE_WINDOW_MS;
const meName = () => String(publicSession()?.name ?? 'This desk');

// A roster change announced by the room itself. The cache is dropped so the next read is fresh,
// which is what makes a promotion or a stage move made from the phone show here inside a poll.
const ROSTER_EVENTS = new Set(['make_moderator', 'add_speaker', 'remove_speaker', 'invite_speaker', 'uninvite_speaker', 'join_channel', 'leave_channel', 'block_from_channel']);

async function onRoomEvent(e: RoomEvent, channel: string, me: string): Promise<void> {
  if (ROSTER_EVENTS.has(e.action)) { channelCache = null; return; }
  if (e.action === 'mute_speaker') {
    const prof = e.user_profile as any;
    const uid = String(e.user_id ?? prof?.user_id ?? '');
    if (!uid) return;
    const name = String(prof?.name ?? roster.get(uid)?.name ?? uid);
    const flag = (e as any).muted ?? (e as any).is_muted;
    if (flag === false) { deskLine(`${uid === me ? meName() : name} was unmuted`, channel); return; }
    if (deskMutedRecently(uid)) return; // already said by the desk's own route
    deskLine(uid === me ? `${meName()} was muted — not by this desk` : `${name} was muted — not by this desk`, channel);
    return;
  }
  if (e.action !== 'new_channel_reaction') return;
  const from = e.action_user_profile as any;
  const to = e.target_user_profile as any;
  const emoji = String((e.reaction as any)?.emoji ?? '');
  if (!emoji || !from?.id) return;
  const userId = String(from.id);
  const targetUid = String(to?.id ?? '');
  const known = roster.get(userId);
  const id = String(e.message_id ?? `react-${Date.now()}`);
  const ttlMs = Math.max(1500, (Number((e.reaction as any)?.display_time_s) || 4) * 1000);
  const line: RoomChatMessage = {
    id, at: Date.now(),
    text: `reacted ${emoji}${to?.name ? ` to ${to.name}` : ''}`,
    userId, author: String(from.name ?? known?.name ?? ''),
    avatar: await localAvatar(from.photo_url) ?? known?.photoUrl ?? null,
    isModerator: !!known?.isModerator, isSpeaker: !!known, isMe: userId === me,
    reaction: emoji, target: String(to?.name ?? ''),
  };
  chatSeen.add(id);
  broadcast({ type: 'studiocall-chat', channel, items: [line] } as any);
  broadcast({ type: 'studiocall-reaction', channel, id, emoji, targetUid, fromName: line.author, ttlMs } as any);
}

/**
 * `channel` is the ROOM we are in; `joined.channel` is the room the audio engine is attached to.
 * They are the same thing when all is well and the gap between them is the whole fault condition —
 * in a room, silent — so any surface that has to draw that state needs both, and the status-bar
 * button polls this alone rather than pairing it with a /room call.
 */
studiocallRouter.get('/audio/health', async (_req, res) => {
  try { res.json({ ...await audioHealth(), channel: liveChannel }); } catch (e) { sendErr(res, e); }
});

studiocallRouter.get('/audio/devices', async (_req, res) => {
  try { res.json(await audioDevices()); } catch (e) { sendErr(res, e); }
});

// Devices are pinned by name so they survive Windows renumbering endpoints.
//
// Setting a capture device on a joined channel changes the setting and leaves the
// running capture on the old endpoint — meters fall to zero or audio garbles, with
// no error anywhere. So a change made while in a room is followed by a rejoin, which
// is the only thing that restarts capture. The RTC token cannot be reused, so the
// rejoin has to go back to Clubhouse for a fresh one; the engine cannot do this alone.
studiocallRouter.post('/audio/devices', async (req, res) => {
  try {
    const appId = getAgoraKey() ?? undefined;
    const pinned = await audioSetDevices({ appId, ...(req.body ?? {}) });
    // Remember what the ENGINE ended up pinned to, not what was asked for. Windows renumbers
    // an endpoint inside its own name, so the pin can resolve to a name spelled differently
    // from the one that was sent — storing the request would keep re-saving a name no device
    // answers to any more, and the select, which matches by name, would read it as "not set".
    rememberSelection(pinned?.wantRecordingName ?? null, pinned?.wantPlaybackName ?? null);
    const out = { ...pinned, ...(await rejoinLiveRoom()) };
    journal('picked devices', { rec: req.body?.recordingName ?? null, play: req.body?.playbackName ?? null }, true);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

/**
 * The dropdown dance, as one button.
 *
 * After a restart the pins read correctly in the tab and the room is still silent, and the only
 * thing that has ever fixed it is setting both selects to "— not set —" and picking the same two
 * devices again. Re-picking them from the tab does nothing, because pinning a device that is
 * already the engine's current one is a no-op inside the SDK — nothing reopens. Going out to the
 * Windows default first is a real device change, so coming back is a real device change too, and
 * that is what reopens the endpoints.
 *
 * So: clear the pins, rejoin, put the same pair back, rejoin again. Same two rejoins the manual
 * version costs. The pair is the one already remembered, so this never changes the routing —
 * it only forces it to be applied again.
 */
studiocallRouter.post('/audio/reset', async (_req, res) => {
  const pair = { ...deviceMemory.selected };
  try {
    const appId = getAgoraKey() ?? undefined;
    await audioSetDevices({ appId, recordingName: null, playbackName: null });
    await rejoinLiveRoom();
    const pinned = await audioSetDevices({
      appId, recordingName: pair.rec, playbackName: pair.play, stereo: deviceMemory.stereo,
    });
    const again = await rejoinLiveRoom();
    logger.info(`[StudioCall] audio reset — re-pinned ${pair.rec ?? 'default'} → ${pair.play ?? 'default'}, rejoined=${again.rejoined}`);
    journal('pressed Reset audio', { rec: pair.rec, play: pair.play }, true);
    res.json({ ...pinned, ...again, reset: pair });
  } catch (e) {
    // A reset that dies halfway leaves the engine on the Windows defaults, which is worse
    // than where it started — put the pair back before reporting the failure.
    await audioSetDevices({ recordingName: pair.rec, playbackName: pair.play }).catch(() => {});
    sendErr(res, e);
  }
});

/*
 * ── Who has held the floor, and for how long ─────────────────────────────────
 *
 * A moderator's job in a big room is to notice what nobody can hold in their head: that one
 * speaker has had eleven minutes and another has had forty seconds. The engine already says who
 * is talking *right now*; this is the integral of that, per person, for as long as we have been
 * in this room.
 *
 * **Accumulated here, on our own clock, not on a client's poll.** The panel that shows this is
 * mounted and unmounted all show long — a pop-out closed, a tab switched — and a tally that only
 * advanced while somebody was looking would be a tally of when the operator was watching. It also
 * has to survive both surfaces reading it at once, which a per-client count could not.
 *
 * The clock STOPS rather than guessing when the engine goes quiet: a tick that arrives late adds
 * at most a few ticks' worth, so a content-server pause cannot hand somebody four minutes they
 * did not speak. Everything resets when the channel changes — the number means "in this room".
 */
const TALK_TICK_MS = 500;
const TALK_MAX_STEP_MS = TALK_TICK_MS * 4;
const talk = { channel: null as string | null, since: 0, lapAt: 0, lastAt: 0, ms: new Map<string, number>() };

function resetTalk(channel: string | null): void {
  talk.channel = channel;
  talk.since = channel ? Date.now() : 0;
  talk.lapAt = 0;
  talk.lastAt = 0;
  talk.ms.clear();
}

/** `since` is when the room's clock started; `lapAt` the last Lap press (0 = none yet). */
function talkBody(): { since: number; lapAt: number; totals: Record<string, number> } {
  return { since: talk.since, lapAt: talk.lapAt, totals: Object.fromEntries(talk.ms) };
}

async function talkTick(): Promise<void> {
  if (!currentRoom().channel) { if (talk.channel) resetTalk(null); return; }
  let d: any;
  try { d = await audioSpeaking(); } catch { talk.lastAt = 0; return; }
  const channel: string | null = d?.joined?.channel ?? null;
  if (!channel) { if (talk.channel) resetTalk(null); return; }
  if (channel !== talk.channel) resetTalk(channel);
  const now = Date.now();
  const step = talk.lastAt ? Math.min(now - talk.lastAt, TALK_MAX_STEP_MS) : 0;
  talk.lastAt = now;
  if (!step) return;
  for (const a of Array.isArray(d?.active) ? d.active : []) {
    const uid = String(a?.uid ?? '');
    if (!uid) continue;
    talk.ms.set(uid, (talk.ms.get(uid) ?? 0) + step);
    addTalk(uid, step);
  }
}

setInterval(() => { void talkTick(); }, TALK_TICK_MS);

studiocallRouter.get('/audio/speaking', async (_req, res) => {
  // Carried on the report the roster already polls rather than on a second endpoint: it is the
  // same question one derivative apart, and a separate poll would double the traffic for it.
  try { res.json({ ...(await audioSpeaking() as object), talk: talkBody() }); } catch (e) { sendErr(res, e); }
});

/** Start the room's talk clock again from zero — the moderator's own reset. */
studiocallRouter.post('/audio/talk/reset', (_req, res) => {
  resetTalk(talk.channel);
  res.json({ ok: true, talk: talkBody() });
});

/**
 * Lap: the segment clock in the Live Chat bar starts again, the room's total does not. Server
 * state like the rest of the clock, so the docked tile and the pop-out read the same lap.
 */
studiocallRouter.post('/audio/talk/lap', (_req, res) => {
  talk.lapAt = talk.channel ? Date.now() : 0;
  res.json({ ok: true, talk: talkBody() });
});

studiocallRouter.post('/audio/mute', async (req, res) => {
  try {
    const out = await audioMute(!!req.body?.muted);
    journal(req.body?.muted ? 'muted the mic' : 'unmuted the mic');
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

// The other direction from /audio/mute: how loud the room plays out of the pinned
// playback device, which on this rig is what OBS hears. The engine holds the value,
// so a rejoin (every device change is one) keeps it — see applyOutput() there.
studiocallRouter.post('/audio/output', async (req, res) => {
  const patch: { volume?: number; muted?: boolean } = {};
  if (req.body?.volume !== undefined) patch.volume = Number(req.body.volume);
  if (req.body?.muted !== undefined) patch.muted = !!req.body.muted;
  try {
    const out = await audioOutput(patch);
    journal(
      patch.muted !== undefined
        ? (patch.muted ? 'muted the room' : 'unmuted the room')
        : `set the room level to ${out?.outVolume ?? patch.volume}%`,
      patch,
      false,
      'room level',
    );
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

// ── on-air controls ─────────────────────────────────────────────────────────

// What StudioCall is putting on the OBS canvas right now. Two switches, both of them
// live decisions an operator makes mid-show, so they persist across the content-server
// reload the way the room does — and they are broadcast, because the surfaces that obey
// them are browser sources with no other way to hear about a click in the tab.
//
// These say what is ON AIR. The Overlay tab's own eye icon still parks the whole layer;
// it is the master switch, this is the show control.
const CONTROLS_FILE = join(env.DATA_DIR, 'controls.json');

interface StudioCallControls {
  /** Speaker DPs hop with the voice. Off, the faces still appear — they just hold still. */
  bounce: boolean;
  /** The room's text chat is drawn on the OBS canvas. */
  chatOverlay: boolean;
  /**
   * What the chat layer draws: `all` is the rolling list, `selected` is the one line
   * the operator picked and nothing else. The mode persists; the pick does not (see
   * `chatPin` below), so a reload never puts a stale line back on air.
   */
  chatMode: 'all' | 'selected';
  /**
   * Put whoever is talking on the CHinfocard layer by themselves. The loudest face other than
   * the operator's, once it has held the floor for `AUTO_CARD_HOLD_MS`, has its profile read
   * and put up; the layer's own auto-hide takes it down. Off, the card is only ever a click.
   */
  autoCard: boolean;
  /** Keep the OBS headline (1_Headline, the typewriter) on the room's topic: typed on join and
   *  whenever the topic changes, taken down on leave. Off, the headline is only ever a click. */
  autoHeadline: boolean;
  /**
   * Invite everybody who walks in up to the stage, without being asked.
   *
   * For a show run as a panel rather than a broadcast: the operator would otherwise be watching
   * the roster all night and clicking a face every time somebody arrives. It is moderator-only
   * (Clubhouse refuses `/invite_speaker` to anybody else) and it invites — the person still
   * has to accept, so nobody is put on air by a toggle.
   */
  autoInvite: boolean;
  /**
   * What the desk says in the room chat when `autoInvite` asks somebody up — `{speaker}` is
   * their name, `{name}` their username. Empty (the default) posts nothing: the invite itself is silent, and a line the
   * operator did not write is not the desk's to make up. Set from the Live Chat Settings tab.
   */
  inviteMessage: string;
  /**
   * Tell each NEW arrival what is being discussed — `topicMessage` posted in the room chat once
   * per person who walks in after the switch went on. `{title}` is what the pop-out is showing
   * (routes/popoutContent.ts), or the room's own topic when the pop-out is empty; `{speaker}` and
   * `{name}` are the arrival's. Off by default and per show, like the invite line.
   */
  topicNotice: boolean;
  topicMessage: string;
  /**
   * One voice at a time: whoever took the floor keeps it, and anybody who talks over them is
   * muted and told why in the room chat.
   *
   * **Moderators are exempt** — a moderator cutting in is the show being run, not somebody
   * speaking out of turn, and a desk that mutes its own host is worse than no rule at all.
   * Off by default: this takes somebody's microphone without being asked, so it is a decision
   * the operator makes per show rather than a default they discover mid-conversation.
   */
  autoMute: boolean;
  /**
   * Say in the room chat when whoever holds the floor passes a minute — the nudge described at
   * `FLOOR_LONG_NOTICE`.
   *
   * **Its own switch, not a part of `autoMute`.** The two used to be one flag, so the only way to
   * hear "you have been talking for a minute" was to also hand the desk the power to cut somebody
   * off mid-sentence — and a panel that wants the timekeeping almost never wants the microphone
   * taken. They share the floor tracker and nothing else: this one only ever posts a line.
   */
  floorNotice: boolean;
  /**
   * Say in the room chat WHY a microphone just went dead — the `AUTO_MUTE_NOTICE` line.
   *
   * On by default, and that default is the whole reason the line exists: a mic that shuts with no
   * explanation reads as a dropped connection, and the person spends the next minute asking "can
   * you hear me?", which is louder than the interruption was. But a desk running a formal panel
   * may want the rule enforced without a running commentary in the chat, so it is a switch. It
   * only ever suppresses the LINE — `autoMute` still takes the microphone.
   */
  muteNotice: boolean;
  /**
   * Off the stage after too many unmutes: a speaker whose mic OPENS `unmuteDropCount` times
   * within `UNMUTE_DROP_WINDOW_MS` (30 s) is moved to the audience with `/uninvite_speaker`.
   * The count is closed→open transitions seen on Agora's own mute callbacks, so a mic
   * the desk shut and they opened again counts — that is exactly the person this is for. Off by
   * default: it takes somebody off the stage without being asked, like `autoMute`, and
   * moderators are exempt.
   */
  unmuteDrop: boolean;
  unmuteDropCount: number;
  /**
   * The bridge between the two chats, one switch per direction. `bridgeYtToRoom` posts each
   * YouTube viewer's line into the room chat as "[YT][Name] text"; `bridgeRoomToYt` queues
   * each room line into the YouTube chat as "[CH][Name] text", behind the prompts and
   * thank-yous like every other send. Both off by default: the second direction costs YouTube
   * quota (50 units an insert) and a busy room would spend the day's allowance in an hour.
   *
   * **The desk's own account is never relayed, in either direction.** That is the loop guard: a
   * relayed line comes back on the next poll as the desk's own message (`isMe` in the room,
   * `isOwner` on YouTube), and skipping the account skips it — along with the prompts, the
   * thank-yous and the operator's typed replies, which are that feed's business.
   */
  bridgeYtToRoom: boolean;
  bridgeRoomToYt: boolean;
  /**
   * Throw anonymous accounts out of the room as the poll finds them — `/block_from_channel`,
   * the same call `autoKick` makes, so they cannot come straight back in. "Anonymous" is read
   * off the roster row alone (`isAnonAccount()`): no profile photo, or a name / username that
   * starts with "anon". Off by default: it removes people without being asked, and a friend
   * who never set a photo is removed with the rest. Never the operator, never a moderator, and
   * moderator-gated because Clubhouse refuses the call to anybody else.
   */
  kickAnon: boolean;
  /**
   * How long somebody flagged `autoKick` in the Speaker Status dialog may stay in a room before
   * they are removed from it. One number for everybody — it is shown at the top of that dialog.
   */
  autoKickMinutes: number;
  /**
   * How the CHinfocard plays. `bands` is the card as it always was — picture, name strip and text
   * together. `sequence` is two acts: the picture alone, full card, for `cardImageHold` s, out;
   * then the text alone, formatted, for `cardTextHold` s, out. Each act has its own effect.
   */
  cardStyle: 'bands' | 'sequence';
  cardImageHold: number;
  cardImageEffect: string;
  cardTextHold: number;
  cardTextEffect: string;
  /**
   * How a comment arrives on the canvas — a new line in the rolling list, or the one held up
   * on its own in `selected`. Both modes wear the pair: the held card is what the audience
   * actually reads, and it used to appear and vanish between two frames. The arrival animates
   * over `chatAnimMs`, the exit over `chatFadeOutMs`.
   */
  /** Effect ids from the shared animation library, stored verbatim — the overlay hands them
   *  straight to `effectStyle()`, so there is no second vocabulary to keep in step. */
  chatAnim: string;
  /** How a line leaves. 'none' drops it, which is what the rolling list did for years. */
  chatAnimOut: string;
  chatAnimMs: number;
  chatFadeOutMs: number;
}

// A room-chat line, not an essay — Clubhouse's own composer stops well short of this.
const INVITE_MESSAGE_MAX = 500;
const CHAT_ANIMS = ['fadeIn', 'blurIn', 'zipInRight', 'zipInLeft', 'riseIn'] as const;
const CHAT_ANIMS_OUT = ['none', 'fadeOut', 'blurOut', 'zipOutRight', 'zipOutLeft', 'sinkOut'] as const;
// The sequence card's two acts pick from these; the overlay maps each to an in/out pair.
const CARD_EFFECTS = ['fade', 'blur', 'slideIn', 'slideUp', 'slideRight'];
const clampHold = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(60, Math.round(n))) : fallback;
};
// The three names this used to store, before the ids became the shared library's own.
const LEGACY_ANIM: Record<string, string> = { scroll: 'riseIn', fade: 'fadeIn', blur: 'blurIn' };
const ANIM_MS_MIN = 100;
const ANIM_MS_MAX = 2000;
const clampAnimMs = (v: unknown, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(ANIM_MS_MIN, Math.min(ANIM_MS_MAX, n)) : fallback;
};

let controls: StudioCallControls = {
  bounce: true, chatOverlay: false, chatMode: 'all', autoCard: false, autoHeadline: false, autoInvite: false,
  autoMute: false, floorNotice: false, muteNotice: true, unmuteDrop: false, unmuteDropCount: 3, autoKickMinutes: 5, inviteMessage: '',
  bridgeYtToRoom: false, bridgeRoomToYt: false, kickAnon: false,
  topicNotice: false, topicMessage: 'We are discussing: {title}',
  cardStyle: 'bands', cardImageHold: 5, cardImageEffect: 'fade', cardTextHold: 5, cardTextEffect: 'fade',
  chatAnim: 'fadeIn', chatAnimOut: 'fadeOut', chatAnimMs: 350, chatFadeOutMs: 400,
};
try { controls = { ...controls, ...JSON.parse(readFileSync(CONTROLS_FILE, 'utf8')) }; } catch {}
// A controls.json written before the ids became the library's own still holds the three
// old names; translate on read rather than leaving the overlay with an id it cannot resolve.
controls.chatAnim = LEGACY_ANIM[controls.chatAnim] ?? controls.chatAnim;

// The one message held on air in `selected` mode — from EITHER feed. Deliberately not
// persisted, for the same reason the info card is not: a reload that silently put
// somebody's line back on the canvas is a surprise nobody asked for.
let chatPin: RoomChatMessage | null = null;

function saveControls() {
  try {
    mkdirSync(dirname(CONTROLS_FILE), { recursive: true });
    writeFileSync(CONTROLS_FILE, JSON.stringify(controls));
  } catch {}
}

function publishControls() {
  broadcast({ type: 'studiocall-controls', ...controls, chatPin } as any);
}

studiocallRouter.get('/controls', (_req, res) => res.json({ ...controls, chatPin }));

studiocallRouter.post('/controls', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.bounce === 'boolean') controls.bounce = body.bounce;
  if (typeof body.chatOverlay === 'boolean') controls.chatOverlay = body.chatOverlay;
  if (typeof body.autoCard === 'boolean') controls.autoCard = body.autoCard;
  // Turning it ON forgets who was invited before, so the sweep covers the people already in the
  // room rather than only the next arrival — which is what the operator means by turning it on.
  if (typeof body.autoInvite === 'boolean') { controls.autoInvite = body.autoInvite; if (body.autoInvite) autoInvited.clear(); }
  // Turning the floor rule on mid-conversation must not mute whoever happens to be second in
  // this tick on the strength of a floor nobody was holding when the toggle was flipped.
  if (typeof body.autoMute === 'boolean') { controls.autoMute = body.autoMute; releaseFloor(); }
  // Same reason as `autoMute`: switched on mid-conversation, the minute is counted from now
  // rather than from a floor nobody was holding when the operator flipped it.
  if (typeof body.floorNotice === 'boolean') { controls.floorNotice = body.floorNotice; releaseFloor(); }
  if (typeof body.muteNotice === 'boolean') controls.muteNotice = body.muteNotice;
  // Switched on mid-show, the count starts now: an unmute from before the rule existed is not
  // an offence against it.
  if (typeof body.unmuteDrop === 'boolean') { controls.unmuteDrop = body.unmuteDrop; resetUnmutes(); }
  if (typeof body.bridgeYtToRoom === 'boolean') controls.bridgeYtToRoom = body.bridgeYtToRoom;
  if (typeof body.bridgeRoomToYt === 'boolean') controls.bridgeRoomToYt = body.bridgeRoomToYt;
  // Switched on, everybody already in the room is looked at on the next poll — that is what the
  // operator means by turning it on — so the once-per-room memory is emptied.
  if (typeof body.kickAnon === 'boolean') { controls.kickAnon = body.kickAnon; anonKicked.clear(); }
  if (body.unmuteDropCount !== undefined) {
    const n = Math.round(Number(body.unmuteDropCount));
    if (Number.isFinite(n)) controls.unmuteDropCount = Math.max(1, Math.min(99, n));
  }
  if (body.autoKickMinutes !== undefined) {
    const n = Math.round(Number(body.autoKickMinutes));
    if (Number.isFinite(n)) controls.autoKickMinutes = Math.max(1, Math.min(600, n));
  }
  if (typeof body.inviteMessage === 'string') controls.inviteMessage = body.inviteMessage.trim().slice(0, INVITE_MESSAGE_MAX);
  // "New members" means arrivals AFTER the switch went on: everybody already in the room is
  // marked told, so switching it on mid-show does not greet the whole roster at once.
  if (typeof body.topicNotice === 'boolean') {
    controls.topicNotice = body.topicNotice;
    topicTold.clear();
    if (body.topicNotice) {
      const here = (lastRoomBody as { speakers?: { userId: string }[]; listeners?: { userId: string }[] } | null);
      for (const u of [...(here?.speakers ?? []), ...(here?.listeners ?? [])]) topicTold.add(u.userId);
    }
  }
  if (typeof body.topicMessage === 'string') controls.topicMessage = body.topicMessage.trim().slice(0, INVITE_MESSAGE_MAX);
  if (typeof body.autoHeadline === 'boolean') { controls.autoHeadline = body.autoHeadline; void syncHeadline(body.autoHeadline ? 'toggled on' : 'toggled off'); }
  if (body.cardStyle === 'bands' || body.cardStyle === 'sequence') controls.cardStyle = body.cardStyle;
  if (CARD_EFFECTS.includes(body.cardImageEffect)) controls.cardImageEffect = body.cardImageEffect;
  if (CARD_EFFECTS.includes(body.cardTextEffect)) controls.cardTextEffect = body.cardTextEffect;
  if (body.cardImageHold !== undefined) controls.cardImageHold = clampHold(body.cardImageHold, controls.cardImageHold);
  if (body.cardTextHold !== undefined) controls.cardTextHold = clampHold(body.cardTextHold, controls.cardTextHold);
  if (body.chatMode === 'all' || body.chatMode === 'selected') controls.chatMode = body.chatMode;
  const inAnim = LEGACY_ANIM[body.chatAnim] ?? body.chatAnim;
  if (CHAT_ANIMS.includes(inAnim)) controls.chatAnim = inAnim;
  if (CHAT_ANIMS_OUT.includes(body.chatAnimOut)) controls.chatAnimOut = body.chatAnimOut;
  if (body.chatAnimMs !== undefined) controls.chatAnimMs = clampAnimMs(body.chatAnimMs, controls.chatAnimMs);
  if (body.chatFadeOutMs !== undefined) controls.chatFadeOutMs = clampAnimMs(body.chatFadeOutMs, controls.chatFadeOutMs);
  saveControls();
  publishControls();
  // The speaker payload carries `bounce`, so a toggle has to break the dedupe or the
  // overlay keeps the old value until somebody next changes volume.
  lastSpeakerPayload = '';
  res.json({ ...controls, chatPin });
});

/**
 * Hold one line on air. Clicking the same one again lets it go, which is how the info card
 * behaves — one gesture for both directions, no separate clear button to hunt for.
 *
 * **Both feeds land here.** The layer is the one chat surface the app has (the separate Chat
 * Card was removed), so a YouTube comment is held the same way a room line is. A room line is
 * resolved server-side against the history the pump last read; anything the pump has never
 * seen must arrive whole in `message`, because there is nowhere to look it up.
 *
 * A YouTube face is an absolute URL on Google's CDN, and the OBS page resolves an avatar
 * against its own host — so it is cached through `localAvatar()` into `data/media/images`
 * and the layer is handed the local path, exactly like a Clubhouse face.
 *
 * A click is an on-air action, so it also puts the layer into `selected` and switches the
 * chat overlay on. Without that the click is silent: `all` mode keeps rolling the room and a
 * parked layer draws nothing, and both read as the click having failed.
 */
studiocallRouter.post('/chat/pin', async (req, res) => {
  const messageId = req.body?.messageId ? String(req.body.messageId) : null;
  if (!messageId || chatPin?.id === messageId) {
    chatPin = null;
  } else {
    const hit = chatRecent.find(m => m.id === messageId);
    const m = req.body?.message;
    // A line the desk said by itself — a floor rule, a bridged line, a YouTube prompt or
    // thank-you — is never a comment card, however it was clicked.
    if (hit?.auto || m?.auto || isBridged(String(hit?.text ?? m?.text ?? ''))) return res.status(409).json({ error: 'An autogenerated line is never put on air.' });
    if (hit) {
      chatPin = { ...hit, source: 'clubhouse' };
    } else if (m && typeof m.text === 'string' && m.text.length) {
      const avatar = String(m.avatar ?? '');
      chatPin = {
        id: messageId,
        at: Number(m.at) || Date.now(),
        text: String(m.text),
        userId: String(m.userId ?? ''),
        author: String(m.author ?? ''),
        avatar: avatar.startsWith('http') ? await localAvatar(avatar) : (avatar || null),
        isModerator: !!m.isModerator,
        isSpeaker: false,
        isMe: false,
        source: m.source === 'youtube' ? 'youtube' : 'clubhouse',
      };
    } else {
      return res.status(404).json({ error: 'that message is no longer in the room history' });
    }
    controls.chatMode = 'selected';
    controls.chatOverlay = true;
    saveControls();
  }
  publishControls();
  res.json({ ...controls, chatPin });
});

// A display that connects later has missed the broadcast — hand it the state on arrival.
onDisplayConnect(send => send({ type: 'studiocall-controls', ...controls, chatPin }));

// ── speaker overlay ─────────────────────────────────────────────────────────

// Who is talking, pushed to the OBS overlay rather than polled by a tab. The tab's
// roster ring dies with the tab; the overlay has to run with nothing open but OBS,
// so the pump lives here and rides the same lifetime as the room ping.
//
// The level is per-uid because Agora reports it per-uid, and nothing downstream can
// recover that: by the time the room reaches a mixer, a capture card or an OBS audio
// source it is one summed bus and "who is speaking" is gone from it. That is why the
// motion is driven from here rather than from an OBS audio-level filter.
const SPEAKER_TICK_MS = 200;
const ROSTER_TTL_MS = 15_000;
const SPEAK_FLOOR = 20;   // matches the engine's own threshold — below this is room noise
// Measured live on this rig: an ordinary sentence runs 30–200, so a ceiling any lower
// than this pins the card at full scale for most of every sentence and the motion dies.
const SPEAK_CEIL = 200;

interface RosterEntry { name: string; username: string; photoUrl: string | null; isModerator: boolean }

let speakerTimer: NodeJS.Timeout | null = null;
let roster = new Map<string, RosterEntry>();
let rosterAt = 0;
let rosterChannel: string | null = null;
let lastSpeakerPayload = '';

async function refreshRoster(channel: string): Promise<void> {
  const data = await getChannel(channel);
  const users = Array.isArray(data?.users) ? data.users : [];
  const next = new Map<string, RosterEntry>();
  for (const u of users) {
    next.set(String(u.user_id), {
      name: u.name,
      username: String(u.username ?? ''),
      photoUrl: await localAvatar(u.photo_url),
      isModerator: !!u.is_moderator,
    });
  }
  roster = next;
  rosterAt = Date.now();
  rosterChannel = channel;
}

async function speakerTick(): Promise<void> {
  const channel = liveChannel;
  if (!channel) return;
  let active: { uid: string; volume: number }[] = [];
  /**
   * Who has an OPEN MIC, from Agora's own mute callbacks — `undefined` from an engine built
   * before it reported them, which is a different thing from "nobody", and the mute lock below
   * has to tell the two apart.
   */
  let openMics: string[] | undefined;
  try {
    const d = await audioSpeaking();
    active = Array.isArray(d?.active) ? d.active : [];
    openMics = Array.isArray(d?.openMics) ? d.openMics.map(String) : undefined;
  } catch {
    active = [];   // engine down: clear the overlay rather than freeze a face on air
  }

  const stale = channel !== rosterChannel || Date.now() - rosterAt > ROSTER_TTL_MS;
  const unknown = active.some(s => !roster.has(String(s.uid)));
  if (active.length && (stale || unknown)) {
    // A failed refresh still stamps the clock, or an unknown uid retries every tick.
    try { await refreshRoster(channel); } catch { rosterAt = Date.now(); }
  }

  // Never put the operator's own face on the canvas. The engine deliberately maps Agora's
  // local-speaker uid 0 onto the real user id so that "who is talking" includes you — the
  // tab's roster needs that — but on air it is a card of the host popping up over the host,
  // who is already on camera. Filtered here rather than in the engine, so the admin side
  // keeps its own indicator.
  // A gagged speaker with an open mic is re-muted here, on the same tick that spotted them.
  // Before the self-filter below: that one is about whose face goes on the canvas, and has
  // nothing to say about whose microphone stays shut.
  const meUid = String(publicSession()?.userId ?? '');
  if (gaggedIds.size) {
    for (const s of active) {
      if (gaggedIds.has(String(s.uid))) void reMuteSpeaker(channel, String(s.uid), 'gag');
    }
  }
  // Automute is the same act on the open-mic list, like the held mute below: the syllable a level
  // trigger waits for is the one being prevented.
  if (autoMuteIds.size) {
    for (const uid of openMics ?? active.map(s => String(s.uid))) {
      if (uid !== meUid && autoMuteIds.has(uid)) void reMuteSpeaker(channel, uid, 'auto');
    }
  }
  // A held mute is the same act aimed at one person the desk muted in THIS room. It reads the
  // open-mic list rather than the level list for the reason the lock does: `onUserMuteAudio` fires
  // when the mic opens, so this shuts it inside a tick instead of after the first syllable — and
  // that syllable is the whole thing being prevented.
  if (heldMuted.size) {
    for (const uid of openMics ?? active.map(s => String(s.uid))) {
      if (uid !== meUid && heldMuted.has(uid)) void reMuteSpeaker(channel, uid, 'held');
    }
  }
  /**
   * The mute lock: a gag's gesture aimed at the whole stage instead of at a list.
   *
   * Clubhouse has no "keep everyone muted" and no unmute-all either, so muting the room is a
   * one-shot that anybody can undo for themselves a second later. The lock is this rig's answer —
   * the sweep shuts every mic once, and this shuts one again as soon as it opens.
   *
   * **The trigger is the OPEN MIC, not the sound coming out of it.** Agora's `onUserMuteAudio`
   * fires on the remote's `muteLocalAudioStream`, which is what a Clubhouse unmute is, so the
   * engine knows a mic is open before a word has been said and this shuts it inside one 200 ms
   * tick. A level-based trigger cannot do better than the first syllable, and that syllable is
   * audible to the whole room — which is the point of the lock.
   *
   * **The level list is the fallback, for an engine that does not report mute state yet.** It is
   * strictly worse and it is not equivalent, so it is used only when `openMics` is absent
   * entirely; an engine that reports an EMPTY list is saying "every mic is shut", and treating
   * that as "no data" would put the old behaviour back on a rig that had been fixed.
   *
   * **Never the operator's own mic.** The engine deliberately maps Agora's local-speaker uid 0
   * onto the real user id so that "who is talking" includes you (see the self-filter below), so
   * without this guard the lock would spend its whole life fighting the host for their own
   * microphone. `reMuteSpeaker`'s per-person cooldown does the rest.
   */
  if (keepMuted) {
    const open = openMics ?? active.map(s => String(s.uid));
    for (const uid of open) {
      if (uid !== meUid) void reMuteSpeaker(channel, uid, 'lock');
    }
  }
  // One voice at a time. Deliberately on the LEVEL list rather than the open-mic list: an open
  // mic is not an interruption, talking into it is, and a panel where everybody sits unmuted
  // and waits their turn is exactly the room this is for.
  // Always — the bookkeeping is what the profile card's speaking-time button reads;
  // the two switches gate only what the tick DOES with it, inside.
  floorTick(channel, active, meUid);
  if (controls.unmuteDrop) unmuteTick(channel, openMics, meUid);

  const active_ = meUid ? active.filter(s => String(s.uid) !== meUid) : active;

  const speakers = active_.map(s => {
    const who = roster.get(String(s.uid));
    const level = Math.max(0, Math.min(1, (s.volume - SPEAK_FLOOR) / (SPEAK_CEIL - SPEAK_FLOOR)));
    return {
      uid: String(s.uid),
      name: who?.name ?? '',
      photoUrl: who?.photoUrl ?? null,
      isModerator: !!who?.isModerator,
      volume: s.volume,
      level: Math.round(level * 100) / 100,
    };
  });

  if (controls.autoCard) autoCardTick(speakers);
  const payload = {
    type: 'studiocall-speakers', channel, speakers, bounce: controls.bounce,
    // Constant across a turn, so it costs the silence dedupe below nothing.
    turn: turnUid ? { uid: turnUid, since: turnSince } : null,
  };
  const raw = JSON.stringify(payload);
  // Silence is one message, not five a second: the empty payload is byte-identical
  // every tick, so an idle room costs the display nothing.
  if (raw === lastSpeakerPayload) return;
  lastSpeakerPayload = raw;
  broadcast(payload as any);
}

/**
 * The floor rule — one voice at a time, and the second one is told why it stopped.
 *
 * Whoever is talking holds the floor. Anybody else who talks over them has their microphone shut
 * and a line posted in the room chat saying so, because a mic that goes dead with no explanation
 * reads as a dropped connection and the person spends the next minute saying "can you hear me?"
 * — which is louder than the interruption was.
 *
 * **Two switches ride on it, and either one alone starts the tracker.** `autoMute` is the muting
 * — the half that takes a microphone. `floorNotice` is the minute call below — the half that only
 * says something. They were one flag until the desk wanted the timekeeping without the power to
 * cut anybody off, which is the ordinary case: everything above is about who holds the floor, and
 * only the loop at the end of this function acts on it.
 *
 * Three deliberate choices:
 *
 * - **Moderators are never muted by it.** A moderator cutting in is the show being run. A rule
 *   that takes the host's microphone the moment they steer the conversation is worse than no
 *   rule, and it would fire hardest on exactly the person who cannot afford it.
 * - **The floor survives the gaps in its holder's own speech** (`FLOOR_RELEASE_MS`). Speech is
 *   not continuous — there is a gap between two sentences, and without this the rule hands the
 *   floor to whoever fills one and then mutes the person who was talking.
 * - **An interruption has to last** (`FLOOR_INTERRUPT_MS`). At a 200 ms tick and a level floor
 *   this low, a cough, a laugh or a one-word "yeah" is a speaker; muting people for back-channel
 *   noise would make the room unusable and the feature would be turned off in a minute.
 */
const AUTO_MUTE_NOTICE = '{speaker} @{name} has been automatically muted, for speaking out of turn.';
/**
 * Posted once when whoever has the floor passes `FLOOR_LONG_MS` — a nudge, not an act. Nobody is
 * muted by it and **moderators are not exempt from it**, because it takes nothing away: the point
 * is that a monologue is invisible from inside itself, and the person most likely to run long is
 * the one running the show.
 */
const FLOOR_LONG_NOTICE = '{speaker} @{name} has been speaking from 1 minute';
const FLOOR_LONG_MS = 60_000;
/** How long somebody has to talk over the floor before it counts as an interruption. */
const FLOOR_INTERRUPT_MS = 600;
/** How long the holder can be silent and still keep the floor. */
const FLOOR_RELEASE_MS = 1200;
/** One explanation per person per this long — a repeat offender is muted every time, told once. */
const FLOOR_TOLD_COOLDOWN_MS = 30_000;

let floorUid: string | null = null;
/** When the current holder took the floor — the clock `FLOOR_LONG_MS` is measured against. */
let floorSince = 0;
/** When they were last heard, which is what carries them across the gaps in their own speech. */
let floorHeldAt = 0;
/** Said once per tenure. Taking the floor again is a new turn and may be announced again. */
let floorLongSaid = false;
const interruptingSince = new Map<string, number>();
const floorToldAt = new Map<string, number>();
/**
 * The TURN: whose voice the room has been hearing, and since when — measured from the last time
 * somebody ELSE took the floor. The floor clock restarts at every pause longer than
 * `FLOOR_RELEASE_MS`, which is right for the interrupter rule and useless for "how long has this
 * person been talking": a monologue is a string of sentences, and the answer wanted is the whole
 * string. The profile card's **Say speaking time** button reads this.
 */
let turnUid: string | null = null;
let turnSince = 0;

/** Nobody holds the floor. Called when the room ends, and when the toggle is thrown. */
function releaseFloor(): void {
  floorUid = null;
  floorSince = 0;
  floorHeldAt = 0;
  floorLongSaid = false;
  turnUid = null;
  turnSince = 0;
  interruptingSince.clear();
  floorToldAt.clear();
}

/** How long `uid` has held the turn, in ms — `null` when the room is hearing somebody else. */
function speakingFor(uid: string): number | null {
  return turnUid && turnUid === uid ? Date.now() - turnSince : null;
}

function floorTick(channel: string, active: { uid: string; volume: number }[], meUid: string): void {
  const now = Date.now();
  /**
   * **The operator holds the floor like anybody else.** They are filtered out of the SPEAKERS
   * list further down `speakerTick` — that filter is about whose face goes on the canvas — and
   * copying it here was a real defect: with the host excluded from `talking`, the host could
   * never hold the floor, so a guest talking over the host became the floor holder and nothing
   * was ever muted. That is the commonest shape of the problem this rule exists to solve.
   *
   * They are excluded from being MUTED instead, which is the guard that was actually wanted.
   */
  const talking = active.map(s => String(s.uid));

  if (floorUid && talking.includes(floorUid)) floorHeldAt = now;
  else if (floorUid && now - floorHeldAt > FLOOR_RELEASE_MS) { floorUid = null; floorLongSaid = false; }

  if (controls.floorNotice && floorUid && !floorLongSaid && now - floorSince >= FLOOR_LONG_MS) {
    floorLongSaid = true;
    // Never about the host: the desk's own operator is the one reading the chat, and a line
    // telling the room that the host has been talking for a minute is the show narrating itself.
    // Other moderators still get it — a monologue is invisible from inside itself.
    if (floorUid !== String(publicSession()?.userId ?? '')) void sayInRoom(channel, FLOOR_LONG_NOTICE, floorUid, 'a long turn');
  }

  if (!talking.length) { interruptingSince.clear(); return; }

  if (!floorUid) {
    // Two people who start inside the same 200 ms tick are simultaneous as far as this rig can
    // see, so the louder one takes it — the better guess at who is addressing the room rather
    // than reacting to it.
    let loudest: string | null = null;
    let best = -1;
    for (const s of active) {
      if (s.volume <= best) continue;
      best = s.volume;
      loudest = String(s.uid);
    }
    if (!loudest) return;
    floorUid = loudest;
    floorSince = now;
    floorHeldAt = now;
    floorLongSaid = false;
    if (loudest !== turnUid) { turnUid = loudest; turnSince = now; }
    interruptingSince.clear();
    return;
  }

  if (!controls.autoMute) return;

  for (const uid of talking) {
    if (uid === floorUid) continue;
    // Never the operator's own mic: the engine maps Agora's local uid 0 onto the real user id so
    // "who is talking" includes you, and without this the rule would fight the host for it.
    if (uid === meUid) continue;
    if (roster.get(uid)?.isModerator) continue;
    const since = interruptingSince.get(uid) ?? now;
    interruptingSince.set(uid, since);
    if (now - since >= FLOOR_INTERRUPT_MS) void muteInterrupter(channel, uid);
  }
  for (const uid of [...interruptingSince.keys()]) {
    if (!talking.includes(uid)) interruptingSince.delete(uid);
  }
}

/**
 * Too many unmutes and you are in the audience.
 *
 * **An unmute is a closed→open transition of one person's mic, seen on Agora's own mute
 * callbacks** — the `openMics` list the mute lock reads, for the same reason it does: it knows a
 * mic opened before a word was said. `micOpen` remembers the last state seen per person, seeded
 * from the roster so somebody who arrived muted has a "closed" to transition from; a person seen
 * for the first time with an open mic is recorded, not counted, so the desk joining a room does not
 * charge everybody already talking with an unmute. An engine too old to report mute state hands
 * `undefined`, and then this does nothing at all — the level list would count every pause in a
 * sentence as a fresh unmute.
 *
 * **The count is a sliding window, not a tally for the room.** `unmuteDropCount` unmutes within
 * `UNMUTE_DROP_WINDOW_MS` is the pattern — somebody toggling their mic on and off in a burst —
 * and a per-room total punished a long, well-behaved session for having lasted: three unmutes
 * in three hours is three turns to speak, not an offence. Each unmute is stamped and the stamps
 * older than the window are dropped before counting.
 *
 * At the count the person is `/uninvite_speaker`-ed — moderator-only on Clubhouse's side,
 * so the room is only told when the call went through. Never the operator, never a moderator.
 * The books are per room (`resetUnmutes()` from `stopSpeakerPump`) and per switch-on.
 */
const UNMUTE_DROP_NOTICE = '{speaker} @{name} has been moved to the audience, after unmuting {count} times in {window} seconds.';
const UNMUTE_DROP_WINDOW_MS = 30_000;
/** One `/uninvite_speaker` per person per this long — the pump ticks five times a second. */
const UNMUTE_DROP_COOLDOWN_MS = 10_000;
const micOpen = new Map<string, boolean>();
/** uid → when each of their recent unmutes happened, oldest first. */
const unmutes = new Map<string, number[]>();
const unmuteDroppedAt = new Map<string, number>();

function resetUnmutes(): void {
  micOpen.clear();
  unmutes.clear();
  unmuteDroppedAt.clear();
}

function unmuteTick(channel: string, openMics: string[] | undefined, meUid: string): void {
  if (!openMics) return;
  const open = new Set(openMics);
  for (const uid of roster.keys()) if (!micOpen.has(uid) && !open.has(uid)) micOpen.set(uid, false);
  for (const uid of micOpen.keys()) if (!open.has(uid)) micOpen.set(uid, false);
  for (const uid of open) {
    const was = micOpen.get(uid);
    micOpen.set(uid, true);
    if (was !== false) continue;
    const now = Date.now();
    const stamps = (unmutes.get(uid) ?? []).filter(t => now - t < UNMUTE_DROP_WINDOW_MS);
    stamps.push(now);
    unmutes.set(uid, stamps);
    if (uid === meUid || roster.get(uid)?.isModerator) continue;
    if (stamps.length >= controls.unmuteDropCount) void dropToAudience(channel, uid, stamps.length);
  }
}

async function dropToAudience(channel: string, uid: string, count: number): Promise<void> {
  if (Date.now() - (unmuteDroppedAt.get(uid) ?? 0) < UNMUTE_DROP_COOLDOWN_MS) return;
  unmuteDroppedAt.set(uid, Date.now());
  try {
    await call('/uninvite_speaker', { channel, user_id: Number(uid) });
  } catch (err) {
    logger.warn({ err, uid, count }, '[StudioCall] a speaker could not be moved to the audience — moderators only. They are still on the stage');
    return;
  }
  unmutes.delete(uid);
  micOpen.delete(uid);
  droppedFromStage.add(uid);
  logger.info({ uid, channel, count }, '[StudioCall] moved a speaker to the audience after too many unmutes');
  journal('moved a speaker to the audience after too many unmutes', { userId: uid, name: roster.get(uid)?.name ?? uid, count });
  bumpDrops(uid);
  await sayInRoom(channel, UNMUTE_DROP_NOTICE.split('{count}').join(String(count)).split('{window}').join(String(UNMUTE_DROP_WINDOW_MS / 1000)), uid, 'the drop');
}

/**
 * Shut an interrupter's mic and say so in the room — but **only say it if the mic actually
 * shut**. In a room the desk does not moderate `/mute_speaker` is refused, and posting "you have
 * been automatically muted" at somebody who is still perfectly audible is worse than staying
 * quiet: it tells the room the desk did something it did not do.
 */
async function muteInterrupter(channel: string, uid: string): Promise<void> {
  if (!(await reMuteSpeaker(channel, uid, 'floor'))) return;
  if (!controls.muteNotice) return;
  if (Date.now() - (floorToldAt.get(uid) ?? 0) < FLOOR_TOLD_COOLDOWN_MS) return;
  floorToldAt.set(uid, Date.now());
  await sayInRoom(channel, AUTO_MUTE_NOTICE, uid, 'the mute');
}

/**
 * Post one of the desk's lines. `{speaker}` is the person's display name and `{name}` their
 * Clubhouse username (the @handle, without the @) — both from the roster unless the caller knows
 * better. Somebody with no username falls back to the display name, so a line never reads "@".
 *
 * Only in a room the desk moderates, and never while Cloudflare has the account under its limit:
 * a line fired into either is a request that fails and a block that lasts longer.
 */
async function sayInRoom(channel: string, template: string, uid: string, why: string, known?: { name?: string; username?: string }): Promise<void> {
  if (!lastRoomBody?.iAmModerator || isRateLimited()) return;
  const { name, message } = fillRoomLine(template, uid, known);
  markAutoSaid(message);
  await call('/send_channel_message', { channel, message })
    .then(() => journal('the floor rule spoke', { userId: uid, name, why }))
    .catch(err => logger.warn({ err, uid, why }, '[StudioCall] the floor rule could not post to the room'));
}

function fillRoomLine(template: string, uid: string, known?: { name?: string; username?: string }): { name: string; message: string } {
  const entry = roster.get(uid);
  const name = known?.name || entry?.name || uid;
  const username = known?.username || entry?.username || name;
  return { name, message: template.split('{speaker}').join(name).split('{name}').join(username).split('{title}').join(topicTitle()) };
}

// Auto card: the loudest face has to hold the floor for this long before it goes up, so a
// one-word interjection does not flip the card.
const AUTO_CARD_HOLD_MS = 1500;
/**
 * **And once somebody has been introduced, they are not introduced again for this long.**
 *
 * The only repeat guard used to be "is this person's card up RIGHT NOW", which is no guard at all
 * in a conversation: the card runs its duration, hides itself, the same person says the next
 * sentence, and it comes straight back. Two people talking put a card on screen more or less
 * permanently — the opposite of what an auto-card is for. It is an INTRODUCTION, and one repeated
 * every thirty seconds is not information, it is furniture.
 *
 * Ten minutes is long enough that a long show still re-introduces a speaker for whoever joined
 * since, and short enough not to be effectively once-per-room. Measured from when the card went
 * UP rather than when it came down: with a card that holds for seconds and a window of minutes,
 * the difference is not worth the extra state.
 */
const AUTO_CARD_REPEAT_MS = 10 * 60_000;
let autoCandidate: { uid: string; since: number } | null = null;
let autoCardBusy = false;
/** uid → when the AUTO path last put their card up. Cleared with the room, in `stopPing`. */
const autoCardShownAt = new Map<string, number>();

function autoCardTick(speakers: { uid: string; volume: number }[]): void {
  const loudest = speakers.reduce<{ uid: string; volume: number } | null>((a, s) => (!a || s.volume > a.volume ? s : a), null);
  if (!loudest) { autoCandidate = null; return; }
  if (autoCandidate?.uid !== loudest.uid) { autoCandidate = { uid: loudest.uid, since: Date.now() }; return; }
  if (Date.now() - autoCandidate.since < AUTO_CARD_HOLD_MS) return;
  if (autoCardBusy || infoCard?.userId === loudest.uid) return;
  // Introduced recently enough that saying it again tells nobody anything.
  const shownAt = autoCardShownAt.get(loudest.uid);
  if (shownAt && Date.now() - shownAt < AUTO_CARD_REPEAT_MS) return;
  autoCardBusy = true;
  const uid = loudest.uid;
  readProfile(uid)
    .then(async card => {
      // The floor may have moved while Clubhouse was answering.
      if (!controls.autoCard || autoCandidate?.uid !== uid) return;
      // Nothing to read and no face: the auto-card puts this up unasked, so it stays silent
      // rather than laying an empty box over the show every time a bare profile talks.
      if (card.thin && !card.photoUrl) return;
      // Stamped only once the card is actually going up. A read abandoned by any check above must
      // not start the cooldown, or a card nobody saw would suppress the one they should have.
      autoCardShownAt.set(uid, Date.now());
      infoCard = card;
      publishInfoCard();
      await armInfoCardHide();
    })
    .catch(e => logger.warn({ err: e, uid }, 'auto card: profile read failed'))
    .finally(() => { autoCardBusy = false; });
}

function startSpeakerPump() {
  if (speakerTimer) return;
  speakerTimer = setInterval(() => { void speakerTick(); }, SPEAKER_TICK_MS);
}

function stopSpeakerPump() {
  if (speakerTimer) clearInterval(speakerTimer);
  speakerTimer = null;
  roster = new Map();
  rosterAt = 0;
  rosterChannel = null;
  // The floor belongs to a room. Carrying a holder into the next one would mute its first
  // second speaker on the strength of a conversation that ended.
  releaseFloor();
  resetUnmutes();
  // Unconditional, and it must stay that way. `lastSpeakerPayload` is the TICK's dedupe, not a
  // record of what is drawn: POST /controls blanks it deliberately to force the next tick through,
  // so a controls change after the last roster broadcast left this guard reading "nothing was ever
  // sent" while the canvas still had the room's faces on it — and leaving cleared nothing.
  lastSpeakerPayload = '';
  broadcast({ type: 'studiocall-speakers', channel: null, speakers: [] } as any);
}

// ── room chat pump ──────────────────────────────────────────────────────────
//
// The room's text chat lands in the Chat tab next to YouTube's, so both readings of
// "the audience is saying something" are in one list. Clubhouse pushes chat over
// PubNub, but that credential is issued per channel by /join_channel and cannot be
// held outside a room, so the REST history is the readable source and it is polled.
//
// Gated on an admin client the way liveChat's reading is: nobody has the tab open,
// nobody is reading the room's chat, and the poll is pure cost. Nothing is lost by
// that — /get_channel_messages returns the whole history, so a tab opened later
// hydrates the backlog from GET /room/chat.

const CHAT_TICK_MS = 3_000;
const CHAT_SEEN_MAX = 500;

let chatTimer: NodeJS.Timeout | null = null;
let chatSeen = new Set<string>();
// Whether the pump has read this room once already. The first read is the room's whole history
// — every panel wants it, the bridge must not: relaying it would post the conversation so far
// into YouTube in one burst.
let chatSeeded = false;
// The pool a pin is resolved against, so putting one line on air costs no round trip
// and works on a message the operator has scrolled back to.
let chatRecent: RoomChatMessage[] = [];

interface RoomChatMessage {
  id: string; at: number; text: string;
  userId: string; author: string; avatar: string | null;
  isModerator: boolean; isSpeaker: boolean; isMe: boolean;
  /** Which feed the line was said in. Absent on the room's own messages, which are the
   *  majority and predate the merge; the overlay reads absent as `clubhouse`. */
  source?: 'youtube' | 'clubhouse';
  /** The desk said it by itself — a floor-rule line, a notice, a bridged line, the room link.
   *  Read back on the poll it is `isMe` like a typed reply, and only this tells them apart:
   *  the canvas drops it, the lists keep it. → `markAutoSaid` */
  auto?: boolean;
  /** A reaction line — "reacted 💯 to Sam". The emoji, and who it was aimed at. Listed and
   *  rolled like a line; never bridged to YouTube, never counted as a line said. */
  reaction?: string;
  target?: string;
}

/**
 * What the desk posted to the room WITHOUT the operator typing it, so the poll can tell an
 * automated line from a typed one — Clubhouse hands both back as the same account's message.
 * Keyed by text, kept for ten minutes: a floor-rule line said twice is automated both times.
 */
const AUTO_SAID_TTL_MS = 10 * 60_000;
const autoSaid = new Map<string, number>();
export function markAutoSaid(text: string): void {
  const now = Date.now();
  for (const [t, at] of autoSaid) if (now - at > AUTO_SAID_TTL_MS) autoSaid.delete(t);
  autoSaid.set(text, now);
}
const wasAutoSaid = (text: string) => autoSaid.has(text);

// A reaction ("Alex reacted 💯 to Sam") comes down the same history as a typed line: every
// message carries `reaction` and `target_user_profile`, null on a typed one. Whether `reaction`
// is the emoji itself or an object around it is unconfirmed — no live sample yet — so both are read.
function reactionEmoji(m: any): string {
  const r = m?.reaction;
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.emoji ?? r.name ?? r.reaction ?? '');
}

async function readRoomChat(channel: string): Promise<RoomChatMessage[]> {
  const data = await call(`/get_channel_messages?channel=${encodeURIComponent(channel)}`);
  const raw = Array.isArray(data?.messages) ? data.messages : [];
  const me = String(publicSession()?.userId ?? '');
  const out = await Promise.all(raw
    .filter((m: any) => (typeof m?.message === 'string' && m.message.length) || reactionEmoji(m))
    .map(async (m: any): Promise<RoomChatMessage> => {
      const userId = String(m.user_profile?.user_id ?? '');
      const known = roster.get(userId);
      const emoji = reactionEmoji(m);
      const target = emoji ? String(m.target_user_profile?.name ?? '') : '';
      return {
        id: String(m.message_id),
        at: Date.parse(m.time_created),
        text: emoji ? `reacted ${emoji}${target ? ` to ${target}` : ''}` : m.message,
        ...(emoji ? { reaction: emoji, target } : {}),
        userId,
        author: m.user_profile?.name ?? known?.name ?? '',
        // Clubhouse's own CDN is off limits to the browser; localAvatar
        // caches each face once and hands out the local path.
        avatar: await localAvatar(m.user_profile?.photo_url) ?? known?.photoUrl ?? null,
        isModerator: !!known?.isModerator,
        isSpeaker: !!known,
        isMe: !!userId && userId === me,
        // A bridged line is auto by its tag, not by the ten-minute memory: the room history
        // is re-read whole on every tick, and a relay older than the memory must not come
        // back as a line the operator can put on air.
        auto: (!!userId && userId === me && wasAutoSaid(m.message)) || isBridged(m.message),
      };
    }));
  out.sort((a, b) => a.at - b.at);
  chatRecent = out.slice(-CHAT_SEEN_MAX);
  return out;
}

async function chatTick(): Promise<void> {
  const channel = liveChannel;
  // Nobody with the tab open means nobody is reading it — unless it is on air, where the
  // only client that matters is a browser source that never counts as an admin.
  if (!channel || (adminClientCount() === 0 && !controls.chatOverlay && !controls.bridgeRoomToYt)) return;
  let messages: RoomChatMessage[] = [];
  try { messages = await readRoomChat(channel); } catch { return; }
  const seeded = chatSeeded;
  chatSeeded = true;
  const fresh = messages.filter(m => !chatSeen.has(m.id));
  if (!fresh.length) return;
  for (const m of fresh) chatSeen.add(m.id);
  if (chatSeen.size > CHAT_SEEN_MAX) chatSeen = new Set([...chatSeen].slice(-CHAT_SEEN_MAX));
  /**
   * A gagged line is deleted in the room and never passed on — not to the list, not to the
   * canvas, not to the News Desk. It happens HERE rather than in the tab because the point of a
   * gag is that nobody has to be watching: the desk can be on another tab, and the pump still
   * runs whenever the chat is on air.
   */
  const pass: RoomChatMessage[] = [];
  for (const m of fresh) {
    if (gaggedIds.has(m.userId) && !m.isMe) await deleteRoomMessage(channel, m);
    else pass.push(m);
  }
  if (!pass.length) return;
  broadcast({ type: 'studiocall-chat', channel, items: pass } as any);
  // Lines posted, counted per person — never the text. Not the history page: it would be
  // counted again on every rejoin.
  if (seeded) for (const m of pass) if (!m.isMe && !m.reaction && m.userId) bumpMessages(m.userId);
  if (seeded && controls.bridgeRoomToYt) {
    for (const m of pass) {
      if (m.isMe || m.reaction || isBridged(m.text)) continue;
      const r = await queueYtChat(bridgeLine('CH', m.author, m.text));
      if (!r.queued) { logger.info({ reason: r.reason }, '[StudioCall] bridge: room line not sent to YouTube'); break; }
    }
  }
  // A link posted in the room goes on the News Desk credited to whoever posted it — the same
  // path a YouTube chat link takes, and the same one the Telegram group has always had.
  captureChatLinks(pass.map(m => ({ id: m.id, text: m.text, author: m.author, feed: 'clubhouse' as const })));
}

// The second loop guard is the text (`isBridged`, chatBridge.ts). The first is the account
// (`isMe` / `isOwner`): a line already wearing a bridge tag is never relayed again, whoever it
// arrives from — a second desk bridging the same pair, or an identity flag that lied — so two
// bridges facing each other cannot ping-pong.
// YouTube → room, and only into a room the desk moderates: a guest account relaying somebody
// else's YouTube chat into somebody else's room is not what the switch says. The lines arrive
// one frame per poll (up to 15 s of chat), and Clubhouse throttles a burst of writes,
// so they go out one after another on a single chain rather than all at once; `call()` rides
// out a 429 on its own.
let bridgeChain: Promise<void> = Promise.resolve();
onLiveChatMessages((items: YtChatMessage[]) => {
  const channel = liveChannel;
  if (!channel || !controls.bridgeYtToRoom || !lastRoomBody?.iAmModerator) return;
  for (const m of items) {
    if (m.isOwner || isBridged(m.text)) continue;
    const message = bridgeLine('YT', m.author, m.text);
    markAutoSaid(message);
    bridgeChain = bridgeChain
      .then(() => call('/send_channel_message', { channel, message }))
      .then(() => undefined, err => logger.warn({ err, author: m.author }, '[StudioCall] bridge: YouTube line not posted to the room'));
  }
});

function startChatPump() {
  if (chatTimer) return;
  chatTimer = setInterval(() => { void chatTick(); }, CHAT_TICK_MS);
}

function stopChatPump() {
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = null;
  chatSeen = new Set();
  chatSeeded = false;
  chatRecent = [];
  // A YouTube line held on air has nothing to do with the room that just ended.
  if (chatPin && chatPin.source !== 'youtube') { chatPin = null; publishControls(); }
  // Leaving is the one room event the chat surfaces never hear about: the pump only
  // broadcasts when it has new messages, so it goes quiet and every panel — and the OBS
  // canvas — keeps the room's last lines up as if the room were still there. Say the room
  // is gone, the way stopSpeakerPump() empties the roster.
  broadcast({ type: 'studiocall-chat', channel: null, items: [] } as any);
}

// ── handraise pump ──────────────────────────────────────────────────────────
//
// A raised hand is NOT in the roster. `get_channel.users[]` carries `is_speaker`,
// `is_moderator` and `is_invited_as_speaker` and nothing else about the stage, so
// the ✋ the tab used to draw beside `is_invited_as_speaker` was the moderator's OWN
// invitation coming back — the opposite of somebody asking.
//
// The hands have their own endpoint, and it is GET-only and moderator-only:
//
//   GET /get_handraise_queue?channel=<ch>   POST → 405, no channel → "Channel is
//                                           required.", not a moderator → "Invalid request."
//
// Polled on the server rather than in the tab because the point of it is the bell: the
// operator is on News Desk with StudioCall not even open when somebody asks for the stage.
const HAND_TICK_MS = 4_000;

interface HandRaise { userId: string; name: string; username: string; photoUrl: string | null }

let handTimer: NodeJS.Timeout | null = null;
let handSeen = new Set<string>();
let hands: HandRaise[] = [];
/** The endpoint refused us — not a moderator here. Stand down until the room changes. */
let handsRefused = false;
/** The response shape is unverified, so the first payload of a room is logged once. */
let handShapeLogged = false;

async function readHands(channel: string): Promise<HandRaise[]> {
  const data = await call(`/get_handraise_queue?channel=${encodeURIComponent(channel)}`);
  if (!handShapeLogged) {
    handShapeLogged = true;
    logger.info({ keys: data && typeof data === 'object' ? Object.keys(data) : typeof data },
      'studiocall handraise queue shape');
  }
  // Which key holds the list is the one thing the probe could not settle — a queue can only
  // be read by a moderator of a live room, and there was none to read. All three spellings
  // Clubhouse uses elsewhere are accepted; the extra two cost a property lookup.
  const raw = [data?.users, data?.queue, data?.handraises].find(Array.isArray) ?? [];
  return Promise.all(raw.map(async (u: any) => ({
    userId: String(u.user_id ?? u.user_profile?.user_id ?? ''),
    name: u.name ?? u.user_profile?.name ?? '',
    username: u.username ?? u.user_profile?.username ?? '',
    photoUrl: await localAvatar(u.photo_url ?? u.user_profile?.photo_url),
  })));
}

async function handTick(): Promise<void> {
  const channel = liveChannel;
  if (!channel || handsRefused) return;
  let queue: HandRaise[] = [];
  try {
    queue = await readHands(channel);
  } catch (e) {
    // Moderator-only, and a non-moderator is refused every tick forever. Anything else is
    // a blip worth retrying.
    if (e instanceof ClubhouseError && e.status === 400) {
      handsRefused = true;
      logger.info({ channel }, 'studiocall handraise queue refused — not a moderator here');
    }
    return;
  }
  hands = queue;
  const fresh = queue.filter(h => h.userId && !handSeen.has(h.userId));
  // A hand that goes down and up again is a new ask, so the seen set tracks the queue
  // rather than only growing — otherwise the second ask is silent.
  handSeen = new Set(queue.map(h => h.userId));
  for (const h of fresh) {
    logger.info({ name: h.name, channel }, 'studiocall hand raised');
    broadcast({ type: 'studiocall-hand', channel, hand: h } as any);
  }
}

function startHandPump() {
  if (handTimer) return;
  handsRefused = false;
  handShapeLogged = false;
  handTimer = setInterval(() => { void handTick(); }, HAND_TICK_MS);
}

function stopHandPump() {
  if (handTimer) clearInterval(handTimer);
  handTimer = null;
  handSeen = new Set();
  hands = [];
  handsRefused = false;
}

// The overlay is a compositor layer like any other, so it is positioned, z-ordered
// and switched off in the Overlay tab. Seeded here rather than in DEFAULT_LAYERS so
// StudioCall owns its own row; portrait geometry is written up front because the
// backfill in ensureOverlayLayers() only runs at boot.
// ── info card ───────────────────────────────────────────────────────────────

// One person's Clubhouse profile, put on air from a click on their face in the tab.
// Deliberately NOT persisted: an info card is a thing you hold up for a moment, and a
// server reload that silently restored somebody's bio to the canvas would be a surprise
// nobody asked for. It clears when the room does.
interface InfoCard {
  /** They follow the operator. Read off `get_profile.follows_me`. */
  followsMe?: boolean;
  /** The operator follows them — `follow_status === 'following'`. The two together are the
   *  mutual follow the card reports. */
  iFollow?: boolean;
  /** How many people follow both of us — `mutual_follows_count`. */
  mutualFollows?: number | null;
  /** Clubhouse's own answer to "may this account wave at them" (`can_wave`). The wave button is
   *  drawn off THIS, never off a relationship we worked out ourselves. */
  canWave?: boolean;
  /** This account has blocked them. `null` when `/get_blocked_users` could not be read — which is
   *  not the same as "no", so the card draws no block button rather than the wrong one. */
  blocked?: boolean | null;
  userId: string;
  name: string;
  username: string;
  photoUrl: string | null;
  bio: string | null;
  followers: number | null;
  following: number | null;
  twitter: string | null;
  instagram: string | null;
  /** What they are in the room right now — the card's label. A free string rather than the
   *  three room roles, because the card is also held up for people who are not in the room:
   *  a YouTube commenter is not a Listener, and printing that on air would be a small lie. */
  role: string;
  /**
   * How the operator framed the face in the profile dialog, carried onto the canvas.
   *
   * Zoom is the dialog's 1–5×. Pan is a **share of the frame**, not pixels: the dialog's picture
   * box and the overlay's Image band are different sizes, and a pixel offset that centred an eye
   * in a 480 px dialog would throw it off the edge of a 900 px card.
   */
  zoom: number;
  panX: number;
  panY: number;
  /**
   * There is nothing to READ on this one — no bio, no counts. Set here so the overlay and the
   * desk cannot disagree about it, and so the warning and the drawing are the same judgement.
   */
  thin: boolean;
  /** What this show has counted about them (`ch_people`) — absent for somebody the desk
   *  has never met, and for a card from the other feed. */
  listenerSince?: string | null;
  roomsAttended?: number | null;
  talkMs?: number | null;
  drops?: number | null;
}

const NO_FRAMING = { zoom: 1, panX: 0, panY: 0 };

/**
 * A card with nothing in its text band.
 *
 * The card is three bands — picture, name strip, profile text — and Clubhouse hands back plenty
 * of profiles with none of the third: no bio, no follower counts, nothing. Drawn as a card that
 * is two thirds empty box with a caption under a face, which reads on air as a graphic that
 * failed to load rather than as a person who wrote no bio. There is no information to present in
 * card form, so it is not presented in card form — the picture is shown large instead, and the
 * desk is told why it did not get a card.
 *
 * Name, username and role are not information ABOUT somebody, they are the label on the picture,
 * so they do not count: a card carrying only those is exactly the case this exists to catch.
 */
const cardIsThin = (c: Pick<InfoCard, 'bio' | 'followers' | 'following'>): boolean =>
  !c.bio?.trim() && c.followers == null && c.following == null;

/** Every card is stamped on the way out of the two builders, so nothing can be published unjudged. */
const stampThin = (c: Omit<InfoCard, 'thin'>): InfoCard => ({ ...c, thin: cardIsThin(c) });

/** The framing off a POST body, clamped to what the dialog can actually produce. */
function framing(body: any) {
  const n = (v: unknown, lo: number, hi: number, dflt: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };
  return {
    zoom: n(body?.zoom, 1, 5, 1),
    panX: n(body?.panX, -1, 1, 0),
    panY: n(body?.panY, -1, 1, 0),
  };
}

let infoCard: InfoCard | null = null;
let infoCardTimer: NodeJS.Timeout | null = null;

function publishInfoCard() {
  broadcast({ type: 'studiocall-infocard', card: infoCard } as any);
}

/**
 * Take the card down because the room it belongs to is gone.
 *
 * The card is somebody's Clubhouse profile — read out of a room, labelled with what they are in
 * that room. Once we have left, it is a bio for a place that no longer exists, still on air. The
 * pending auto-hide goes with it: a timer that fires against the next room's card would cut a face
 * put up minutes later.
 */
function clearInfoCard() {
  if (infoCardTimer) { clearTimeout(infoCardTimer); infoCardTimer = null; }
  if (!infoCard) return;
  infoCard = null;
  publishInfoCard();
}

/** A layer's `duration`, in seconds. 0 is the column's default and means "no timer". */
async function layerDuration(id: string): Promise<number> {
  return smLayerDuration(id);
}

// Auto-hide, held on the server rather than in the overlay. The card is a thing you hold
// up for a moment, and the operator who put it up is usually talking rather than watching
// the clock — but a timer that lived in the display would die with a browser-source reload
// and leave the card up for the rest of the show. Every surface clears off one broadcast.
async function armInfoCardHide() {
  if (infoCardTimer) { clearTimeout(infoCardTimer); infoCardTimer = null; }
  if (!infoCard) return;
  const secs = await layerDuration('CHinfocard');
  if (secs <= 0) return;   // 0 = stays until the operator clicks it off
  const showing = infoCard.userId;
  infoCardTimer = setTimeout(() => {
    infoCardTimer = null;
    // Only clear the card that armed this timer — a second face put up in the meantime
    // owns its own timer and must not be cut short by the first one's.
    if (infoCard?.userId !== showing) return;
    infoCard = null;
    publishInfoCard();
  }, secs * 1000);
}

async function readProfile(userId: string): Promise<InfoCard> {
  const data = await call('/get_profile', { user_id: Number(userId) });
  const p = data?.user_profile ?? {};
  const known = roster.get(String(userId));
  const photoUrl = await localAvatar(p.photo_url) ?? known?.photoUrl ?? null;
  const followers = typeof p.num_followers === 'number' ? p.num_followers : null;
  const following = typeof p.num_following === 'number' ? p.num_following : null;
  // The counts the roster never carries are noted on the way past, so the Speaker Status rows
  // can show them without a profile read each; what the show has counted comes back on the card.
  void noteProfile({ userId: String(userId), name: p.name, username: p.username, photoUrl, followers, following });
  const met = (await getPeople([String(userId)]).catch(() => null))?.[String(userId)];
  return stampThin({
    userId: String(userId),
    name: p.name ?? known?.name ?? '',
    username: p.username ?? '',
    photoUrl,
    bio: p.bio ?? null,
    followers,
    following,
    listenerSince: met?.firstSeenAt || null,
    roomsAttended: met ? met.roomsAttended : null,
    talkMs: met ? met.talkMs : null,
    drops: met ? met.drops : null,
    twitter: p.twitter ?? null,
    instagram: p.instagram ?? null,
    role: known?.isModerator ? 'Moderator' : known ? 'Speaker' : 'Listener',
    followsMe: !!p.follows_me,
    // Whether a wave can reach them is CLUBHOUSE'S answer, not ours to infer. `can_wave` already
    // weighs the whole relationship — the mutual follow, their wave settings, whether either of us
    // has blocked the other — so a button drawn off `follows_me` alone offered a wave that would
    // be refused. `iFollow` and `mutualFollows` stay for the card to *explain* the state.
    canWave: !!p.can_wave,
    iFollow: p.follow_status === 'following',
    mutualFollows: typeof p.mutual_follows_count === 'number' ? p.mutual_follows_count : null,
    blocked: await isBlocked(String(userId)),
    ...NO_FRAMING,
  });
}

/**
 * Who this account has blocked, cached — the profile card needs it on every open and
 * `/get_blocked_users` is a Clubhouse call like any other (a burst is what gets throttled).
 *
 * Held for a minute and dropped outright on a block or unblock, so the button never draws the
 * state it just changed away from.
 */
interface BlockedUser { userId: string; name: string }
let blockedIds: { at: number; ids: Set<string>; users: BlockedUser[] } | null = null;
const BLOCKED_TTL_MS = 60_000;

async function blockedSet(): Promise<Set<string>> {
  if (blockedIds && Date.now() - blockedIds.at < BLOCKED_TTL_MS) return blockedIds.ids;
  const data = await call('/get_blocked_users', {});
  const users: BlockedUser[] = (Array.isArray(data?.users) ? data.users : []).map((u: any) => ({ userId: String(u.user_id), name: String(u.name ?? '') }));
  blockedIds = { at: Date.now(), ids: new Set(users.map(u => u.userId)), users };
  return blockedIds.ids;
}

/** A failed read is not "not blocked" — it is no answer, and the card draws no button on null. */
async function isBlocked(userId: string): Promise<boolean | null> {
  try { return (await blockedSet()).has(userId); } catch { return null; }
}

/** The blocked list with names, for the Speaker Status dialog's rows; null when it could not be read. */
async function blockedPeople(): Promise<BlockedUser[] | null> {
  try { await blockedSet(); return blockedIds?.users ?? null; } catch { return null; }
}

/**
 * A card for somebody Clubhouse has never heard of.
 *
 * The face in the merged chat list can be a YouTube commenter, and there is no `/get_profile`
 * for them — so the caller sends what it has (a name and a picture) and the card is built from
 * that. Every field the overlay draws beyond those two is guarded there, so a card with no bio
 * and no counts renders as a name and a face rather than as a broken layout.
 *
 * The picture is cached the same way a Clubhouse one is: the OBS page resolves a photo against
 * its own host, so an absolute Google CDN url has to become a local path first.
 */
async function guestCard(userId: string, c: any): Promise<InfoCard> {
  const photo = String(c?.photoUrl ?? '');
  return stampThin({
    userId,
    name: String(c?.name ?? ''),
    username: String(c?.username ?? ''),
    photoUrl: photo.startsWith('http') ? await localAvatar(photo) : (photo || null),
    bio: null, followers: null, following: null, twitter: null, instagram: null,
    role: String(c?.role ?? 'Guest'),
    ...NO_FRAMING,
  });
}

// Read a profile without putting it anywhere — the tab's own preview.
studiocallRouter.get('/user/:userId', async (req, res) => {
  const userId = String(req.params.userId);
  try {
    // `speakingSince` rides on the card, not on the InfoCard the canvas draws: it is the turn
    // clock, and the `studiocall-speakers` broadcast keeps it current after this read.
    res.json({ ...await readProfile(userId), speakingSince: turnUid === userId ? turnSince : null });
  } catch (e) { sendErr(res, e); }
});

/**
 * What the show has counted about people (`ch_people`): `?ids=a,b,c` → a map by user id,
 * with nothing for somebody the desk has never met. The Speaker Status rows read it in one call.
 */
studiocallRouter.get('/people', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean);
  try { res.json({ people: await getPeople(ids) }); } catch (e) { sendErr(res, e); }
});

/** The operator's own note on somebody — the one column of the record that is written by hand. */
studiocallRouter.patch('/people/:userId', async (req, res) => {
  const userId = String(req.params.userId);
  if (typeof req.body?.notes !== 'string') return res.status(400).json({ error: 'notes required' });
  try {
    await setNotes(userId, req.body.notes.trim().slice(0, 2000));
    res.json({ ok: true, person: (await getPeople([userId]))[userId] ?? null });
  } catch (e) { sendErr(res, e); }
});

studiocallRouter.get('/infocard', (_req, res) => res.json({ card: infoCard }));

/**
 * Put a face on air, or take it off with a null userId (or the one already showing — the tab
 * clicks the same avatar to toggle).
 *
 * `on: true` says **show this one**, and is not a toggle: it is what the profile dialog's picture
 * sends. A click on a picture has to mean one thing, and a double-click on it (which is the
 * dialog's zoom-to-fit) would otherwise put the card up and take it straight back down.
 *
 * `zoom` / `panX` / `panY` are how the picture is framed in the dialog, and they are live: the
 * same `on: true` post against the card already up carries a new framing and nothing else, so
 * dragging a zoomed face in the pop-out moves it on the canvas as it is dragged.
 */
studiocallRouter.post('/infocard', async (req, res) => {
  const userId = req.body?.userId == null ? null : String(req.body.userId);
  const show = req.body?.on === true;
  const view = framing(req.body);
  try {
    if (!userId || (!show && userId === infoCard?.userId)) {
      infoCard = null;
    } else if (userId === infoCard?.userId) {
      // Already up and asked for again: the only thing that can have changed is the framing,
      // and re-reading the profile for it would put a Clubhouse call behind every drag frame.
      if (view.zoom !== infoCard.zoom || view.panX !== infoCard.panX || view.panY !== infoCard.panY) {
        infoCard = { ...infoCard, ...view };
        publishInfoCard();
      }
      return res.json({ card: infoCard });
    } else if (/^\d+$/.test(userId)) {
      // A Clubhouse id is a number. Anything else came from the other feed and has no
      // profile to read — and if the read fails for one that does, the caller's own copy
      // is better than nothing on air.
      infoCard = await readProfile(userId).catch(async (e) => {
        if (!req.body?.card) throw e;
        return guestCard(userId, req.body.card);
      });
      infoCard = { ...infoCard, ...view };
    } else {
      infoCard = { ...await guestCard(userId, req.body?.card), ...view };
    }
    // A profile with nothing to read AND no face is not a card, it is an empty box with a name
    // in it. Refused rather than drawn, and the desk is told which of the two it was — an
    // operator who clicked a face and saw nothing has to know whether the click missed or the
    // person simply has nothing on their profile.
    if (infoCard && infoCard.thin && !infoCard.photoUrl) {
      const who = infoCard.name || infoCard.username || infoCard.userId;
      infoCard = null;
      publishInfoCard();
      return res.json({ card: null, refused: `${who} has no bio, no counts and no picture — there is nothing to put on air.` });
    }
    publishInfoCard();
    await armInfoCardHide();
    res.json({ card: infoCard });
  } catch (e) { sendErr(res, e); }
});

onDisplayConnect(send => send({ type: 'studiocall-infocard', card: infoCard }));


restoreRoom();

// Re-attach audio to the room we are already in. Needed whenever the RTC leg drops
// without the room ending: the engine restarted, or Agora kicked this uid because
// the same account joined from another client (error 123, banned by server — two
// clients cannot share one uid). Re-joining the Clubhouse channel reissues the RTC
// token, which is the only way to get a fresh one.
studiocallRouter.post('/audio/reconnect', async (_req, res) => {
  if (!liveChannel) return res.status(409).json({ error: 'not in a room' });
  try {
    const data = await call('/join_channel', { channel: liveChannel });
    const audio = await connectAudio(data, liveChannel, liveSpeaker);
    journal('pressed Reconnect audio', { channel: liveChannel }, true);
    res.json({ channel: liveChannel, ...audio });
  } catch (e) { sendErr(res, e); }
});

// ── invites ────────────────────────────────────────────────────────────────

// Clubhouse has no push path we can hold outside a room: the PubNub credential
// that carries live user events (`users.<id>`) is issued per channel by
// /join_channel, so there is nothing to subscribe to until you are already in a
// room. /get_activities is what the desktop client itself polls, so it is the
// mechanism here too — 30 s instead of its 60 s, because the point is to catch a
// room while it is still open. GET, not POST: /get_activities 404s on POST.
const ACTIVITY_POLL_MS = 30_000;
const SEEN_FILE = join(env.DATA_DIR, 'invites.json');

// "**Alex** invited you into a room" / "**X** pinged you into <topic> from <house>".
// Clubhouse rewrites the same activity to end in "but you missed it" once the room
// is gone, which is what separates an invite worth interrupting the operator for from a
// note about one that is already over.
const INVITE_TITLE = /\b(invited you into|pinged you into)\b/i;
const MISSED_TITLE = /but you missed it/i;

export interface StudioCallInvite {
  activityId: string;
  at: string | null;
  from: string;
  /** Who invited us, so the notice can ping them back into our own room. */
  fromUserId: string | null;
  fromPhotoUrl: string | null;
  title: string;
  channel: string | null;
  missed: boolean;
}

let seenActivityIds: string[] = [];
try { seenActivityIds = JSON.parse(readFileSync(SEEN_FILE, 'utf8'))?.seen ?? []; } catch {}

function rememberSeen(ids: string[]) {
  seenActivityIds = [...ids, ...seenActivityIds].slice(0, 200);
  try {
    mkdirSync(dirname(SEEN_FILE), { recursive: true });
    writeFileSync(SEEN_FILE, JSON.stringify({ seen: seenActivityIds }));
  } catch {}
}

// Titles come marked up with ** ** around every name; the room to join is buried in
// whichever nested action carries a clubhouse:// or clubhouse.com room link.
function plainTitle(t: unknown): string {
  return String(t ?? '').replace(/\*\*/g, '').trim();
}

// An activity says what it is about only in deep-link form, under `target` / `target_url`
// on any of its nested avatars and details — `clubhouse://room/<ch>` for the room it names,
// `clubhouse://user/<id>` for whoever it is from. Collected once, read twice.
function findTargets(activity: any): string[] {
  const targets: string[] = [];
  const walk = (node: any, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (typeof node.target === 'string') targets.push(node.target);
    if (typeof node.target_url === 'string') targets.push(node.target_url);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(activity);
  return targets;
}

function findChannel(activity: any): string | null {
  for (const t of findTargets(activity)) {
    const m = /clubhouse:\/\/(?:room|channel)\/([A-Za-z0-9_-]+)/.exec(t)
      ?? /clubhouse\.com\/room\/([A-Za-z0-9_-]+)/.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

function findUserId(activity: any): string | null {
  for (const t of findTargets(activity)) {
    const m = /clubhouse:\/\/user\/(\d+)/.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

async function readInvites(): Promise<StudioCallInvite[]> {
  const data = await call('/get_activities');
  const activities = Array.isArray(data?.activities) ? data.activities : [];
  const invites = activities.filter((a: any) => a?.activity_id && INVITE_TITLE.test(plainTitle(a.title)));
  return Promise.all(invites.map(async (a: any) => {
    const title = plainTitle(a.title);
    return {
      activityId: String(a.activity_id),
      at: a.timestamp ?? null,
      // The inviter's name is the first bolded run of the original title.
      from: plainTitle(/\*\*(.+?)\*\*/.exec(String(a.title ?? ''))?.[1] ?? title.split(' ')[0]),
      fromUserId: findUserId(a),
      fromPhotoUrl: await localAvatar(a.avatar?.thumbnails?.find((t: any) => t?.url)?.url),
      title,
      channel: findChannel(a),
      missed: MISSED_TITLE.test(title),
    } satisfies StudioCallInvite;
  }));
}

studiocallRouter.get('/invites', async (_req, res) => {
  if (!hasSession()) return res.json({ invites: [] });
  try { res.json({ invites: await readInvites() }); } catch (e) { sendErr(res, e); }
});

// A poll that has never run has nothing to compare against, so the first pass only
// records what is already there — otherwise every invite in the backlog would fire
// a notification the moment the server starts.
let primed = seenActivityIds.length > 0;

async function pollInvites() {
  if (!hasSession()) return;
  try {
    const invites = await readInvites();
    const fresh = invites.filter(i => !seenActivityIds.includes(i.activityId));
    rememberSeen(invites.map(i => i.activityId));
    if (!primed) { primed = true; return; }
    for (const invite of fresh.filter(i => !i.missed)) {
      logger.info({ from: invite.from, channel: invite.channel }, 'studiocall room invite');
      broadcast({ type: 'studiocall-invite', invite } as any);
    }
  } catch (e) {
    logger.warn({ err: e }, 'studiocall activity poll failed');
  }
}

setInterval(() => { void pollInvites(); }, ACTIVITY_POLL_MS).unref();
void pollInvites();

// ── room control ────────────────────────────────────────────────────────────

// Every one of these needs a channel; refuse early rather than sending a call that
// Clubhouse answers with a bare "Invalid channel ID".
function requireChannel(res: express.Response): string | null {
  if (!liveChannel) { res.status(409).json({ error: 'not in a room' }); return null; }
  return liveChannel;
}

// Promote to moderator. NOTE: there is no way back — /remove_moderator and
// /unmake_moderator are both 404. Clubhouse does not expose revocation, so the UI
// has to confirm before calling this.
studiocallRouter.post('/room/moderator', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  try {
    await call('/make_moderator', { channel, user_id: Number(req.body?.userId) });
    const userId = String(req.body?.userId);
    promotedAt.set(userId, Date.now());
    const known = roster.get(userId);
    if (known) known.isModerator = true;
    channelCache = null;
    res.json({ ok: true, userId, irreversible: true });
  } catch (e) { sendErr(res, e); }
});

/**
 * Take the mic in a room we are only listening to.
 *
 * `/invite_speaker` is moderator-only and cannot be aimed at yourself; `/audience_reply` is
 * the audience's own route onto the stage. In a room with automatic speaker approval — which is
 * what `is_handraise_enabled: false` plus `can_speak: true` means — Clubhouse promotes on the
 * spot rather than queueing a hand.
 *
 * The RTC leg has to follow. Agora fixes the client role at join, so a Clubhouse speaker who
 * joined as audience is on the stage with a microphone that transmits nothing — the same class of
 * silent failure as a device change mid-call. This rejoins the audio through a fresh `/join_channel` token, as a
 * speaker, and reports whether that half worked separately: being on the stage with no audio is a
 * state the operator has to be told about, not one to hide behind an ok:true.
 *
 * There is no way back down. `/leave_speaker`, `/remove_speaker` and self-`/uninvite_speaker` are
 * unverified, and inventing one that silently no-ops is worse than not offering it — leave the
 * room to leave the stage.
 */
studiocallRouter.post('/room/mic', async (_req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  try {
    // Two ways up, and the room decides which. An OPEN room — `is_handraise_enabled: false`,
    // anyone may simply take the mic — promotes on the spot through `/become_speaker`, which
    // answers 200 and hands back a fresh RTC token in the same response. `/audience_reply` is
    // the handraise path, and in an open room it answers **400 with an empty error_message**:
    // the empty-400 signature for a body the endpoint will not take. Read as a refusal, it looked
    // like the room saying no while the room was in fact wide open.
    let data: any = null;
    let raisedHand = false;
    try {
      data = await call('/become_speaker', { channel });
    } catch (e) {
      if (!(e instanceof ClubhouseError)) throw e;
      await call('/audience_reply', { channel, raise_hands: true, unraise_hands: false });
      raisedHand = true;
    }
    /**
     * **A raised hand is not a stage — ask the room before acting as though it were.**
     *
     * `/audience_reply` answers 200 for a hand that has merely been QUEUED, and this used to read
     * that as a promotion: it set `liveSpeaker`, tore down working audience audio and rejoined the
     * RTC leg as a speaker the room did not have. The operator was told "On the stage" while the
     * roster still said listener, and the rejoin cost them the audio they already had. Only the
     * roster knows, so read it — with the cache dropped, since an answer from before the reply
     * would report the old state. A room with automatic approval promotes on the reply, so this is
     * a question, not an assumption either way.
     *
     * `/become_speaker` needs no such check: it promotes and hands back the RTC token in the same
     * response, and `/get_channel` can lag a beat behind it — asking there would report a listener
     * and strand a real speaker with an audience mic.
     */
    if (raisedHand) {
      channelCache = null;
      const fresh = await getChannel(channel).catch(() => null);
      const me = String(publicSession()?.userId ?? '');
      const promoted = (Array.isArray(fresh?.users) ? fresh.users : [])
        .some((u: any) => String(u.user_id) === me && u.is_speaker);
      if (!promoted) return res.json({ ok: true, onStage: false, queued: true });
    }
    liveSpeaker = true;
    saveRoom();
    await audioLeave().catch(() => {});
    // `/become_speaker` already issued the token; the handraise path still has to fetch one.
    if (!data?.token) data = await call('/join_channel', { channel });
    const audio = await connectAudio(data, channel, true);
    res.json({ ok: true, onStage: true, audio });
  } catch (e) { sendErr(res, e); }
});

/**
 * Ping somebody into the room we are in — the notification that reads "**X** pinged you into
 * <topic>", coming back the other way.
 *
 * `/invite_to_existing_channel` is the endpoint, and it is the only one of its family that
 * exists: `/invite_to_channel`, `/invite_to_room` and `/ping_to_channel` are all 404. Probed
 * the usual way — a bogus channel answers `400 {"error_message":"Invalid channel ID"}`, which
 * is the endpoint being real and rejecting the channel.
 *
 * The channel is validated before the rest of the body is read, so the NAME of the id field is
 * unconfirmed. Same call as `/set_channel_title`: send both spellings, since Clubhouse
 * ignores fields it does not know and one of the two is right.
 */
studiocallRouter.post('/room/invite', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const userId = String(req.body?.userId ?? '').trim();
  if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'userId required' });
  try {
    await call('/invite_to_existing_channel', { channel, user_id: Number(userId), user_ids: [Number(userId)] });
    res.json({ ok: true, userId, channel });
  } catch (e) { sendErr(res, e); }
});

/**
 * Wave — Clubhouse's "come and talk": the notification that invites somebody into a private
 * room with you, which they can accept or silently ignore. Clubhouse only delivers it to people
 * who follow you (the app offers the button in the hallway for exactly those), so the profile
 * carries `followsMe` and the button is drawn off that.
 *
 * The endpoint family is read out of the Clubdeck bundle — `/send_wave`, `/accept_wave`,
 * `/cancel_wave`, `/get_received_waves`, `/get_initiated_waves`, `/suspend_waves`,
 * `/unsuspend_waves`. The body's field name is unconfirmed (the bundle is minified past its
 * call sites), so `user_id` and `user_ids` both go, as with `/invite_to_existing_channel`.
 */
studiocallRouter.post('/wave', async (req, res) => {
  const userId = String(req.body?.userId ?? '').trim();
  if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'userId required' });
  try {
    const out = await call('/send_wave', { user_id: Number(userId), user_ids: [Number(userId)] });
    res.json({ ok: true, userId, wave: out });
  } catch (e) { sendErr(res, e); }
});

// React to somebody in the room — Clubhouse's 👏 ❤️ 💯 aimed at a speaker; the room reads it as
// "<you> reacted 👏 to <them>". `emoji` is the confirmed field ("Emoji is required."). The channel
// is validated before the target is read, so the target's field name is unconfirmed and both
// spellings go, as /room/invite does.
studiocallRouter.post('/react', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const userId = String(req.body?.userId ?? '').trim();
  const emoji = String(req.body?.emoji ?? '').trim();
  if (!/^\d+$/.test(userId)) return res.status(400).json({ error: 'userId required' });
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  try {
    const out = await call('/emoji_reaction', { channel, emoji, user_id: Number(userId), target_user_id: Number(userId) });
    res.json({ ok: true, userId, emoji, reaction: out });
  } catch (e) { sendErr(res, e); }
});

studiocallRouter.get('/waves', async (_req, res) => {
  try {
    const [received, initiated] = await Promise.all([call('/get_received_waves'), call('/get_initiated_waves')]);
    res.json({ received, initiated });
  } catch (e) { sendErr(res, e); }
});

// Move someone on or off the stage. Off-stage is the gentle alternative to removal.
studiocallRouter.post('/room/speaker', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const userId = Number(req.body?.userId);
  const onStage = !!req.body?.onStage;
  try {
    await call(onStage ? '/invite_speaker' : '/uninvite_speaker', { channel, user_id: userId });
    // A moderator's move is the one thing Auto invite defers to, in both directions.
    if (onStage) droppedFromStage.delete(String(userId)); else droppedFromStage.add(String(userId));
    res.json({ ok: true, userId: String(userId), onStage });
  } catch (e) { sendErr(res, e); }
});

// Rename the room you are in. `/set_channel_title` is the live endpoint — the obvious
// `/change_channel_topic`, `/update_channel_topic`, `/edit_channel_topic` and
// `/set_channel_topic` are all 404. Its body key is NOT confirmed: the probe with a
// bogus channel is rejected on the channel before Clubhouse reads the rest, so both
// `topic` and `title` are sent. Unknown fields are ignored, and one of them is the right
// one. Moderator-only on Clubhouse's side, which is why the tab hides the control.
studiocallRouter.post('/room/topic', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const topic = String(req.body?.topic ?? '').trim();
  if (!topic) return res.status(400).json({ error: 'A topic is required' });
  try {
    // Clubhouse answers 200 with `success:false` when it declines — not a moderator any more, the
    // room already closed — so a caller trusting the HTTP status alone reports a rename that never
    // happened and types a strap claiming it did.
    const out = await call('/set_channel_title', { channel, topic, title: topic });
    if (out?.success === false) {
      return res.status(403).json({ error: out?.error_message ?? 'Clubhouse refused the new topic — moderators only.' });
    }
    void syncHeadline('renamed');
    // The rename made both announcements stale at once: the Telegram post still names the old
    // show, and anyone walking into the room now has nothing saying where to watch. Those
    // announcements are StudioMate's; its relay hears this and refreshes them.
    broadcast({ type: 'studiocall-room-renamed', channel, topic });
    res.json({ ok: true, channel, topic });
  } catch (e) { sendErr(res, e); }
});

// The two room settings with a live setter. Both found in Clubdeck's string table and
// confirmed with OPTIONS, and the body keys confirmed by re-sending the room's current value —
// which changes nothing and answers `success:true` only when the key is the one Clubhouse reads.
// Both are moderator-only; Clubhouse answers 200 `success:false` when it declines.
async function setRoomSetting(res: express.Response, endpoint: string, key: string, value: unknown, what: string) {
  const channel = requireChannel(res); if (!channel) return;
  if (typeof value !== 'number' || !Number.isInteger(value)) return res.status(400).json({ error: `${what} must be one of the room's options` });
  try {
    const out = await call(endpoint, { channel, [key]: value });
    if (out?.success === false) {
      return res.status(403).json({ error: out?.error_message ?? `Clubhouse refused the ${what} — moderators only.` });
    }
    channelCache = null;
    res.json({ ok: true, channel, value });
  } catch (e) { sendErr(res, e); }
}

// Who may take the stage: open stage / request to join / invite only (`handraise_queue_options`).
studiocallRouter.post('/room/stage', (req, res) => setRoomSetting(res, '/update_handraise_queue_setting', 'handraise_queue_setting', req.body?.value, 'stage setting'));

// Who may post in the room chat: everyone / house members / trusted members (`chat_permission_options`).
studiocallRouter.post('/room/chat-permission', (req, res) => setRoomSetting(res, '/set_chat_permission', 'chat_permission', req.body?.value, 'chat permission'));

/**
 * "<title> is being discussed in Clubhouse" into the Telegram group, with the room link — the
 * pop-out's content (routes/popoutContent.ts), or the room's topic when the pop-out is empty.
 *
 * An operator press, so it may speak in the group; `standalone` because it is
 * not THE announcement: a later room rename must amend the live-show post, not this line.
 */
studiocallRouter.post('/popout/telegram', async (req, res) => {
  const title = String(req.body?.title ?? '').trim() || topicTitle();
  if (!title) return res.status(409).json({ error: 'Nothing is in the pop-out and the room has no topic — nothing to announce.' });
  const channel = liveChannel;
  const link = channel ? await roomLink(channel) : null;
  const text = `${title} is being discussed in Clubhouse${link ? `\n🎙 Join the conversation: ${link}` : ''}`;
  const sent = await telegramAnnounce(text);
  if (!sent.ok) return res.status(sent.reachable ? 409 : 502).json({ error: sent.error });
  res.json({ ok: true, text });
});

/**
 * The room's pinned link — the one URL a moderator can put in front of everybody in the room.
 *
 * Three endpoints, and none of them is the name the pubsub event carries: the room broadcasts
 * `add_link` / `remove_link` when one appears, but the calls that DO it are `/add_channel_link`,
 * `/remove_channel_link` and `/check_channel_link`. (Read out of Clubdeck's own bundle — it is the
 * only client left that pins a link from a desktop, and the API names are not documented anywhere.)
 *
 * Clubhouse keeps a list but every client shows the last one, and pinning a second replaces the
 * first in the UI — so this pins one and takes the previous down with it, which is what "Edit"
 * means to an operator.
 */
studiocallRouter.post('/room/link', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const link = String(req.body?.url ?? '').trim();
  if (!link) return res.status(400).json({ error: 'no url' });
  try {
    // Clubhouse resolves the page itself — title, root and the display form all come back on the
    // room, so nothing here has to fetch the URL (and the browser client must not).
    const out = await call('/add_channel_link', { channel, link });
    if (out?.success === false) return res.status(400).json({ error: out?.error_message ?? 'Clubhouse refused the link' });
    res.json({ ok: true, channel, link });
  } catch (e) { sendErr(res, e); }
});

studiocallRouter.post('/room/link/remove', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const linkId = req.body?.linkId;
  if (linkId === undefined || linkId === null || linkId === '') return res.status(400).json({ error: 'no linkId' });
  try {
    const out = await call('/remove_channel_link', { channel, link_id: linkId });
    if (out?.success === false) return res.status(400).json({ error: out?.error_message ?? 'Clubhouse refused that' });
    res.json({ ok: true, channel, linkId });
  } catch (e) { sendErr(res, e); }
});

// Remove someone from the room entirely.
studiocallRouter.post('/room/remove', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  try {
    await call('/block_from_channel', { channel, user_id: Number(req.body?.userId) });
    bumpDrops(String(req.body?.userId));
    res.json({ ok: true, removed: String(req.body?.userId) });
  } catch (e) { sendErr(res, e); }
});

/**
 * Mute one speaker — and KEEP them muted until the desk says otherwise.
 *
 * The hold is set before the Clubhouse call, not after: the pump is the thing that makes this
 * stick, and a hold armed only on success would leave a mic open for a whole retry if the first
 * write is throttled. `muted:false` is the release, and it drops the hold FIRST so the pump
 * cannot re-shut the mic that this same request is about to open. → the held-mutes section
 */
studiocallRouter.post('/room/mute-user', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const userId = String(req.body?.userId);
  const muted = req.body?.muted !== false;
  if (muted) heldMuted.set(userId, { userId, name: String(req.body?.name ?? roster.get(userId)?.name ?? ''), at: new Date().toISOString() });
  else { heldMuted.delete(userId); gagMutedAt.delete(userId); }
  publishHeld();
  try {
    if (muted) deskMutedAt.set(userId, Date.now());
    await call('/mute_speaker', { channel, user_id: Number(userId), muted });
    const who = heldMuted.get(userId)?.name || roster.get(userId)?.name || String(req.body?.name ?? '') || userId;
    journal(muted ? 'muted a speaker, and held them muted' : 'released a held mute', { userId, name: who });
    deskLine(muted ? `${meName()} muted ${who} and is holding them muted` : `${meName()} released ${who}`, channel);
    res.json({ ok: true, userId, muted, held: muted });
  } catch (e) { sendErr(res, e); }
});

/**
 * Mute everyone else on stage. Clubhouse has no bulk call, so this is one request per speaker;
 * partial failure is reported rather than swallowed, because a room that is "mostly muted" is
 * worse than knowing which one is still live.
 *
 * **Paced.** Fired flat out this is the one thing in the app that looks exactly like abuse from
 * Clubhouse's side — nine identical writes in two seconds — and it was answered the way abuse is
 * answered: 429 on every single call, nobody muted, and a notice naming all nine as failures
 *. `call()` now waits out a throttle, but the fix that matters is not provoking one:
 * a gap between speakers, the same lesson `GAG_MUTE_COOLDOWN_MS` learned at the other end.
 *
 * The gap is per speaker, so a full stage takes a couple of seconds. That is the right trade —
 * the alternative on the record is instant and silences nobody.
 */
const MUTE_ALL_GAP_MS = 300;

async function muteEveryone(channel: string): Promise<{ muted: number; failed: string[] }> {
  const data = await call('/get_channel', { channel });
  const me = String(publicSession()?.userId ?? '');
  const targets = (Array.isArray(data?.users) ? data.users : [])
    .filter((u: any) => u.is_speaker && String(u.user_id) !== me);
  const failed: string[] = [];
  for (const [i, u] of targets.entries()) {
    if (i) await new Promise(r => setTimeout(r, MUTE_ALL_GAP_MS));
    deskMutedAt.set(String(u.user_id), Date.now());
    await call('/mute_speaker', { channel, user_id: Number(u.user_id), muted: true })
      .catch((err: unknown) => {
        logger.warn({ err, userId: String(u.user_id), channel }, '[StudioCall] mute-all could not mute a speaker');
        failed.push(u.name ?? String(u.user_id));
      });
  }
  return { muted: targets.length - failed.length, failed };
}

studiocallRouter.post('/room/mute-all', async (_req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  try {
    const { muted, failed } = await muteEveryone(channel);
    journal('muted everyone on stage', { muted, failed: failed.length });
    res.json({ ok: failed.length === 0, muted, failed });
  } catch (e) { sendErr(res, e); }
});

/**
 * **The mute lock** — mute everyone, and keep them muted.
 *
 * `POST /room/mute-all` is a one-shot, and Clubhouse gives every speaker their own unmute, so a
 * silenced stage is only silent until somebody opens their mic again. The lock is the standing
 * version of the same decision: the sweep runs once when it is armed, and from then on the speaker
 * pump shuts any mic that opens. It is the gag's mechanism aimed at the whole stage.
 *
 * **It is a LATCH, not a toggle.** `on` is stated by the caller, because the chip and the tab are
 * two buttons drawn from one polled state, and a toggle raced against that poll turns a second
 * press into an unlock nobody asked for.
 *
 * **Disarming does not unmute anybody**, deliberately, and for the same reason ending a gag does
 * not: letting people speak again means the desk stops shutting mics, not that the desk opens
 * them. Clubhouse has no unmute-all and could not do it anyway.
 *
 * It dies with the room (`stopPing`) — a lock left armed across rooms would silence the next one
 * for reasons nobody present could see.
 */
let keepMuted = false;

studiocallRouter.get('/room/keep-muted', (_req, res) => res.json({ on: keepMuted }));

studiocallRouter.post('/room/keep-muted', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const on = req.body?.on !== false;
  keepMuted = on;
  broadcast({ type: 'studiocall-keep-muted', on } as any);
  journal(on ? 'armed the mute lock' : 'released the mute lock', {});
  if (!on) return res.json({ ok: true, on: false, muted: 0, failed: [] });
  try {
    // Arming sweeps once: the mics that are already open are the reason somebody reached for this,
    // and waiting for each of them to speak before shutting it is not what the button says.
    const { muted, failed } = await muteEveryone(channel);
    res.json({ ok: failed.length === 0, on: true, muted, failed });
  } catch (e) { sendErr(res, e); }
});

// Open or close the room's text chat.
studiocallRouter.post('/room/chat', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const on = req.body?.enabled !== false;
  try {
    await call(on ? '/enable_channel_messages' : '/disable_channel_messages', { channel });
    res.json({ ok: true, enabled: on });
  } catch (e) { sendErr(res, e); }
});

// The room's text chat, for the Chat tab to hydrate from. Answers 200 with an empty
// list rather than 409 when no room is open, because the tab merges this with
// YouTube's chat and "not in a room" is an ordinary state there, not an error.
studiocallRouter.get('/room/chat', async (_req, res) => {
  if (!liveChannel) return res.json({ live: false, channel: null, messages: [] });
  try {
    const messages = await readRoomChat(liveChannel);
    res.json({ live: true, channel: liveChannel, messages: messages.filter(m => !gaggedIds.has(m.userId) || m.isMe) });
  } catch (e) { sendErr(res, e); }
});

/**
 * The operator's own line. Longer than `ROOM_MESSAGE_MAX` it goes out as several, in order —
 * the same rule the YouTube queue applies — rather than being cut short or refused. The limit
 * is the one the composers already enforced; Clubhouse's true cap is not documented.
 */
const ROOM_MESSAGE_MAX = 200;
const ROOM_SEND_GAP_MS = 300;

studiocallRouter.post('/room/chat/send', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const parts = splitMessage(text, ROOM_MESSAGE_MAX);
    for (const [i, message] of parts.entries()) {
      if (i) await new Promise(r => setTimeout(r, ROOM_SEND_GAP_MS));
      await call('/send_channel_message', { channel, message });
    }
    res.json({ ok: true, parts: parts.length });
  } catch (e) { sendErr(res, e); }
});

/**
 * A line the desk says by itself — StudioMate's announce prompts and thank-yous. Marked
 * auto-said first, so it never comes back through the chat pump as a line to put on air.
 */
studiocallRouter.post('/room/say', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const message = String(req.body?.message ?? '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    markAutoSaid(message);
    await call('/send_channel_message', { channel, message });
    res.json({ ok: true, channel });
  } catch (e) { sendErr(res, e); }
});

/**
 * The operator's press on the profile card: tell the room how long this person has held the turn
 *. A press, not an automation, so it goes out in any room the desk can chat in — only
 * Cloudflare's block stops it. Refused when somebody else has the turn: a line that
 * says "N minutes" about a person who stopped talking a while ago is the desk misinforming the
 * room, and the card's button is hidden in that state anyway.
 */
const SPEAKING_TIME_LINE = '{speaker} @{name} has been speaking for {minutes}';

studiocallRouter.post('/room/chat/speaking-time', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const userId = String(req.body?.userId ?? '');
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const ms = speakingFor(userId);
  if (ms == null) return res.status(409).json({ error: 'They are not the one speaking right now' });
  if (isRateLimited()) return res.status(429).json({ error: 'Clubhouse has the account under its rate limit — try again in a while' });
  const mins = Math.floor(ms / 60_000);
  const minutes = mins < 1 ? 'less than a minute' : mins === 1 ? '1 minute' : `${mins} minutes`;
  try {
    const { name, message } = fillRoomLine(SPEAKING_TIME_LINE.split('{minutes}').join(minutes), userId);
    markAutoSaid(message);
    await call('/send_channel_message', { channel, message });
    journal('speaking time posted', { userId, name, minutes });
    res.json({ ok: true, minutes: mins, message });
  } catch (e) { sendErr(res, e); }
});

studiocallRouter.post('/room/chat/delete', async (req, res) => {
  const channel = requireChannel(res); if (!channel) return;
  const messageId = String(req.body?.messageId ?? '');
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  try {
    await call('/delete_channel_message', { channel, message_id: messageId });
    // Gone from the room, so gone from every surface reading it: the history the pump holds,
    // the line held on air if it was this one, and every open list — same broadcast the gag uses.
    chatRecent = chatRecent.filter(m => m.id !== messageId);
    if (chatPin?.id === messageId) { chatPin = null; publishControls(); }
    broadcast({ type: 'studiocall-chat-remove', ids: [messageId] } as any);
    res.json({ ok: true, deleted: messageId });
  } catch (e) { sendErr(res, e); }
});

// ── held mutes ──────────────────────────────────────────────────────────────
//
// **One person's mute, standing.**
//
// Muting a speaker on Clubhouse is a one-shot and every speaker owns their own unmute, so the
// person the desk just silenced is back a second later — and the operator, who is talking, has to
// notice and press it again. Every time. That is not a control, it is a chore that arrives
// whenever the show is busiest.
//
// So Mute is a LATCH: the press shuts the mic now, and the speaker pump shuts it again each time
// it opens. **Unmute is the release** — it opens the mic and drops the hold together,
// because a desk that unmutes somebody and then re-mutes them 200 ms later is broken, not strict.
//
// **Not the gag, and not the lock.** A gag also deletes every line they type and is persisted to
// follow them across rooms; the lock is aimed at the whole stage. A held mute is aimed at one
// person, in this room, about their microphone only — which is what pressing Mute on their card
// means. It dies with the room for the same reason the lock does: a hold left standing would
// silence somebody in the NEXT room for a decision nobody present saw anyone make.
interface HeldMute { userId: string; name: string; at: string }

const heldMuted = new Map<string, HeldMute>();

function publishHeld() {
  broadcast({ type: 'studiocall-held-mutes', people: [...heldMuted.values()] } as any);
}

studiocallRouter.get('/room/held-mutes', (_req, res) => res.json({ people: [...heldMuted.values()] }));

// ── speaker status ──────────────────────────────────────────────────────────
//
// **Three standing decisions about one person, kept across rooms.**
//
// - **gag** — every line they type is deleted the moment it arrives, and their mic is shut whenever
//   it opens. A room has one or two people in it who are not there for the conversation, and
//   moderating them by hand is a job that arrives in the middle of the show: every line has to be
//   spotted and deleted while the operator is talking, and the one that gets missed is the one that
//   goes on the canvas. So the decision is made ONCE and the pump does the work from then on.
// - **autoMute** — their mic is shut whenever it opens, and their lines are left alone. The gag's
//   microphone half on its own, for somebody whose typing is fine and whose talking is not.
// - **autoKick** — once they have been in the room longer than `controls.autoKickMinutes` they are
//   removed from it (`/block_from_channel`, moderator-only). The clock starts when the room poll
//   first sees them and restarts if they leave and come back. → `autoKickTick`
// - **autoMod** — made a moderator whenever they are on the stage of a room we moderate
//   (`/make_moderator`, moderator-only and one-way: Clubhouse exposes no revocation). → `autoModTick`
//
// The Clubhouse account block is the fourth column of the same dialog and is NOT stored here:
// Clubhouse holds it, and `blockedPeople()` reads it. A gag is deliberately not a block — a block
// throws them out and tells them so; a gag is quieter and reversible, and the desk stays out of
// the argument.
//
// Persisted, because the whole value is that it outlives the moment: a decision that had to be
// re-made after a content-server reload would be re-made in the middle of the next show. Keyed by
// Clubhouse user id, so it follows them across rooms and renames.
const STATUS_FILE = join(env.DATA_DIR, 'speaker-status.json');
/** Where the gag list lived before it grew the other columns — read once, when the new file is absent. */
const GAG_FILE = join(env.DATA_DIR, 'gagged.json');

type StatusFlag = 'gag' | 'autoMute' | 'autoKick' | 'autoMod';
const STATUS_FLAGS: StatusFlag[] = ['gag', 'autoMute', 'autoKick', 'autoMod'];
/** Each flag holds the ISO time it was set, or is absent. */
interface SpeakerStatus { userId: string; name: string; gag?: string; autoMute?: string; autoKick?: string; autoMod?: string }

let status = new Map<string, SpeakerStatus>();
// One set per flag, rebuilt on every change — the pump asks five times a second.
let gaggedIds = new Set<string>();
let autoMuteIds = new Set<string>();
let autoKickIds = new Set<string>();
let autoModIds = new Set<string>();

function reindexStatus() {
  const with_ = (f: StatusFlag) => new Set([...status.values()].filter(s => s[f]).map(s => s.userId));
  gaggedIds = with_('gag');
  autoMuteIds = with_('autoMute');
  autoKickIds = with_('autoKick');
  autoModIds = with_('autoMod');
}

function loadStatus() {
  try {
    if (existsSync(STATUS_FILE)) {
      const raw = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        status = new Map(raw.filter((s: any) => s?.userId).map((s: any) => {
          const entry: SpeakerStatus = { userId: String(s.userId), name: String(s.name ?? '') };
          for (const f of STATUS_FLAGS) if (s[f]) entry[f] = String(s[f]);
          return [entry.userId, entry];
        }));
      }
    } else if (existsSync(GAG_FILE)) {
      const raw = JSON.parse(readFileSync(GAG_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        status = new Map(raw.filter((g: any) => g?.userId).map((g: any) =>
          [String(g.userId), { userId: String(g.userId), name: String(g.name ?? ''), gag: String(g.at || new Date().toISOString()) }]));
      }
    }
  } catch (e) { logger.warn({ err: e }, '[StudioCall] speaker status unreadable — starting empty'); }
  reindexStatus();
}
loadStatus();

function saveStatus() {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify([...status.values()], null, 2));
  } catch (e) { logger.warn({ err: e }, '[StudioCall] could not save the speaker status'); }
}

async function statusPayload() {
  return { type: 'studiocall-speaker-status', people: [...status.values()], blocked: await blockedPeople() };
}

async function publishStatus() {
  broadcast(await statusPayload() as any);
}

/**
 * Somebody flagged `autoKick` is removed from the room once they have been in it longer than
 * `controls.autoKickMinutes`. Runs on the room poll, on the roster it just fetched, so the clock
 * is "first seen in this room" and is dropped the moment they are not in it — coming back starts
 * it again. Kicking is moderator-only, so it only tries when the room is ours; the bookkeeping
 * runs regardless so a promotion mid-show does not start everybody's clock from zero. Never the
 * operator. Cleared with the room (`stopPing`).
 */
const AUTO_KICK_COOLDOWN_MS = 60_000;
const roomSeenAt = new Map<string, number>();
const autoKickedAt = new Map<string, number>();

/**
 * Anonymous accounts out of the room. `controls.kickAnon`, off by default.
 *
 * **What "anonymous" means here is what the roster row can tell** — `get_channel.users[]` carries
 * `photo_url`, `name` and `username` and nothing about age, followers or bio, and reading
 * `/get_profile` for every arrival would be a call per person per room against an API that
 * throttles bursts. So: no profile photo, or a name / username beginning "anon". The
 * throwaway accounts that drift through a room wear exactly that, and a genuine account with no
 * photo is the price, which is why the switch is off until the operator throws it.
 *
 * Once per person per room (`anonKicked`, cleared with the room and when the switch is thrown):
 * `/block_from_channel` keeps them out, so a second call would be a refusal, not a kick. The
 * operator and moderators are never removed, and the tick needs the desk to moderate the room.
 */
const anonKicked = new Set<string>();
const ANON_NAME = /^\s*anon/i;

function isAnonAccount(u: { name?: string; username?: string; hasPhoto: boolean }): boolean {
  return !u.hasPhoto || ANON_NAME.test(u.name ?? '') || ANON_NAME.test(u.username ?? '');
}

function kickAnonTick(channel: string, here: { userId: string; name: string; username?: string; isModerator: boolean; hasPhoto: boolean }[], iAmModerator: boolean): void {
  if (!controls.kickAnon || !iAmModerator) return;
  const me = String(publicSession()?.userId ?? '');
  for (const u of here) {
    if (u.userId === me || u.isModerator || anonKicked.has(u.userId) || !isAnonAccount(u)) continue;
    anonKicked.add(u.userId);
    const why = !u.hasPhoto ? 'no profile photo' : 'named anon';
    void call('/block_from_channel', { channel, user_id: Number(u.userId) })
      .then(() => {
        logger.info({ userId: u.userId, name: u.name, channel, why }, '[StudioCall] removed an anonymous account from the room');
        journal('removed an anonymous account from the room', { userId: u.userId, name: u.name, why });
        bumpDrops(u.userId);
      })
      .catch(err => logger.warn({ err, userId: u.userId, name: u.name }, '[StudioCall] could not remove an anonymous account — moderators only. They are still in the room'));
  }
}

function autoKickTick(channel: string, here: { userId: string; name: string }[], iAmModerator: boolean): void {
  const now = Date.now();
  const present = new Set(here.map(u => u.userId));
  for (const uid of [...roomSeenAt.keys()]) if (!present.has(uid)) roomSeenAt.delete(uid);
  for (const u of here) if (!roomSeenAt.has(u.userId)) roomSeenAt.set(u.userId, now);
  if (!iAmModerator || !autoKickIds.size) return;
  const me = String(publicSession()?.userId ?? '');
  const limit = controls.autoKickMinutes * 60_000;
  for (const u of here) {
    if (!autoKickIds.has(u.userId) || u.userId === me) continue;
    if (now - (roomSeenAt.get(u.userId) ?? now) < limit) continue;
    if (now - (autoKickedAt.get(u.userId) ?? 0) < AUTO_KICK_COOLDOWN_MS) continue;
    autoKickedAt.set(u.userId, now);
    void call('/block_from_channel', { channel, user_id: Number(u.userId) })
      .then(() => {
        logger.info({ userId: u.userId, channel, minutes: controls.autoKickMinutes }, '[StudioCall] auto-kicked somebody whose minutes ran out');
        journal('auto-kicked somebody whose minutes ran out', { userId: u.userId, name: u.name, minutes: controls.autoKickMinutes });
        bumpDrops(u.userId);
      })
      .catch(err => logger.warn({ err, userId: u.userId }, '[StudioCall] auto-kick refused — moderators only. They are still in the room'));
  }
}

/**
 * Somebody flagged `autoMod` is made a moderator whenever they are on the stage of a room we
 * moderate. Runs on the room poll's roster like the kick, and on the press when they are already
 * up. `/make_moderator` is one-way — Clubhouse exposes no revocation (see `/room/moderator`) — so
 * it fires only for a speaker who is not one yet; a listener cannot hold it, so they get it the
 * moment they come up. Moderator-only, never the operator, one attempt per person per minute,
 * cleared with the room.
 */
const AUTO_MOD_COOLDOWN_MS = 60_000;
const autoModdedAt = new Map<string, number>();
interface StageUser { userId: string; name: string; isSpeaker: boolean; isModerator: boolean }

function autoModTick(channel: string, here: StageUser[], iAmModerator: boolean): void {
  if (!iAmModerator || !autoModIds.size) return;
  const now = Date.now();
  const me = String(publicSession()?.userId ?? '');
  for (const u of here) {
    if (!autoModIds.has(u.userId) || u.userId === me || !u.isSpeaker || u.isModerator) continue;
    if (now - (autoModdedAt.get(u.userId) ?? 0) < AUTO_MOD_COOLDOWN_MS) continue;
    autoModdedAt.set(u.userId, now);
    void call('/make_moderator', { channel, user_id: Number(u.userId) })
      .then(() => {
        logger.info({ userId: u.userId, channel }, '[StudioCall] made an automod speaker a moderator');
        journal('made an automod speaker a moderator', { userId: u.userId, name: u.name });
      })
      .catch(err => logger.warn({ err, userId: u.userId }, '[StudioCall] automod refused — moderators only. They are still a plain speaker'));
  }
}

/**
 * Delete a gagged line in the room, and say so when Clubhouse refuses.
 *
 * `/delete_channel_message` is moderator-only. In a room we do not moderate the gag can still do
 * its other half — the line never reaches this desk's list or the canvas — but it stays up for
 * everybody else, and that difference is not something to discover later from an empty chat.
 */
async function deleteRoomMessage(channel: string, m: { id: string; author: string }): Promise<void> {
  await call('/delete_channel_message', { channel, message_id: m.id })
    .catch(err => logger.warn({ err, author: m.author },
      '[StudioCall] a gagged line could not be deleted — moderators only. It is hidden here but still in the room'));
}

/**
 * Mute a gagged speaker, and keep muting them.
 *
 * A gag started as a text act — every line deleted as it arrives — but the person it is aimed at
 * is often on the stage as well, and there the same decision has to hold or it does not mean
 * anything: gagging somebody who then keeps talking is not a gag, it is a note in a log. So a
 * gagged speaker is re-muted whenever they open their mic.
 *
 * **The trigger is Agora level, not Clubhouse's `is_muted`.** The roster is only refreshed on a
 * TTL, so reading a mute flag from it would react seconds late; the speaker pump already asks the
 * engine who is making sound every 200 ms, and an open mic makes sound. That is as close to "as
 * soon as they unmute" as this rig can see.
 *
 * Rate-limited per person, because the pump ticks five times a second and `/mute_speaker` is a
 * network call — without the cooldown one unmute becomes a burst of identical requests at
 * Clubhouse, which is how an account gets throttled.
 */
const GAG_MUTE_COOLDOWN_MS = 3000;
const gagMutedAt = new Map<string, number>();
const RE_MUTE_LINE_EVERY_MS = 60_000;
const reMuteLineAt = new Map<string, number>();

/**
 * Shut one open mic, at most once every `GAG_MUTE_COOLDOWN_MS`.
 *
 * Three callers want exactly this and must not grow three copies of it: a **gag**, aimed at one
 * person; a **held mute**, aimed at one person for this room only; and the **mute lock**, aimed at
 * everyone on stage. `why` only changes what is said afterwards — the throttle, the call and the
 * moderator-only failure are one implementation, and the cooldown map is shared because it is per
 * PERSON, not per reason: somebody who is gagged AND held AND under the lock must still cost one
 * request per three seconds, not three.
 */
const RE_MUTE_SAID = {
  gag: 'muted a gagged speaker',
  auto: 'muted an auto-muted speaker',
  held: 'held a muted speaker shut',
  lock: 'mute lock closed a mic',
  floor: 'muted somebody speaking out of turn',
} as const;

/**
 * Resolves **true only when the mic actually shut** — false for a call the cooldown skipped and
 * false for one Clubhouse refused. Three of the four callers fire and forget; the floor rule
 * needs the answer, because it posts a line in the room saying the person has been muted and
 * that must never be said about somebody who is still audible.
 */
async function reMuteSpeaker(channel: string, userId: string, why: keyof typeof RE_MUTE_SAID): Promise<boolean> {
  const last = gagMutedAt.get(userId) ?? 0;
  if (Date.now() - last < GAG_MUTE_COOLDOWN_MS) return false;
  gagMutedAt.set(userId, Date.now());
  deskMutedAt.set(userId, Date.now());
  return await call('/mute_speaker', { channel, user_id: Number(userId), muted: true })
    .then(() => {
      const who = status.get(userId)?.name || heldMuted.get(userId)?.name || roster.get(userId)?.name || userId;
      logger.info({ userId, channel, why }, '[StudioCall] re-muted an open mic');
      journal(RE_MUTE_SAID[why], { userId, name: who });
      const saidAt = reMuteLineAt.get(userId) ?? 0;
      if (Date.now() - saidAt > RE_MUTE_LINE_EVERY_MS) {
        reMuteLineAt.set(userId, Date.now());
        deskLine(`${meName()} ${RE_MUTE_SAID[why]}: ${who}`, channel);
      }
      return true;
    })
    // Moderator-only, exactly like deleting their lines. In a room we do not moderate the gag
    // still hides them here, but it cannot take their mic — and that is not something to work
    // out later from somebody talking over the show.
    .catch(err => {
      logger.warn({ err, userId, why },
        '[StudioCall] an open mic could not be muted — moderators only. They are still audible in the room');
      return false;
    });
}

studiocallRouter.get('/speaker-status', async (_req, res) => res.json(await statusPayload()));

/**
 * Set or clear one flag on one person. `on` is explicit rather than a toggle: the button is
 * drawn from a list that arrives by broadcast, and a toggle raced against that list would turn a
 * second click into a release nobody asked for.
 */
studiocallRouter.post('/speaker-status', async (req, res) => {
  const userId = String(req.body?.userId ?? '');
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const flag = req.body?.flag as StatusFlag;
  if (!STATUS_FLAGS.includes(flag)) return res.status(400).json({ error: 'flag must be gag, autoMute, autoKick or autoMod' });
  const on = req.body?.on !== false;
  try {
    const entry = status.get(userId) ?? { userId, name: '' };
    if (req.body?.name) entry.name = String(req.body.name);
    if (on) entry[flag] = new Date().toISOString(); else delete entry[flag];
    if (STATUS_FLAGS.some(f => entry[f])) status.set(userId, entry); else status.delete(userId);
    reindexStatus();
    const channel = liveChannel;
    if (!on) {
      // Deliberately NOT unmuting them: mute is theirs to undo. Letting somebody speak again
      // means the desk stops shutting the mic, not that the desk opens it for them.
      gagMutedAt.delete(userId);
    } else if (flag === 'gag') {
      // What is already on screen is the reason the operator reached for this. Sweeping the lines
      // the desk is still holding is the difference between "from now on" and "gone".
      if (channel) {
        const theirs = chatRecent.filter(m => m.userId === userId);
        for (const m of theirs) await deleteRoomMessage(channel, m);
        chatRecent = chatRecent.filter(m => m.userId !== userId);
        if (theirs.length) broadcast({ type: 'studiocall-chat-remove', ids: theirs.map(m => m.id) } as any);
      }
      // A gagged line held on air is the one place a gag would otherwise leave them talking.
      if (chatPin && chatPin.userId === userId) { chatPin = null; publishControls(); }
    }
    // Gag and automute take their mic now rather than on their next word. The pump would catch
    // them a fifth of a second after they speak, which is a fifth of a second of them on air —
    // somebody already mid-sentence when the operator reached for this should stop, not finish.
    // Muting an already-muted speaker is a no-op, so this is safe when they are not talking, and
    // it costs nothing when they are not on the stage at all.
    if (on && channel && (flag === 'gag' || flag === 'autoMute')) {
      gagMutedAt.delete(userId);   // an explicit act is never held off by the pump's cooldown
      await reMuteSpeaker(channel, userId, flag === 'gag' ? 'gag' : 'auto');
    }
    // Same for automod: somebody already on the stage is promoted on the press, not on the next poll.
    if (on && channel && flag === 'autoMod') autoModTick(channel, (lastRoomBody?.speakers ?? []) as StageUser[], !!lastRoomBody?.iAmModerator);
    saveStatus();
    await publishStatus();
    res.json({ ok: true, userId, flag, on, people: [...status.values()] });
  } catch (e) { sendErr(res, e); }
});

// The cached block list only, never a Clubhouse read per connecting page: overlay pages connect
// too, and the dialog that needs it fresh fetches GET /speaker-status when it opens.
onDisplayConnect(send => send({ type: 'studiocall-speaker-status', people: [...status.values()], blocked: blockedIds?.users ?? null }));

// ── profile photo ───────────────────────────────────────────────────────────

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Uploading a NEW face is not possible from here, and the refusal is Clubhouse's.
 *
 * `/update_photo` is retired for every caller: the request that the current Android app makes,
 * byte for byte — its two parts (`file`/avatar.jpg + `full_file`/full.jpg), its exact header set
 * from `ClubhouseNetworkInterceptor`, `CH-AppBuild: 1038253` — is refused just the same, and this
 * account carries no `ENABLE_PROFILE_PHOTO_HISTORY` flag to reach the newer path with. So the
 * upload is kept only to report that honestly rather than to let a crop dialog fail into a notice
 * the operator has to interpret.
 */
studiocallRouter.post('/profile/photo', photoUpload.single('file'), async (req, res) => {
  const file = (req as any).file;
  if (!file?.buffer?.length) return res.status(400).json({ error: 'no image uploaded' });
  try {
    const form = new FormData();
    form.append('file', new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }), 'avatar.jpg');
    form.append('full_file', new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }), 'full.jpg');
    const out = await callMultipart('/update_photo', form);
    const photoUrl = await refreshOwnPhoto(out);
    res.json({ ok: true, photoUrl });
  } catch (e) { sendErr(res, e); }
});

/**
 * The faces already on this account, newest first — what CAN be switched between from the desk.
 *
 * Clubhouse gave a photo an identity of its own when it retired the uploader: every picture this
 * account has ever worn is still there under a `photo_key` of `<userId>#<micros>`, and selecting
 * one is a supported call. So "change my picture" is a PICK here, not an upload, and a new face
 * has to come from the phone once before it can be chosen.
 *
 * The thumbnails are pulled through `writeImageFile()` like every other avatar — the
 * browser never touches Clubhouse's CDN.
 */
/**
 * Every face an account has worn. `?userId=` reads somebody ELSE's — `/get_user_photo_history`
 * takes a user id and answers for anyone, which is what makes the profile card able to show a
 * caller's past pictures rather than only the one they are wearing today. No argument means the
 * operator's own, which is the half that also gets a Wear button (`/profile/photo/select` only
 * ever writes to this account).
 */
studiocallRouter.get('/profile/photos', async (req, res) => {
  try {
    const asked = String(req.query.userId ?? '').trim();
    const userId = asked ? Number(asked) : publicSession()?.userId;
    if (!userId) return res.status(401).json({ error: 'not signed in' });
    const data = await call('/get_user_photo_history', { user_id: userId });
    const photos = await Promise.all((Array.isArray(data?.photo_history) ? data.photo_history : []).map(async (p: any) => ({
      photoKey: String(p.photo_key),
      thumbnailUrl: await localAvatar(p.thumbnail_url),
      fullUrl: await localAvatar(p.full_photo_url),
    })));
    res.json({ photos });
  } catch (e) { sendErr(res, e); }
});

/**
 * Block somebody, and let them back in.
 *
 * This is the ACCOUNT-level block — `/block` and `/unblock`, which is what the phone app's profile
 * sheet does — and it is not `/block_from_channel` (`/room/block`, further up), which only throws
 * somebody out of the room that is running. The card offers this one because the question it
 * answers is about the person, not about tonight.
 *
 * The cached blocked list is dropped rather than patched: the next card open re-reads it, and a
 * set edited by hand is a set that drifts from Clubhouse the first time a block is made on a phone.
 */
studiocallRouter.post('/user/block', async (req, res) => {
  const userId = String(req.body?.userId ?? '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const on = req.body?.on !== false;
  try {
    const out = await call(on ? '/block' : '/unblock', { user_id: Number(userId) });
    if (out?.success === false) return res.status(400).json({ error: out?.error_message ?? 'Clubhouse refused that' });
    blockedIds = null;
    logger.info({ userId, on }, '[StudioCall] account block changed');
    res.json({ ok: true, userId, blocked: on });
    // Every Speaker Status dialog draws the block column from this list, so a change re-reads it.
    void publishStatus();
  } catch (e) { sendErr(res, e); }
});

/**
 * Follow somebody, or stop. `on` is stated rather than toggled, for the same reason the gag and
 * the mute lock state theirs: the button is drawn from a profile the card polls, and a toggle
 * raced against that read turns a second press into an unfollow nobody asked for.
 *
 * Not a moderator action and not room-scoped — it is the operator's own account following another,
 * so it works on anybody the card can show, in a room or out of one.
 */
studiocallRouter.post('/user/follow', async (req, res) => {
  const userId = String(req.body?.userId ?? '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const on = req.body?.on !== false;
  try {
    const out = await call(on ? '/follow' : '/unfollow', { user_id: Number(userId) });
    if (out?.success === false) return res.status(400).json({ error: out?.error_message ?? 'Clubhouse refused that' });
    journal(on ? 'followed somebody' : 'unfollowed somebody', { userId });
    res.json({ ok: true, userId, following: on });
  } catch (e) { sendErr(res, e); }
});

/** Wear one of them. `photo_key` is `<userId>#<micros>` — never the CDN filename. */
studiocallRouter.post('/profile/photo/select', async (req, res) => {
  const photoKey = String(req.body?.photoKey ?? '').trim();
  if (!photoKey) return res.status(400).json({ error: 'no photoKey' });
  try {
    const out = await call('/set_profile_photo', { photo_key: photoKey });
    if (out?.success === false) return res.status(400).json({ error: out?.error_message ?? 'Clubhouse refused that photo' });
    const photoUrl = await refreshOwnPhoto(out);
    res.json({ ok: true, photoUrl });
  } catch (e) { sendErr(res, e); }
});

// ── device memory ───────────────────────────────────────────────────────────
//
// Remembering the last *selected* pair is not worth much: several selections on this
// rig produced no audio at all. What is worth remembering is the last pair that was
// observed actually carrying signal. So the selection is stored as it happens, and
// separately promoted to `lastWorking` only once the engine reports real outbound
// level while that pair is in force.
//
// Inbound cannot be part of the test — it only moves when somebody else talks, and a
// room can legitimately be silent — so it is recorded when seen but never required.

const DEVICES_FILE = join(env.DATA_DIR, 'devices.json');
const WORKING_FLOOR = 20; // matches the engine's speaking threshold

interface DevicePair { rec: string | null; play: string | null }
interface DeviceMemory {
  selected: DevicePair;
  /** Mono or stereo out of this machine into the room. Remembered beside the pins because
   *  it is applied at the same moment they are — at join, on a fresh or restarted engine. */
  stereo?: boolean;
  lastWorking?: DevicePair & { at: string; outPeak: number; inSeen: boolean;
    /** First moment this pair was proven. `at` is the latest, so `at - since` is how long it held. */
    since?: string };
}

/**
 * A pairing the operator kept, with how long it was carrying audio when they kept it.
 *
 * `lastWorking` holds exactly one pair and every new one overwrites it, which is the wrong shape
 * for the question this rig keeps asking: the RODECaster exposes four near-identical endpoints and
 * which of them works changes with what is plugged in, so what the operator needs is the several
 * pairings that have worked and how long each lasted — a pair that carried an hour is worth more
 * than one that carried nine seconds before dropping out. So these accumulate rather than replace.
 */
interface SavedPair extends DevicePair {
  id: string;
  at: string;
  /** Milliseconds this pair was observed carrying audio before it was saved. 0 = never proven. */
  durationMs: number;
  outPeak: number;
  inSeen: boolean;
}

let deviceMemory: DeviceMemory = { selected: { rec: null, play: null } };
try { deviceMemory = JSON.parse(readFileSync(DEVICES_FILE, 'utf8')); } catch {}

function saveDeviceMemory() {
  try {
    mkdirSync(dirname(DEVICES_FILE), { recursive: true });
    writeFileSync(DEVICES_FILE, JSON.stringify(deviceMemory, null, 2));
  } catch {}
}

function rememberSelection(rec: string | null, play: string | null) {
  deviceMemory.selected = { rec: rec ?? null, play: play ?? null };
  saveDeviceMemory();
}

function samePair(a: DevicePair, b: DevicePair) {
  return (a.rec ?? null) === (b.rec ?? null) && (a.play ?? null) === (b.play ?? null);
}

// Watches the live room and promotes the current pair once it demonstrably carries
// audio. Runs only while in a room, and only every few seconds — the speaker overlay
// already polls fast, this is just evidence gathering.
let workingTimer: NodeJS.Timeout | null = null;

/** The current unbroken run of observed audio on one pair — how long it has been working. */
let workingRun: { pair: DevicePair; from: number; last: number } | null = null;

function startWorkingWatch() {
  if (workingTimer) return;
  workingTimer = setInterval(async () => {
    if (!liveChannel) return;
    try {
      const sp = await audioSpeaking();
      const out = sp?.levels?.out ?? 0;
      const inLvl = sp?.levels?.in ?? 0;
      if (out < WORKING_FLOOR) return;
      const now = deviceMemory.selected;
      const prev = deviceMemory.lastWorking;
      // The run clock, kept apart from the record below. It has to advance on EVERY tick that
      // sees level, but the record stops being rewritten once the peak plateaus — so measuring
      // the span from the record's own timestamps would freeze it a few seconds in.
      const t = Date.now();
      if (workingRun && samePair(workingRun.pair, now)) workingRun.last = t;
      else workingRun = { pair: { ...now }, from: t, last: t };
      // Nothing new to record — unless the run has grown a minute past what is on disk, which is
      // the span itself changing, and the one number a kept pairing is judged on after a reload.
      const stale = !prev?.at || t - Date.parse(prev.at) > 60_000;
      if (prev && samePair(prev, now) && out <= prev.outPeak && (prev.inSeen || inLvl < WORKING_FLOOR) && !stale) return;
      const nowIso = new Date().toISOString();
      const continuing = prev && samePair(prev, now);
      deviceMemory.lastWorking = {
        ...now,
        at: nowIso,
        // A different pair starts its own clock; the same one keeps the clock it started.
        since: new Date(workingRun!.from).toISOString(),
        outPeak: Math.max(out, continuing ? prev!.outPeak : 0),
        inSeen: (continuing ? prev!.inSeen : false) || inLvl >= WORKING_FLOOR,
      };
      saveDeviceMemory();
    } catch {}
  }, 3000);
}

function stopWorkingWatch() {
  if (workingTimer) clearInterval(workingTimer);
  workingTimer = null;
}

// Push the remembered pair at the engine before a join, so a fresh engine or a
// restarted one comes back on the devices that were chosen rather than on defaults.
//
// This is `selected` and never `lastWorking`. Every device change rejoins the channel
// (a pin on a joined channel does not restart capture), and the rejoin comes back
// through here — so preferring lastWorking meant the last *proven* pair was re-pinned
// over the pair the operator had just picked, one moment after picking it. Selecting
// an input snapped back to "— not set —", and the output could not be changed at all.
// lastWorking is evidence for the Restore button, not an authority over a choice.
async function applyRememberedDevices(): Promise<void> {
  const pair = deviceMemory.selected;
  if (!pair.rec && !pair.play && deviceMemory.stereo === undefined) return;
  const pinned = await audioSetDevices({
    appId: getAgoraKey() ?? undefined,
    recordingName: pair.rec,
    playbackName: pair.play,
    stereo: deviceMemory.stereo,
  }).catch(() => null);
  // The engine answers with the name the device goes by today, which may be a renumbered
  // spelling of the one just sent. Take it back, or the stale name is re-pinned at every
  // join for the life of the file.
  if (pinned && (pinned.wantRecordingName !== pair.rec || pinned.wantPlaybackName !== pair.play)) {
    rememberSelection(pinned.wantRecordingName ?? null, pinned.wantPlaybackName ?? null);
  }
}

// Mono or stereo into the room. Its own route rather than a field on /audio/devices,
// because that one reads the device names out of the body and would take an absent pair
// as "clear both". Rejoins for the same reason a device change does: Agora reads the
// audio profile at join and ignores it afterwards.
studiocallRouter.post('/audio/stereo', async (req, res) => {
  const stereo = !!req.body?.stereo;
  deviceMemory.stereo = stereo;
  saveDeviceMemory();
  try {
    const pinned = await audioSetDevices({ appId: getAgoraKey() ?? undefined, stereo });
    const out = { ...pinned, ...(await rejoinLiveRoom()) };
    journal('changed send format', { stereo }, true);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

studiocallRouter.get('/audio/memory', (_req, res) => res.json(deviceMemory));

// The operator declaring the pair good, which is stronger evidence than the watcher's:
// startWorkingWatch() can only promote a pair once it sees outbound level, and a host who
// is listening rather than talking never produces any — so the pair that is plainly
// carrying the room stays unrecorded until it is too late to be useful. This records it
// on the word of the person hearing it, and notes the levels seen at that moment.
studiocallRouter.post('/audio/memory/save', async (_req, res) => {
  const now = deviceMemory.selected;
  if (!now.rec && !now.play) return res.status(409).json({ error: 'no devices are pinned to save' });
  const sp = await audioSpeaking().catch(() => null);
  const prevW = deviceMemory.lastWorking;
  const nowIso = new Date().toISOString();
  deviceMemory.lastWorking = {
    ...now,
    at: nowIso,
    since: prevW && samePair(prevW, now) ? (prevW.since ?? prevW.at) : nowIso,
    outPeak: sp?.levels?.out ?? 0,
    inSeen: (sp?.levels?.in ?? 0) >= WORKING_FLOOR,
  };
  saveDeviceMemory();
  journal('saved this routing as working', { rec: now.rec, play: now.play });
  res.json(deviceMemory);
});

// ── kept pairings ───────────────────────────────────────────────────────────

const PAIRS_FILE = join(env.DATA_DIR, 'audio-pairs.json');

let savedPairs: SavedPair[] = [];
try { savedPairs = JSON.parse(readFileSync(PAIRS_FILE, 'utf8')); } catch {}
function savePairs() {
  try {
    mkdirSync(dirname(PAIRS_FILE), { recursive: true });
    writeFileSync(PAIRS_FILE, JSON.stringify(savedPairs, null, 2));
  } catch (e) { logger.warn({ err: e }, '[StudioCall] could not save the kept pairings'); }
}

/**
 * How long the pair now selected has been carrying audio, in ms.
 *
 * Only `lastWorking` can answer this — it is the one thing that records observed level rather
 * than intent — and only while it is describing the pair actually selected. A pair that was
 * chosen a moment ago and has never been proven returns 0, which is honest: nothing was measured.
 */
function workingSpanMs(): number {
  if (workingRun && samePair(workingRun.pair, deviceMemory.selected)) {
    return Math.max(0, workingRun.last - workingRun.from);
  }
  // No run this session. The persisted record still spans the run it last saw, so a pairing
  // kept after a reload reports what was measured then rather than claiming nothing.
  const w = deviceMemory.lastWorking;
  if (!w || !samePair(w, deviceMemory.selected) || !w.since) return 0;
  const from = Date.parse(w.since);
  const to = Date.parse(w.at);
  return Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0;
}

studiocallRouter.get('/audio/pairs', (_req, res) => res.json({ pairs: savedPairs }));

// Keep the pair now selected, with the span it has been proven for. The operator's own act:
// the watcher can say a pair works, but only the person hearing the room knows it is the one
// worth coming back to after the next restart shuffles the endpoints.
studiocallRouter.post('/audio/pairs', async (_req, res) => {
  const now = deviceMemory.selected;
  if (!now.rec && !now.play) return res.status(409).json({ error: 'no devices are pinned to save' });
  const sp = await audioSpeaking().catch(() => null);
  const entry: SavedPair = {
    id: Date.now().toString(36),
    rec: now.rec ?? null,
    play: now.play ?? null,
    at: new Date().toISOString(),
    durationMs: workingSpanMs(),
    outPeak: deviceMemory.lastWorking && samePair(deviceMemory.lastWorking, now)
      ? deviceMemory.lastWorking.outPeak : (sp?.levels?.out ?? 0),
    inSeen: (sp?.levels?.in ?? 0) >= WORKING_FLOOR
      || !!(deviceMemory.lastWorking && samePair(deviceMemory.lastWorking, now) && deviceMemory.lastWorking.inSeen),
  };
  // One row per pairing: saving the same two devices again updates the span rather than
  // growing a list of identical lines nobody can tell apart.
  savedPairs = [entry, ...savedPairs.filter(p => !samePair(p, entry))];
  savePairs();
  journal('kept this routing', { rec: entry.rec, play: entry.play, durationMs: entry.durationMs });
  res.json({ pairs: savedPairs, saved: entry });
});

studiocallRouter.delete('/audio/pairs/:id', (req, res) => {
  savedPairs = savedPairs.filter(p => p.id !== req.params.id);
  savePairs();
  res.json({ pairs: savedPairs });
});

// Put a kept pairing back. Rejoins, for the same reason Restore does.
studiocallRouter.post('/audio/pairs/:id/restore', async (req, res) => {
  const p = savedPairs.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'no such pairing' });
  try {
    const pinned = await audioSetDevices({ appId: getAgoraKey() ?? undefined, recordingName: p.rec, playbackName: p.play });
    rememberSelection(pinned?.wantRecordingName ?? p.rec, pinned?.wantPlaybackName ?? p.play);
    const out = { ...pinned, restored: p, ...(await rejoinLiveRoom()) };
    journal('restored a kept routing', { rec: p.rec, play: p.play }, true);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

// Put the last known-good pair back. Rejoins, because a device change on a joined
// channel does not restart capture on its own.
studiocallRouter.post('/audio/memory/restore', async (_req, res) => {
  const w = deviceMemory.lastWorking;
  if (!w) return res.status(404).json({ error: 'no known-good configuration recorded yet' });
  try {
    const pinned = await audioSetDevices({ appId: getAgoraKey() ?? undefined, recordingName: w.rec, playbackName: w.play });
    rememberSelection(pinned?.wantRecordingName ?? w.rec, pinned?.wantPlaybackName ?? w.play);
    const out = { ...pinned, restored: w, ...(await rejoinLiveRoom()) };
    journal('pressed Restore', { rec: w.rec, play: w.play }, true);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

// ── the audio journal ───────────────────────────────────────────────────────
//
// Every step is written down as it is taken — the ones that produced silence as well as
// the one that finally worked. A record of the successes alone cannot answer the only
// question anybody actually has afterwards ("I changed six things, which one moved the
// needle"), and the pair that ends up in lastWorking is precisely the one needing no
// explanation. So this logs the ACTION as it reads on screen, what the UI asked for, and
// what the engine reported back — those three disagree exactly when something is wrong.
//
// It also takes a second reading a few seconds later, because the interesting fact about
// a device change is never its return value: capture has only just restarted when the
// route answers, so every meter reads zero. Whether audio actually moved is knowable one
// beat afterwards, and that is the line worth having.

const AUDIO_LOG_DIR = join(env.DATA_DIR, 'audio-logs');
const dayFile = () => join(AUDIO_LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);

async function snapshot(): Promise<Record<string, unknown>> {
  const [h, sp] = await Promise.all([
    audioHealth().catch(() => null),
    audioSpeaking().catch(() => null),
  ]);
  return {
    rec: h?.wantRecordingName ?? null,
    play: h?.wantPlaybackName ?? null,
    stereo: h?.wantStereo ?? null,
    roomLevel: h?.outVolume ?? null,
    micMuted: h?.muted ?? null,
    roomMuted: h?.outMuted ?? null,
    channel: h?.joined?.channel ?? null,
    // The three that say whether sound is truly leaving this machine. `asSpeaker:false`
    // is the audience trap: every device looks right and nothing can ever publish.
    asSpeaker: h?.uplink?.asSpeaker ?? null,
    sending: h?.uplink?.sending ?? null,
    kbps: h?.uplink?.kbps ?? null,
    out: sp?.levels?.out ?? null,
    in: sp?.levels?.in ?? null,
    engineError: h?.lastError?.msg ?? null,
  };
}

// A slider sends a step per tick, and twenty identical rows are how a log stops being read.
// Collapse a repeat of the same step inside this window — the value it settled on is still
// there, because the label carries it and the next action re-reads the state anyway.
const JOURNAL_DEDUPE_MS = 3000;
let lastJournal = { step: '', at: 0 };

/** Fire-and-forget: a log write must never delay an audio control or fail one. */
function journal(step: string, asked?: Record<string, unknown>, followUp = false, key = step): void {
  // Collapse on `key`, not on the label: a drag makes every label distinct ("set the room
  // level to 74%", "…75%") and would slip past a comparison of the words.
  const now = Date.now();
  if (key === lastJournal.step && now - lastJournal.at < JOURNAL_DEDUPE_MS) return;
  lastJournal = { step: key, at: now };
  void (async () => {
    try {
      mkdirSync(AUDIO_LOG_DIR, { recursive: true });
      const write = async (label: string) => {
        const line = { at: new Date().toISOString(), step: label, asked: asked ?? null, ...(await snapshot()) };
        appendFileSync(dayFile(), JSON.stringify(line) + '\n');
      };
      await write(step);
      if (followUp) setTimeout(() => void write(`${step} — 6s later`), 6000);
    } catch {}
  })();
}

const tail = (file: string, lines: number): string => {
  try { return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n'); }
  catch { return '(no log file)'; }
};

/** Who actually holds :4018 — the check that would have caught the orphaned engine. */
const portOwner = (): Promise<string> =>
  new Promise(resolve => {
    execFile('netstat', ['-ano'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err) return resolve('(netstat failed)');
      const rows = out.split(/\r?\n/).filter(l => /:4018\s/.test(l) && /LISTENING/i.test(l));
      resolve(rows.length ? rows.map(r => r.trim()).join('\n') : '(nothing listening on 4018)');
    });
  });

/**
 * Export everything about the audio: what is set now, every step taken today with the
 * result of each, who owns the port, and the engine's own log. One file, meant to be
 * read by a person or pasted into the tracker.
 */
studiocallRouter.post('/audio/log', async (_req, res) => {
  try {
    const now = await snapshot();
    const steps = (() => {
      try { return readFileSync(dayFile(), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); }
      catch { return [] as any[]; }
    })();

    const row = (s: any) => `| ${String(s.at).slice(11, 19)} | ${s.step} | ${s.rec ?? '—'} | ${s.play ?? '—'} | ${s.asSpeaker === false ? '**audience**' : s.sending ? `sending ${s.kbps ?? '?'}kbps` : 'not sending'} | ${s.out ?? '—'}/${s.in ?? '—'} | ${s.engineError ?? ''} |`;

    const pm2 = join(homedir(), '.pm2', 'logs');
    const md = `# StudioCall audio log — ${new Date().toLocaleString()}

## 1. What is set right now

| | |
|---|---|
| Into the room (mic) | ${now.rec ?? '— not set —'} |
| Out of the room (to OBS) | ${now.play ?? '— not set —'} |
| Send format | ${now.stereo ? 'stereo' : 'mono'} |
| Room level | ${now.roomLevel ?? '—'}% |
| Mic muted | ${now.micMuted} |
| Room muted | ${now.roomMuted} |
| Room | ${now.channel ?? 'not in a room'} |
| Publishing | ${now.asSpeaker === false ? 'NO — joined as audience, nothing can be heard' : now.sending ? `yes, ${now.kbps}kbps` : 'no'} |
| Levels out/in | ${now.out ?? '—'} / ${now.in ?? '—'} |
| Engine error | ${now.engineError ?? 'none'} |

Saved as last-known-good: ${deviceMemory.lastWorking
  ? `${deviceMemory.lastWorking.rec ?? 'default'} → ${deviceMemory.lastWorking.play ?? 'default'} (${deviceMemory.lastWorking.at})`
  : 'nothing saved'}

## 2. Every step taken today

Both the ones that worked and the ones that did not. A "— 6s later" row is the same step
re-read once capture had restarted; that is the row that says whether audio actually moved.

| Time | Step | Into the room | Out of the room | Publishing | out/in | Engine error |
|---|---|---|---|---|---|---|
${steps.length ? steps.map(row).join('\n') : '| | (nothing recorded yet today) | | | | | |'}

## 3. Who owns :4018

An engine that answers but was never started by PM2 serves whatever build it was launched
with. Compare this pid against \`npx pm2 jlist\`; two instances, or a listener older than
the PM2 entry's uptime, is the fault.

\`\`\`
${await portOwner()}
\`\`\`

## 4. Engine log — studiocall-audio (out)

\`\`\`
${tail(join(pm2, 'studiocall-audio-out.log'), 40)}
\`\`\`

## 5. Engine log — studiocall-audio (errors)

\`\`\`
${tail(join(pm2, 'studiocall-audio-error.log'), 40)}
\`\`\`
`;

    mkdirSync(AUDIO_LOG_DIR, { recursive: true });
    const name = `audio-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    writeFileSync(join(AUDIO_LOG_DIR, name), md);
    logger.info(`[StudioCall] audio log written — ${name} (${steps.length} steps today)`);
    res.json({ ok: true, file: name, path: join(AUDIO_LOG_DIR, name), steps: steps.length });
  } catch (e) { sendErr(res, e); }
});
