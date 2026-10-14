import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig } from "@/lib/followable"
import { applyFollowingEffects, buildCommentEffects, buildFollowingEffects, resolveCommentFollowActor, statusDedupeKey, type FollowingEffect } from "@/lib/following-hooks"
import { runWithMcpActor } from "@/lib/mcp-authz"
import { detectFieldTransitions } from "@/lib/status-transitions"

const mocks = vi.hoisted(() => ({ autoFollow: vi.fn(), emit: vi.fn() }))
vi.mock("@/lib/follows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/follows")>()), autoFollow: mocks.autoFollow }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), emitSubjectEvent: mocks.emit }))

const WS = "00000000-0000-4000-8000-000000000001"
const ME = "00000000-0000-4000-8000-0000000000a1"
const OTHER = "00000000-0000-4000-8000-0000000000a2"
const AGENT = "00000000-0000-4000-8000-0000000000c1"
const TASK = "00000000-0000-4000-8000-0000000000b1"
const UPDATED = new Date("2026-10-01T10:00:00.000Z")

const build = (input: Partial<Parameters<typeof buildFollowingEffects>[0]> & Pick<Parameters<typeof buildFollowingEffects>[0], "model" | "operation" | "after">) =>
  buildFollowingEffects({
    before: null,
    actor: { type: "USER", id: ME },
    transitions: detectFieldTransitions(input.model, input.before ?? null, input.after),
    workspaceId: async () => WS,
    ...input,
  })

beforeEach(() => { followableConfig.shippedSlice = 2 })
afterEach(() => { followableConfig.shippedSlice = 1; vi.clearAllMocks() })

