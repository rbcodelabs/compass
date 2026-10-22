import { beforeEach, describe, expect, it, vi } from "vitest"
import { serializeMention } from "@/lib/comment-mentions"

const mocks = vi.hoisted(() => ({
  db: {
    doc: { findUnique: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    docComment: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    taskLink: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    agent: { findMany: vi.fn() },
    agentWorkspaceGrant: { findMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    organizationMember: { findMany: vi.fn() },
  },
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  createTask: vi.fn(),
  eligible: vi.fn(),
  trigger: vi.fn(),
  resolveAssignees: vi.fn(),
  autoFollow: vi.fn(),
  emit: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/lib/doc-comments", () => ({ createDocCommentCore: mocks.createComment, deleteDocCommentCore: mocks.deleteComment }))
vi.mock("@/lib/task-create", () => ({ createWorkspaceTask: mocks.createTask }))
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: mocks.eligible, resolveTaskAssignees: mocks.resolveAssignees }))
vi.mock("@/lib/agent-task-trigger", () => ({ startRunForAssignedTask: mocks.trigger }))
vi.mock("@/lib/follows", () => ({ autoFollow: mocks.autoFollow }))
vi.mock("@/lib/notifications", () => ({ emitSubjectEvent: mocks.emit }))

import { agentIdsAssignedInDoc, loadCommentTaskCards, loadMentionCandidates, postDocCommentWithOptionalTask } from "@/lib/doc-comment-tasks"

const WS = "00000000-0000-4000-8000-000000000001"
const DOC = "00000000-0000-4000-8000-0000000000d1"
const ME = "00000000-0000-4000-8000-0000000000a1"
const QUINN = "6f1c2a40-1111-4222-8333-944455556666"
const QUENTIN = "7a1c2a40-1111-4222-8333-944455556667"
const BOT = "8b1c2a40-1111-4222-8333-944455556668"
const DANA = "9c1c2a40-1111-4222-8333-944455556669"
const COMMENT = "00000000-0000-4000-8000-0000000000c1"
const TASK = "00000000-0000-4000-8000-0000000000e1"

const quinn = serializeMention({ kind: "user", id: QUINN, label: "Quinn Morales" })
const quentin = serializeMention({ kind: "user", id: QUENTIN, label: "Quentin Okafor" })
const bot = serializeMention({ kind: "agent", id: BOT, label: "QA Agent" })
const dana = serializeMention({ kind: "user", id: DANA, label: "Dana Whitfield" })

const base = { docId: DOC, userId: ME, userName: "Rick", anchorText: "The rollout checklist" }
const withTask = { title: "Draft rollout checklist", priority: "HIGH" as const, dueDate: "2026-10-23" }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.db.doc.findUnique.mockResolvedValue({ id: DOC, workspaceId: WS, title: "Launch plan" })
  mocks.db.workspaceMember.findFirst.mockResolvedValue({ id: "m1" })
  mocks.db.docComment.findMany.mockResolvedValue([])
  mocks.db.task.findMany.mockResolvedValue([])
  mocks.db.taskLink.findMany.mockResolvedValue([])
  mocks.eligible.mockResolvedValue([
    { type: "USER", id: QUINN, displayName: "Quinn Morales", available: true },
    { type: "USER", id: QUENTIN, displayName: "Quentin Okafor", available: true },
    { type: "AGENT", id: BOT, displayName: "QA Agent", available: true },
  ])
  mocks.createComment.mockImplementation(async (input: { body: string; anchorText?: string }) => ({
    ok: true,
    comment: { id: COMMENT, docId: DOC, parentId: null, body: input.body, status: "OPEN", anchorText: input.anchorText ?? null },
  }))
  mocks.createTask.mockResolvedValue({ id: TASK, workspaceId: WS, title: "x", status: "TODO", priority: "HIGH", dueDate: null, seqPrefix: "TASK", seqNumber: 5, assigneeUserId: QUINN, assigneeAgentId: null })
  mocks.resolveAssignees.mockImplementation(async (_ws: string, tasks: Array<Record<string, unknown>>) =>
    tasks.map(t => ({ ...t, assignee: { type: "USER", id: QUINN, displayName: "Quinn Morales", available: true } })))
  mocks.deleteComment.mockResolvedValue({ id: COMMENT })
  mocks.autoFollow.mockResolvedValue({ status: "followed" })
  mocks.emit.mockResolvedValue({ status: "emitted" })
  mocks.trigger.mockResolvedValue({ status: "skipped" })
})

