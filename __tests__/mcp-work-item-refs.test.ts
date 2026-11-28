import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const { assertWorkspaceMember, findFirst, roadmapFindFirst } = vi.hoisted(() => ({ assertWorkspaceMember: vi.fn(), findFirst: vi.fn(), roadmapFindFirst: vi.fn() }))
vi.mock("@/lib/mcp-authz", () => ({ assertWorkspaceMember }))
vi.mock("@/lib/db", () => ({ default: () => ({ task: { findFirst }, opportunity: { findFirst }, roadmapItem: { findFirst: roadmapFindFirst } }) }))

import { McpRefError, MCP_REF_PARAMS, MCP_TOOL_REF_PARAMS, resolveToolRefs, widenRefSchemas } from "@/lib/mcp-work-item-refs"

const WS = "11111111-1111-4111-8111-111111111111"
const UUID = "22222222-2222-4222-8222-222222222222"
const actor = { userId: "u1" } as never

beforeEach(() => vi.resetAllMocks())

describe("widenRefSchemas", () => {
  it("accepts a UUID or a display ID for mapped parameters and keeps optionality and description", () => {
    const shape = widenRefSchemas({
      taskId: z.string().uuid().describe("UUID of the task"),
      parentTaskId: z.string().uuid().optional(),
      title: z.string(),
    })
    const schema = z.object(shape)
    expect(schema.safeParse({ taskId: UUID, title: "t" }).success).toBe(true)
    expect(schema.safeParse({ taskId: "task-12", title: "t" }).success).toBe(true)
    expect(schema.safeParse({ taskId: "TASK-12", parentTaskId: "TASK-3", title: "t" }).success).toBe(true)
    expect(schema.safeParse({ taskId: "nonsense", title: "t" }).success).toBe(false)
    expect(schema.safeParse({ taskId: "TASK-0", title: "t" }).success).toBe(false)
    expect(schema.safeParse({ title: "t" }).success).toBe(false)
    expect((shape.taskId as z.ZodType).description).toContain("display ID like TASK-12")
    expect((shape.parentTaskId as z.ZodType).isOptional()).toBe(true)
  })

  it("adds an optional workspaceId when the tool had none, and leaves an existing one alone", () => {
    const added = widenRefSchemas({ taskId: z.string().uuid() })
    expect(Object.keys(added)).toEqual(["taskId", "workspaceId"])
    expect(z.object(added).safeParse({ taskId: UUID }).success).toBe(true)
    const own = z.string().uuid().describe("mine")
    expect(widenRefSchemas({ workspaceId: own, taskId: z.string().uuid() }).workspaceId).toBe(own)
  })

  it("returns the very same object when nothing is mapped, and never touches ambiguous names", () => {
    const untouched = { workspaceId: z.string().uuid(), itemId: z.string().uuid(), commentId: z.string().uuid() }
    expect(widenRefSchemas(untouched)).toBe(untouched)
    for (const ambiguous of ["itemId", "objectId", "targetId", "linkedId", "entityId", "commentId"]) expect(MCP_REF_PARAMS).not.toHaveProperty(ambiguous)
  })
})

