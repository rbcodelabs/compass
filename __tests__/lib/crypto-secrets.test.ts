/**
 * Unit tests for lib/crypto-secrets.ts.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { encrypt, decrypt } from "@/lib/crypto-secrets";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

describe("encrypt/decrypt round trip", () => {
  it("decrypts back to the original plaintext", () => {
    const plaintext = "super-secret-sso-shared-value";
    const ciphertext = encrypt(plaintext, KEY_A);
    expect(decrypt(ciphertext, KEY_A)).toBe(plaintext);
  });

  it("round-trips an empty string", () => {
    const ciphertext = encrypt("", KEY_A);
    expect(decrypt(ciphertext, KEY_A)).toBe("");
  });

  it("round-trips a long value", () => {
    const plaintext = randomBytes(500).toString("base64");
    const ciphertext = encrypt(plaintext, KEY_A);
    expect(decrypt(ciphertext, KEY_A)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext on repeated calls (random IV)", () => {
    const plaintext = "same-value-every-time";
    const c1 = encrypt(plaintext, KEY_A);
    const c2 = encrypt(plaintext, KEY_A);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1, KEY_A)).toBe(plaintext);
    expect(decrypt(c2, KEY_A)).toBe(plaintext);
  });
});

describe("decrypt failure modes (fail closed)", () => {
  it("throws when decrypting with the wrong key", () => {
    const ciphertext = encrypt("secret", KEY_A);
    expect(() => decrypt(ciphertext, KEY_B)).toThrow();
  });

  it("throws when the ciphertext has been tampered with", () => {
    const ciphertext = encrypt("secret", KEY_A);
    const raw = Buffer.from(ciphertext, "base64");
    // Flip a byte in the middle (inside the ciphertext portion, past iv+tag).
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    const tampered = raw.toString("base64");
    expect(() => decrypt(tampered, KEY_A)).toThrow();
  });

  it("throws on truncated/malformed input", () => {
    expect(() => decrypt("not-enough-bytes", KEY_A)).toThrow();
  });

  it("throws when the key does not decode to 32 bytes", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encrypt("secret", shortKey)).toThrow();
    const ciphertext = encrypt("secret", KEY_A);
    expect(() => decrypt(ciphertext, shortKey)).toThrow();
  });
});
