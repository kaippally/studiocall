import { fetch as undiciFetch } from 'undici';
import JSONBig from 'json-bigint';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MEDIA_ROUTE, writeImageFile } from '../media.js';
import { env } from '../env.js';
import { encryptString, decryptString } from '../crypto.js';
import { logger } from '../logger.js';

// The one connection to Clubhouse's undocumented mobile API. Everything StudioCall
// does — auth, opening a room, the roster behind the speaker overlay — goes through
// call(). The client never talks to Clubhouse; only this server does.

const DATA_DIR = env.DATA_DIR;
const SESSION_FILE = join(DATA_DIR, 'session.json');

// Clubhouse rejects a request whose CH-AppVersion/Build drift from a real mobile
// client, so these track the app Clubdeck last shipped against. Bump when 401s
// start appearing for no other reason.
const DEFAULT_API_ROOT = 'https://www.clubhouseapi.com/api';
const DEFAULT_USER_AGENT = 'clubhouse/android';
const DEFAULT_APP_VERSION = '24.01.02';
const DEFAULT_APP_BUILD = '3375';

export interface Session {
  apiRoot: string;
  userAgent: string;
  appVersion: string;
  appBuild: string;
  languages: string;
  locale: string;
  acceptLanguages: string;
  deviceId: string;
  userId: number;
  authTokenEnc: string; // encrypted at rest; never logged, never sent to the client
  agoraKeyEnc?: string; // Agora App ID — the audio leg needs it
  name?: string;
  username?: string;
  photoUrl?: string;      // Clubhouse CDN — server-side use only
  photoUrlLocal?: string; // /api/studiocall/media/images/<hash>.<ext>
}

let session: Session | null = null;
try {
  session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
} catch {}

function persist(s: Session) {
  session = s;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

export function hasSession(): boolean {
  return !!session;
}

// What the client and UI are allowed to see. No token, no Agora key.
export function publicSession() {
  if (!session) return null;
  return {
    userId: session.userId,
    name: session.name,
    username: session.username,
    photoUrl: session.photoUrlLocal ?? null,
    appVersion: session.appVersion,
    appBuild: session.appBuild,
  };
}

// Clubhouse serves avatars from its own CDN, which the browser client is not allowed
// to touch and which must not be hotlinked into the DB or overlay.
// Pull each one through writeImageFile once and hand out the local path. The speaker
// overlay reuses this — same faces, same cache.
const avatarCache = new Map<string, string>();

export async function localAvatar(remoteUrl: string | undefined | null): Promise<string | null> {
  if (!remoteUrl) return null;
  const hit = avatarCache.get(remoteUrl);
  if (hit) return hit;
  try {
    const res = await undiciFetch(remoteUrl);
    if (!res.ok) return null;
    const { filename } = await writeImageFile(Buffer.from(await res.arrayBuffer()));
    const local = `${MEDIA_ROUTE}/${filename}`;
    avatarCache.set(remoteUrl, local);
    return local;
  } catch (e) {
    logger.warn({ err: e }, 'studiocall avatar fetch failed');
    return null;
  }
}

export async function cacheOwnAvatar(): Promise<void> {
  if (!session?.photoUrl || session.photoUrlLocal) return;
  const local = await localAvatar(session.photoUrl);
  if (local) persist({ ...session, photoUrlLocal: local });
}

export function getAuthToken(): string {
  if (!session) throw new Error('StudioCall not logged in');
  return decryptString(session.authTokenEnc, 'studiocall:auth');
}

export function getAgoraKey(): string | null {
  if (!session?.agoraKeyEnc) return env.AGORA_APP_ID || null;
  return decryptString(session.agoraKeyEnc, 'studiocall:agora');
}

function headers(): Record<string, string> {
  if (!session) throw new Error('StudioCall not logged in');
  return {
    'CH-Languages': session.languages,
    'CH-Locale': session.locale,
    'CH-AppBuild': session.appBuild,
    'CH-AppVersion': session.appVersion,
    'User-Agent': session.userAgent,
    'CH-DeviceId': session.deviceId,
    'CH-UserID': String(session.userId),
    'Accept-Language': session.acceptLanguages,
    Authorization: `Token ${getAuthToken()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export class ClubhouseError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Clubhouse API ${status}`);
    this.name = 'ClubhouseError';
  }
}

// Clubhouse issues snowflake IDs past Number.MAX_SAFE_INTEGER — a social_club_id of
// 6106309341783081985 comes back from JSON.parse as ...082000. Silently wrong, and it
// would address the wrong house. Parse every response with big integers preserved as
// strings, and always pass IDs back as strings.
const JSONbig = JSONBig({ storeAsString: true, useNativeBigInt: false });

