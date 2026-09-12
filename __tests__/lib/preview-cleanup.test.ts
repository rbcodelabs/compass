import type { AppPrismaClient } from "@/lib/db";
import { describe, expect, it, vi } from "vitest";
import { cleanupPreviewRun } from "@/lib/preview-automation/service";
vi.mock("@/lib/delete-workspace-cascade", () => ({ deleteWorkspaceCascade: vi.fn() }));
describe("preview cleanup", () => {
  it("rejects a deployment mismatch without deleting anything", async () => {
    const prisma = { previewAutomationRun: { findUnique: vi.fn().mockResolvedValue({ deploymentId: "other" }), update: vi.fn() } };
    await expect(cleanupPreviewRun(prisma as unknown as AppPrismaClient, "run", "deployment")).rejects.toThrow();
    expect(prisma.previewAutomationRun.update).not.toHaveBeenCalled();
  });
  it("treats a missing run as already cleaned", async () => {
    const prisma = { previewAutomationRun: { findUnique: vi.fn().mockResolvedValue(null) } };
    expect(await cleanupPreviewRun(prisma as unknown as AppPrismaClient, "run", "deployment")).toEqual({ runId: "run", cleaned: true });
  });
});
