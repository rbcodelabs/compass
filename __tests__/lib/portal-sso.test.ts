/**
 * Unit tests for lib/portal-sso.ts.
 */
import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { generateSsoSecret, verifySsoToken } from "@/lib/portal-sso";

const SECRET = generateSsoSecret();
const KEY = new TextEncoder().encode(SECRET);
const OTHER_KEY = new TextEncoder().encode(generateSsoSecret());

interface TokenOpts {
  email?: unknown;
  omitEmail?: boolean;
  name?: unknown;
  expiresInSeconds?: number;
  issuedSecondsAgo?: number;
  key?: Uint8Array;
  alg?: string;
  omitExp?: boolean;
  omitIat?: boolean;
}

async function mintToken(opts: TokenOpts = {}): Promise<string> {
  const {
    email = "user@example.com",
    omitEmail = false,
    name,
    expiresInSeconds = 60,
    issuedSecondsAgo = 0,
    key = KEY,
    alg = "HS256",
    omitExp = false,
    omitIat = false,
  } = opts;

  const nowSeconds = Math.floor(Date.now() / 1000) - issuedSecondsAgo;

  const payload: Record<string, unknown> = {};
  if (!omitEmail) payload.email = email;
  if (name !== undefined) payload.name = name;

  let builder = new SignJWT(payload).setProtectedHeader({ alg });
  if (!omitIat) builder = builder.setIssuedAt(nowSeconds);
  if (!omitExp) builder = builder.setExpirationTime(nowSeconds + expiresInSeconds);

  return builder.sign(key);
}

describe("generateSsoSecret", () => {
  it("produces a base64 string that decodes to 32 bytes", () => {
    const secret = generateSsoSecret();
    expect(Buffer.from(secret, "base64").length).toBe(32);
  });

  it("produces a different secret on each call", () => {
    expect(generateSsoSecret()).not.toBe(generateSsoSecret());
  });
});

describe("verifySsoToken — happy path", () => {
  it("returns the email for a validly signed token", async () => {
    const token = await mintToken({ email: "USER@Example.com  " });
    const identity = await verifySsoToken(SECRET, token);
    expect(identity).toEqual({ email: "user@example.com" });
  });

  it("includes a trimmed name when present", async () => {
    const token = await mintToken({ email: "a@b.com", name: "  Ada Lovelace  " });
    const identity = await verifySsoToken(SECRET, token);
    expect(identity).toEqual({ email: "a@b.com", name: "Ada Lovelace" });
  });

  it("omits name when not provided", async () => {
    const token = await mintToken({ email: "a@b.com" });
    const identity = await verifySsoToken(SECRET, token);
    expect(identity).toEqual({ email: "a@b.com" });
    expect(identity && "name" in identity).toBe(false);
  });

  it("omits name when it is an empty/whitespace string", async () => {
    const token = await mintToken({ email: "a@b.com", name: "   " });
    const identity = await verifySsoToken(SECRET, token);
    expect(identity).toEqual({ email: "a@b.com" });
  });
});

describe("verifySsoToken — fails closed", () => {
  it("rejects a token signed with the wrong secret", async () => {
    const token = await mintToken({ key: OTHER_KEY });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token signed with a different algorithm (alg confusion)", async () => {
    // HS256 key reused under "none" is rejected by jose's SignJWT itself for
    // unsecured tokens, so simulate the more realistic case: a token with a
    // header alg our verifier doesn't allow. jwtVerify pins to ["HS256"],
    // so signing with HS384 (same key material reinterpreted) must fail.
    const token = await mintToken({ alg: "HS384" });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({ issuedSecondsAgo: 120, expiresInSeconds: 60 });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token older than the 5 minute max age even if not yet expired", async () => {
    const token = await mintToken({ issuedSecondsAgo: 6 * 60, expiresInSeconds: 60 * 60 });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token missing the email claim", async () => {
    const token = await mintToken({ omitEmail: true });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token with a non-string email claim", async () => {
    const token = await mintToken({ email: 12345 });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token with an empty/whitespace-only email claim", async () => {
    const token = await mintToken({ email: "   " });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token with a non-string name claim", async () => {
    const token = await mintToken({ email: "a@b.com", name: 42 });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token missing iat", async () => {
    const token = await mintToken({ omitIat: true });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects a token missing exp", async () => {
    const token = await mintToken({ omitExp: true });
    expect(await verifySsoToken(SECRET, token)).toBeNull();
  });

  it("rejects garbage input instead of throwing", async () => {
    expect(await verifySsoToken(SECRET, "not-a-jwt")).toBeNull();
    expect(await verifySsoToken(SECRET, "")).toBeNull();
  });
});