describe("resolveToolRefs", () => {
  it("returns UUID-only arguments untouched, without any lookup", async () => {
    const args = { workspaceId: WS, taskId: UUID }
    expect(await resolveToolRefs(actor, args)).toBe(args)
    expect(assertWorkspaceMember).not.toHaveBeenCalled()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("checks workspace access first, then swaps display IDs for UUIDs inside that workspace", async () => {
    findFirst.mockResolvedValue({ id: UUID, seqPrefix: "TASK", seqNumber: 12 })
    const result = await resolveToolRefs(actor, { workspaceId: WS, taskId: "task-12", title: "x" })
    expect(result).toEqual({ workspaceId: WS, taskId: UUID, title: "x" })
    expect(assertWorkspaceMember).toHaveBeenCalledWith(expect.anything(), WS)
    expect(assertWorkspaceMember.mock.invocationCallOrder[0]).toBeLessThan(findFirst.mock.invocationCallOrder[0])
    expect(findFirst.mock.calls[0][0].where).toEqual({ workspaceId: WS, seqPrefix: "TASK", seqNumber: 12 })
  })

  it("does not look anything up when the caller cannot use the workspace", async () => {
    assertWorkspaceMember.mockRejectedValue(new Error("Workspace not found or access denied"))
    await expect(resolveToolRefs(actor, { workspaceId: WS, taskId: "TASK-1" })).rejects.toThrow("access denied")
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("asks for workspaceId when a display ID comes without one", async () => {
    await expect(resolveToolRefs(actor, { taskId: "TASK-1" })).rejects.toThrow(/pass workspaceId/)
    await expect(resolveToolRefs(actor, { taskId: "TASK-1", workspaceId: "not-a-uuid" })).rejects.toBeInstanceOf(McpRefError)
  })

  it("names the real type for a display ID of the wrong kind, and reports a missing row", async () => {
    await expect(resolveToolRefs(actor, { workspaceId: WS, opportunityId: "TASK-5" })).rejects.toThrow("TASK-5 is a Task")
    findFirst.mockResolvedValue(null)
    await expect(resolveToolRefs(actor, { workspaceId: WS, taskId: "TASK-99" })).rejects.toThrow("TASK-99 was not found in this workspace.")
  })
})

// Roadmap items (RM-n): the same resolver, workspace scoped, plus per-tool overrides for the ambiguous `itemId`.
const WS_B = "33333333-3333-4333-8333-333333333333"
const RM_UUID = "44444444-4444-4444-8444-444444444444"

/** A store where RM-10 exists only in workspace A (WS), exactly like a per-workspace sequence. */
function roadmapStore() {
  roadmapFindFirst.mockImplementation(async ({ where }: { where: { id?: string; workspaceId: string; seqPrefix?: string; seqNumber?: number } }) =>
    where.workspaceId === WS && (where.id === RM_UUID || (where.seqPrefix === "RM" && where.seqNumber === 10))
      ? { id: RM_UUID, seqPrefix: "RM", seqNumber: 10 }
      : null)
}

describe("roadmap item display IDs", () => {
  it("resolves RM-10 for roadmapItemId inside the declared workspace, case and leading zeros tolerated", async () => {
    roadmapStore()
    for (const ref of ["RM-10", "rm-10", "RM-010", "rm-0010"]) {
      expect(await resolveToolRefs(actor, { workspaceId: WS, roadmapItemId: ref })).toEqual({ workspaceId: WS, roadmapItemId: RM_UUID })
    }
    expect(roadmapFindFirst.mock.calls[0][0].where).toEqual({ workspaceId: WS, seqPrefix: "RM", seqNumber: 10 })
  })

  it("does not resolve the same display ID in another workspace, and never returns the other workspace's row", async () => {
    roadmapStore()
    await expect(resolveToolRefs(actor, { workspaceId: WS_B, roadmapItemId: "RM-10" })).rejects.toThrow("RM-10 was not found in this workspace.")
    expect(roadmapFindFirst.mock.calls.every(([arg]) => arg.where.workspaceId === WS_B)).toBe(true)
  })

  it("reports a TASK-n passed as a roadmap item as the wrong type", async () => {
    roadmapStore()
    await expect(resolveToolRefs(actor, { workspaceId: WS, roadmapItemId: "TASK-5" })).rejects.toThrow("TASK-5 is a Task")
    expect(roadmapFindFirst).not.toHaveBeenCalled()
  })

  it("maps itemId to a roadmap item only for the tools that mean one", async () => {
    expect(MCP_TOOL_REF_PARAMS).toEqual({ update_roadmap_item: { itemId: "roadmapItem" }, set_launch_tier: { itemId: "roadmapItem" } })
    const schema = (tool?: string) => z.object(widenRefSchemas({ itemId: z.string().uuid() }, tool))
    expect(schema("update_roadmap_item").safeParse({ itemId: "RM-10" }).success).toBe(true)
    expect(schema("set_launch_tier").safeParse({ itemId: "RM-10" }).success).toBe(true)
    // update_launch_checklist_item.itemId is a checklist item and other tools are untouched: still UUID only.
    const checklist = widenRefSchemas({ itemId: z.string().uuid() }, "update_launch_checklist_item")
    expect(z.object(checklist).safeParse({ itemId: "RM-10" }).success).toBe(false)
    expect(Object.keys(checklist)).toEqual(["itemId"])
    expect(schema().safeParse({ itemId: "RM-10" }).success).toBe(false)
  })

  it("resolves itemId only when the calling tool maps it", async () => {
    roadmapStore()
    expect(await resolveToolRefs(actor, { workspaceId: WS, itemId: "RM-10", title: "x" }, "update_roadmap_item")).toEqual({ workspaceId: WS, itemId: RM_UUID, title: "x" })
    const untouched = { workspaceId: WS, itemId: "RM-10" }
    expect(await resolveToolRefs(actor, untouched, "update_launch_checklist_item")).toBe(untouched)
    expect(await resolveToolRefs(actor, untouched)).toBe(untouched)
    await expect(resolveToolRefs(actor, { workspaceId: WS_B, itemId: "RM-10" }, "set_launch_tier")).rejects.toThrow("not found")
    await expect(resolveToolRefs(actor, { itemId: "RM-10" }, "update_roadmap_item")).rejects.toThrow(/pass workspaceId/)
  })
})
