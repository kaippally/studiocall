/**
 * One-time move of StudioCall's state out of StudioMate.
 *
 *   npm run migrate:studiomate            (from server/)
 *   npm run migrate:studiomate -- --force (overwrite data already here)
 *
 * Copies data/studiocall/* (the Clubhouse session, controls, speaker flags, invites, device pins,
 * kept audio pairs, short links, the room), the `ch_people` rows out of kcom.db, and every avatar
 * those records point at — rewriting `/api/media/file/images/…` to `/api/studiocall/media/images/…`.
 * Writes `.env` with StudioMate's KMS_MASTER_KEY when there is none, because the session token was
 * sealed with that key.
 *
 * Refuses while StudioMate's room.json names a live room: two servers pinging, polling and
 * re-joining one Clubhouse room on one account is how the audio leg gets banned (error 123).
 */
import { createClient } from '@libsql/client';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const force = process.argv.includes('--force');
if (!process.env.STUDIOMATE_DIR) throw new Error('Set STUDIOMATE_DIR to the StudioMate folder to migrate from.');
const SM = resolve(process.env.STUDIOMATE_DIR);
const SM_DATA = join(SM, 'data', 'studiocall');
const SM_IMAGES = join(SM, 'data', 'media', 'images');
const SM_DB = join(SM, 'data', 'kcom.db');

const envFile = join(ROOT, '.env');
if (!existsSync(envFile)) {
  const smEnv = readFileSync(join(SM, '.env'), 'utf8');
  const key = smEnv.match(/^KMS_MASTER_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error(`No KMS_MASTER_KEY in ${join(SM, '.env')}`);
  writeFileSync(envFile, `KMS_MASTER_KEY=${key}\nSTUDIOMATE_URL=https://localhost:4000\n`);
  console.log(`wrote ${envFile}`);
}

const { env } = await import('../src/env.js');
const DATA = env.DATA_DIR;

const smRoom = (() => { try { return JSON.parse(readFileSync(join(SM_DATA, 'room.json'), 'utf8')); } catch { return null; } })();
if (smRoom?.channel && !force) {
  console.error(`StudioMate is still in room ${smRoom.channel}. End or leave it first (or pass --force if StudioMate's StudioCall server is already gone).`);
  process.exit(1);
}
if (existsSync(join(DATA, 'session.json')) && !force) {
  console.error(`${DATA} already holds a session — pass --force to overwrite it.`);
  process.exit(1);
}

mkdirSync(join(DATA, 'media', 'images'), { recursive: true });
const OLD = '/api/media/file/';
const NEW = '/api/studiocall/media/';
const images = new Set<string>();
const collect = (text: string) => {
  for (const m of text.matchAll(/\/api\/media\/file\/(images\/[A-Za-z0-9]+\.[a-z0-9]+)/g)) images.add(m[1]!);
};

let files = 0;
for (const name of readdirSync(SM_DATA)) {
  const from = join(SM_DATA, name);
  const to = join(DATA, name);
  if (statSync(from).isDirectory()) { cpSync(from, to, { recursive: true }); continue; }
  if (!name.endsWith('.json')) { copyFileSync(from, to); continue; }
  const text = readFileSync(from, 'utf8');
  collect(text);
  writeFileSync(to, text.split(OLD).join(NEW));
  files++;
}
console.log(`copied ${files} state files`);

const src = createClient({ url: pathToFileURL(SM_DB).href });
const { client: dst } = await import('../src/db.js');
const rows = (await src.execute('SELECT * FROM ch_people')).rows as unknown as Record<string, unknown>[];
for (const r of rows) {
  const photo = String(r.photo_url ?? '');
  collect(photo);
  await dst.execute({
    sql: `INSERT OR REPLACE INTO ch_people (user_id, name, username, photo_url, notes, followers, following,
            first_seen_at, last_seen_at, rooms_attended, rooms_spoken, talk_ms, messages, drops)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.user_id, r.name, r.username, photo.split(OLD).join(NEW), r.notes, r.followers, r.following,
      r.first_seen_at, r.last_seen_at, r.rooms_attended, r.rooms_spoken, r.talk_ms, r.messages, r.drops] as any,
  });
}
console.log(`copied ${rows.length} people`);

let copied = 0, missing = 0;
for (const img of images) {
  const from = join(SM_IMAGES, img.slice('images/'.length));
  if (!existsSync(from)) { missing++; continue; }
  copyFileSync(from, join(DATA, 'media', img));
  copied++;
}
console.log(`copied ${copied} avatars${missing ? `, ${missing} referenced but not on disk` : ''}`);
process.exit(0);
