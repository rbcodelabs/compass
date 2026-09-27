/**
 * Unit tests for app/api/embed/sso/route.ts — the widget's direct Portal SSO
 * Identify exchange: a customer-signed JWT in, a scoped visitor token out, no
 * popup and no cookie.
 *
 * Mocking follows the same shape as __tests__/api-embed-comments-route.test.ts
 * and __tests__/api-embed-session-route.test.ts: resolveEmbedToken,
 * consumeEmbedRate, and touchEmbedToken are stubbed out of @/lib/embed-sources
 * while isOriginAllowed and EmbedSourceError stay real (the ordering of the
 * origin check relative to everything else is part of what is under test).
 * mintEmbedVisitorSession is stubbed the same way resolveEmbedVisitorToken is
 * stubbed in those files, so this file tests this route's policy rather than
 * lib/embed-visitor's own mint logic (covered by __tests__/embed-visitor.test.ts).
 *
 * verifySsoToken, decrypt/encrypt, and jose's SignJWT are all real — the same
 * choice __tests__/lib/portal-sso.test.ts and
 * __tests__/api-admin-portal-sso-resync.test.ts make — because several tests
 * below are exactly about the real crypto: a token signed with the wrong
 * secret must fail here exactly as it does there.
 *
 * @/lib/db is mocked with a tiny in-memory upsert-by-email, not a bare
 * vi.fn(), so "a second call with the same identity reuses the same
 * PortalAccount" exercises real upsert semantics instead of merely asserting
 * a mock was called twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { encrypt } from "@/lib/crypto-secrets";

type Account = { id: string; email: string; name: string | null };

let accounts: Map<string, Account>;
let nextAccountId: number;

const mockPortalAccountUpsert = vi.fn(
  async ({ where, update, create }: { where: { email: string }; update: { name?: string }; create: { email: string; name: string | null } }) => {
    const existing = accounts.get(where.email);
    if (existing) {
      const merged = { ...existing, ...(update.name ? { name: update.name } : {}) };
      accounts.set(where.email, merged);
      return merged;
    }
    const created: Account = { id: `portal-${nextAccountId++}`, email: create.email, name: create.name ?? null };
    accounts.set(where.email, created);
    return created;
  }
);

const mockPrisma = { portalAccount: { upsert: mockPortalAccountUpsert } };
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return { ...actual, resolveEmbedToken: vi.fn(), consumeEmbedRate: vi.fn(), touchEmbedToken: vi.fn() };
});

vi.mock("@/lib/embed-visitor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-visitor")>();
  return { ...actual, mintEmbedVisitorSession: vi.fn() };
});

import { EMBED_TOKEN_PREFIX, consumeEmbedRate, resolveEmbedToken, touchEmbedToken } from "@/lib/embed-sources";
import { mintEmbedVisitorSession } from "@/lib/embed-visitor";
import { OPTIONS, POST } from "@/app/api/embed/sso/route";

const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockTouch = vi.mocked(touchEmbedToken);
const mockMint = vi.mocked(mintEmbedVisitorSession);

const ORIGIN = "https://prototype.example.com";
// Assembled from the exported prefix rather than pasted whole — resolveEmbedToken
// is mocked here, so nothing hashes or looks this up, and a bare 32-hex literal
// would read to the secret scanner as a credential it is not.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
const SSO_SECRET = Buffer.alloc(32, 3).toString("base64");
const OTHER_SECRET = Buffer.alloc(32, 111).toString("base64");
const ENCRYPTED_SECRET = encrypt(SSO_SECRET, ENCRYPTION_KEY);

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [ORIGIN],
  authMode: "PORTAL" as const,
  ssoEnabled: true,
  ssoSecretEncrypted: ENCRYPTED_SECRET,
};

const AUTH = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };

function post(body: unknown, headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/sso", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function signSsoToken(
  opts: {
    email?: string;
    name?: string;
    secret?: string;
    expiresInSeconds?: number;
    issuedSecondsAgo?: number;
  } = {}
): Promise<string> {
  const { email = "dana@example.com", name, secret = SSO_SECRET, expiresInSeconds = 60, issuedSecondsAgo = 0 } = opts;
  const key = new TextEncoder().encode(secret);
  const nowSeconds = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  const payload: Record<string, unknown> = { email };
  if (name) payload.name = name;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + expiresInSeconds)
    .sign(key);
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  accounts = new Map();
  nextAccountId = 1;
  process.env.SSO_SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  mockTouch.mockResolvedValue(undefined);
  mockMint.mockResolvedValue({ token: "cmpvt_minted", expiresAt: new Date("2026-01-01T00:00:00.000Z") });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("OPTIONS", () => {
  it("advertises exactly POST for CORS preflight", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("POST /api/embed/sso", () => {
  it("mints a visitor token for a valid JWT against a PORTAL source", async () => {
    const jwt = await signSsoToken({ email: "Dana@Example.com" });
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "cmpvt_minted",
      expiresAt: "2026-01-01T00:00:00.000Z",
      email: "dana@example.com",
      name: null,
    });
    expect(mockMint).toHaveBeenCalledWith({
      feedbackSourceId: "source-1",
      identity: { portalAccountId: expect.any(String) },
    });
    // READ is charged immediately after authorize; SUBMIT only once the JWT
    // has actually verified — see the module header.
    expect(mockRate).toHaveBeenNthCalledWith(1, "token-1", "READ");
    expect(mockRate).toHaveBeenNthCalledWith(2, "token-1", "SUBMIT");
    expect(mockTouch).toHaveBeenCalledWith("token-1");
  });

  it("carries a name claim through to the resolved account", async () => {
    const jwt = await signSsoToken({ email: "ada@example.com", name: "Ada Lovelace" });
    const response = await POST(post({ ssoToken: jwt }));
    await expect(response.json()).resolves.toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
  });

  it("reuses the same PortalAccount on a second exchange (upsert, not create-or-fail)", async () => {
    const jwt = await signSsoToken({ email: "dana@example.com" });

    await POST(post({ ssoToken: jwt }));
    const firstIdentity = mockMint.mock.calls[0][0].identity as { portalAccountId: string };

    await POST(post({ ssoToken: jwt }));
    const secondIdentity = mockMint.mock.calls[1][0].identity as { portalAccountId: string };

    expect(secondIdentity.portalAccountId).toBe(firstIdentity.portalAccountId);
    // Two upserts against the same email, never a second row.
    expect(mockPortalAccountUpsert).toHaveBeenCalledTimes(2);
    expect(accounts.size).toBe(1);
  });

  it("rejects an INTERNAL_SSO source with 403 regardless of workspace SSO config", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, authMode: "INTERNAL_SSO" });
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
    // The refusal must be identical whether or not SSO Identify happens to be
    // configured on the workspace — see the module header. Both branches below
    // (ssoEnabled true here, false in the next test) produce the same status
    // and, more importantly, the same message.
    const body = await response.json();
    expect(body.error).toBe("SSO Identify sign-in is only available for feedback sources in PORTAL mode.");
  });

  it("gives an INTERNAL_SSO source the identical refusal whether or not SSO Identify is configured", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, authMode: "INTERNAL_SSO", ssoEnabled: false, ssoSecretEncrypted: null });
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("SSO Identify sign-in is only available for feedback sources in PORTAL mode.");
  });

  it("rejects a PORTAL source whose workspace has not enabled SSO Identify", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, ssoEnabled: false });
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("rejects a PORTAL source with no ssoSecretEncrypted even if the flag is on", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, ssoSecretEncrypted: null });
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(403);
  });

  it("rejects a token signed with the wrong secret as 401, without charging SUBMIT", async () => {
    const jwt = await signSsoToken({ secret: OTHER_SECRET });
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();
    // Only the READ charge happened — see the module header on why a bad JWT
    // must not touch the SUBMIT bucket.
    expect(mockRate).toHaveBeenCalledTimes(1);
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
  });

  it("rejects an expired token as 401, without charging SUBMIT", async () => {
    const jwt = await signSsoToken({ issuedSecondsAgo: 120, expiresInSeconds: 60 });
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(401);
    expect(mockRate).toHaveBeenCalledTimes(1);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("rejects garbage in place of a JWT as 401", async () => {
    const response = await POST(post({ ssoToken: "not-a-jwt" }));
    expect(response.status).toBe(401);
    expect(mockRate).toHaveBeenCalledTimes(1);
  });

  it("rejects a disallowed origin with 403, before any rate charge", async () => {
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" }));
    expect(response.status).toBe(403);
    expect(mockRate).not.toHaveBeenCalled();
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-JSON) body with 400", async () => {
    const response = await POST(post("not json"));
    expect(response.status).toBe(400);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("rejects a non-object JSON body with 400", async () => {
    const response = await POST(post("[1,2,3]"));
    expect(response.status).toBe(400);
  });

  it("rejects a missing ssoToken with 400", async () => {
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ ssoToken: 12345 }))).status).toBe(400);
    expect((await POST(post({ ssoToken: "   " }))).status).toBe(400);
  });

  it("rejects a request with no embed token as 401", async () => {
    const response = await POST(post({ ssoToken: "irrelevant" }, { origin: ORIGIN }));
    expect(response.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("never sets Access-Control-Allow-Credentials, and never caches the minted token", async () => {
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 429 with Retry-After when the quota is spent", async () => {
    const { EmbedSourceError } = await import("@/lib/embed-sources");
    mockRate.mockRejectedValueOnce(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("returns 500 without minting anything when SSO_SECRET_ENCRYPTION_KEY is not configured", async () => {
    delete process.env.SSO_SECRET_ENCRYPTION_KEY;
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(500);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("returns 500 without minting anything when the stored ciphertext does not decrypt under the current key", async () => {
    mockResolve.mockResolvedValue({ ...RESOLVED, ssoSecretEncrypted: "not-valid-ciphertext" });
    const jwt = await signSsoToken();
    const response = await POST(post({ ssoToken: jwt }));
    expect(response.status).toBe(500);
    expect(mockMint).not.toHaveBeenCalled();
  });
});
