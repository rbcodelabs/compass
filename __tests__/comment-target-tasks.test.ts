import { beforeEach, describe, expect, it, vi } from "vitest"
import { serializeMention } from "@/lib/comment-mentions"

const mocks = vi.hoisted(() => ({
  db: {
    workspaceMember: { findFirst: vi.fn() },
    comment: { findMany: vi.fn(), deleteMany: vi.fn() },
    task: { findMany: vi.fn() },
    taskLink: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    agent: { findMany: vi.fn() },
    agentWorkspaceGrant: { findMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    organizationMember: { findMany: vi.fn() },
  },
  createComment: vi.fn(),
  createTask: vi.fn(),
  eligible: vi.fn(),
  resolveAssignees: vi.fn(),
  autoFollow: vi.fn(),
  emit: vi.fn(),
  active: vi.fn(),
  resolveDisplay: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/comments", async () => ({
  // The real target list, so a new comment target type fails this suite until its task link type is decided.
  ...(await vi.importActual<typeof import("@/lib/comments")>("@/lib/comments")),
  createComment: mocks.createComment,
  getComment: vi.fn(),
}))
vi.mock("@/lib/doc-comments", () => ({ createDocCommentCore: vi.fn(), deleteDocCommentCore: vi.fn() }))
vi.mock("@/lib/task-create", () => ({ createWorkspaceTask: mocks.createTask }))
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: mocks.eligible, resolveTaskAssignees: mocks.resolveAssignees }))
vi.mock("@/lib/follows", () => ({ autoFollow: mocks.autoFollow }))
vi.mock("@/lib/notifications", () => ({ emitSubjectEvent: mocks.emit }))
vi.mock("@/lib/followable", () => ({
  isSubjectTypeActive: mocks.active,
  getFollowable: () => ({ resolveDisplay: mocks.resolveDisplay }),
}))

import { agentIdsAssignedOnTarget, postTargetCommentWithOptionalTask, TASK_LINK_TYPE_FOR_TARGET } from "@/lib/comment-target-tasks"
import { COMMENT_TARGET_TYPES } from "@/lib/comments"

const WS = "00000000-0000-4000-8000-000000000001"
const TARGET = "00000000-0000-4000-8000-0000000000d1"
const ME = "00000000-0000-4000-8000-0000000000a1"
const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const QUENTIN = "7a1c2a40-1111-4222-8333-944455556667"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"
const COMMENT = "00000000-0000-4000-8000-0000000000c1"
const TASK = "00000000-0000-4000-8000-0000000000e1"

const quinn = serializeMention({ kind: "user", id: QUINN, label: "Quinn Morales" })
const quentin = serializeMention({ kind: "user", id: QUENTIN, label: "Quentin Okafor" })
const bot = serializeMention({ kind: "agent", id: BOT, label: "QA Agent" })

const base = { workspaceId: WS, targetType: "ROADMAP_ITEM" as const, targetId: TARGET, userId: ME, userName: "Rick" }
const withTask = { title: "Draft rollout checklist", priority: "HIGH" as const, dueDate: "2026-10-23" }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.db.workspaceMember.findFirst.mockResolvedValue({ id: "m1" })
  mocks.db.comment.findMany.mockResolvedValue([])
  mocks.db.comment.deleteMany.mockResolvedValue({ count: 1 })
  mocks.db.task.findMany.mockResolvedValue([])
  mocks.active.mockReturnValue(true)
  mocks.resolveDisplay.mockResolvedValue(new Map([[TARGET, { title: "Q4 launch", path: "x" }]]))
  mocks.eligible.mockResolvedValue([
    { type: "USER", id: QUINN, displayName: "Quinn Morales", available: true },
    { type: "USER", id: QUENTIN, displayName: "Quentin Okafor", available: true },
    { type: "AGENT", id: BOT, displayName: "QA Agent", available: true },
  ])
  mocks.createComment.mockImplementation(async (input: { body: string }) => ({ id: COMMENT, body: input.body, parentId: null }))
  mocks.createTask.mockResolvedValue({ id: TASK, workspaceId: WS, title: "x", status: "TODO", priority: "HIGH", dueDate: null, seqPrefix: "TASK", seqNumber: 5 })
  mocks.resolveAssignees.mockImplementation(async (_ws: string, tasks: Array<Record<string, unknown>>) =>
    tasks.map(t => ({ ...t, assignee: { type: "USER", id: QUINN, displayName: "Quinn Morales", available: true } })))
  mocks.autoFollow.mockResolvedValue({ status: "followed" })
  mocks.emit.mockResolvedValue({ status: "emitted" })
})

