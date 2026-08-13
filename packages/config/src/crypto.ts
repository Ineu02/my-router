import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric encryption for secrets stored at rest.
 *
 * The DB historically held only a *reference* to a secret (an env var name).
 * OAuth tokens have no env var — they are minted at runtime and must live in
 * the database — so they are encrypted here before they ever touch SQLite.
 *
 * Scheme: AES-256-GCM with a per-blob random salt and IV. The key is derived
 * from a passphrase (CREDENTIAL_ENC_KEY, falling back to SESSION_SECRET) via
 * scrypt, so the raw key never has to be stored. GCM's auth tag makes tampering
 * detectable — a modified ciphertext fails to decrypt rather than returning
 * garbage.
 *
 * Blob layout (all base64url, `:`-joined, versioned):
 *
 *   v1:<salt>:<iv>:<tag>:<ciphertext>
 *
 * The version prefix lets the scheme evolve without a data migration.
 */

const VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce — the size GCM is defined for.
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256.

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt is deliberately slow; these params match Node's documented safe
  // defaults and are fine for the low call volume here (once per token write).
  return scryptSync(passphrase, salt, KEY_BYTES, { N: 16384, r: 8, p: 1 });
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Encrypt UTF-8 plaintext into a self-describing blob. The passphrase must be
 * non-empty — an empty key would derive a predictable key and defeat the point.
 */
export function encryptSecret(plaintext: string, passphrase: string): string {
  if (!passphrase) {
    throw new Error('encryptSecret: passphrase is empty — set CREDENTIAL_ENC_KEY or SESSION_SECRET');
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(salt), b64(iv), b64(tag), b64(ct)].join(':');
}

/**
 * Reverse of {@link encryptSecret}. Throws on any structural problem, an
 * unknown version, a wrong key, or a tampered blob (GCM tag mismatch).
 */
export function decryptSecret(blob: string, passphrase: string): string {
  if (!passphrase) {
    throw new Error('decryptSecret: passphrase is empty — set CREDENTIAL_ENC_KEY or SESSION_SECRET');
  }
  const parts = blob.split(':');
  if (parts.length !== 5) {
    throw new Error('decryptSecret: malformed blob');
  }
  const [version, saltB, ivB, tagB, ctB] = parts;
  if (version !== VERSION) {
    throw new Error(`decryptSecret: unsupported version "${version}"`);
  }

  const salt = unb64(saltB!);
  const iv = unb64(ivB!);
  const tag = unb64(tagB!);
  const ct = unb64(ctB!);
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('decryptSecret: malformed blob fields');
  }

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True if a string looks like one of our encrypted blobs (cheap prefix test). */
export function isEncryptedBlob(s: string): boolean {
  return typeof s === 'string' && s.startsWith(`${VERSION}:`) && s.split(':').length === 5;
}

/** Constant-time string compare, for comparing decrypted tokens/ids safely. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
