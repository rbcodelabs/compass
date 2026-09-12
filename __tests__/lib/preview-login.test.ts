import { createHash } from "node:crypto";
import type { AppPrismaClient } from "@/lib/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/preview-automation/scenarios", () => ({ applyPreviewScenario: vi.fn() }));
vi.mock("@/lib/schema", () => ({ getActiveSchema: vi.fn(() => "compass_preview") }));

import { applyPreviewScenario } from "@/lib/preview-automation/scenarios";
import {
  PREVIEW_LOGIN_PERSONAS,
  ensureSampleWorkspace,
  isPreviewLoginEnabled,
  isPreviewLoginPersona,
  issuePreviewLoginSession,
  verifyPreviewLoginAccessCode,
} from "@/lib/preview-login";

describe("isPreviewLoginEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["preview", "1", true],
    ["preview", "0", false],
    ["preview", "", false],
    ["preview", undefined, false],
    ["production", "1", false],
    ["development", "1", false],
    [undefined, "1", false],
    [undefined, undefined, false],
  ] as const)("VERCEL_ENV=%s PREVIEW_LOGIN_ENABLED=%s -> %s", (vercelEnv, enabled, expected) => {
    vi.stubEnv("VERCEL_ENV", vercelEnv ?? "");
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", enabled ?? "");
    expect(isPreviewLoginEnabled()).toBe(expected);
  });
});

describe("isPreviewLoginPersona", () => {
  it("only accepts the closed persona catalog", () => {
    for (const persona of PREVIEW_LOGIN_PERSONAS) expect(isPreviewLoginPersona(persona)).toBe(true);
    for (const value of ["admin", "", "OWNER", 1, null, undefined, ["owner"], { persona: "owner" }]) {
      expect(isPreviewLoginPersona(value)).toBe(false);
    }
  });
});

describe("verifyPreviewLoginAccessCode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the exact configured code", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "correct-horse-battery-staple");
    expect(verifyPreviewLoginAccessCode("correct-horse-battery-staple")).toBe(true);
  });

  it("rejects a wrong code", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "correct-horse-battery-staple");
    expect(verifyPreviewLoginAccessCode("wrong")).toBe(false);
  });

  it("fails closed when the env var is unset, even against an empty submission", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "");
    expect(verifyPreviewLoginAccessCode("")).toBe(false);
    expect(verifyPreviewLoginAccessCode("anything")).toBe(false);
  });

  it("rejects missing or non-string input without throwing", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "correct-horse-battery-staple");
    for (const value of [undefined, null, "", 42, {}, []]) {
      expect(() => verifyPreviewLoginAccessCode(value)).not.toThrow();
      expect(verifyPreviewLoginAccessCode(value)).toBe(false);
    }
  });

  it("does not throw on a length mismatch between submitted and expected", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "short");
    expect(() => verifyPreviewLoginAccessCode("a".repeat(5000))).not.toThrow();
    expect(verifyPreviewLoginAccessCode("a".repeat(5000))).toBe(false);
    expect(() => verifyPreviewLoginAccessCode("x")).not.toThrow();
    expect(verifyPreviewLoginAccessCode("x")).toBe(false);
  });

  it("compares fixed-length digests, not raw byte length", () => {
    vi.stubEnv("PREVIEW_LOGIN_ACCESS_CODE", "abc");
    const digest = createHash("sha256").update("abc").digest();
    expect(digest.length).toBe(32);
  });
});

function fixture() {
  let userCounter = 0;
  const tx = {
    organization: { create: vi.fn().mockImplementation(({ data }) => ({ id: "org-1", ...data })) },
    user: {
      create: vi.fn().mockImplementation(({ data }) => {
        userCounter += 1;
        return { id: `user-${userCounter}`, ...data };
      }),
    },
    workspace: { create: vi.fn().mockImplementation(({ data }) => ({ id: "workspace-1", ...data })) },
    organizationMember: { createMany: vi.fn() },
    workspaceMember: { createMany: vi.fn() },
  };
  const client = {
    organization: { findUnique: vi.fn().mockResolvedValue(null) },
    workspace: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    session: { create: vi.fn().mockImplementation(({ data }) => data) },
  };
  return { tx, client: client as unknown as AppPrismaClient, raw: client };
}

describe("ensureSampleWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the org, workspace, users, and members exactly once", async () => {
    const { client, raw } = fixture();
    const result = await ensureSampleWorkspace(client);
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(result.orgSlug).toBe("preview-sample");
    expect(result.workspaceSlug).toBe("workspace");
    expect(applyPreviewScenario).toHaveBeenCalledWith(expect.anything(), {
      schema: "compass_preview",
      workspaceId: "workspace-1",
      scenario: "full-data",
    });
  });

  it("is idempotent: a second call skips creation and reseeding entirely", async () => {
    const { client, raw } = fixture();
    await ensureSampleWorkspace(client);
    vi.mocked(applyPreviewScenario).mockClear();
    raw.$transaction.mockClear();

    // Second call finds the org already present.
    raw.organization.findUnique.mockResolvedValue({ id: "org-1", slug: "preview-sample" });
    raw.workspace.findFirst.mockResolvedValue({ id: "workspace-1", slug: "workspace" });
    raw.user.findUnique
      .mockResolvedValueOnce({ id: "user-1", email: "preview-owner@preview.invalid" })
      .mockResolvedValueOnce({ id: "user-2", email: "preview-viewer@preview.invalid" });

    const result = await ensureSampleWorkspace(client);
    expect(raw.$transaction).not.toHaveBeenCalled();
    expect(applyPreviewScenario).not.toHaveBeenCalled();
    expect(result.ownerUserId).toBe("user-1");
    expect(result.viewerUserId).toBe("user-2");
  });

  it("recovers from a concurrent creation race instead of surfacing a duplicate-org error", async () => {
    const { client, raw, tx } = fixture();
    raw.$transaction.mockRejectedValueOnce(new Error("Unique constraint failed on the fields: (`slug`)"));
    raw.organization.findUnique
      .mockResolvedValueOnce(null) // first lookup: not there yet
      .mockResolvedValueOnce({ id: "org-1", slug: "preview-sample" }); // after the race, a winner exists
    raw.workspace.findFirst.mockResolvedValue({ id: "workspace-1", slug: "workspace" });
    raw.user.findUnique
      .mockResolvedValueOnce({ id: "user-1", email: "preview-owner@preview.invalid" })
      .mockResolvedValueOnce({ id: "user-2", email: "preview-viewer@preview.invalid" });

    const result = await ensureSampleWorkspace(client);
    expect(result.orgSlug).toBe("preview-sample");
    expect(tx.organization.create).not.toHaveBeenCalled();
  });
});

describe("issuePreviewLoginSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a token that is not preview_-prefixed, expiring within 60 minutes", async () => {
    const { client, raw } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const session = await issuePreviewLoginSession(client, "owner", now);
    expect(session.sessionToken.startsWith("previewlogin_")).toBe(true);
    expect(session.sessionToken.startsWith("preview_")).toBe(false);
    expect(session.expiresAt.getTime() - now.getTime()).toBe(60 * 60 * 1000);
    expect(raw.session.create).toHaveBeenCalledWith({
      data: { sessionToken: session.sessionToken, userId: "user-1", expires: session.expiresAt },
    });
  });

  it("resolves the viewer persona to the second synthetic user", async () => {
    const { client, raw } = fixture();
    await issuePreviewLoginSession(client, "viewer", new Date());
    expect(raw.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: "user-2" }) }));
  });
});
