import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadDotenv({ path: resolve(ROOT, '.env') });

function required(name: string, test: RegExp, hint: string): string {
  const v = process.env[name] ?? '';
  if (!test.test(v)) throw new Error(`${name} ${hint} — set it in ${resolve(ROOT, '.env')}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  ROOT,
  PORT: Number(process.env.STUDIOCALL_PORT) || 4019,
  DATA_DIR: resolve(ROOT, process.env.STUDIOCALL_DATA_DIR || 'data'),
  // The key the Clubhouse session token is encrypted with. A session imported from StudioMate
  // was sealed with StudioMate's KMS_MASTER_KEY, so the same value has to be used here.
  KMS_MASTER_KEY: required('KMS_MASTER_KEY', /^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)'),
  // Optional. Set, and the StudioMate-side features work: the OBS headline, browser-source
  // refresh, the Telegram announce, the YouTube chat bridge, News Desk link capture, short links.
  STUDIOMATE_URL: (process.env.STUDIOMATE_URL || '').replace(/\/$/, ''),
  AUDIO_URL: process.env.STUDIOCALL_AUDIO_URL || 'http://127.0.0.1:4018',
  // The Agora App ID Clubhouse's audio runs on. Imported from Clubdeck with the session; a session
  // made by SMS login has none, and this supplies it.
  AGORA_APP_ID: process.env.CLUBHOUSE_AGORA_APP_ID || '',
  // Walk out of a room we only joined when the last UI closes. '0' keeps the room.
  LEAVE_ON_ADMIN_CLOSE: process.env.STUDIOCALL_LEAVE_ON_ADMIN_CLOSE !== '0',
};
