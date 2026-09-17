import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from './env.js';

mkdirSync(env.DATA_DIR, { recursive: true });

export const client = createClient({ url: pathToFileURL(join(env.DATA_DIR, 'studiocall.db')).href });

// Clubhouse people the desk has met, and what it counted about them.
await client.execute(`
  CREATE TABLE IF NOT EXISTS ch_people (
    user_id        TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    username       TEXT NOT NULL DEFAULT '',
    photo_url      TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    followers      INTEGER,
    following      INTEGER,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    rooms_attended INTEGER NOT NULL DEFAULT 0,
    rooms_spoken   INTEGER NOT NULL DEFAULT 0,
    talk_ms        INTEGER NOT NULL DEFAULT 0,
    messages       INTEGER NOT NULL DEFAULT 0,
    drops          INTEGER NOT NULL DEFAULT 0
  )
`);
