/**
 * Unit tests for the feedback-source server actions.
 *
 * `resolveWorkspaceAdmin` is the only thing stubbed out of @/lib/permissions —
 * `PermissionError` and `isPermissionError` stay real, because the point of half
 * these tests is that a permission failure comes back as a *value* rather than a
 * thrown error Next would redact in production.
 *
 * `normalizeAllowedOrigins` also stays real. Mocking it would leave nothing to
 * check: these actions are the only thing standing between operator-typed text
 * and the allowlist the embed route trusts, so the wiring is the behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveWorkspaceAdmin: vi.fn(),
  feedbackSource: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  feedbackSourceToken: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  artifact: { findFirst: vi.fn() },
  workspace: { update: vi.fn() },
}));

const mockPrisma = {
  feedbackSource: mocks.feedbackSource,
  feedbackSourceToken: mocks.feedbackSourceToken,
  artifact: mocks.artifact,
  workspace: mocks.workspace,
};

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));
vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  resolveWorkspaceAdmin: mocks.resolveWorkspaceAdmin,
}));

import { PermissionError } from "@/lib/permissions";
import { EMBED_TOKEN_PREFIX } from "@/lib/embed-sources";
import {
  createFeedbackSource,
  mintFeedbackSourceToken,
  revokeFeedbackSourceToken,
  setArtifactFeedbackPublic,
  updateFeedbackSource,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/feedback-source-actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "admin-user" } });
  mocks.resolveWorkspaceAdmin.mockResolvedValue({
    prisma: mockPrisma,
    workspaceId: "ws-1",
    organizationId: "org-1",
  });
  mocks.artifact.findFirst.mockResolvedValue({ id: "artifact-1" });
  mocks.feedbackSource.create.mockResolvedValue({ id: "source-1" });
  mocks.feedbackSource.findFirst.mockResolvedValue({
    id: "source-1",
    name: "Checkout prototype",
    allowedOrigins: ["https://old.example.com"],
    enabled: true,
  });
  mocks.feedbackSource.update.mockResolvedValue({});
  mocks.feedbackSourceToken.create.mockResolvedValue({ id: "token-1" });
  mocks.feedbackSourceToken.findFirst.mockResolvedValue({ id: "token-1" });
  mocks.feedbackSourceToken.updateMany.mockResolvedValue({ count: 1 });
  mocks.workspace.update.mockResolvedValue({});
});

describe("setArtifactFeedbackPublic", () => {
  it("publishes the thread on the workspace the admin gate resolved", async () => {
    const result = await setArtifactFeedbackPublic("org", "ws", true);

    expect(result).toEqual({ ok: true, artifactFeedbackPublic: true });
    // `ws-1` comes from resolveWorkspaceAdmin, never from the argument list, so a
    // slug the caller does not administer cannot address another workspace's row.
    expect(mocks.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { artifactFeedbackPublic: true },
    });
  });

  it("turns publishing back off with the same call", async () => {
    // Worth its own case: a write-only-on switch would leave an operator unable to
    // undo a decision that published a comment thread.
    const result = await setArtifactFeedbackPublic("org", "ws", false);

    expect(result).toEqual({ ok: true, artifactFeedbackPublic: false });
    expect(mocks.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { artifactFeedbackPublic: false },
    });
  });

  it("refuses a caller who is not a workspace admin, and writes nothing", async () => {
    // Workspace admin rather than workspace member on purpose: turning this on
    // makes the thread readable by anyone holding an embed token, which is the same
    // class of decision as minting one.
    mocks.resolveWorkspaceAdmin.mockRejectedValue(new PermissionError("You do not have access to this workspace."));

    const result = await setArtifactFeedbackPublic("org", "ws", true);

    // Returned rather than thrown, so the message survives Next's production
    // redaction of server-action errors.
    expect(result).toEqual({ ok: false, error: "You do not have access to this workspace." });
    expect(mocks.workspace.update).not.toHaveBeenCalled();
  });
});

describe("createFeedbackSource", () => {
  it("stores canonical origins and mints a usable token in one step", async () => {
    const result = await createFeedbackSource("org", "ws", {
      name: "  Checkout prototype  ",
      artifactId: "artifact-1",
      allowedOrigins: ["HTTPS://App.Example.com/", ""],
    });

    expect(result).toMatchObject({ ok: true, id: "source-1", allowedOrigins: ["https://app.example.com"] });
    expect(mocks.feedbackSource.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws-1",
        artifactId: "artifact-1",
        name: "Checkout prototype",
        allowedOrigins: ["https://app.example.com"],
        enabled: true,
        createdById: "admin-user",
        // Written explicitly rather than left to the column default: DSQL's ADD
        // COLUMN cannot carry one, so the stored value would otherwise be NULL and
        // the mode would exist only as a read-time coalesce.
        authMode: "INTERNAL_SSO",
      },
      select: { id: true },
    });
    // A source with no token cannot be embedded, so creation is not "done" until
    // one exists.
    expect(mocks.feedbackSourceToken.create).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error("expected success");
    expect(result.token.startsWith(EMBED_TOKEN_PREFIX)).toBe(true);
  });

  it("files the source under the mode the operator chose", async () => {
    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-1",
      allowedOrigins: [],
      authMode: "PORTAL",
    });

    expect(result).toMatchObject({ ok: true, authMode: "PORTAL" });
    expect(mocks.feedbackSource.create.mock.calls[0][0].data).toMatchObject({ authMode: "PORTAL" });
  });

  it("refuses a mode it does not recognize rather than quietly defaulting", async () => {
    // Silently filing an unrecognized value as the default would flip a source the
    // operator believed was set to external reviewers — a widening of who may
    // comment, done without telling them.
    for (const authMode of ["ANYONE", "portal", "", "INTERNAL"]) {
      const result = await createFeedbackSource("org", "ws", {
        name: "Proto",
        artifactId: "artifact-1",
        allowedOrigins: [],
        authMode,
      });
      expect(result).toEqual({ ok: false, error: "Choose who can comment on this prototype." });
    }
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled();
  });

  it("returns the raw token exactly once and never stores it", async () => {
    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-1",
      allowedOrigins: [],
    });
    if (!result.ok) throw new Error("expected success");

    const stored = mocks.feedbackSourceToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).not.toContain(result.token);
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(stored.tokenHash).toHaveLength(64);
  });

  it("refuses an origin the exact-match check could never honor, and creates nothing", async () => {
    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-1",
      allowedOrigins: ["https://*.example.com"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/wildcard/);
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled();
    expect(mocks.feedbackSourceToken.create).not.toHaveBeenCalled();
  });

  it("refuses an artifact from another workspace", async () => {
    // The scoped findFirst returns nothing for a valid uuid that belongs
    // elsewhere — a cross-workspace binding would open a write path into a
    // workspace this admin has no rights over.
    mocks.artifact.findFirst.mockResolvedValue(null);

    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-from-elsewhere",
      allowedOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: "That prototype no longer exists in this workspace." });
    expect(mocks.artifact.findFirst).toHaveBeenCalledWith({
      where: { id: "artifact-from-elsewhere", workspaceId: "ws-1", status: "ACTIVE" },
      select: { id: true },
    });
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled();
  });

  it("requires a name", async () => {
    const result = await createFeedbackSource("org", "ws", {
      name: "   ",
      artifactId: "artifact-1",
      allowedOrigins: [],
    });
    expect(result).toEqual({ ok: false, error: "Give this feedback source a name." });
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled();
  });

  it("returns a permission failure as a value rather than throwing", async () => {
    mocks.resolveWorkspaceAdmin.mockRejectedValue(new PermissionError("Forbidden: workspace admin required"));

    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-1",
      allowedOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: "Forbidden: workspace admin required" });
    expect(mocks.feedbackSource.create).not.toHaveBeenCalled();
  });

  it("never leaks an unexpected error's message to the caller", async () => {
    mocks.feedbackSource.create.mockRejectedValue(new Error("connection string: postgres://secret"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createFeedbackSource("org", "ws", {
      name: "Proto",
      artifactId: "artifact-1",
      allowedOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: "Something went wrong. Please try again." });
    spy.mockRestore();
  });
});

describe("updateFeedbackSource", () => {
  it("leaves unspecified fields at their stored values", async () => {
    const result = await updateFeedbackSource("org", "ws", "source-1", { enabled: false });

    expect(result).toEqual({
      ok: true,
      name: "Checkout prototype",
      allowedOrigins: ["https://old.example.com"],
      enabled: false,
      // The stored row in this fixture has no auth_mode at all — the state every
      // source created before this migration is in. The action echoes back the
      // resolved mode rather than the raw null, so the panel never has to decide
      // what a missing value means.
      authMode: "INTERNAL_SSO",
    });
    expect(mocks.feedbackSource.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: expect.objectContaining({
        name: "Checkout prototype",
        allowedOrigins: ["https://old.example.com"],
        enabled: false,
      }),
    });
  });

  it("switches the mode when the operator changes it, and only then", async () => {
    // The stored row carries an explicit mode here, so this is about the write
    // rather than about the legacy-NULL coalesce the test above covers.
    mocks.feedbackSource.findFirst.mockResolvedValue({
      id: "source-1",
      name: "Checkout prototype",
      allowedOrigins: ["https://old.example.com"],
      enabled: true,
      authMode: "PORTAL",
    });

    await expect(
      updateFeedbackSource("org", "ws", "source-1", { authMode: "INTERNAL_SSO" })
    ).resolves.toMatchObject({ ok: true, authMode: "INTERNAL_SSO" });
    expect(mocks.feedbackSource.update.mock.calls[0][0].data).toMatchObject({ authMode: "INTERNAL_SSO" });

    // Omitted on a later edit: the stored PORTAL survives rather than being reset
    // to the create-time default by an unrelated origin change.
    await expect(
      updateFeedbackSource("org", "ws", "source-1", { allowedOrigins: [] })
    ).resolves.toMatchObject({ ok: true, authMode: "PORTAL" });
    expect(mocks.feedbackSource.update.mock.calls[1][0].data).toMatchObject({ authMode: "PORTAL" });
  });

  it("refuses an unrecognized mode without touching the stored row", async () => {
    const result = await updateFeedbackSource("org", "ws", "source-1", { authMode: "ANYONE" });
    expect(result).toEqual({ ok: false, error: "Choose who can comment on this prototype." });
    expect(mocks.feedbackSource.update).not.toHaveBeenCalled();
  });

  it("replaces the allowlist with the canonical form, not the text typed", async () => {
    const result = await updateFeedbackSource("org", "ws", "source-1", {
      allowedOrigins: ["https://new.example.com:443/", "https://new.example.com"],
    });

    // Canonicalized, then de-duplicated: two lines, one origin.
    expect(result).toMatchObject({ ok: true, allowedOrigins: ["https://new.example.com"] });
  });

  it("accepts an empty allowlist, which fails closed", async () => {
    const result = await updateFeedbackSource("org", "ws", "source-1", { allowedOrigins: [] });
    expect(result).toMatchObject({ ok: true, allowedOrigins: [] });
  });

  it("scopes the lookup to this workspace so a foreign source id is not editable", async () => {
    mocks.feedbackSource.findFirst.mockResolvedValue(null);

    const result = await updateFeedbackSource("org", "ws", "source-from-elsewhere", { enabled: false });

    expect(result).toEqual({ ok: false, error: "That feedback source no longer exists." });
    expect(mocks.feedbackSource.findFirst).toHaveBeenCalledWith({
      where: { id: "source-from-elsewhere", workspaceId: "ws-1" },
      select: expect.any(Object),
    });
    expect(mocks.feedbackSource.update).not.toHaveBeenCalled();
  });

  it("rejects a bad origin without touching the stored allowlist", async () => {
    const result = await updateFeedbackSource("org", "ws", "source-1", {
      allowedOrigins: ["https://good.example.com", "not-a-url"],
    });

    expect(result.ok).toBe(false);
    expect(mocks.feedbackSource.update).not.toHaveBeenCalled();
  });
});

describe("mintFeedbackSourceToken", () => {
  it("mints against a source in this workspace", async () => {
    const result = await mintFeedbackSourceToken("org", "ws", "source-1", "  Rotated  ");

    expect(result).toMatchObject({ ok: true, tokenId: "token-1" });
    expect(mocks.feedbackSourceToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feedbackSourceId: "source-1",
        label: "Rotated",
        createdById: "admin-user",
      }),
      select: { id: true },
    });
  });

  it("refuses a source id from another workspace", async () => {
    mocks.feedbackSource.findFirst.mockResolvedValue(null);

    const result = await mintFeedbackSourceToken("org", "ws", "source-from-elsewhere");

    expect(result).toEqual({ ok: false, error: "That feedback source no longer exists." });
    expect(mocks.feedbackSourceToken.create).not.toHaveBeenCalled();
  });

  it("mints a distinct token each time", async () => {
    const first = await mintFeedbackSourceToken("org", "ws", "source-1");
    const second = await mintFeedbackSourceToken("org", "ws", "source-1");
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(first.token).not.toBe(second.token);
  });
});

describe("revokeFeedbackSourceToken", () => {
  it("revokes a token reached through a source in this workspace", async () => {
    const result = await revokeFeedbackSourceToken("org", "ws", "token-1");

    expect(result).toEqual({ ok: true });
    expect(mocks.feedbackSourceToken.findFirst).toHaveBeenCalledWith({
      where: { id: "token-1", feedbackSource: { workspaceId: "ws-1" } },
      select: { id: true },
    });
    expect(mocks.feedbackSourceToken.updateMany).toHaveBeenCalledWith({
      where: { id: "token-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("reports success for an already-revoked token", async () => {
    // The conditional update matches zero rows. The caller asked for a state
    // that now holds, so an error would only be confusing.
    mocks.feedbackSourceToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(revokeFeedbackSourceToken("org", "ws", "token-1")).resolves.toEqual({ ok: true });
  });

  it("refuses a token id belonging to another workspace", async () => {
    mocks.feedbackSourceToken.findFirst.mockResolvedValue(null);

    const result = await revokeFeedbackSourceToken("org", "ws", "token-from-elsewhere");

    expect(result).toEqual({ ok: false, error: "That token no longer exists." });
    expect(mocks.feedbackSourceToken.updateMany).not.toHaveBeenCalled();
  });
});
