import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { createWidget } from "@/lib/portal-home/schema"
import { saveDraft } from "@/lib/portal-home/service"

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
