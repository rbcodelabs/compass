import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { createWidget } from "@/lib/portal-home/schema"
import { loadHomeLayout, loadPublishedHome, publishDraft, saveDraft } from "@/lib/portal-home/service"

describe("saveDraft", () => {
  const widget = createWidget("rich_text", 3)

  it("falls back to an update when a concurrent first save wins the unique workspace index", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    const prisma = {
      portalHomeLayout: { upsert: vi.fn().mockRejectedValue(conflict), update: vi.fn().mockResolvedValue({}) },
    } as unknown as AppPrismaClient
    const saved = await saveDraft(prisma, "ws", [widget])
    expect(saved[0].order).toBe(0)
    expect(prisma.portalHomeLayout.update).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws" } }))
  })

  it("does not swallow other database errors", async () => {
    const prisma = {
      portalHomeLayout: { upsert: vi.fn().mockRejectedValue(new Error("connection lost")), update: vi.fn() },
    } as unknown as AppPrismaClient
    await expect(saveDraft(prisma, "ws", [widget])).rejects.toThrow("connection lost")
    expect(prisma.portalHomeLayout.update).not.toHaveBeenCalled()
  })
})

describe("template persistence", () => {
  const widget = createWidget("rich_text", 0)

  it("saveDraft validates the template and writes it with the draft", async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { portalHomeLayout: { upsert, update: vi.fn() } } as unknown as AppPrismaClient
    await saveDraft(prisma, "ws", [widget], "docs_hub")
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ draftTemplate: "docs_hub" }),
      update: expect.objectContaining({ draftTemplate: "docs_hub" }),
    }))
  })

  it("saveDraft leaves the template untouched when none is given and throws on an unknown id", async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = { portalHomeLayout: { upsert, update: vi.fn() } } as unknown as AppPrismaClient
    await saveDraft(prisma, "ws", [widget])
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty("draftTemplate")
    await expect(saveDraft(prisma, "ws", [widget], "magazine")).rejects.toThrow()
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it("publishDraft copies the draft template to published, coercing NULL to editorial", async () => {
    const update = vi.fn().mockResolvedValue({})
    const find = (draftTemplate: string | null) => vi.fn().mockResolvedValue({ draftWidgets: [widget], draftTemplate })
    const withBento = { portalHomeLayout: { findUnique: find("bento"), update } } as unknown as AppPrismaClient
    expect((await publishDraft(withBento, "ws", "u")).template).toBe("bento")
    expect(update.mock.calls[0][0].data.publishedTemplate).toBe("bento")
    const legacy = { portalHomeLayout: { findUnique: find(null), update } } as unknown as AppPrismaClient
    expect((await publishDraft(legacy, "ws", "u")).template).toBe("editorial")
    expect(update.mock.calls[1][0].data.publishedTemplate).toBe("editorial")
  })

  it("loadHomeLayout and loadPublishedHome coerce missing/unknown templates and never read the draft template for customers", async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ draftWidgets: [], publishedWidgets: null, publishedAt: null, draftTemplate: "shell", publishedTemplate: null })
      .mockResolvedValueOnce({ publishedWidgets: [widget], publishedTemplate: "bento" })
      .mockResolvedValueOnce({ publishedWidgets: [widget], publishedTemplate: "retired" })
    const prisma = { portalHomeLayout: { findUnique } } as unknown as AppPrismaClient
    expect(await loadHomeLayout(prisma, "ws")).toMatchObject({ draftTemplate: "shell", publishedTemplate: "editorial" })
    expect((await loadPublishedHome(prisma, "ws")).template).toBe("bento")
    expect((await loadPublishedHome(prisma, "ws")).template).toBe("editorial")
    expect(findUnique.mock.calls[1][0].select).toEqual({ publishedWidgets: true, publishedTemplate: true })
  })
})

describe("before migration 114 is applied", () => {
  const widget = createWidget("rich_text", 0)
  const missing = Object.assign(new Error("column does not exist"), { code: "P2022" })

  it("reads fall back to editorial and publish still copies the widgets", async () => {
    const findUnique = vi.fn(async (args: { select?: Record<string, boolean> }) => {
      if (!args.select || args.select.publishedTemplate || args.select.draftTemplate) throw missing
      return { draftWidgets: [widget], publishedWidgets: [widget], publishedAt: null }
    })
    const update = vi.fn().mockResolvedValue({ id: "x" })
    const prisma = { portalHomeLayout: { findUnique, update } } as unknown as AppPrismaClient
    expect(await loadHomeLayout(prisma, "ws")).toMatchObject({ draftTemplate: "editorial", publishedTemplate: "editorial", hasRow: true })
    expect(await loadPublishedHome(prisma, "ws")).toMatchObject({ template: "editorial" })
    expect((await publishDraft(prisma, "ws", "u")).template).toBe("editorial")
    expect(update.mock.calls[0][0].data).not.toHaveProperty("publishedTemplate")
  })

  it("still throws unrelated database errors", async () => {
    const prisma = { portalHomeLayout: { findUnique: vi.fn().mockRejectedValue(new Error("connection lost")) } } as unknown as AppPrismaClient
    await expect(loadHomeLayout(prisma, "ws")).rejects.toThrow("connection lost")
    await expect(loadPublishedHome(prisma, "ws")).rejects.toThrow("connection lost")
  })
})