describe("authorization", () => {
  it("rejects a user with no workspace membership (a read-only viewer) before writing anything", async () => {
    mocks.db.workspaceMember.findFirst.mockResolvedValue(null)
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Please ${quinn}`, task: withTask })
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" })
    expect(mocks.createComment).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("checks membership against the document's own workspace", async () => {
    await postDocCommentWithOptionalTask({ ...base, body: "hello" })
    expect(mocks.db.workspaceMember.findFirst).toHaveBeenCalledWith({ where: { workspaceId: WS, userId: ME }, select: { id: true } })
  })

  it("reports a missing doc", async () => {
    mocks.db.doc.findUnique.mockResolvedValue(null)
    expect(await postDocCommentWithOptionalTask({ ...base, body: "hello" })).toEqual({ ok: false, error: "DOC_NOT_FOUND" })
  })
})

describe("creating a task from a comment", () => {
  it("assigns the first mention, links the Comment and the Doc, and returns the card", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Can you draft this? ${quinn}`, task: withTask })
    expect(result.ok).toBe(true)
    expect(mocks.createTask).toHaveBeenCalledWith(WS, expect.objectContaining({
      title: "Draft rollout checklist",
      priority: "HIGH",
      assignee: { type: "USER", id: QUINN },
      dueDate: new Date("2026-10-23T00:00:00.000Z"),
      links: [{ linkedType: "COMMENT", linkedId: COMMENT }, { linkedType: "DOC", linkedId: DOC }],
    }))
    if (result.ok) {
      expect(result.card).toMatchObject({ taskId: TASK, displayId: "TASK-5", assignee: { id: QUINN } })
    }
  })

  it("makes only one task even with several mentions; extra mentions are watchers", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `With ${quinn} and ${quentin}, review by ${bot}`, task: withTask })
    expect(mocks.createTask).toHaveBeenCalledTimes(1)
    expect(mocks.createTask.mock.calls[0][1].assignee).toEqual({ type: "USER", id: QUINN })
    if (result.ok) expect(result.mentioned.watchers.map(w => w.id)).toEqual([QUENTIN, BOT])
  })

  it("lets the author promote a different mention to assignee", async () => {
    await postDocCommentWithOptionalTask({ ...base, body: `${quinn} and ${quentin}`, task: withTask, assignee: { kind: "user", id: QUENTIN } })
    expect(mocks.createTask.mock.calls[0][1].assignee).toEqual({ type: "USER", id: QUENTIN })
  })

  it("posts a plain comment when no task is requested, even with a mention", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `FYI ${quinn}`, task: null })
    expect(result.ok).toBe(true)
    expect(mocks.createTask).not.toHaveBeenCalled()
    if (result.ok) expect(result.card).toBeNull()
  })

  it("rejects a task request with nobody mentioned", async () => {
    expect(await postDocCommentWithOptionalTask({ ...base, body: "no mention", task: withTask })).toEqual({ ok: false, error: "NO_ASSIGNEE" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("rejects an empty title", async () => {
    expect(await postDocCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, title: "   " } })).toEqual({ ok: false, error: "EMPTY_TITLE" })
  })

  it.each(["NOPE", "high", ""])("rejects the invalid priority %j before writing anything", async priority => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, priority: priority as never } })
    expect(result).toEqual({ ok: false, error: "INVALID_PRIORITY" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it.each(["2026-02-31", "2026-13-01", "2026-00-10", "10/23/2026", "2026-2-3", "not a date"])("rejects the invalid due date %j instead of normalizing it", async dueDate => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, dueDate } })
    expect(result).toEqual({ ok: false, error: "INVALID_DUE_DATE" })
    expect(mocks.createComment).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("accepts a leap day and no due date", async () => {
    expect((await postDocCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, dueDate: "2028-02-29" } })).ok).toBe(true)
    expect((await postDocCommentWithOptionalTask({ ...base, body: quinn, task: { ...withTask, dueDate: null } })).ok).toBe(true)
  })

  it("rejects an empty body", async () => {
    expect(await postDocCommentWithOptionalTask({ ...base, body: "  " })).toEqual({ ok: false, error: "EMPTY_BODY" })
  })

  it("creates no comment and no task when the first mention is not in the workspace", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `${dana} can you take this?`, task: withTask })
    expect(result).toEqual({ ok: false, error: "ASSIGNEE_NOT_IN_WORKSPACE" })
    expect(mocks.createComment).not.toHaveBeenCalled()
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("posts a plain comment that mentions a non-member (mention only)", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `${dana} fyi`, task: null })
    expect(result.ok).toBe(true)
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it("removes the comment when the task cannot be created, so no orphan promises a task", async () => {
    mocks.createTask.mockRejectedValue(new Error("Assignee is not in this workspace"))
    const result = await postDocCommentWithOptionalTask({ ...base, body: quinn, task: withTask })
    expect(result).toMatchObject({ ok: false, error: "TASK_FAILED", message: "Assignee is not in this workspace" })
    expect(mocks.deleteComment).toHaveBeenCalledWith(COMMENT)
  })
})

