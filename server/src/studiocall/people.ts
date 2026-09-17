import { client } from '../db.js';
import { logger } from '../logger.js';

/**
 * Everybody the desk has met in a Clubhouse room, and what it counted about them (`ch_people`).
 *
 * The record is COUNTS, never messages: lines posted, rooms seen in, rooms spoken in while the
 * desk moderated, total speech, and how often the desk dropped them. It exists so the Speaker
 * Status rows and the CHinfocard can say who somebody is to this show — "listener since May,
 * forty rooms, an hour on the stage, dropped twice" — without anybody remembering it.
 *
 * Writes are throttled per person: the room poll sees two hundred listeners every few seconds,
 * and an upsert per person per poll would be the busiest thing in the database. A row is
 * written when something it counts changed, or once a minute to move `last_seen_at`.
 */
export interface Person {
  userId: string; name: string; username: string; photoUrl: string; notes: string;
  followers: number | null; following: number | null;
  firstSeenAt: string; lastSeenAt: string;
  roomsAttended: number; roomsSpoken: number; talkMs: number; messages: number; drops: number;
}

const SEEN_WRITE_GAP_MS = 60_000;
const TALK_FLUSH_MS = 10_000;

let roomKey: string | null = null;
const seenRoom = new Set<string>();
const spokeRoom = new Set<string>();
const lastWrote = new Map<string, number>();
const talkBuf = new Map<string, number>();

const nowIso = () => new Date().toISOString();

/** A counter column, added to on the way in — the row is made if it is the first time. */
type Counter = 'rooms_attended' | 'rooms_spoken' | 'talk_ms' | 'messages' | 'drops';

async function bump(userId: string, col: Counter, n: number): Promise<void> {
  const now = nowIso();
  await client.execute({
    sql: `INSERT INTO ch_people (user_id, first_seen_at, last_seen_at, ${col}) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET ${col} = ${col} + excluded.${col}, last_seen_at = excluded.last_seen_at`,
    args: [userId, now, now, n],
  }).catch(err => logger.warn({ err, userId, col }, '[StudioCall] people: could not count'));
}

/** The room changed or ended: the per-room "already counted" books start again. */
export function resetPeopleRoom(): void {
  roomKey = null;
  seenRoom.clear();
  spokeRoom.clear();
}

/**
 * The room poll's roster. Attendance is counted once per person per room, and "spoken" once
 * per person per room the desk moderates — a listener promoted later is counted then.
 */
export async function touchPeople(
  channel: string,
  users: { userId: string; name?: string; username?: string; photoUrl?: string | null; isSpeaker: boolean }[],
  hosted: boolean,
): Promise<void> {
  if (channel !== roomKey) { roomKey = channel; seenRoom.clear(); spokeRoom.clear(); }
  const nowMs = Date.now();
  const now = nowIso();
  for (const u of users) {
    if (!u.userId) continue;
    const attend = seenRoom.has(u.userId) ? 0 : 1;
    if (attend) seenRoom.add(u.userId);
    const spoke = hosted && u.isSpeaker && !spokeRoom.has(u.userId) ? 1 : 0;
    if (spoke) spokeRoom.add(u.userId);
    if (!attend && !spoke && nowMs - (lastWrote.get(u.userId) ?? 0) < SEEN_WRITE_GAP_MS) continue;
    lastWrote.set(u.userId, nowMs);
    await client.execute({
      sql: `INSERT INTO ch_people (user_id, name, username, photo_url, first_seen_at, last_seen_at, rooms_attended, rooms_spoken)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
              username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE username END,
              photo_url = CASE WHEN excluded.photo_url <> '' THEN excluded.photo_url ELSE photo_url END,
              last_seen_at = excluded.last_seen_at,
              rooms_attended = rooms_attended + excluded.rooms_attended,
              rooms_spoken = rooms_spoken + excluded.rooms_spoken`,
      args: [u.userId, u.name ?? '', u.username ?? '', u.photoUrl ?? '', now, now, attend, spoke],
    }).catch(err => logger.warn({ err, userId: u.userId }, '[StudioCall] people: could not record'));
  }
}

/** Speech, from the talk clock's tick — buffered and flushed every ten seconds. */
export function addTalk(userId: string, ms: number): void {
  talkBuf.set(userId, (talkBuf.get(userId) ?? 0) + ms);
}

setInterval(() => {
  if (!talkBuf.size) return;
  const batch = [...talkBuf];
  talkBuf.clear();
  for (const [uid, ms] of batch) void bump(uid, 'talk_ms', ms);
}, TALK_FLUSH_MS);

export function bumpMessages(userId: string): void { void bump(userId, 'messages', 1); }
export function bumpDrops(userId: string): void { void bump(userId, 'drops', 1); }

/** What `/get_profile` said — the counts a row cannot learn from a roster line. */
export async function noteProfile(p: { userId: string; name?: string; username?: string; photoUrl?: string | null; followers: number | null; following: number | null }): Promise<void> {
  const now = nowIso();
  await client.execute({
    sql: `INSERT INTO ch_people (user_id, name, username, photo_url, followers, following, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
            username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE username END,
            photo_url = CASE WHEN excluded.photo_url <> '' THEN excluded.photo_url ELSE photo_url END,
            followers = COALESCE(excluded.followers, followers),
            following = COALESCE(excluded.following, following)`,
    args: [p.userId, p.name ?? '', p.username ?? '', p.photoUrl ?? '', p.followers, p.following, now, now],
  }).catch(err => logger.warn({ err, userId: p.userId }, '[StudioCall] people: could not note the profile'));
}

export async function setNotes(userId: string, notes: string): Promise<void> {
  const now = nowIso();
  await client.execute({
    sql: `INSERT INTO ch_people (user_id, notes, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET notes = excluded.notes`,
    args: [userId, notes, now, now],
  });
}

function rowToPerson(r: Record<string, unknown>): Person {
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
  const nn = (v: unknown) => (v == null ? null : n(v));
  return {
    userId: String(r.user_id), name: String(r.name ?? ''), username: String(r.username ?? ''),
    photoUrl: String(r.photo_url ?? ''), notes: String(r.notes ?? ''),
    followers: nn(r.followers), following: nn(r.following),
    firstSeenAt: String(r.first_seen_at ?? ''), lastSeenAt: String(r.last_seen_at ?? ''),
    roomsAttended: n(r.rooms_attended), roomsSpoken: n(r.rooms_spoken), talkMs: n(r.talk_ms),
    messages: n(r.messages), drops: n(r.drops),
  };
}

export async function getPeople(ids: string[]): Promise<Record<string, Person>> {
  const clean = [...new Set(ids.filter(Boolean))];
  if (!clean.length) return {};
  const out: Record<string, Person> = {};
  // A row per id, in chunks — a stage of two hundred is one query, not two hundred.
  for (let i = 0; i < clean.length; i += 200) {
    const chunk = clean.slice(i, i + 200);
    const rs = await client.execute({
      sql: `SELECT * FROM ch_people WHERE user_id IN (${chunk.map(() => '?').join(',')})`,
      args: chunk,
    });
    for (const r of rs.rows) { const p = rowToPerson(r as unknown as Record<string, unknown>); out[p.userId] = p; }
  }
  return out;
}
