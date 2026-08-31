import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../env';

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');
const ALGO = 'aes-256-gcm';

/**
 * Full-length GCM tag, in bytes.
 *
 * Node accepts shorter tags (4, 8, 12...) and verifies against whatever length
 * it is given, so a payload carrying a 4-byte tag would be authenticated with
 * only 32 bits of integrity. Pinning the length - and rejecting anything else
 * before it reaches the cipher - keeps forgery resistance at the full 128 bits
 * regardless of what the stored payload claims.
 */
const AUTH_TAG_BYTES = 16;

/**
 * Encrypt a secret (e.g. a GitHub access token) for storage at rest.
 * Format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv, { authTagLength: AUTH_TAG_BYTES });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed encrypted payload');
  const iv = Buffer.from(parts[1] as string, 'base64');
  const tag = Buffer.from(parts[2] as string, 'base64');
  const data = Buffer.from(parts[3] as string, 'base64');
  // Refuse a truncated tag outright rather than letting GCM verify against it.
  if (tag.length !== AUTH_TAG_BYTES) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv(ALGO, KEY, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** scrypt password hashing - no native dependencies required. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export const sha256 = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
