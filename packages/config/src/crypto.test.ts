import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncryptedBlob, safeEqual } from './crypto.js';

const KEY = 'test-encryption-passphrase-0123456789';

describe('crypto: AES-256-GCM secret encryption', () => {
  it('round-trips a secret', () => {
    const plain = 'sk-refresh-token-abcdef.0123456789';
    const blob = encryptSecret(plain, KEY);
    expect(decryptSecret(blob, KEY)).toBe(plain);
  });

  it('round-trips unicode and long payloads', () => {
    const plain = '🔐 ' + 'x'.repeat(4096) + ' café';
    expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
  });

  it('produces a versioned, 5-field blob', () => {
    const blob = encryptSecret('hello', KEY);
    const parts = blob.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(isEncryptedBlob(blob)).toBe(true);
  });

  it('is non-deterministic — same input yields different blobs', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('same');
    expect(decryptSecret(b, KEY)).toBe('same');
  });

  it('fails to decrypt with the wrong key', () => {
    const blob = encryptSecret('secret', KEY);
    expect(() => decryptSecret(blob, 'wrong-passphrase-9999999999')).toThrow();
  });

  it('detects tampering via the GCM auth tag', () => {
    const blob = encryptSecret('secret', KEY);
    const parts = blob.split(':');
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow();
  });

  it('rejects malformed blobs and unknown versions', () => {
    expect(() => decryptSecret('not-a-blob', KEY)).toThrow(/malformed/);
    expect(() => decryptSecret('v9:a:b:c:d', KEY)).toThrow(/unsupported version/);
  });

  it('refuses an empty passphrase on both paths', () => {
    expect(() => encryptSecret('x', '')).toThrow(/passphrase is empty/);
    expect(() => decryptSecret('v1:a:b:c:d', '')).toThrow(/passphrase is empty/);
  });

  it('isEncryptedBlob distinguishes plaintext env refs from blobs', () => {
    expect(isEncryptedBlob('MOCK_PROVIDER_API_KEY')).toBe(false);
    expect(isEncryptedBlob(encryptSecret('x', KEY))).toBe(true);
  });

  it('safeEqual compares in constant time by value', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