describe("task link types per target", () => {
  it("maps every target that tasks can link to, and names the ones that cannot", () => {
    const unlinkable = COMMENT_TARGET_TYPES.filter(type => !TASK_LINK_TYPE_FOR_TARGET[type])
    expect(unlinkable.sort()).toEqual(["ARTIFACT", "ASSUMPTION", "RESEARCH_STUDY", "TASK"])
    expect(TASK_LINK_TYPE_FOR_TARGET.REVIEW_REQUEST).toBe("DECISION")
  })
})

describe("posting", () => {
  it("rejects an empty body", async () => {
    expect(await postTargetCommentWithOptionalTask({ ...base, body: "  " })).toEqual({ ok: false, error: "EMPTY_BODY" })
  })

  it("posts a plain mention without needing membership, and creates no task", async () => {
    mocks.db.workspaceMember.findFirst.mockResolvedValue(null)
    const result = await postTargetCommentWithOptionalTask({ ...base, body: `FYI ${quinn}` })
    expect(result.ok).toBe(true)
    expect(mocks.createTask).not.toHaveBeenCalled()
    expect(mocks.createComment).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, targetType: "ROADMAP_ITEM", targetId: TARGET, authorType: "HUMAN", source: "UI" }))
  })

  it("requires a real workspace membership to create a task, before writing anything", async () => {
    mocks.db.workspaceMember.findFirst.mockResolvedValue(null)
    expect(await postTargetCommentWithOptionalTask({ ...base, body: quinn, task: withTask })).toEqual({ ok: false, error: "FORBIDDEN" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("maps a createComment failure to a value, keeping the parent errors distinct", async () => {
    mocks.createComment.mockRejectedValue(new Error("Parent comment must share the exact workspace and target."))
    expect(await postTargetCommentWithOptionalTask({ ...base, body: "hi", parentId: "p" })).toMatchObject({ ok: false, error: "PARENT_NOT_FOUND" })
    mocks.createComment.mockRejectedValue(new Error("Comment threads are only one level deep."))
    expect(await postTargetCommentWithOptionalTask({ ...base, body: "hi", parentId: "p" })).toMatchObject({ ok: false, error: "PARENT_IS_REPLY" })
    mocks.createComment.mockRejectedValue(new Error("boom"))
    expect(await postTargetCommentWithOptionalTask({ ...base, body: "hi" })).toMatchObject({ ok: false, error: "COMMENT_FAILED", message: "boom" })
  })
})

describe("creating a task from a comment", () => {
  it("assigns the first mention and links the Comment plus the commented item", async () => {
    const result = await postTargetCommentWithOptionalTask({ ...base, body: `Can you draft this? ${quinn}`, task: withTask })
    expect(result.ok).toBe(true)
    expect(mocks.createTask).toHaveBeenCalledWith(WS, expect.objectContaining({
      title: "Draft rollout checklist",
      priority: "HIGH",
      assignee: { type: "USER", id: QUINN },
      dueDate: new Date("2026-10-23T00:00:00.000Z"),
      description: "From a comment on the roadmap item “Q4 launch”.",
      links: [{ linkedType: "COMMENT", linkedId: COMMENT }, { linkedType: "ROADMAP_ITEM", linkedId: TARGET }],
    }))
    if (result.ok) expect(result.card).toMatchObject({ taskId: TASK, displayId: "TASK-5" })
  })

  it("uses the DECISION link type for a review request", async () => {
    await postTargetCommentWithOptionalTask({ ...base, targetType: "REVIEW_REQUEST", body: quinn, task: withTask })
    expect(mocks.createTask.mock.calls[0][1].links).toEqual([{ linkedType: "COMMENT", linkedId: COMMENT }, { linkedType: "DECISION", linkedId: TARGET }])
  })

  it("degrades to the Comment link alone for a target tasks cannot link to", async () => {
    const result = await postTargetCommentWithOptionalTask({ ...base, targetType: "ASSUMPTION", body: quinn, task: withTask })
    expect(result.ok).toBe(true)
    expect(mocks.createTask.mock.calls[0][1].links).toEqual([{ linkedType: "COMMENT", linkedId: COMMENT }])
  })

  it("makes one task for several mentions and honours a promoted assignee", async () => {
    await postTargetCommentWithOptionalTask({ ...base, body: `${quinn} ${quentin}`, task: withTask, assignee: { kind: "user", id: QUENTIN } })
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask.mock.calls[0][1].assignee).toEqual({ type: "USER", id: QUENTIN })
  })

  it("rejects a task with nobody mentioned, a bad title, and an assignee outside the workspace", async () => {
    expect(await postTargetCommentWithOptionalTask({ ...base, body: "none", task: withTask })).toEqual({ ok: false, error: "NO_ASSIGNEE" })
    expect(await postTargetCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, title: " " } })).toEqual({ ok: false, error: "EMPTY_TITLE" })
    mocks.eligible.mockResolvedValue([])
    expect(await postTargetCommentWithOptionalTask({ ...base, body: quinn, task: withTask })).toEqual({ ok: false, error: "ASSIGNEE_NOT_IN_WORKSPACE" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("deletes the comment when the task cannot be created", async () => {
    mocks.createTask.mockRejectedValue(new Error("db down"))
    const result = await postTargetCommentWithOptionalTask({ ...base, body: quinn, task: withTask })
    expect(result).toEqual({ ok: false, error: "TASK_FAILED", message: "db down" })
    expect(mocks.db.comment.deleteMany).toHaveBeenCalledWith({ where: { id: COMMENT } })
  })
})

describe("agent scope confirmation", () => {
  it("asks first when the agent holds no task from a comment on this target", async () => {
    const result = await postTargetCommentWithOptionalTask({ ...base, body: bot, task: withTask })
    expect(result).toEqual({ ok: false, error: "AGENT_SCOPE_CONFIRMATION_REQUIRED" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("proceeds once confirmed", async () => {
    const result = await postTargetCommentWithOptionalTask({ ...base, body: bot, task: withTask, agentScopeConfirmed: true })
    expect(result.ok).toBe(true)
    expect(mocks.createTask.mock.calls[0][1].assignee).toEqual({ type: "AGENT", id: BOT })
  })

  it("skips the step for an agent already assigned from this target's comments", async () => {
    mocks.db.comment.findMany.mockResolvedValue([{ id: "c0" }])
    mocks.db.task.findMany.mockResolvedValue([{ assigneeAgentId: BOT }])
    expect((await postTargetCommentWithOptionalTask({ ...base, body: bot, task: withTask })).ok).toBe(true)
  })

  it("scopes the known-agents lookup to this target's comments", async () => {
    mocks.db.comment.findMany.mockResolvedValue([{ id: "c0" }, { id: "c1" }])
    mocks.db.task.findMany.mockResolvedValue([{ assigneeAgentId: BOT }, { assigneeAgentId: BOT }])
    expect(await agentIdsAssignedOnTarget(WS, "ROADMAP_ITEM", TARGET)).toEqual([BOT])
    expect(mocks.db.comment.findMany).toHaveBeenCalledWith({ where: { workspaceId: WS, targetType: "ROADMAP_ITEM", targetId: TARGET }, select: { id: true } })
    expect(mocks.db.task.findMany.mock.calls[0][0].where.links.some).toEqual({ linkedType: "COMMENT", linkedId: { in: ["c0", "c1"] } })
  })
})

describe("mention notifications", () => {
  it("follows and notifies on the commented item when its type is live, skipping the task assignee and the author", async () => {
    await postTargetCommentWithOptionalTask({ ...base, body: `${quinn} ${quentin} ${serializeMention({ kind: "user", id: ME, label: "Rick" })}`, task: withTask })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
      subjectType: "ROADMAP_ITEM", subjectId: TARGET, kind: "MENTIONED", recipientUserIds: [QUENTIN], dedupeKey: `mention:${COMMENT}`,
    }))
    expect(mocks.autoFollow).toHaveBeenCalledWith(expect.objectContaining({ userId: QUENTIN, subjectType: "ROADMAP_ITEM", subjectId: TARGET }))
    expect(mocks.autoFollow).toHaveBeenCalledWith(expect.objectContaining({ userId: QUENTIN, subjectType: "TASK", subjectId: TASK }))
  })

  it("notifies through the task when the commented type is not followable yet", async () => {
    mocks.active.mockReturnValue(false)
    await postTargetCommentWithOptionalTask({ ...base, body: `${quinn} ${quentin}`, task: withTask })
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ subjectType: "TASK", subjectId: TASK, recipientUserIds: [QUENTIN] }))
  })

  it("never notifies agents", async () => {
    await postTargetCommentWithOptionalTask({ ...base, body: bot, task: withTask, agentScopeConfirmed: true })
    expect(mocks.emit).not.toHaveBeenCalled()
  })
})
