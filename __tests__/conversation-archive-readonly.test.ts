/**
 * TASK-195 S2: "an archived thread takes no replies". Beyond the turn route, nothing else may start an agent run in it
 * or append to it: continuation runs (wake-ups, supervision actions) are refused and a due wake-up is cancelled.
 */
import { describe, expect, it, vi } from "vitest"

import { startConversationContinuationRun } from "@/lib/agent-continuation-run"
import { fireScheduledWakeupById } from "@/lib/agent-scheduled-wakeups"

const WS = "0b6f3c9e-6a1d-4c1e-9d3a-2f0c8e7b5a41"
const CONV = "5d2a7e14-3b9c-4f60-8a21-c7e9d0f4b312"

describe("startConversationContinuationRun", () => {
  it("refuses an archived shared conversation before creating a message or a run", async () => {
    const prisma = {
      workspace: { findFirst: vi.fn(async () => ({ id: WS, name: "W", slug: "w", organization: { slug: "o" } })) },
      agentConversation: { findFirst: vi.fn(async () => ({ id: CONV })) },
      agentMessage: { create: vi.fn() },
      agentRun: { create: vi.fn() },
    }
    const outcome = await startConversationContinuationRun(
      { conversationId: CONV, workspaceId: WS, userId: "u", message: "carry on" },
      { prisma: prisma as never },
    )
    expect(outcome).toMatchObject({ status: "refused", code: "CONVERSATION_ARCHIVED" })
    expect(prisma.agentConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: CONV, visibility: "WORKSPACE", archivedAt: { not: null } }),
    }))
    expect(prisma.agentMessage.create).not.toHaveBeenCalled()
    expect(prisma.agentRun.create).not.toHaveBeenCalled()
  })
})

describe("fireScheduledWakeupById", () => {
  it("cancels a due wake-up on an archived shared conversation instead of firing it", async () => {
    const row = { id: "w1", workspaceId: WS, conversationId: CONV, userId: "u", agentId: null, fireAt: new Date("2026-11-01T00:00:00Z"), reason: null, prompt: "p", status: "PENDING" }
    const prisma = {
      agentScheduledWakeup: { findUnique: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: 1 })) },
      agentConversation: { findFirst: vi.fn(async () => ({ id: CONV })) },
      agentRun: { findFirst: vi.fn(async () => null) },
    }
    const result = await fireScheduledWakeupById(prisma as never, "w1", { now: new Date("2026-11-02T00:00:00Z") })
    expect(result).toEqual({ status: "skipped", wakeupId: "w1" })
    expect(prisma.agentScheduledWakeup.updateMany).toHaveBeenCalledWith({
      where: { id: "w1", status: "PENDING" },
      data: expect.objectContaining({ status: "CANCELED" }),
    })
  })
})
