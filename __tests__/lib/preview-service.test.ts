import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { bootstrapPreviewRun, issuePreviewSession, teardownPreviewRun } from "@/lib/preview-automation/service";
import type { PreviewGrant } from "@/lib/preview-automation/grants";
const grant = { runId: "run", deploymentId: "deployment", nonce: "nonce", exp: 2000000000, operation: "bootstrap" } as PreviewGrant;
function fixture() {
  const tx = {
    previewAutomationNonce: { create: vi.fn() },
    previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(({ data }) => data), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    organization: { create: vi.fn() }, workspace: { createMany: vi.fn() },
    user: { createMany: vi.fn() }, organizationMember: { createMany: vi.fn() }, workspaceMember: { createMany: vi.fn() },
    session: { create: vi.fn().mockImplementation(({ data }) => data) },
    previewAutomationSession: { create: vi.fn() },
  };
  return { tx, client: { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient };
}
describe("preview run lifecycle", () => {
  it("creates only synthetic registered identities with a hard one-hour deadline", async () => {
    const { tx, client } = fixture();
    const now = new Date();
    const result = await bootstrapPreviewRun(client, grant, now);
    expect(tx.previewAutomationNonce.create).toHaveBeenCalled();
    expect(tx.previewAutomationRun.create.mock.calls[0][0].data.expiresAt).toEqual(new Date(+now + 3600000));
    expect(tx.user.createMany.mock.calls[0][0].data.every((user: { email: string }) => user.email.endsWith("@preview.invalid"))).toBe(true);
    expect(result.orgSlug).toBe("preview-run");
  });
  it("rolls no mutation forward after a duplicate nonce", async () => {
    const { tx, client } = fixture();
    tx.previewAutomationNonce.create.mockRejectedValue(new Error("duplicate"));
    await expect(bootstrapPreviewRun(client, grant)).rejects.toThrow("duplicate");
    expect(tx.organization.create).not.toHaveBeenCalled();
  });
  it("refuses an expired run before issuing a session", async () => {
    const { tx, client } = fixture();
    tx.previewAutomationRun.findUnique.mockResolvedValue({ deploymentId: "deployment", expiresAt: new Date(0), revokedAt: null });
    await expect(issuePreviewSession(client, { ...grant, operation: "session", persona: "owner" })).rejects.toThrow();
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it("serializes issuance against revocation before creating session rows", async () => {
    const { tx, client } = fixture();
    tx.previewAutomationRun.findUnique.mockResolvedValue({ id: "run", deploymentId: "deployment", expiresAt: new Date(Date.now() + 60000), revokedAt: null, ownerUserId: "owner" });
    tx.previewAutomationRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(issuePreviewSession(client, { ...grant, operation: "session", persona: "owner" })).rejects.toThrow(/unavailable/i);
    expect(tx.previewAutomationRun.updateMany).toHaveBeenCalledWith({ where: { id: "run", revokedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { sessionNonce: "nonce" } });
    expect(tx.session.create).not.toHaveBeenCalled();
  });
  it("writes a revoked tombstone when teardown precedes bootstrap", async () => {
    const { tx, client } = fixture();
    Object.assign(client, { previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(null) } });
    await teardownPreviewRun(client, { ...grant, operation: "teardown" });
    expect(tx.previewAutomationRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ id: "run", revokedAt: expect.any(Date), cleanedAt: expect.any(Date) }) });
    expect(tx.organization.create).not.toHaveBeenCalled();
  });
});