describe("buildFollowingEffects", () => {
  it("auto-follows the human creator of a Task, Opportunity or Solution", async () => {
    for (const [model, subjectType] of [["task", "TASK"], ["opportunity", "OPPORTUNITY"], ["solution", "SOLUTION"]] as const) {
      const effects = await build({ model, operation: "create", after: { id: "s1", status: "OPEN" } })
      expect(effects).toEqual([{ type: "follow", target: { userId: ME, workspaceId: WS, subjectType, subjectId: "s1" }, source: "AUTO_CREATE" }])
    }
  })

  it("never auto-follows for agent, system or external actors (agents are never followers)", async () => {
    for (const actor of [{ type: "AGENT", id: AGENT }, { type: "SYSTEM", id: null }, { type: "EXTERNAL", id: null }] as const) {
      expect(await build({ model: "task", operation: "create", after: { id: TASK }, actor })).toEqual([])
    }
  })

  it("emits one STATUS_CHANGED effect for an actual transition, with only machine facts", async () => {
    const effects = await build({ model: "task", operation: "update", before: { status: "TODO" }, after: { id: TASK, status: "DONE", updatedAt: UPDATED } as never })
    expect(effects).toHaveLength(1)
    const [effect] = effects as Extract<FollowingEffect, { type: "emit" }>[]
    expect(effect.event).toMatchObject({
      workspaceId: WS, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED",
      actor: { type: "USER", id: ME }, payload: { from: "TODO", to: "DONE" },
      dedupeKey: statusDedupeKey("TASK", TASK, "TODO", "DONE", UPDATED),
    })
  })

  it("emits nothing for a repeated status, a no-op write, or a create", async () => {
    expect(await build({ model: "task", operation: "update", before: { status: "DONE" }, after: { id: TASK, status: "DONE" } as never })).toEqual([])
    expect(await build({ model: "solution", operation: "update", before: { status: "DRAFT" }, after: { id: "s1" } as never })).toEqual([])
  })

  it("never resolves the workspace when there is nothing to do", async () => {
    const workspaceId = vi.fn().mockResolvedValue(WS)
    await build({ model: "task", operation: "update", before: { status: "DONE" }, after: { id: TASK, status: "DONE" } as never, workspaceId })
    expect(workspaceId).not.toHaveBeenCalled()
  })

  it("ignores roadmap horizon moves and types whose slice has not shipped", async () => {
    expect(await build({ model: "roadmapItem", operation: "update", before: { status: "ACTIVE", horizon: "LATER" }, after: { id: "r", status: "ACTIVE", horizon: "NEXT" } as never })).toEqual([])
    expect(await build({ model: "experiment", operation: "update", before: { status: "DESIGNING" }, after: { id: "e", status: "RUNNING" } as never })).toEqual([])
    followableConfig.shippedSlice = 3
    expect(await build({ model: "experiment", operation: "update", before: { status: "DESIGNING" }, after: { id: "e", status: "RUNNING" } as never })).toHaveLength(1)
  })

  it("does nothing for models that are not follow subjects", async () => {
    expect(await build({ model: "evidence", operation: "create", after: { id: "x" } })).toEqual([])
    expect(await build({ model: "experimentResult", operation: "create", after: { id: "x" } })).toEqual([])
  })

  it("keeps an agent-caused status change attributed to the agent", async () => {
    const [effect] = await build({ model: "task", operation: "update", before: { status: "TODO" }, after: { id: TASK, status: "DONE" } as never, actor: { type: "AGENT", id: AGENT } }) as Extract<FollowingEffect, { type: "emit" }>[]
    expect(effect.event.actor).toEqual({ type: "AGENT", id: AGENT })
  })

  describe("assignment (Tasks only)", () => {
    it("auto-follows the new assignee and notifies only them", async () => {
      const effects = await build({ model: "task", operation: "update", before: { assigneeUserId: null }, after: { id: TASK, assigneeUserId: OTHER, updatedAt: UPDATED } as never })
      expect(effects).toEqual([
        { type: "follow", target: { userId: OTHER, workspaceId: WS, subjectType: "TASK", subjectId: TASK }, source: "AUTO_ASSIGN" },
        expect.objectContaining({ type: "emit", event: expect.objectContaining({ kind: "ASSIGNED", subjectType: "TASK", recipientUserIds: [OTHER], payload: { to: OTHER } }) }),
      ])
    })

    it("treats an assignee set at creation as an assignment, after the creator follow", async () => {
      const effects = await build({ model: "task", operation: "create", after: { id: TASK, assigneeUserId: OTHER } as never })
      expect(effects.map((e) => (e.type === "follow" ? `follow:${e.source}:${e.target.userId}` : `emit:${e.event.kind}`))).toEqual([`follow:AUTO_CREATE:${ME}`, `follow:AUTO_ASSIGN:${OTHER}`, "emit:ASSIGNED"])
    })

    it("self-assignment follows but the emit never reaches the actor (the emitter excludes them)", async () => {
      const effects = await build({ model: "task", operation: "update", before: { assigneeUserId: null }, after: { id: TASK, assigneeUserId: ME } as never })
      expect(effects[0]).toMatchObject({ type: "follow", source: "AUTO_ASSIGN", target: { userId: ME } })
      expect(effects[1]).toMatchObject({ type: "emit", event: { actor: { type: "USER", id: ME }, recipientUserIds: [ME] } })
    })

    it("does nothing when the assignee is unchanged, cleared, or an agent", async () => {
      expect(await build({ model: "task", operation: "update", before: { assigneeUserId: OTHER }, after: { id: TASK, assigneeUserId: OTHER } as never })).toEqual([])
      expect(await build({ model: "task", operation: "update", before: { assigneeUserId: OTHER }, after: { id: TASK, assigneeUserId: null } as never })).toEqual([])
      expect(await build({ model: "task", operation: "update", before: { assigneeUserId: null }, after: { id: TASK, assigneeUserId: null, assigneeAgentId: AGENT } as never })).toEqual([])
    })

    it("a reassignment back to the same person later gets a fresh notification (dedupe includes updatedAt)", async () => {
      const at = (d: string) => new Date(d)
      const first = await build({ model: "task", operation: "update", before: { assigneeUserId: null }, after: { id: TASK, assigneeUserId: OTHER, updatedAt: at("2026-10-01T10:00:00Z") } as never })
      const second = await build({ model: "task", operation: "update", before: { assigneeUserId: null }, after: { id: TASK, assigneeUserId: OTHER, updatedAt: at("2026-10-02T10:00:00Z") } as never })
      const key = (effects: FollowingEffect[]) => (effects[1] as Extract<FollowingEffect, { type: "emit" }>).event.dedupeKey
      expect(key(first)).not.toEqual(key(second))
    })

    it("only Tasks emit assignment", async () => {
      expect(await build({ model: "opportunity", operation: "update", before: {}, after: { id: "o", assigneeUserId: OTHER } as never })).toEqual([])
    })
  })
})

describe("statusDedupeKey", () => {
  it("is stable for the same transition and changes with any input", () => {
    const base = statusDedupeKey("TASK", TASK, "TODO", "DONE", UPDATED)
    expect(statusDedupeKey("TASK", TASK, "TODO", "DONE", UPDATED)).toBe(base)
    expect(base.length).toBeLessThanOrEqual(200)
    for (const other of [
      statusDedupeKey("TASK", TASK, "TODO", "BLOCKED", UPDATED),
      statusDedupeKey("TASK", TASK, "BACKLOG", "DONE", UPDATED),
      statusDedupeKey("TASK", TASK, "TODO", "DONE", new Date("2026-10-01T10:00:01.000Z")),
      statusDedupeKey("SOLUTION", TASK, "TODO", "DONE", UPDATED),
    ]) expect(other).not.toBe(base)
  })

  it("tolerates a missing before-state and updatedAt", () => {
    expect(statusDedupeKey("TASK", TASK, undefined, "TODO", undefined)).toMatch(/^status:/)
  })
})

