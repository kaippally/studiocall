/**
 * Envelope encryption with AES-256-GCM.
 *
 * KMS_MASTER_KEY (env, 32 bytes) wraps a per-row Data Encryption Key (DEK).
 * Each encrypted value is stored as: v1.<wrapped_dek_b64>.<iv_b64>.<ciphertext_b64>.<tag_b64>
 * AAD (additional authenticated data) binds the ciphertext to a context string
 * (typically `${tableName}:${userId}:${columnName}`) so a value can't be moved
 * between rows or columns without detection.
 *
 * Rationale: a single AES-GCM column scheme is the simplest GDPR-compliant
 * "encryption at rest of personal data" pattern (Art. 32). Envelope makes
 * key rotation possible later without re-encrypting every row.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';

const MASTER_KEY = Buffer.from(env.KMS_MASTER_KEY, 'hex');
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

function b64(buf: Buffer) { return buf.toString('base64'); }
function fromB64(s: string) { return Buffer.from(s, 'base64'); }

function encryptWith(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct, tag };
}

function decryptWith(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt a string. `context` MUST uniquely describe where this value lives. */
export function encryptString(plaintext: string, context: string): string {
  const aad = Buffer.from(context, 'utf8');
  const dek = randomBytes(32);
  // Wrap DEK with master key, AAD = context (so wrapped DEK can't be reused elsewhere).
  const wrap = encryptWith(MASTER_KEY, dek, aad);
  const wrappedDek = Buffer.concat([wrap.iv, wrap.tag, wrap.ct]);
  // Encrypt payload with DEK.
  const payload = encryptWith(dek, Buffer.from(plaintext, 'utf8'), aad);
  return [VERSION, b64(wrappedDek), b64(payload.iv), b64(payload.ct), b64(payload.tag)].join('.');
}

export function decryptString(ciphertext: string, context: string): string {
  const aad = Buffer.from(context, 'utf8');
  const parts = ciphertext.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('ciphertext: invalid format');
  const wrapped = fromB64(parts[1]!);
  const iv = fromB64(parts[2]!);
  const ct = fromB64(parts[3]!);
  const tag = fromB64(parts[4]!);
  const wIv = wrapped.subarray(0, 12);
  const wTag = wrapped.subarray(12, 28);
  const wCt = wrapped.subarray(28);
  const dek = decryptWith(MASTER_KEY, wIv, wCt, wTag, aad);
  try {
    const plain = decryptWith(dek, iv, ct, tag, aad);
    return plain.toString('utf8');
  } finally {
    dek.fill(0);
  }
}
