/**
 * Assigning a task to a cloud agent starts an attributed run (phase 4).
 *
 * The REAL trigger, run-identity, ownership, caps and createAgentRun modules run over a small in-memory database, so the
 * refusals below are decided by the production predicates (canInvokeAgent, live grants, the caps, the one-run-per-
 * conversation fence), not by mock call counts. Only the sandbox launch, the snapshot lookup and the scheduler are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

const db = vi.hoisted(() => ({ state: {} as Record<string, Row[]>, seq: 0 }))

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((part) => matches(row, part))
    const value = row[key]
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return (condition.in as unknown[]).includes(value)
      if ("lte" in condition) return value instanceof Date && value.getTime() <= (condition.lte as Date).getTime()
      if ("gte" in condition) return value instanceof Date && value.getTime() >= (condition.gte as Date).getTime()
      if ("startsWith" in condition) return typeof value === "string" && value.startsWith(condition.startsWith as string)
      if ("not" in condition) return value !== condition.not
      return false
    }
    return value === condition
  })
}

const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row)
const table = (name: string) => ({
  findFirst: vi.fn(async ({ where, select, orderBy }: Row = {}) => {
    await Promise.resolve()
    let rows = (db.state[name] ?? []).filter((candidate) => matches(candidate, where))
    if (orderBy?.updatedAt === "desc") rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
    return rows[0] ? pick(rows[0], select) : null
  }),
  findMany: vi.fn(async ({ where, select }: Row = {}) => (db.state[name] ?? []).filter((candidate) => matches(candidate, where)).map((row) => pick(row, select))),
  count: vi.fn(async ({ where }: Row = {}) => (db.state[name] ?? []).filter((candidate) => matches(candidate, where)).length),
  create: vi.fn(async ({ data, select }: Row) => {
    await Promise.resolve()
    // The primary key is unique, as in the database: this is what makes the deterministic conversation id a real dedup.
    if (data.id && (db.state[name] ?? []).some((existing) => existing.id === data.id)) throw Object.assign(new Error("Unique constraint failed on the fields: (`id`)"), { code: "P2002" })
    const row = { id: data.id ?? `${name}-${++db.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data }
    ;(db.state[name] ??= []).push(row)
    return pick(row, select)
  }),
})

const rowLocks = new Map<string, Promise<void>>()
const prisma: Row = {
  agent: table("agent"),
  agentWorkspaceGrant: table("agentWorkspaceGrant"),
  agentConversation: table("agentConversation"),
  agentMessage: { ...table("agentMessage"), aggregate: vi.fn(async () => ({ _count: { _all: db.state.userTurns?.length ?? 0 }, _sum: { costUsd: 0 } })) },
  agentRun: table("agentRun"),
  agentRunEvent: table("agentRunEvent"),
  workspaceMember: table("workspaceMember"),
  task: {
    findFirst: vi.fn(async ({ where }: Row) => {
      const task = (db.state.task ?? []).find((candidate) => matches(candidate, where))
      if (!task) return null
      const workspace = (db.state.workspace ?? []).find((w) => w.id === task.workspaceId)!
      return { ...task, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, organization: { slug: workspace.orgSlug } } }
    }),
  },
  workspace: {
    findFirst: vi.fn(async ({ where, select }: Row) => {
      const ws = (db.state.workspace ?? []).find((w) => matches(w, where))
      if (!ws) return null
      const userOf = (s: Row | undefined) => s?.where?.userId
      return {
        members: (db.state.workspaceMember ?? []).filter((m) => m.workspaceId === ws.id && m.userId === userOf(select?.members)),
        organization: { members: [] },
      }
    }),
  },
  // A transaction that behaves like the real thing for the one property under test: writing a conversation row takes a row
  // lock that is held until the transaction ends, so a second transaction touching the same conversation waits for the first.
  $transaction: vi.fn(async (fn: (tx: Row) => unknown) => {
    const releases: Array<() => void> = []
    const tx: Row = {
      ...prisma,
      agentConversation: {
        ...prisma.agentConversation,
        updateMany: async ({ where }: Row) => {
          const previous = rowLocks.get(where.id) ?? Promise.resolve()
          let release!: () => void
          const mine = new Promise<void>((resolve) => { release = resolve })
          rowLocks.set(where.id, previous.then(() => mine))
          await previous
          releases.push(release)
          return { count: 1 }
        },
      },
    }
    try { return await fn(tx) } finally { releases.forEach((release) => release()) }
  }),
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))
// `after` only exists inside a request; the trigger's own fallback (run inline) is exercised by passing `defer` explicitly.
vi.mock("next/server", () => ({ after: () => { throw new Error("outside a request scope") } }))

import { startRunForAssignedTask, buildTaskContext, taskConversationId, type AgentRunOutcome } from "@/lib/agent-task-trigger"
import { resetAgentColumnsAvailabilityCache } from "@/lib/agent-ownership"
import { resetAgentRunAttributionAvailabilityCache, resetAgentRunsAvailabilityCache } from "@/lib/agent-runs"

const WS = "ws-1"
const OTHER_WS = "ws-2"
const sharedAgent = { id: "agent-shared", name: "Triage", ownerUserId: null, ownerType: "WORKSPACE", ownerWorkspaceId: WS, kind: "CLOUD", status: "ACTIVE", invokePolicy: "WORKSPACE_MEMBERS", instructions: "Be brief.", model: null }
const personalAgent = { id: "agent-personal", name: "Mine", ownerUserId: "owner", ownerType: "USER", ownerWorkspaceId: null, kind: "CLOUD", status: "ACTIVE", invokePolicy: "OWNER", instructions: null, model: null }
const externalAgent = { id: "agent-ext", name: "CI bot", ownerUserId: "owner", ownerType: "USER", ownerWorkspaceId: null, kind: "EXTERNAL", status: "ACTIVE", invokePolicy: null, instructions: null, model: null }

const launch = vi.fn(async () => ({ started: true }))
const defer = vi.fn(async (task: () => Promise<unknown>) => { await task() })
const finalize = vi.fn(async (args: Row) => { const run = db.state.agentRun.find((r) => r.id === args.runId); if (run) run.status = args.status; return { finalized: true } })
const deps = { finalize, now: () => new Date(), getSnapshotId: async () => "snap-1", launch, defer, origin: () => "https://compass.test", env: { ANTHROPIC_API_KEY: "key", MCP_BYPASS_SECRET: "bypass" } as Record<string, string | undefined>, prisma: prisma as any }

function assignTo(agentId: string | null, over: Row = {}) {
  db.state.task = [{ id: "task-1", workspaceId: WS, title: "Fix the signup copy", description: "Tighten it.", seqPrefix: "TASK", seqNumber: 7, assigneeAgentId: agentId, ...over }]
}
const trigger = (over: Partial<Parameters<typeof startRunForAssignedTask>[0]> = {}, overrides: Row = {}): Promise<AgentRunOutcome> =>
  startRunForAssignedTask({ taskId: "task-1", actingUserId: "member", ...over }, { ...deps, ...overrides })

function liveRuns(agentId: string, n: number, extra: Row = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `live-${agentId}-${i}`, conversationId: `other-${i}`, agentId, status: "RUNNING", createdAt: new Date(), ...extra }))
}

beforeEach(() => {
  vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
  vi.clearAllMocks()
  resetAgentColumnsAvailabilityCache()
  resetAgentRunsAvailabilityCache()
  resetAgentRunAttributionAvailabilityCache()
  db.seq = 0
  db.state = {
    agent: [{ ...sharedAgent }, { ...personalAgent }, { ...externalAgent }],
    agentWorkspaceGrant: [
      { agentId: sharedAgent.id, workspaceId: WS, access: "WRITE", revokedAt: null, grantedByUserId: "admin" },
      { agentId: personalAgent.id, workspaceId: WS, access: "WRITE", revokedAt: null, grantedByUserId: "owner" },
      { agentId: externalAgent.id, workspaceId: WS, access: "WRITE", revokedAt: null, grantedByUserId: "owner" },
    ],
    workspace: [{ id: WS, name: "Home", slug: "home", orgSlug: "acme" }, { id: OTHER_WS, name: "Away", slug: "away", orgSlug: "acme" }],
    workspaceMember: [
      { workspaceId: WS, userId: "admin", role: "ADMIN" },
      { workspaceId: WS, userId: "member", role: "MEMBER" },
      { workspaceId: WS, userId: "owner", role: "MEMBER" },
    ],
    agentConversation: [], agentMessage: [], agentRun: [], userTurns: [],
  }
  assignTo(sharedAgent.id)
})
afterEach(() => vi.unstubAllEnvs())

const runs = () => db.state.agentRun

describe("a task assigned to a cloud agent", () => {
  it("starts an attributed run: agent, invoker, kind, and a conversation for the task", async () => {
    const outcome = await trigger()
    expect(outcome).toMatchObject({ status: "started", agentName: "Triage" })
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatchObject({ workspaceId: WS, userId: "member", agentId: sharedAgent.id, invokedByUserId: "member", kind: "TASK_ASSIGNMENT", status: "QUEUED", claimId: null })
    const conversation = db.state.agentConversation[0]
    expect(conversation).toMatchObject({ workspaceId: WS, userId: "member" })
    expect(conversation.title).toMatch(/^TASK-7: Fix the signup copy/)
    expect(runs()[0].conversationId).toBe(conversation.id)
    expect(outcome).toMatchObject({ conversationId: conversation.id, conversationUrl: `/acme/home/agent?c=${conversation.id}` })
  })

  it("puts the task in the prompt and the transcript, and hands the launcher the agent and its grants only (no claim)", async () => {
    await trigger()
    const [context] = launch.mock.calls[0] as unknown as [Row]
    expect(context.agent).toMatchObject({ id: sharedAgent.id, name: "Triage", instructions: "Be brief." })
    expect(context.userId).toBe("member")
    expect(context.prompt).toContain('"Home" workspace')
    expect(context.prompt).toContain("task-1")
    expect(context.prompt).toContain("Task title: Fix the signup copy")
    expect(context.snapshotId).toBe("snap-1")
    expect(context.mcpBaseUrl).toBe("https://compass.test")
    expect(context.run.id).toBe(runs()[0].id)
    expect(db.state.agentMessage[0]).toMatchObject({ role: "user", conversationId: db.state.agentConversation[0].id })
    expect(db.state.agentMessage[0].content).toContain("task-1")
    expect(db.state.agentConversation[0].interviewProcessingJson).toBeUndefined()
  })

  it("answers before the sandbox starts: the launch is deferred, not awaited inline", async () => {
    const order: string[] = []
    const slowDefer = vi.fn(async (task: () => Promise<unknown>) => { order.push("deferred"); void task() })
    const slowLaunch = vi.fn(async () => { order.push("launched") })
    await trigger({}, { defer: slowDefer, launch: slowLaunch })
    expect(order[0]).toBe("deferred")
    expect(slowDefer).toHaveBeenCalledTimes(1)
  })

  it("includes the source comment and doc for a task created from a doc comment", async () => {
    await trigger({ comment: { id: "comment-9", docId: "doc-3", body: "@Triage please tighten this" } })
    const [context] = launch.mock.calls[0] as unknown as [Row]
    expect(context.prompt).toContain("comment comment-9 in doc doc-3")
    expect(context.prompt).toContain("Comment: @Triage please tighten this")
  })

  it("runs a personal agent when its owner is the one who assigned it", async () => {
    assignTo(personalAgent.id)
    expect(await trigger({ actingUserId: "owner" })).toMatchObject({ status: "started" })
    expect(runs()[0]).toMatchObject({ agentId: personalAgent.id, invokedByUserId: "owner" })
  })

  it("reuses the task's conversation for a later assignment once the earlier run has finished", async () => {
    await trigger()
    runs()[0].status = "SUCCEEDED"
    const again = await trigger({ previousAssigneeAgentId: personalAgent.id })
    expect(again).toMatchObject({ status: "started" })
    expect(db.state.agentConversation).toHaveLength(1)
    expect(runs()).toHaveLength(2)
  })
})

describe("what does not start a run", () => {
  it("does not for an EXTERNAL agent: assignment stays a queue entry", async () => {
    assignTo(externalAgent.id)
    expect(await trigger()).toEqual({ status: "skipped" })
    expect(runs()).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
  })

  it("does not when agents are disabled", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
    expect(await trigger()).toEqual({ status: "skipped" })
    expect(runs()).toHaveLength(0)
  })

  it("does not for a task with no agent assignee, or one that is gone", async () => {
    assignTo(null)
    expect(await trigger()).toEqual({ status: "skipped" })
    db.state.task = []
    expect(await trigger()).toEqual({ status: "skipped" })
    expect(runs()).toHaveLength(0)
  })

  it("does not when the assignee did not change (re-saving the same assignee)", async () => {
    expect(await trigger({ previousAssigneeAgentId: sharedAgent.id })).toEqual({ status: "skipped" })
    expect(runs()).toHaveLength(0)
    expect(db.state.agentConversation).toHaveLength(0)
  })

  it("refuses a personal agent assigned by someone other than its owner (canInvokeAgent), without a run", async () => {
    assignTo(personalAgent.id)
    const outcome = await trigger({ actingUserId: "member" })
    expect(outcome).toMatchObject({ status: "refused", code: "AGENT_NOT_INVOKABLE", agentName: "Mine" })
    expect(outcome.status === "refused" && outcome.message).toMatch(/assigned to Mine.*not allowed to run it/)
    expect(runs()).toHaveLength(0)
    expect(db.state.agentMessage).toHaveLength(0)
  })

  it("refuses a shared agent whose policy is admins-only when a plain member assigns it, and allows an admin", async () => {
    db.state.agent[0].invokePolicy = "ADMINS"
    expect(await trigger({ actingUserId: "member" })).toMatchObject({ status: "refused", code: "AGENT_NOT_INVOKABLE" })
    expect(runs()).toHaveLength(0)
    expect(await trigger({ actingUserId: "admin" })).toMatchObject({ status: "started" })
  })

  it("refuses a non-member (no workspace membership) for a shared agent", async () => {
    expect(await trigger({ actingUserId: "stranger" })).toMatchObject({ status: "refused", code: "AGENT_NOT_INVOKABLE" })
    expect(runs()).toHaveLength(0)
  })

  it.each([
    ["suspended", () => { db.state.agent[0].status = "SUSPENDED" }],
    ["revoked in this workspace", () => { db.state.agentWorkspaceGrant[0].revokedAt = new Date() }],
    ["granted only in another workspace", () => { db.state.agentWorkspaceGrant[0].workspaceId = OTHER_WS }],
    ["granted by an administrator who no longer administers", () => { db.state.agentWorkspaceGrant[0].grantedByUserId = "ex-admin" }],
  ])("refuses an agent that is %s, without a run", async (_label, arrange) => {
    arrange()
    expect(await trigger()).toMatchObject({ status: "refused", code: "AGENT_NOT_AVAILABLE" })
    expect(runs()).toHaveLength(0)
  })

  it("refuses when background runs or attribution are not applied", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "P2021" })
    prisma.agentRun.findFirst.mockRejectedValueOnce(missing)
    expect(await trigger()).toMatchObject({ status: "refused", code: "AGENT_RUN_UNAVAILABLE" })
    expect(runs()).toHaveLength(0)
  })

  it("refuses when the agent runtime is not set up (no snapshot, or no model credential)", async () => {
    expect(await trigger({}, { getSnapshotId: async () => null })).toMatchObject({ status: "refused", code: "AGENT_RUNTIME_UNAVAILABLE" })
    expect(await trigger({}, { env: { ANTHROPIC_API_KEY: "  " } })).toMatchObject({ status: "refused", code: "AGENT_RUNTIME_UNAVAILABLE" })
    expect(runs()).toHaveLength(0)
  })

  it("refuses when the person is over their own daily agent limit", async () => {
    db.state.userTurns = Array.from({ length: 100 }, () => ({}))
    const outcome = await trigger()
    expect(outcome).toMatchObject({ status: "refused", code: "USER_LIMIT_REACHED" })
    expect(runs()).toHaveLength(0)
  })
})

describe("idempotency and the one-run-per-conversation fence", () => {
  it("a second trigger while the first run is still going starts nothing and says so", async () => {
    const first = await trigger()
    const second = await trigger({ previousAssigneeAgentId: personalAgent.id })
    expect(second).toMatchObject({ status: "already_running", agentName: "Triage" })
    expect(second.status === "already_running" && first.status === "started" && second.conversationId === first.conversationId).toBe(true)
    expect(runs()).toHaveLength(1)
    expect(db.state.agentMessage).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it("maps the fence's own RUN_IN_FLIGHT (a race past the pre-check) to already_running, not an error", async () => {
    const first = await trigger()
    expect(first.status).toBe("started")
    // The pre-check misses (as it would under a race), so only createAgentRun's transactional fence can catch it.
    prisma.agentRun.findFirst.mockResolvedValueOnce(null)
    const raced = await trigger({ previousAssigneeAgentId: personalAgent.id })
    expect(raced.status === "already_running" || raced.status === "started").toBe(true)
    if (raced.status === "started") expect(runs().filter((r) => r.status === "QUEUED")).toHaveLength(1)
  })
})

describe("concurrent triggers", () => {
  it("two simultaneous assignments of the same task by the same person start one run in one conversation", async () => {
    const outcomes = await Promise.all([trigger(), trigger()])
    expect(outcomes.map((o) => o.status).sort()).toEqual(["already_running", "started"])
    expect(runs()).toHaveLength(1)
    expect(db.state.agentConversation).toHaveLength(1)
    expect(db.state.agentMessage).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)
    const [a, b] = outcomes
    expect((a as { conversationId: string }).conversationId).toBe((b as { conversationId: string }).conversationId)
  })

  it("five at once still start exactly one", async () => {
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => trigger()))
    expect(outcomes.filter((o) => o.status === "started")).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === "already_running")).toHaveLength(4)
    expect(runs()).toHaveLength(1)
    expect(db.state.agentConversation).toHaveLength(1)
  })

  it("maps a database write conflict on the conversation (DSQL aborting the loser) to already_running", async () => {
    await trigger()
    prisma.agentRun.findFirst.mockResolvedValueOnce(null) // the pre-check misses
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
    expect(await trigger({ previousAssigneeAgentId: personalAgent.id })).toMatchObject({ status: "already_running" })
  })

  it("different people assigning the same task get their own conversations and runs", async () => {
    const a = await trigger({ actingUserId: "member" })
    const b = await trigger({ actingUserId: "admin" })
    expect([a.status, b.status]).toEqual(["started", "started"])
    expect(db.state.agentConversation).toHaveLength(2)
    expect(new Set(db.state.agentConversation.map((c) => c.userId))).toEqual(new Set(["member", "admin"]))
  })

  it("one person assigning two tasks gets two conversations", async () => {
    await trigger()
    db.state.task.push({ ...db.state.task[0], id: "task-2", seqNumber: 8, title: "Another" })
    await trigger({ taskId: "task-2" })
    expect(db.state.agentConversation).toHaveLength(2)
  })

  it("never adopts a chat the person merely named like the task", async () => {
    db.state.agentConversation = [{ id: "their-own-chat", workspaceId: WS, userId: "member", title: "TASK-7: Fix the signup copy", updatedAt: new Date() }]
    const outcome = await trigger()
    expect(outcome.status).toBe("started")
    expect(db.state.agentConversation).toHaveLength(2)
    expect(runs()[0].conversationId).not.toBe("their-own-chat")
  })
})

describe("taskConversationId", () => {
  it("is a stable v4-shaped UUID that depends on both the person and the task", () => {
    const id = taskConversationId("u1", "t1")
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(taskConversationId("u1", "t1")).toBe(id)
    expect(taskConversationId("u2", "t1")).not.toBe(id)
    expect(taskConversationId("u1", "t2")).not.toBe(id)
  })

  it("cannot be steered by delimiter tricks between the two inputs", () => {
    expect(taskConversationId("a:b", "c")).not.toBe(taskConversationId("a", "b:c"))
  })
})

describe("a run whose launch never happened", () => {
  const OLD = new Date(Date.now() - 10 * 60_000)

  it("is closed on the next trigger, freeing its concurrent slot and the conversation", async () => {
    const stuck = liveRuns(sharedAgent.id, 5, { kind: "TASK_ASSIGNMENT", status: "QUEUED", startedAt: null, statusChangedAt: OLD })
    db.state.agentRun = stuck
    const outcome = await trigger()
    expect(finalize).toHaveBeenCalledTimes(5)
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED", errorCode: "RUN_START_FAILED" }))
    expect(outcome.status).toBe("started")
  })

  it("leaves a run that is merely young, already started, or someone else's alone", async () => {
    db.state.agentRun = [
      ...liveRuns(sharedAgent.id, 1, { id: "young", kind: "TASK_ASSIGNMENT", status: "QUEUED", startedAt: null, statusChangedAt: new Date() }),
      ...liveRuns(sharedAgent.id, 1, { id: "started", kind: "TASK_ASSIGNMENT", status: "RUNNING", startedAt: OLD, statusChangedAt: OLD }),
      ...liveRuns(personalAgent.id, 1, { id: "other-agent", kind: "TASK_ASSIGNMENT", status: "QUEUED", startedAt: null, statusChangedAt: OLD }),
      ...liveRuns(sharedAgent.id, 1, { id: "chat", kind: "CHAT", status: "QUEUED", startedAt: null, statusChangedAt: OLD }),
    ]
    await trigger()
    expect(finalize.mock.calls.map(([args]) => (args as Row).runId)).toEqual([])
  })

  it("does not fail the assignment when closing the dead run itself fails", async () => {
    db.state.agentRun = liveRuns(sharedAgent.id, 1, { kind: "TASK_ASSIGNMENT", status: "QUEUED", startedAt: null, statusChangedAt: OLD })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const outcome = await trigger({}, { finalize: vi.fn(async () => { throw new Error("db down") }) })
    expect(outcome.status).toBe("started")
  })
})

describe("agent caps do not block the assignment", () => {
  it("refuses at the concurrent cap (default 5) with the cap named, creating nothing", async () => {
    db.state.agentRun = liveRuns(sharedAgent.id, 5)
    const outcome = await trigger()
    expect(outcome).toMatchObject({ status: "refused", code: "AGENT_CAP_REACHED", agentName: "Triage" })
    expect(outcome.status === "refused" && outcome.message).toMatch(/assigned to Triage, but no run started.*5 runs in progress/)
    expect(runs()).toHaveLength(5)
    expect(db.state.agentConversation).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
  })

  it("allows a run under the cap and refuses at the daily cap", async () => {
    db.state.agentRun = liveRuns(sharedAgent.id, 4)
    expect((await trigger()).status).toBe("started")
    db.state.agentRun = Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, conversationId: `c-${i}`, agentId: sharedAgent.id, status: "SUCCEEDED", createdAt: new Date() }))
    expect(await trigger({ previousAssigneeAgentId: personalAgent.id })).toMatchObject({ status: "refused", code: "AGENT_CAP_REACHED" })
  })

  it("honours a lower per-agent cap, and another agent's runs do not count against this one", async () => {
    db.state.agent[0].maxConcurrentRuns = 2
    db.state.agentRun = [...liveRuns(personalAgent.id, 5), ...liveRuns(sharedAgent.id, 1)]
    expect((await trigger()).status).toBe("started")
    expect(await trigger({ previousAssigneeAgentId: personalAgent.id })).toMatchObject({ status: "already_running" })
    db.state.agentRun.push(...liveRuns(sharedAgent.id, 1, { id: "live-extra" }))
    db.state.agentConversation = []
    expect(await trigger({ previousAssigneeAgentId: personalAgent.id })).toMatchObject({ status: "refused", code: "AGENT_CAP_REACHED" })
  })
})

describe("failure handling", () => {
  it("never throws: a database fault becomes a refusal that says the assignment is saved", async () => {
    prisma.task.findFirst.mockRejectedValueOnce(new Error("connection reset"))
    const outcome = await trigger()
    expect(outcome).toMatchObject({ status: "refused", code: "AGENT_RUN_FAILED" })
    expect(outcome.status === "refused" && outcome.message).toMatch(/was assigned/)
  })
})

describe("buildTaskContext", () => {
  it("caps and cleans untrusted text", () => {
    const text = buildTaskContext({ title: "T".repeat(500), description: `a\u0000b${"x".repeat(2000)}` }, { body: "c".repeat(2000) })
    expect(text.length).toBeLessThan(1600)
    expect(text).not.toContain("\u0000")
    expect(text).toMatch(/^Task title: T{199}…/)
  })
})
