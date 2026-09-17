import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env.js';

// Every face this app draws is pulled off Clubhouse's CDN (or Google's, for a YouTube line) once
// and served from here, because the browser client never talks to a third-party origin and an
// OBS page resolves a picture against its own host.
export const MEDIA_DIR = join(env.DATA_DIR, 'media');
export const MEDIA_ROUTE = '/api/studiocall/media';
mkdirSync(join(MEDIA_DIR, 'images'), { recursive: true });

export async function writeImageFile(buf: Buffer): Promise<{ filename: string }> {
  const ft = await fileTypeFromBuffer(buf);
  if (!ft || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ft.mime)) {
    throw new Error('unsupported image type');
  }
  const normalized = await sharp(buf).rotate().toBuffer();
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const filename = `images/${hash}.${ft.ext}`;
  await writeFile(join(MEDIA_DIR, filename), normalized);
  return { filename };
}
