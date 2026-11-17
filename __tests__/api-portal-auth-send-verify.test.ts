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
const mockWorkspace = { findFirst: vi.fn() };

const mockPrisma = {
  workspace: mockWorkspace,
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

vi.mock("@/lib/embed-sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/embed-sources")>("@/lib/embed-sources");
  return { ...actual, resolveEmbedToken: vi.fn() };
});

import { createPortalSession } from "@/lib/portal-auth";
import { EmbedSourceError, resolveEmbedToken } from "@/lib/embed-sources";
import { POST as sendPOST } from "@/app/api/portal/auth/send/route";
import { GET as verifyGET } from "@/app/api/portal/auth/verify/route";

const mockCreatePortalSession = vi.mocked(createPortalSession);
const mockResolveEmbedToken = vi.mocked(resolveEmbedToken);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockPortalVerificationToken.findFirst.mockResolvedValue(null);
  mockPortalVerificationToken.create.mockResolvedValue({ id: "tok-1" });
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" });
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.AUTH_RESEND_KEY;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

/** Sign-in is requested from a workspace portal page unless a test says otherwise. */
function sendRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/portal/auth/send", {
    method: "POST",
    body: JSON.stringify("returnTo" in body || "embedToken" in body ? body : { returnTo: "/portal/acme/ws/roadmap", ...body }),
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

  it("rejects an email containing markup characters with 422 and creates no token", async () => {
    const res = await sendPOST(sendRequest({ email: "<img src=x onerror=alert(1)>@example.com" }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("dev fallback never writes the verify URL to the console", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const res = await sendPOST(sendRequest({ email: "dev-quiet@example.com" }));
    const data = await res.json();
    expect(data.devVerifyUrl).toContain("token=");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("production without AUTH_RESEND_KEY fails closed with 503, creates no token, and logs nothing sensitive", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    const res = await sendPOST(sendRequest({ email: "prod@example.com" }));
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(text).not.toContain("token=");
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const spy of logSpies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("token=");
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("production build without AUTH_RESEND_KEY", () => {
    const MOCK_RUNTIME = {
      COMPASS_ENV: "development",
      E2E_MOCK_AUTH: "1",
      E2E_ISOLATED_DATABASE: "1",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/compass_e2e",
    };
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
      for (const name of ["VERCEL", "VERCEL_ENV", "COMPASS_ENV", "PGHOST", "AWS_ROLE_ARN", "PGSCHEMA", "PREVIEW_AUTOMATION_ENABLED"]) vi.stubEnv(name, undefined);
    });
    afterEach(() => vi.unstubAllEnvs());

    it("hands the verify link back on the e2e mock-auth build in full mock mode (no mail transport exists there)", async () => {
      vi.stubEnv("COMPASS_E2E_MOCK_AUTH_BUILD", "1");
      for (const [name, value] of Object.entries(MOCK_RUNTIME)) vi.stubEnv(name, value);
      const res = await sendPOST(sendRequest({ email: "e2e-portal@example.com" }));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.devVerifyUrl).toContain("token=");
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["unflagged build", { COMPASS_E2E_MOCK_AUTH_BUILD: "" }],
      ["flagged build without the runtime flag", { COMPASS_E2E_MOCK_AUTH_BUILD: "1", E2E_MOCK_AUTH: "" }],
      ["flagged build without COMPASS_ENV", { COMPASS_E2E_MOCK_AUTH_BUILD: "1", COMPASS_ENV: "" }],
    ])(
      "still fails closed with 503 and no token on an %s",
      async (_label, overrides) => {
        for (const [name, value] of Object.entries({ ...MOCK_RUNTIME, ...overrides })) vi.stubEnv(name, value);
        const res = await sendPOST(sendRequest({ email: "prod@example.com" }));
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain("token=");
        expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
      },
    );
  });

  it("returns 502, removes the unsent token, and leaks nothing when the Resend call is rejected", async () => {
    process.env.AUTH_RESEND_KEY = "re_test_key";
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 422 } as Response);
    mockPortalVerificationToken.delete.mockResolvedValue({});
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];

    const res = await sendPOST(sendRequest({ email: "rejected@example.com" }));
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(text).not.toContain("token=");
    expect(mockPortalVerificationToken.delete).toHaveBeenCalledTimes(1);
    for (const spy of logSpies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("token=");
    }
    vi.restoreAllMocks();
  });

  it("returns 502 and removes the unsent token when the Resend call throws", async () => {
    process.env.AUTH_RESEND_KEY = "re_test_key";
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    mockPortalVerificationToken.delete.mockResolvedValue({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await sendPOST(sendRequest({ email: "throws@example.com" }));

    expect(res.status).toBe(502);
    expect(mockPortalVerificationToken.delete).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("rejects an invalid email with 422", async () => {
    const res = await sendPOST(sendRequest({ email: "not-an-email" }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("only accepts /portal/... returnTo values; anything else names no workspace and is refused", async () => {
    const res = await sendPOST(
      sendRequest({ email: "dev2@example.com", returnTo: "https://evil.com/steal" })
    );
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("accepts a valid /portal/... returnTo", async () => {
    const res = await sendPOST(
      sendRequest({ email: "dev3@example.com", returnTo: "/portal/acme/ws/feedback" })
    );
    const data = await res.json();
    expect(data.devVerifyUrl).toContain(encodeURIComponent("/portal/acme/ws/feedback"));
  });
});

describe("POST /api/portal/auth/send: the workspace the session will be bound to", () => {
  it("looks the workspace up from the portal path and stores it on the token", async () => {
    await sendPOST(sendRequest({ email: "a@example.com", returnTo: "/portal/acme/ws/feedback?x=1" }));
    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "ws", organization: { slug: "acme" } },
      select: { id: true },
    });
    expect(mockPortalVerificationToken.create.mock.calls[0][0].data).toMatchObject({ email: "a@example.com", workspaceId: "ws-1" });
  });

  it("422s and mints nothing when no workspace can be determined", async () => {
    const res = await sendPOST(sendRequest({ email: "a@example.com", returnTo: undefined }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("422s and mints nothing when the portal path names a workspace that does not exist", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    const res = await sendPOST(sendRequest({ email: "a@example.com", returnTo: "/portal/acme/nope/roadmap" }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("the embed popup names its workspace through its embed token (it has no /portal path)", async () => {
    mockResolveEmbedToken.mockResolvedValue({ workspaceId: "ws-embed" } as Awaited<ReturnType<typeof resolveEmbedToken>>);
    const res = await sendPOST(sendRequest({ email: "a@example.com", embedToken: "cmp_embed_x" }));
    expect(res.status).toBe(200);
    expect(mockResolveEmbedToken).toHaveBeenCalledWith("cmp_embed_x");
    expect(mockPortalVerificationToken.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "ws-embed" });
  });

  it("a revoked or unknown embed token is refused with 422 and mints nothing", async () => {
    mockResolveEmbedToken.mockRejectedValue(new EmbedSourceError(401, "Invalid embed token"));
    const res = await sendPOST(sendRequest({ email: "a@example.com", embedToken: "cmp_embed_bad" }));
    expect(res.status).toBe(422);
    expect(mockPortalVerificationToken.create).not.toHaveBeenCalled();
  });

  it("an embed token wins over a returnTo: a client cannot name a different workspace than its source's", async () => {
    mockResolveEmbedToken.mockResolvedValue({ workspaceId: "ws-embed" } as Awaited<ReturnType<typeof resolveEmbedToken>>);
    await sendPOST(sendRequest({ email: "a@example.com", embedToken: "cmp_embed_x", returnTo: "/portal/acme/other/roadmap" }));
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
    expect(mockPortalVerificationToken.create.mock.calls[0][0].data.workspaceId).toBe("ws-embed");
  });

  it("throttles per email AND workspace: a live link for one workspace does not block another", async () => {
    await sendPOST(sendRequest({ email: "a@example.com" }));
    expect(mockPortalVerificationToken.findFirst.mock.calls[0][0].where).toMatchObject({
      email: "a@example.com",
      workspaceId: "ws-1",
    });
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
      workspaceId: "ws-1",
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await verifyGET(verifyRequest(`?token=${rawToken}`));

    expect(mockPortalVerificationToken.delete).toHaveBeenCalledWith({ where: { tokenHash } });
    expect(mockCreatePortalSession).toHaveBeenCalledWith("account-1", "ws-1");
  });

  it("refuses a link with no workspace (issued before binding): consumed, no session", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      workspaceId: null,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await verifyGET(verifyRequest("?token=old"));

    expect(res.status).toBe(400);
    expect(mockPortalVerificationToken.delete).toHaveBeenCalled();
    expect(mockPortalAccount.upsert).not.toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it("rejects an expired token (still deletes it, but does not create a session)", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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
      workspaceId: "ws-1",
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

  it("HTML-escapes the stored email in the confirmation page", async () => {
    const malicious = "<img src=x onerror=alert(1)>@example.com";
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: malicious,
      workspaceId: "ws-1",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockPortalAccount.upsert.mockResolvedValue({ id: "account-1", email: malicious });

    const res = await verifyGET(verifyRequest("?token=valid"));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;@example.com");
  });

  it("rejects a protocol-relative returnTo (//evil.com)", async () => {
    mockPortalVerificationToken.findUnique.mockResolvedValue({
      email: "jane@example.com",
      workspaceId: "ws-1",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await verifyGET(verifyRequest("?token=valid&returnTo=%2F%2Fevil.com"));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Signed in as jane@example.com");
  });
});
