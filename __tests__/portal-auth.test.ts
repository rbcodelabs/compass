/**
 * Unit tests for lib/portal-auth.ts.
 *
 * Prisma and next/headers' cookies() are both mocked — no real DB or
 * request context is used.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPortalSession = {
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};

const mockPrisma = {
  portalSession: mockPortalSession,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

// In-memory fake cookie jar mimicking next/headers' ReadonlyRequestCookies
// (the subset of the API lib/portal-auth.ts actually uses: get/set/delete).
const cookieJar = new Map<string, string>();
const mockCookieStore = {
  get: vi.fn((name: string) => {
    const value = cookieJar.get(name);
    return value !== undefined ? { name, value } : undefined;
  }),
  set: vi.fn((name: string, value: string) => {
    cookieJar.set(name, value);
  }),
  delete: vi.fn((name: string) => {
    cookieJar.delete(name);
  }),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

import {
  normalizePortalEmail,
  createPortalSession,
  getPortalSession,
  clearPortalSession,
  PORTAL_SESSION_COOKIE,
} from "@/lib/portal-auth";

beforeEach(() => {
  vi.clearAllMocks();
  cookieJar.clear();
});

// ─── normalizePortalEmail ─────────────────────────────────────────────────────

describe("normalizePortalEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizePortalEmail("  Jane@Example.COM  ")).toBe("jane@example.com");
  });

  it("is idempotent on already-normalized input", () => {
    expect(normalizePortalEmail("jane@example.com")).toBe("jane@example.com");
  });
});

// ─── createPortalSession / getPortalSession round trip ────────────────────────

describe("createPortalSession + getPortalSession", () => {
  it("round-trips: a session created via createPortalSession is readable via getPortalSession", async () => {
    mockPortalSession.create.mockResolvedValue({ id: "sess-1" });

    await createPortalSession("account-1");

    // The cookie should now be set with a raw token.
    expect(mockCookieStore.set).toHaveBeenCalledWith(
      PORTAL_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    );

    const rawToken = cookieJar.get(PORTAL_SESSION_COOKIE)!;
    expect(rawToken).toBeTruthy();

    // Simulate the DB now containing that session, keyed by its hash.
    const createCall = mockPortalSession.create.mock.calls[0][0];
    const storedTokenHash = createCall.data.tokenHash;

    mockPortalSession.findUnique.mockResolvedValue({
      portalAccountId: "account-1",
      expiresAt: new Date(Date.now() + 60_000),
      portalAccount: { email: "jane@example.com" },
    });
    mockPortalSession.update.mockResolvedValue({});

    const session = await getPortalSession();

    expect(mockPortalSession.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: storedTokenHash },
      select: expect.any(Object),
    });
    expect(session).toEqual({ portalAccountId: "account-1", email: "jane@example.com" });
  });

  it("never persists the raw token — only a hash", async () => {
    mockPortalSession.create.mockResolvedValue({ id: "sess-1" });
    await createPortalSession("account-1");

    const rawToken = cookieJar.get(PORTAL_SESSION_COOKIE)!;
    const createCall = mockPortalSession.create.mock.calls[0][0];
    expect(createCall.data.tokenHash).not.toBe(rawToken);
    expect(createCall.data).not.toHaveProperty("token");
  });
});

// ─── getPortalSession failure modes (fail closed) ─────────────────────────────

describe("getPortalSession", () => {
  it("returns null when no cookie is present", async () => {
    const session = await getPortalSession();
    expect(session).toBeNull();
    expect(mockPortalSession.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the cookie doesn't match any session row", async () => {
    cookieJar.set(PORTAL_SESSION_COOKIE, "some-unknown-token");
    mockPortalSession.findUnique.mockResolvedValue(null);

    const session = await getPortalSession();
    expect(session).toBeNull();
  });

  it("returns null when the matching session has expired", async () => {
    cookieJar.set(PORTAL_SESSION_COOKIE, "expired-token");
    mockPortalSession.findUnique.mockResolvedValue({
      portalAccountId: "account-1",
      expiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
      portalAccount: { email: "jane@example.com" },
    });

    const session = await getPortalSession();
    expect(session).toBeNull();
    // Fails closed without mutating state (no lastUsedAt bump on an expired row).
    expect(mockPortalSession.update).not.toHaveBeenCalled();
  });
});

// ─── clearPortalSession ────────────────────────────────────────────────────────

describe("clearPortalSession", () => {
  it("deletes the session row and clears the cookie when a cookie is present", async () => {
    cookieJar.set(PORTAL_SESSION_COOKIE, "some-token");
    mockPortalSession.deleteMany.mockResolvedValue({ count: 1 });

    await clearPortalSession();

    expect(mockPortalSession.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.any(String) },
    });
    expect(mockCookieStore.delete).toHaveBeenCalledWith(PORTAL_SESSION_COOKIE);
  });

  it("still clears the cookie even when no cookie was present", async () => {
    await clearPortalSession();

    expect(mockPortalSession.deleteMany).not.toHaveBeenCalled();
    expect(mockCookieStore.delete).toHaveBeenCalledWith(PORTAL_SESSION_COOKIE);
  });
});
