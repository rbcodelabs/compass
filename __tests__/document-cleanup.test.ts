import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "@/lib/db";
import { assertDocumentPilotCleanupReviewed } from "@/lib/document-cleanup";

describe("document pilot workspace deletion guard", () => {
  afterEach(() => vi.unstubAllEnvs());
  function db(inventory: unknown = null, receipt: unknown = null, document: unknown = null) {
    const models = {
      docStorageObject: { findFirst: vi.fn().mockResolvedValue(inventory) },
      docOperation: { findFirst: vi.fn().mockResolvedValue(receipt) },
      doc: { findFirst: vi.fn().mockResolvedValue(document) },
    };
    // Deliberately only the read delegates used by this guard exist in the fixture.
    return { models, prisma: models as unknown as AppPrismaClient };
  }
  it.each(["inventory", "receipt", "document"])("preserves %s until explicit cleanup review", async kind => {
    const { prisma } = db(kind === "inventory" ? { id: "object" } : null, kind === "receipt" ? { id: "operation" } : null, kind === "document" ? { id: "doc" } : null);
    await expect(assertDocumentPilotCleanupReviewed(prisma, "workspace-a")).rejects.toThrow("explicit cleanup review");
  });
  it("permits legacy workspaces with no pilot data and scopes every query", async () => {
    const { prisma, models } = db();
    await expect(assertDocumentPilotCleanupReviewed(prisma, "workspace-a")).resolves.toBeUndefined();
    expect(models.docStorageObject.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "workspace-a" }, select: { id: true } });
    expect(models.docOperation.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "workspace-a" }, select: { id: true } });
    expect(models.doc.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "workspace-a", storageProvider: "GEODE" }, select: { id: true } });
  });
  it("fails closed when inventory cannot be read", async () => {
    const { prisma, models } = db();
    models.docStorageObject.findFirst.mockRejectedValue(new Error("unavailable"));
    await expect(assertDocumentPilotCleanupReviewed(prisma, "workspace-a")).rejects.toThrow("unavailable");
  });
  it("blocks an enabled pilot even before its first upload can race the guard", async () => {
    vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a");
    const { prisma } = db();
    await expect(assertDocumentPilotCleanupReviewed(prisma, "workspace-a")).rejects.toThrow("explicit cleanup review");
  });
});
