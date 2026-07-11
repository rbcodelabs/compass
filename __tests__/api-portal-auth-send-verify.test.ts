/**
 * Unit tests for app/api/portal/auth/send/route.ts and
 * app/api/portal/auth/verify/route.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";

const mockPortalVerificationToken = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};
const mockPortalAccount = { upsert: vi.fn() };

const mockPrisma = {
  portalVerificationToken: mockPortalVerificationToken,
  portalAccount: mockPortalAccount,
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/portal-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portal-auth")>("@/lib/portal-auth");
  return {
    ...actual,
    createPortalSession: vi.fn(),
  };
});

import { createPortalSession } from "@/lib/portal-auth";
import { POST as sendPOST } from "@/app/api/portal/auth/send/route";
import { GET as verifyGET } from "@/app/api/portal/auth/verify/route";

const mockCreatePortalSession = vi.mocked(createPortalSession);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockPortalVerificationToken.findFirst.mockResolvedValue(null);
  mockPortalVerificationToken.create.mockResolvedValue({ id: "tok-1" });
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.AUTH_RESEND_KEY;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

function sendRequest(body: unknown) {
  return new NextRequest("http://localhost/api/portal/auth/send", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ─── /api/portal/auth/send ─────────────────────────────────────────────────────

describe("POST /api/portal/auth/send", () => {
  it("returns generic success for a brand-new email (no account-enumeration signal)", async () => {
    const res = await sendPOST(sendRequest({ email: "new@example.com" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockPortalVerificationToken.create).toHaveBeenCalledTimes(1);
  });

  it("returns the identical generic success shape even when a live token already exists (no duplicate token created)", async () => {
    mockPortalVerificationToken.findFirst.mockResolvedValue({ id: "existing-tok" });

    const res = await sendPOST(sendRequest({ email: "existing@example.com" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("dev fallback (no AUTH_RESEND_KEY): skips the network call and returns devVerifyUrl", async () => {
    const res = await sendPOST(sendRequest({ email: "dev@example.com" }));
    const data = await res.json();

    expect(fetch).not.toHaveBeenCalled();
    expect(data.devVerifyUrl).toContain("/api/portal/auth/verify?token=");
  });

  it("with AUTH_RESEND_KEY set: calls the Resend API directly and does not return devVerifyUrl", async () => {
    process.env.AUTH_RESEND_KEY = "re_test_key";

    const res = await sendPOST(sendRequest({ email: "prod-like@example.com" }));
    const data = await res.json();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({ method: "POST" })
    );
    expect(data.devVerifyUrl).toBeUndefined();
  });

  it("rejects an invalid email with 422", async () => {
    const res = await sendPOST(sendRequest({ email: "not-an-email" }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("only accepts /portal/... returnTo values into the constructed verify URL", async () => {
    const res = await sendPOST(
      sendRequest({ email: "dev2@example.com", returnTo: "https://evil.com/steal" })
    );
    const data = await res.json();
    expect(data.devVerifyUrl).not.toContain("returnTo=");
  });

  it("accepts a valid /portal/... returnTo", async () => {
    const res = await sendPOST(
      sendRequest({ email: "dev3@example.com", returnTo: "/portal/acme/ws/feedback" })
    );
    const data = await res.json();
    expect(data.devVerifyUrl).toContain(encodeURIComponent("/portal/acme/ws/feedback"));
  });
});

// ─── /api/portal/auth/verify ────────────────────────────────────────────────────

function verifyRequest(query: string) {
  return new NextRequest(`http://localhost/api/portal/auth/verify${query}`);
}

describe("GET /api/portal/auth/verify", () => {
  beforeEach(() => {
    mockCreatePortalSession.mockResolvedValue("raw-session-token");
    mockPortalAccount.upsert.mockResolvedValue({ id: "account-1", email: "jane@example.com" });
    mockPortalVerificationToken.delete.mockResolvedValue({});
  });

  it("400s when no token is present", async () => {
    const res = await verifyGET(verifyRequest(""));
    expect(res.status).toBe(400);
    expect(mockPortalVerificationToken.findUnique).not.toHaveBeenCalled();
  });

  it("400s when the token doesn't match any verification row", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue(null);
    const res = await verifyGET(verifyRequest("?token=unknown"));
    expect(res.status).toBe(400);
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it("is single-use: deletes the verification token row on lookup, before creating a session", async () => {
    const rawToken = "valid-raw-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await verifyGET(verifyRequest(`?token=${rawToken}`));

    expect(mockPortalVerificationToken.delete).toHaveBeenCalledWith({ where: { tokenHash } });
    expect(mockCreatePortalSession).toHaveBeenCalledWith("account-1");
  });

  it("rejects an expired token (still deletes it, but does not create a session)", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await verifyGET(verifyRequest("?token=expired"));

    expect(res.status).toBe(400);
    expect(mockPortalVerificationToken.delete).toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it("redirects to a valid /portal/... returnTo on success", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await verifyGET(
      verifyRequest("?token=valid&returnTo=%2Fportal%2Facme%2Fws%2Ffeedback")
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/portal/acme/ws/feedback");
  });

  it("rejects an absolute-URL returnTo (open-redirect attempt) and falls back to the confirmation page", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await verifyGET(
      verifyRequest("?token=valid&returnTo=https%3A%2F%2Fevil.com")
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed in as jane@example.com");
  });

  it("rejects a protocol-relative returnTo (//evil.com)", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await verifyGET(verifyRequest("?token=valid&returnTo=%2F%2Fevil.com"));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed in as jane@example.com");
  });
});
