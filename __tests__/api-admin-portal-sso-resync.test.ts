/**
 * Unit tests for app/api/admin/portal-sso-resync/route.ts.
 *
 * One-time-ops admin endpoint (mirrors app/api/admin/migrate/route.ts's
 * checkAuth() pattern): regenerates a workspace's SSO Identify shared
 * secret and returns the raw value, so a customer integration whose copy
 * has drifted out of sync with our DB can be resynced without needing an
 * interactive login to Settings. Gated by MIGRATION_SECRET, same trust
 * boundary as the migrate route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspaceFindFirst = vi.fn();
const mockWorkspaceUpdate = vi.fn();

const mockPrisma = {
  workspace: {
    findFirst: mockWorkspaceFindFirst,
    update: mockWorkspaceUpdate,
  },
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

import { POST } from "@/app/api/admin/portal-sso-resync/route";

const ORIGINAL_ENV = { ...process.env };

function request(body: unknown, secret?: string) {
  return new NextRequest("http://localhost/api/admin/portal-sso-resync", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-migration-secret": secret } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIGRATION_SECRET = "test-migration-secret";
  process.env.SSO_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/portal-sso-resync", () => {
  it("rejects a request without the correct x-migration-secret header", async () => {
    const res = await POST(request({ orgSlug: "rbcodelabs", workspaceSlug: "golden-wealth" }, "wrong-secret"));
    expect(res.status).toBe(401);
    expect(mockWorkspaceUpdate).not.toHaveBeenCalled();
  });

  it("rejects (401, not a distinguishing error) when MIGRATION_SECRET is not configured on the server", async () => {
    // Matches checkAuth() in app/api/admin/migrate/route.ts: a missing server
    // secret must not be distinguishable from a wrong header value to an
    // unauthenticated caller.
    delete process.env.MIGRATION_SECRET;
    const res = await POST(request({ orgSlug: "rbcodelabs", workspaceSlug: "golden-wealth" }, "anything"));
    expect(res.status).toBe(401);
    expect(mockWorkspaceUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the org/workspace slug pair doesn't resolve to a workspace", async () => {
    mockWorkspaceFindFirst.mockResolvedValue(null);
    const res = await POST(
      request({ orgSlug: "nope", workspaceSlug: "nope" }, "test-migration-secret")
    );
    expect(res.status).toBe(404);
  });

  it("regenerates the secret, persists it enabled and encrypted, and returns the raw value", async () => {
    mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1" });
    mockWorkspaceUpdate.mockResolvedValue({ id: "ws-1" });

    const res = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "golden-wealth" }, "test-migration-secret")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.rawSecret).toBe("string");
    expect(body.rawSecret.length).toBeGreaterThan(0);

    expect(mockWorkspaceUpdate).toHaveBeenCalledTimes(1);
    const call = mockWorkspaceUpdate.mock.calls[0][0];
    expect(call.where).toEqual({ id: "ws-1" });
    expect(call.data.ssoEnabled).toBe(true);
    expect(call.data.ssoSecretEncrypted).toEqual(expect.any(String));
    // The stored value must be the ENCRYPTED form, never the raw secret.
    expect(call.data.ssoSecretEncrypted).not.toBe(body.rawSecret);
    expect(call.data.ssoSecretUpdatedAt).toBeInstanceOf(Date);
  });

  it("returns 500 without touching the DB when SSO_SECRET_ENCRYPTION_KEY is missing", async () => {
    delete process.env.SSO_SECRET_ENCRYPTION_KEY;
    mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1" });

    const res = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "golden-wealth" }, "test-migration-secret")
    );

    expect(res.status).toBe(500);
    expect(mockWorkspaceUpdate).not.toHaveBeenCalled();
  });
});
