import type { AppPrismaClient } from "@/lib/db";
import { afterEach, describe, expect, it, vi } from "vitest";
const readiness = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/preview-automation/managed-database", () => ({ assertManagedPilotDeploymentReady: readiness }));
import { bootstrapPreviewRun, issuePreviewSession, teardownPreviewRun } from "@/lib/preview-automation/service";
import type { PreviewGrant } from "@/lib/preview-automation/grants";
const grant = { runId: "run", deploymentId: "deployment", nonce: "nonce", exp: 2000000000, operation: "bootstrap" } as PreviewGrant;
function fixture() {
  const tx = {
    previewAutomationNonce: { create: vi.fn() },
    previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(({ data }) => data), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    organization: { create: vi.fn() }, workspace: { createMany: vi.fn() },
    user: { createMany: vi.fn() }, organizationMember: { createMany: vi.fn() }, workspaceMember: { createMany: vi.fn() },
    session: { create: vi.fn().mockImplementation(({ data }) => data), deleteMany: vi.fn() },
    previewAutomationSession: { create: vi.fn() },
  };
  return { tx, client: { $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as AppPrismaClient };
}
describe("preview run lifecycle", () => {
  afterEach(() => vi.unstubAllEnvs());
  function managed() {
    const env = { PREVIEW_DATABASE_MODE: "vercel-managed", PREVIEW_AUTOMATION_ENABLED: "1", VERCEL_ENV: "preview",
      VERCEL_GIT_PULL_REQUEST_ID: "276", VERCEL_GIT_COMMIT_SHA: "a".repeat(40), VERCEL_DEPLOYMENT_ID: "dpl_test",
      VERCEL_URL: "compass-test.vercel.app", VERCEL_GIT_REPO_OWNER: "rbcodelabs", VERCEL_GIT_REPO_SLUG: "compass",
      VERCEL_GIT_COMMIT_REF: "feat/geode-docs-preview-pilot", PGSCHEMA: "", DATABASE_URL: "",
      PREVIEW_MANAGED_RUN_ID: "11111111-1111-4111-8111-111111111111", PREVIEW_MANAGED_WORKSPACE_ID: "22222222-2222-4222-8222-222222222222" };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return { ...grant, runId: env.PREVIEW_MANAGED_RUN_ID, deploymentId: env.VERCEL_DEPLOYMENT_ID };
  }
  it("binds managed bootstrap to its preconfigured workspace", async () => {
    const approved = managed();
    const { tx, client } = fixture();
    await bootstrapPreviewRun(client, approved);
    expect(tx.previewAutomationRun.create.mock.calls[0][0].data.workspaceId).toBe(process.env.PREVIEW_MANAGED_WORKSPACE_ID);
  });
  it("requires owned and fully migrated schema before bootstrap writes", async () => {
    const approved = managed();
    readiness.mockRejectedValueOnce(new Error("Schema not ready"));
    const { client } = fixture();
    await expect(bootstrapPreviewRun(client, approved)).rejects.toThrow("Schema not ready");
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it("rejects a signed but different managed run before any transaction", async () => {
    managed();
    const { client } = fixture();
    await expect(bootstrapPreviewRun(client, grant)).rejects.toThrow();
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it("rejects a managed existing run with a mismatching workspace", async () => {
    const approved = managed();
    const { tx, client } = fixture();
    tx.previewAutomationRun.findUnique.mockResolvedValue({ id: approved.runId, deploymentId: approved.deploymentId, workspaceId: "wrong", expiresAt: new Date(Date.now() + 60000), revokedAt: null });
    await expect(bootstrapPreviewRun(client, approved)).rejects.toThrow();
  });
  it("managed teardown revokes only, retaining synthetic data for reviewed cleanup", async () => {
    const approved = managed();
    const { tx, client } = fixture();
    tx.previewAutomationRun.findUnique.mockResolvedValue({ id: approved.runId, deploymentId: approved.deploymentId, revokedAt: null });
    Object.assign(tx.previewAutomationRun, { update: vi.fn() });
    Object.assign(tx.session, { deleteMany: vi.fn() });
    Object.assign(tx.previewAutomationSession, { deleteMany: vi.fn() });
    const result = await teardownPreviewRun(client, { ...approved, operation: "teardown" });
    expect(result).toEqual({ runId: approved.runId, revoked: true, retained: true });
    expect(tx.session.deleteMany).toHaveBeenCalled();
    expect(tx.organization.create).not.toHaveBeenCalled();
  });
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
