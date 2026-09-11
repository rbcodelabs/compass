import type { AppPrismaClient } from "@/lib/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
const cascade = vi.hoisted(() => vi.fn());
vi.mock("@/lib/delete-workspace-cascade", () => ({ deleteWorkspaceCascade: cascade }));
import { cleanupPreviewRun } from "@/lib/preview-automation/service";

const run = { id: "run", deploymentId: "dpl_test", orgId: "owned-org", workspaceId: "owned-workspace", isolatedWorkspaceId: "owned-isolated", ownerUserId: "owned-owner", viewerUserId: "owned-member", revokedAt: null, cleanedAt: null };
function fixture() {
  const calls: { model: string; operation: string; args: unknown }[] = [];
  const models = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const db = new Proxy({}, {
    get(_target, property: string) {
      if (!models.has(property)) {
        const methods: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const method of ["findUnique", "deleteMany", "updateMany", "update", "count"]) {
          methods[method] = vi.fn(async (args: unknown) => {
            calls.push({ model: property, operation: method, args });
            if (property === "previewAutomationRun" && method === "findUnique") return run;
            if (property === "workspace" && method === "findUnique") return { organizationId: run.orgId };
            return method === "count" ? 0 : { count: 1 };
          });
        }
        models.set(property, methods);
      }
      return models.get(property);
    },
  }) as AppPrismaClient;
  return { db, calls };
}
beforeEach(() => cascade.mockReset().mockResolvedValue(undefined));

describe("independent QA: exact cleanup ownership and recoverable revocation", () => {
  it("denies a run from another deployment before deleting anything", async () => {
    const { db, calls } = fixture();
    await expect(cleanupPreviewRun(db, run.id, "dpl_other")).rejects.toThrow();
    expect(calls.every(call => call.operation === "findUnique")).toBe(true);
    expect(cascade).not.toHaveBeenCalled();
  });
  it("revokes first and deletes sessions before removing their automation mappings", async () => {
    const { db, calls } = fixture();
    await cleanupPreviewRun(db, run.id, run.deploymentId);
    const revoke = calls.findIndex(call => call.model === "previewAutomationRun" && call.operation === "update");
    const sessions = calls.findIndex(call => call.model === "session" && call.operation === "deleteMany");
    const mappings = calls.findIndex(call => call.model === "previewAutomationSession" && call.operation === "deleteMany");
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(sessions).toBeGreaterThan(revoke);
    expect(mappings).toBeGreaterThan(sessions);
  });
  it("only invokes workspace deletion for the exact two registered IDs", async () => {
    const { db, calls } = fixture();
    await cleanupPreviewRun(db, run.id, run.deploymentId);
    expect(cascade.mock.calls.map(call => call[1])).toEqual([run.workspaceId, run.isolatedWorkspaceId]);
    expect(calls.find(call => call.model === "user" && call.operation === "deleteMany")?.args).toEqual({ where: { id: { in: [run.ownerUserId, run.viewerUserId] } } });
    expect(calls.find(call => call.model === "organization" && call.operation === "deleteMany")?.args).toEqual({ where: { id: run.orgId } });
  });
  it("retains run invalidation after workspace deletion fails so a later invocation can recover", async () => {
    const { db, calls } = fixture();
    cascade.mockRejectedValueOnce(new Error("transient deletion failure"));
    await expect(cleanupPreviewRun(db, run.id, run.deploymentId)).rejects.toThrow("transient deletion failure");
    expect(calls.some(call => call.model === "previewAutomationRun" && call.operation === "update" && JSON.stringify(call.args).includes("revokedAt"))).toBe(true);
    expect(calls.some(call => call.model === "previewAutomationRun" && call.operation === "update" && JSON.stringify(call.args).includes("cleanedAt"))).toBe(false);
    await expect(cleanupPreviewRun(db, run.id, run.deploymentId)).resolves.toMatchObject({ cleaned: true });
  });
  it("does not remove mappings if session deletion fails", async () => {
    const { db } = fixture();
    vi.mocked(db.session.deleteMany).mockRejectedValueOnce(new Error("session deletion failed"));
    await expect(cleanupPreviewRun(db, run.id, run.deploymentId)).rejects.toThrow();
    expect(db.previewAutomationSession.deleteMany).not.toHaveBeenCalled();
    expect(cascade).not.toHaveBeenCalled();
  });
  it("refuses to cascade when a registered workspace no longer belongs to the registered organization", async () => {
    const { db } = fixture();
    vi.mocked(db.workspace.findUnique).mockResolvedValueOnce({ organizationId: "unrelated-org" } as never);
    await expect(cleanupPreviewRun(db, run.id, run.deploymentId)).rejects.toThrow(/ownership/);
    expect(cascade).not.toHaveBeenCalled();
  });
});