/**
 * A 429 is "not yet", not "no", and treating the two the same is how muting a full stage came to
 * mute nobody: Clubhouse throttled the burst, every refusal was reported as a failure,
 * and the operator was told which nine people were still live. So a throttled call waits and goes
 * again — the `Retry-After` it names when it names one, a short backoff when it does not.
 *
 * Three attempts and roughly a second and a half of waiting at worst, which is inside what any
 * caller here can absorb; past that the throttle is not a burst of ours and the error is real.
 */
const THROTTLE_TRIES = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function throttleWaitMs(res: { headers: { get(name: string): string | null } }, attempt: number): number {
  const named = Number(res.headers.get('retry-after'));
  return Number.isFinite(named) && named > 0 ? Math.min(named * 1000, 10_000) : 400 * 2 ** attempt;
}

/**
 * The other throttle, and it is not a burst of ours: Cloudflare's **error 1015** in front of the
 * API blocks the whole account for `retry_after` seconds (30 in every one seen), and every request
 * made inside that window — retries included — keeps the block alive. Retrying into it is what
 * held the account under a limit for minutes: each poll tick fired another line, each
 * line waited 3 × 10 s and failed, and the next tick had already queued the next one. So a 1015 is
 * not retried at all; it opens a window in which `call()` refuses immediately, with the same
 * error and no request made, and `isRateLimited()` lets the fire-and-forget automations skip
 * their turn instead of feeding it.
 */
const RATE_LIMIT_DEFAULT_S = 30;
const RATE_LIMIT_MAX_S = 60;
let rateLimitedUntil = 0;

export function isRateLimited(): boolean { return Date.now() < rateLimitedUntil; }

function rateLimitError(json: any): ClubhouseError {
  const left = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
  const wait = left > 0 ? `${left} s` : 'a moment';
  const body = json && typeof json === 'object' ? json : {};
  return new ClubhouseError(429, body.error_message ? body
    : { ...body, error_message: `Clubhouse is rate-limiting this account — wait ${wait} and try again.` });
}

// A Clubhouse API call. Most endpoints are POST with a JSON body even when they
// read; GET is used for a handful (get_settings, get_channel). Path is the bare
// endpoint, e.g. '/create_channel'.
export async function call(path: string, body?: unknown, method: 'GET' | 'POST' = body ? 'POST' : 'GET'): Promise<any> {
  if (!session) throw new Error('StudioCall not logged in');
  if (isRateLimited()) throw rateLimitError(null);
  for (let attempt = 0; ; attempt++) {
    const res = await undiciFetch(`${session.apiRoot}${path}`, {
      method,
      headers: headers(),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSONbig.parse(text) : null; } catch { json = text; }
    if (res.status === 429 && json?.cloudflare_error) {
      const named = Number(json.retry_after);
      const secs = Math.min(Number.isFinite(named) && named > 0 ? named : RATE_LIMIT_DEFAULT_S, RATE_LIMIT_MAX_S);
      rateLimitedUntil = Date.now() + secs * 1000;
      logger.warn({ path, secs }, 'studiocall clubhouse rate-limited by Cloudflare — holding every call');
      throw rateLimitError(json);
    }
    if (res.status === 429 && attempt < THROTTLE_TRIES - 1) {
      const wait = throttleWaitMs(res, attempt);
      logger.warn({ path, attempt, wait }, 'studiocall clubhouse throttled — waiting');
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      logger.warn({ path, status: res.status }, 'studiocall clubhouse call failed');
      throw res.status === 429 ? rateLimitError(json) : new ClubhouseError(res.status, json);
    }
    return json;
  }
}

// Adopt the credential the desktop Clubhouse client (Clubdeck) already holds,
// instead of re-authing by SMS and risking invalidating its live session. Reads
// its plaintext profile.json, encrypts the token into our own session store.
export function importFromClubdeck(profilePath: string): Session {
  const p = JSON.parse(readFileSync(profilePath, 'utf8'));
  const authToken: string | undefined = p?.tokens?.auth || p?.token || p?._debug?.auth_token;
  const userId: number | undefined = p?.userId ?? p?.user?.user_id ?? p?._debug?.user_profile?.user_id;
  if (!authToken || !userId) throw new Error('Clubdeck profile has no auth token / user id');
  const s: Session = {
    apiRoot: p.apiRoot || DEFAULT_API_ROOT,
    userAgent: p.userAgent || DEFAULT_USER_AGENT,
    appVersion: String(p.appVersion || DEFAULT_APP_VERSION),
    appBuild: String(p.appBuild || DEFAULT_APP_BUILD),
    languages: p.languages || 'en-US',
    locale: p.locale || 'en_US',
    acceptLanguages: p.acceptLanguages || 'en-US;q=1',
    deviceId: p.deviceId || randomUUID().toUpperCase(),
    userId,
    authTokenEnc: encryptString(authToken, 'studiocall:auth'),
    agoraKeyEnc: p.agoraKey ? encryptString(String(p.agoraKey), 'studiocall:agora') : undefined,
    name: p.user?.name ?? p._debug?.user_profile?.name,
    username: p.user?.username ?? p._debug?.user_profile?.username,
    photoUrl: p.user?.photo_url ?? p._debug?.user_profile?.photo_url,
  };
  persist(s);
  return s;
}

// SMS auth path, for logging in without a Clubdeck install. Two steps: request a
// code, then complete with it. A fresh deviceId is minted only if we have none,
// so a re-verify doesn't read as a new device.
export async function startPhoneAuth(phoneNumber: string): Promise<any> {
  const deviceId = session?.deviceId || randomUUID().toUpperCase();
  const res = await undiciFetch(`${DEFAULT_API_ROOT}/start_phone_number_auth`, {
    method: 'POST',
    headers: {
      'CH-Languages': 'en-US',
      'CH-Locale': 'en_US',
      'CH-AppBuild': DEFAULT_APP_BUILD,
      'CH-AppVersion': DEFAULT_APP_VERSION,
      'User-Agent': DEFAULT_USER_AGENT,
      'CH-DeviceId': deviceId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ phone_number: phoneNumber }),
  });
  pendingDeviceId = deviceId;
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new ClubhouseError(res.status, json);
  return json;
}

