/**
 * Unit tests for app/api/preview-login/start/route.ts.
 *
 * Mirrors the fail-closed-before-database-access pattern used in
 * __tests__/preview-automation-qa/handler-rejection.test.ts: a Prisma spy
 * that throws proves the disabled/invalid paths never reach the database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const initialize = vi.hoisted(() => vi.fn(() => { throw new Error("database initialization must not occur"); }));
vi.mock("@/lib/db", () => ({ default: initialize }));

import { POST } from "@/app/api/preview-login/start/route";

function request(body: string, contentType = "application/x-www-form-urlencoded") {
  return new Request("https://pr-1-team.vercel.app/api/preview-login/start", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

function enablePreviewLogin(code = "test-access-code") {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("PREVIEW_LOGIN_ENABLED", "1");
  vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", code);
}

describe("POST /api/preview-login/start", () => {
  it("does not expose shared convenience login to managed pilots", async () => {
    enablePreviewLogin();
    vi.stubEnv("PREVIEW_DATABASE_MODE", "vercel-managed");
    const response = await POST(request("code=test-access-code&persona=owner"));
    expect(response.status).toBe(404);
    expect(initialize).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    initialize.mockClear();
  });

  it.each(["production", "development", ""])("returns 404 outside preview before any database access (%s)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "1");
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "test-access-code");
    const response = await POST(request("code=test-access-code&persona=owner"));
    expect(response.status).toBe(404);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("returns 404 when PREVIEW_LOGIN_ENABLED is not the exact opt-in value", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "true");
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "test-access-code");
    const response = await POST(request("code=test-access-code&persona=owner"));
    expect(response.status).toBe(404);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("returns 404 even with a correct code when PREVIEW_LOGIN_ACCESS_CODE is unset (no codeless bypass)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "1");
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "");
    const response = await POST(request("code=&persona=owner"));
    expect(response.status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects an unknown persona value with 400 before any database access", async () => {
    enablePreviewLogin();
    const response = await POST(request("code=test-access-code&persona=superadmin"));
    expect(response.status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a missing persona with 400", async () => {
    enablePreviewLogin();
    const response = await POST(request("code=test-access-code"));
    expect(response.status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a missing access code with 401", async () => {
    enablePreviewLogin();
    const response = await POST(request("persona=owner"));
    expect(response.status).toBe(401);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a wrong access code with 401, identical to a missing one", async () => {
    enablePreviewLogin();
    const wrong = await POST(request("code=wrong&persona=owner"));
    const missing = await POST(request("persona=owner"));
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await wrong.json()).toEqual(await missing.json());
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects an oversized body with 400 before any database access", async () => {
    enablePreviewLogin();
    const response = await POST(request(`code=${"a".repeat(10_000)}&persona=owner`));
    expect(response.status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("marks every response uncacheable and free of stack traces or secrets", async () => {
    enablePreviewLogin();
    const response = await POST(request("code=wrong&persona=owner"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body).not.toContain("wrong");
    expect(body).not.toContain("test-access-code");
  });
});

describe("POST /api/preview-login/start — success path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/preview-login");
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });

  it("issues a session cookie expiring within 60 minutes and redirects to the sample workspace", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ default: vi.fn(() => ({})) }));
    vi.doMock("@/lib/preview-login", async () => {
      const actual = await vi.importActual<typeof import("@/lib/preview-login")>("@/lib/preview-login");
      return {
        ...actual,
        issuePreviewLoginSession: vi.fn().mockResolvedValue({
          sessionToken: "previewlogin_abc123",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          orgSlug: "preview-sample",
          workspaceSlug: "workspace",
        }),
      };
    });
    const { POST: freshPOST } = await import("@/app/api/preview-login/start/route");
    enablePreviewLogin();
    const response = await freshPOST(request("code=test-access-code&persona=owner"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://pr-1-team.vercel.app/preview-sample/workspace");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("previewlogin_abc123");
    expect(setCookie.toLowerCase()).toContain("httponly");

    const cookieMatch = setCookie.match(/expires=([^;]+)/i);
    expect(cookieMatch).not.toBeNull();
    const cookieExpires = new Date(cookieMatch![1]).getTime();
    expect(cookieExpires).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5000);
    expect(cookieExpires).toBeGreaterThan(Date.now());
  });
});