describe("agent assignment", () => {
  it("asks for scope confirmation the first time an agent is assigned in this doc", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Pull baselines ${bot}`, task: withTask })
    expect(result).toEqual({ ok: false, error: "AGENT_SCOPE_CONFIRMATION_REQUIRED" })
    expect(mocks.createComment).not.toHaveBeenCalled()
  })

  it("assigns the agent through assigneeAgentId once confirmed", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Pull baselines ${bot}`, task: withTask, agentScopeConfirmed: true })
    expect(result.ok).toBe(true)
    expect(mocks.createTask.mock.calls[0][1].assignee).toEqual({ type: "AGENT", id: BOT })
  })

  it("skips the confirmation when that agent already holds a task from this doc", async () => {
    mocks.db.docComment.findMany.mockResolvedValue([{ id: "older-comment" }])
    mocks.db.task.findMany.mockResolvedValue([{ assigneeAgentId: BOT }])
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Again ${bot}`, task: withTask })
    expect(result.ok).toBe(true)
  })

  it("rejects an agent that is not enabled in the workspace", async () => {
    mocks.eligible.mockResolvedValue([{ type: "USER", id: QUINN, displayName: "Quinn Morales", available: true }])
    const result = await postDocCommentWithOptionalTask({ ...base, body: bot, task: withTask, agentScopeConfirmed: true })
    expect(result).toEqual({ ok: false, error: "ASSIGNEE_NOT_IN_WORKSPACE" })
  })
})

describe("an agent mention that starts a run", () => {
  beforeEach(() => {
    mocks.createTask.mockResolvedValue({ id: TASK, workspaceId: WS, title: "x", status: "TODO", priority: "HIGH", dueDate: null, seqPrefix: "TASK", seqNumber: 5, assigneeUserId: null, assigneeAgentId: BOT })
  })

  it("asks the trigger with the task, the commenter, and the comment as context, and returns what happened", async () => {
    const outcome = { status: "started", agentName: "QA Agent", runId: "r1", conversationId: "c1", conversationUrl: "/o/w/agent?c=c1" }
    mocks.trigger.mockResolvedValue(outcome)
    const body = `Pull baselines ${bot}`
    const result = await postDocCommentWithOptionalTask({ ...base, body, task: withTask, agentScopeConfirmed: true })
    expect(mocks.trigger).toHaveBeenCalledWith({ taskId: TASK, actingUserId: ME, comment: { id: COMMENT, docId: DOC, body } })
    expect(result).toMatchObject({ ok: true, agentRun: outcome })
  })

  it("keeps the comment and the task when the run is refused, and reports why", async () => {
    mocks.trigger.mockResolvedValue({ status: "refused", code: "AGENT_CAP_REACHED", message: "no run started" })
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Go ${bot}`, task: withTask, agentScopeConfirmed: true })
    expect(result).toMatchObject({ ok: true, agentRun: { status: "refused", code: "AGENT_CAP_REACHED" } })
    expect(mocks.deleteComment).not.toHaveBeenCalled()
  })

  it("does not ask the trigger for a person assignee, a plain comment, or a rejected comment", async () => {
    mocks.createTask.mockResolvedValue({ id: TASK, workspaceId: WS, title: "x", status: "TODO", priority: "HIGH", dueDate: null, seqPrefix: "TASK", seqNumber: 5, assigneeUserId: QUINN, assigneeAgentId: null })
    await postDocCommentWithOptionalTask({ ...base, body: `Please ${quinn}`, task: withTask })
    await postDocCommentWithOptionalTask({ ...base, body: `FYI ${bot}` })
    mocks.db.workspaceMember.findFirst.mockResolvedValue(null)
    await postDocCommentWithOptionalTask({ ...base, body: `Go ${bot}`, task: withTask, agentScopeConfirmed: true })
    expect(mocks.trigger).not.toHaveBeenCalled()
  })

  it("leaves `agentRun` off the result when the trigger skipped", async () => {
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Go ${bot}`, task: withTask, agentScopeConfirmed: true })
    expect(result).not.toHaveProperty("agentRun")
  })
})

describe("agent kind on the card and the candidates (drives the queue-vs-run copy)", () => {
  it("carries agentKind from the resolved assignee onto the returned card", async () => {
    mocks.createTask.mockResolvedValue({ id: TASK, workspaceId: WS, title: "x", status: "TODO", priority: "HIGH", dueDate: null, seqPrefix: "TASK", seqNumber: 5, assigneeUserId: null, assigneeAgentId: BOT })
    mocks.resolveAssignees.mockImplementation(async (_ws: string, tasks: Array<Record<string, unknown>>) =>
      tasks.map(t => ({ ...t, assignee: { type: "AGENT", id: BOT, displayName: "QA Agent", available: true, agentKind: "CLOUD" } })))
    const result = await postDocCommentWithOptionalTask({ ...base, body: `Go ${bot}`, task: withTask, agentScopeConfirmed: true })
    expect(result).toMatchObject({ ok: true, card: { assignee: { type: "AGENT", agentKind: "CLOUD" } } })
  })

  it("offers each agent candidate with its kind", async () => {
    mocks.eligible.mockResolvedValue([{ type: "AGENT", id: BOT, displayName: "QA Agent", available: true, agentKind: "CLOUD" }])
    mocks.db.agent.findMany.mockResolvedValue([])
    mocks.db.agentWorkspaceGrant.findMany.mockResolvedValue([])
    mocks.db.user.findMany.mockResolvedValue([])
    mocks.db.workspace.findUnique.mockResolvedValue({ organizationId: "org" })
    mocks.db.organizationMember.findMany.mockResolvedValue([])
    const candidates = await loadMentionCandidates(WS)
    expect(candidates.agents[0]).toMatchObject({ id: BOT, agentKind: "CLOUD" })
  })
})

describe("agentIdsAssignedInDoc", () => {
  it("only counts tasks linked to comments of this doc and dedupes", async () => {
    mocks.db.docComment.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }])
    mocks.db.task.findMany.mockResolvedValue([{ assigneeAgentId: BOT }, { assigneeAgentId: BOT }])
    expect(await agentIdsAssignedInDoc(WS, DOC)).toEqual([BOT])
    expect(mocks.db.task.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: WS, links: { some: { linkedType: "COMMENT", linkedId: { in: ["c1", "c2"] } } } }),
    }))
  })

  it("is empty for a doc with no comments", async () => {
    expect(await agentIdsAssignedInDoc(WS, DOC)).toEqual([])
    expect(mocks.db.task.findMany).not.toHaveBeenCalled()
  })
})

describe("notifications for mentions", () => {
  async function flush() {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it("tells watchers (not the assignee, who hears via ASSIGNED, and not the author) and follows them", async () => {
    await postDocCommentWithOptionalTask({ ...base, body: `${quinn} ${quentin} ${bot}`, task: withTask, agentScopeConfirmed: true })
    await flush()
    expect(mocks.emit).toHaveBeenCalledTimes(1)
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({
      kind: "MENTIONED", subjectType: "DOC", subjectId: DOC, recipientUserIds: [QUENTIN],
      payload: { commentId: COMMENT }, dedupeKey: `mention:${COMMENT}`, actor: { type: "USER", id: ME },
    })
    const followed = mocks.autoFollow.mock.calls.map(([call]) => `${call.subjectType}:${call.userId}:${call.source}`)
    expect(followed).toContain(`DOC:${QUENTIN}:AUTO_MENTION`)
    expect(followed).toContain(`TASK:${QUENTIN}:AUTO_MENTION`)
    expect(followed.some(entry => entry.includes(QUINN))).toBe(false)
  })

  it("notifies a plain-mentioned person when no task is made", async () => {
    await postDocCommentWithOptionalTask({ ...base, body: `FYI ${quinn}`, task: null })
    await flush()
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({ recipientUserIds: [QUINN] })
    expect(mocks.autoFollow.mock.calls.every(([call]) => call.subjectType === "DOC")).toBe(true)
  })

  it("does not notify the author for mentioning themselves, and sends nothing for agent-only mentions", async () => {
    const me = serializeMention({ kind: "user", id: ME, label: "Rick" })
    await postDocCommentWithOptionalTask({ ...base, body: `${me} ${bot}`, task: null })
    await flush()
    expect(mocks.emit).not.toHaveBeenCalled()
  })
})

describe("loadCommentTaskCards", () => {
  it("returns one card per comment, scoped to the workspace", async () => {
    mocks.db.taskLink.findMany.mockResolvedValue([
      { taskId: TASK, linkedId: COMMENT, task: { id: TASK, seqPrefix: "TASK", seqNumber: 5, title: "Draft", status: "IN_PROGRESS", priority: "HIGH", dueDate: new Date("2026-10-23T00:00:00Z"), assigneeUserId: QUINN, assigneeAgentId: null } },
    ])
    const cards = await loadCommentTaskCards(WS, [COMMENT])
    expect(mocks.db.taskLink.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { linkedType: "COMMENT", linkedId: { in: [COMMENT] }, task: { workspaceId: WS } },
    }))
    expect(cards[COMMENT]).toMatchObject({ taskId: TASK, displayId: "TASK-5", status: "IN_PROGRESS", priority: "HIGH", dueDate: "2026-10-23T00:00:00.000Z" })
  })

  it("keeps the last known name for an assignee who is no longer available", async () => {
    mocks.db.taskLink.findMany.mockResolvedValue([
      { taskId: TASK, linkedId: COMMENT, task: { id: TASK, seqPrefix: "TASK", seqNumber: 5, title: "Draft", status: "TODO", priority: "HIGH", dueDate: null, assigneeUserId: QUINN, assigneeAgentId: null } },
    ])
    mocks.resolveAssignees.mockImplementation(async (_ws: string, tasks: Array<Record<string, unknown>>) =>
      tasks.map(t => ({ ...t, assignee: { type: "USER", id: QUINN, displayName: "Unavailable person", available: false } })))
    mocks.db.user.findMany.mockResolvedValue([{ id: QUINN, name: "Quinn Morales", email: "quinn@example.com" }])
    const cards = await loadCommentTaskCards(WS, [COMMENT])
    expect(cards[COMMENT].assignee).toMatchObject({ displayName: "Quinn Morales", available: false })
  })

  it("does no query for no comments", async () => {
    expect(await loadCommentTaskCards(WS, [])).toEqual({})
    expect(mocks.db.taskLink.findMany).not.toHaveBeenCalled()
  })
})

describe("loadMentionCandidates", () => {
  it("offers members and granted agents, and lists org members outside the workspace separately", async () => {
    mocks.db.user.findMany.mockResolvedValue([{ id: QUINN, email: "quinn@example.com" }, { id: QUENTIN, email: "quentin@example.com" }])
    mocks.db.agent.findMany.mockResolvedValue([{ id: BOT, description: "Test plans" }])
    mocks.db.agentWorkspaceGrant.findMany.mockResolvedValue([{ agentId: BOT, access: "READ" }])
    mocks.db.workspace.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mocks.db.organizationMember.findMany.mockResolvedValue([
      { userId: QUINN, user: { id: QUINN, name: "Quinn Morales", email: "quinn@example.com" } },
      { userId: DANA, user: { id: DANA, name: null, email: "dana@example.com" } },
    ])
    const result = await loadMentionCandidates(WS)
    expect(result.people.map(p => [p.id, p.detail])).toEqual([[QUINN, "quinn@example.com"], [QUENTIN, "quentin@example.com"]])
    expect(result.agents).toEqual([{ kind: "agent", id: BOT, name: "QA Agent", detail: "Test plans", access: "READ" }])
    // Only the non-member appears outside, falling back to email when there is no name.
    expect(result.outside).toEqual([{ kind: "user", id: DANA, name: "dana@example.com", detail: "dana@example.com", outsideWorkspace: true }])
    // Grants are read for this workspace and only while active.
    expect(mocks.db.agentWorkspaceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, revokedAt: null }) }))
  })

  it("has no agents when none is eligible", async () => {
    mocks.eligible.mockResolvedValue([{ type: "USER", id: QUINN, displayName: "Quinn Morales", available: true }])
    mocks.db.user.findMany.mockResolvedValue([{ id: QUINN, email: "quinn@example.com" }])
    mocks.db.workspace.findUnique.mockResolvedValue({ organizationId: "org-1" })
    mocks.db.organizationMember.findMany.mockResolvedValue([])
    const result = await loadMentionCandidates(WS)
    expect(result.agents).toEqual([])
    expect(mocks.db.agent.findMany).not.toHaveBeenCalled()
  })
})
