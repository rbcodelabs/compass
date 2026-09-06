import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { bootstrapPreviewRun, issuePreviewSession } from "@/lib/preview-automation/service";
import type { PreviewGrant } from "@/lib/preview-automation/grants";

const now = new Date("2026-09-06T12:00:00Z");
const grant: PreviewGrant = {
  v: 1, iss: "compass-preview-controller", aud: "compass-preview-automation", deploymentId: "dpl_revision1",
  origin: "https://compass-revision1-team.vercel.app", runId: "39f0a355-278a-4ef4-8eab-72591ec6cce1",
  nonce: "39f0a355-278a-4ef4-8eab-72591ec6cce2", operation: "session", persona: "owner",
  iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 300,
};
const active = {
  id: grant.runId, deploymentId: grant.deploymentId, createdAt: now, expiresAt: new Date(now.getTime() + 3_600_000),
  revokedAt: null, cleanedAt: null, ownerUserId: "registered-owner", viewerUserId: "registered-member",
  orgId: "registered-org", workspaceId: "registered-workspace", isolatedWorkspaceId: "registered-isolated",
};
function database(run: unknown = active) {
  const tx = {
    previewAutomationNonce: { create: vi.fn().mockResolvedValue({}) },
    previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(run), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    previewAutomationSession: { create: vi.fn().mockResolvedValue({}) },
    session: { create: vi.fn().mockResolvedValue({}) },
    user: { createMany: vi.fn() },
  };
  const prisma = { $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)) };
  return { tx, prisma: prisma as unknown as PrismaClient };
}

describe("independent QA: session issuance refuses invalid registry state", () => {
  it.each([
    null,
    { ...active, deploymentId: "dpl_other" },
    { ...active, revokedAt: now },
    { ...active, expiresAt: now },
    { ...active, expiresAt: new Date(now.getTime() - 1) },
  ])("does not create a session for unavailable run %j", async run => {
    const { tx, prisma } = database(run);
    await expect(issuePreviewSession(prisma, grant, now)).rejects.toThrow();
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it("uses the registered persona identity and remaining lifetime, never a fresh hour", async () => {
    const { tx, prisma } = database();
    const late = new Date(now.getTime() + 59 * 60_000);
    const result = await issuePreviewSession(prisma, { ...grant, persona: "viewer" }, late);
    expect(result.expiresAt).toEqual(active.expiresAt);
    expect(tx.session.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: active.viewerUserId, expires: active.expiresAt }),
    }));
    expect(result.sessionToken).toMatch(/^preview_[A-Za-z0-9_-]{43}$/);
  });
  it("does not issue a session after atomic nonce insertion rejects a replay", async () => {
    const { tx, prisma } = database();
    tx.previewAutomationNonce.create.mockRejectedValue(Object.assign(new Error("unique nonce"), { code: "P2002" }));
    await expect(issuePreviewSession(prisma, grant, now)).rejects.toThrow();
    expect(tx.previewAutomationRun.findUnique).not.toHaveBeenCalled();
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it("does not issue a session when revocation wins after the initial active-run read", async () => {
    const { tx, prisma } = database();
    tx.previewAutomationRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(issuePreviewSession(prisma, grant, now)).rejects.toThrow();
    expect(tx.session.create).not.toHaveBeenCalled();
    expect(tx.previewAutomationSession.create).not.toHaveBeenCalled();
  });
  it("rejects an unknown persona without creating a session", async () => {
    const { tx, prisma } = database();
    await expect(issuePreviewSession(prisma, { ...grant, persona: "admin" as "owner" }, now)).rejects.toThrow();
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it("bootstrap retry does not recreate fixtures or renew the run deadline", async () => {
    const { tx, prisma } = database();
    const result = await bootstrapPreviewRun(prisma, { ...grant, operation: "bootstrap", persona: undefined }, new Date(now.getTime() + 20 * 60_000));
    expect(result.expiresAt).toBe(active.expiresAt.toISOString());
    expect(tx.previewAutomationRun.create).not.toHaveBeenCalled();
    expect(tx.user.createMany).not.toHaveBeenCalled();
  });
  it("bootstrap retry cannot adopt a run belonging to another deployment", async () => {
    const { tx, prisma } = database({ ...active, deploymentId: "dpl_other" });
    await expect(bootstrapPreviewRun(prisma, { ...grant, operation: "bootstrap", persona: undefined }, now)).rejects.toThrow();
    expect(tx.previewAutomationRun.create).not.toHaveBeenCalled();
  });
});
