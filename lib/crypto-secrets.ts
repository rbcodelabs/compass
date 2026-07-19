/**
 * Reversible symmetric encryption for secrets Compass must be able to
 * decrypt later (unlike password hashing, which is one-way by design).
 *
 * Used for `Workspace.ssoSecretEncrypted`: the SSO shared secret is shown
 * to the customer once, at generation time, but Compass must keep the
 * plaintext available (encrypted at rest) so it can verify inbound
 * customer-signed JWTs on every SSO exchange.
 *
 * AES-256-GCM: a random 96-bit nonce per encryption call, authenticated
 * (tamper-evident — `decrypt` throws on any ciphertext/tag mismatch rather
 * than silently returning garbage).
 */
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // 96-bit nonce, the recommended size for GCM
const AUTH_TAG_LENGTH_BYTES = 16;

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `Encryption key must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

/**
 * Encrypts `plaintext` with AES-256-GCM using `keyB64` (a base64-encoded
 * 32-byte key). Returns a single base64 string packing [iv][authTag][ciphertext]
 * — everything needed to decrypt except the key itself.
 */
export function encrypt(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypts a value produced by `encrypt`. Fails closed: a wrong key,
 * truncated/corrupted input, or tampered ciphertext all throw rather than
 * returning a partially-decrypted or garbage string.
 */
export function decrypt(encoded: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const raw = Buffer.from(encoded, "base64");

  if (raw.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Ciphertext is too short to contain an IV and auth tag");
  }

  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