describe("comment effects", () => {
  const base = { workspaceId: WS, targetType: "TASK", targetId: TASK, commentId: "c1", actor: { type: "USER", id: ME } as const }

  it("follows the commenter and notifies followers of a root comment", () => {
    expect(buildCommentEffects(base)).toEqual([
      { type: "follow", target: { userId: ME, workspaceId: WS, subjectType: "TASK", subjectId: TASK }, source: "AUTO_COMMENT" },
      { type: "emit", event: { workspaceId: WS, subjectType: "TASK", subjectId: TASK, kind: "COMMENT_ADDED", actor: { type: "USER", id: ME }, payload: { commentId: "c1", parentCommentId: null }, dedupeKey: "comment:c1" } },
    ])
  })

  it("notifies replies as COMMENT_REPLIED with the parent id", () => {
    const effects = buildCommentEffects({ ...base, parentId: "root" })
    expect(effects[1]).toMatchObject({ event: { kind: "COMMENT_REPLIED", payload: { commentId: "c1", parentCommentId: "root" } } })
  })

  it("does not follow for agents or external authors, but still notifies followers", () => {
    for (const actor of [{ type: "AGENT", id: AGENT }, { type: "EXTERNAL", id: null }] as const) {
      const effects = buildCommentEffects({ ...base, actor })
      expect(effects.map((e) => e.type)).toEqual(["emit"])
    }
  })

  it("skips migration imports and subject types whose slice has not shipped", () => {
    expect(buildCommentEffects({ ...base, source: "MIGRATION" })).toEqual([])
    expect(buildCommentEffects({ ...base, targetType: "EXPERIMENT" })).toEqual([])
    followableConfig.shippedSlice = 3
    expect(buildCommentEffects({ ...base, targetType: "EXPERIMENT" })).toHaveLength(2)
  })

  it("never activates deferred types (Artifacts)", () => {
    followableConfig.shippedSlice = 3
    expect(buildCommentEffects({ ...base, targetType: "ARTIFACT" })).toEqual([])
  })
})

describe("resolveCommentFollowActor", () => {
  it("treats an external author as EXTERNAL with no id", () => {
    expect(resolveCommentFollowActor({ source: "WIDGET", externalAuthor: { submitterEmail: "v@example.com" } })).toEqual({ type: "EXTERNAL", id: null })
    expect(resolveCommentFollowActor({ source: "WIDGET" })).toEqual({ type: "EXTERNAL", id: null })
  })

  it("uses the author for UI comments and for internal widget visitors", () => {
    expect(resolveCommentFollowActor({ source: "UI", authorId: ME, authorType: "HUMAN" })).toEqual({ type: "USER", id: ME })
    expect(resolveCommentFollowActor({ source: "WIDGET", authorId: ME, authorType: "HUMAN" })).toEqual({ type: "USER", id: ME })
  })

  it("resolves MCP comments from the credential: a user's own key is that user, an agent token is the agent", () => {
    expect(runWithMcpActor({ purpose: "USER", userId: ME }, () => resolveCommentFollowActor({ source: "MCP", authorType: "AGENT" }))).toEqual({ type: "USER", id: ME })
    expect(runWithMcpActor({ purpose: "AGENT_TURN", userId: ME, agentId: AGENT }, () => resolveCommentFollowActor({ source: "MCP", authorType: "AGENT" }))).toEqual({ type: "AGENT", id: AGENT })
    expect(runWithMcpActor({ purpose: "SERVICE", userId: ME }, () => resolveCommentFollowActor({ source: "MCP", authorType: "AGENT" }))).toEqual({ type: "SYSTEM", id: null })
  })

  it("falls back to SYSTEM rather than inventing a user", () => {
    expect(resolveCommentFollowActor({ source: "UI", authorType: "AGENT", authorId: AGENT })).toEqual({ type: "SYSTEM", id: null })
    expect(resolveCommentFollowActor({ source: "UI" })).toEqual({ type: "SYSTEM", id: null })
  })
})

describe("applyFollowingEffects", () => {
  it("runs effects in order and tolerates failures in one without losing the rest", async () => {
    const calls: string[] = []
    mocks.autoFollow.mockImplementation(async () => { calls.push("follow"); throw new Error("db down") })
    mocks.emit.mockImplementation(async () => { calls.push("emit"); return { status: "emitted" } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    await applyFollowingEffects([
      { type: "follow", target: { userId: ME, workspaceId: WS, subjectType: "TASK", subjectId: TASK }, source: "AUTO_CREATE" },
      { type: "emit", event: { workspaceId: WS, subjectType: "TASK", subjectId: TASK, kind: "STATUS_CHANGED", actor: { type: "USER", id: ME }, dedupeKey: "k" } },
    ])
    expect(calls).toEqual(["follow", "emit"])
  })
})