let pendingDeviceId: string | null = null;

export async function completePhoneAuth(phoneNumber: string, code: string): Promise<Session> {
  const deviceId = pendingDeviceId || session?.deviceId || randomUUID().toUpperCase();
  const res = await undiciFetch(`${DEFAULT_API_ROOT}/complete_phone_number_auth`, {
    method: 'POST',
    headers: {
      'CH-Languages': 'en-US',
      'CH-Locale': 'en_US',
      'CH-AppBuild': DEFAULT_APP_BUILD,
      'CH-AppVersion': DEFAULT_APP_VERSION,
      'User-Agent': DEFAULT_USER_AGENT,
      'CH-DeviceId': deviceId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ phone_number: phoneNumber, verification_code: code }),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.auth_token) throw new ClubhouseError(res.status, json);
  const s: Session = {
    apiRoot: DEFAULT_API_ROOT,
    userAgent: DEFAULT_USER_AGENT,
    appVersion: DEFAULT_APP_VERSION,
    appBuild: DEFAULT_APP_BUILD,
    languages: 'en-US',
    locale: 'en_US',
    acceptLanguages: 'en-US;q=1',
    deviceId,
    userId: json.user_profile.user_id,
    authTokenEnc: encryptString(json.auth_token, 'studiocall:auth'),
    name: json.user_profile.name,
    username: json.user_profile.username,
    photoUrl: json.user_profile.photo_url,
  };
  persist(s);
  return s;
}

export const CLUBDECK_PROFILE = join(
  process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'Clubdeck',
  'profile.json',
);

// update_photo is the one endpoint that takes multipart rather than JSON — Clubdeck
// flags it to skip body serialization. Same auth headers, minus Content-Type, which
// fetch must set itself so the multipart boundary is correct.
export async function callMultipart(path: string, form: FormData): Promise<any> {
  if (!session) throw new Error('StudioCall not logged in');
  const h = headers();
  delete (h as any)['Content-Type'];
  const res = await undiciFetch(`${session.apiRoot}${path}`, { method: 'POST', headers: h, body: form as any });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSONbig.parse(text) : null; } catch { json = text; }
  if (!res.ok || json?.success === false) throw new ClubhouseError(res.status, json);
  return json;
}

// After a photo change, re-read the profile and re-cache the image locally so the
// UI and overlay never point at Clubhouse's CDN.
export async function refreshOwnPhoto(updateResponse?: any): Promise<string | null> {
  if (!session) return null;
  let remote: string | undefined = updateResponse?.user_profile?.photo_url ?? updateResponse?.photo_url;
  if (!remote) {
    const prof = await call('/get_profile', { user_id: session.userId }).catch(() => null);
    remote = prof?.user_profile?.photo_url;
  }
  if (!remote) return session.photoUrlLocal ?? null;
  const local = await localAvatar(remote);
  persist({ ...session, photoUrl: remote, photoUrlLocal: local ?? undefined });
  return local;
}
