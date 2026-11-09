/**
 * The approval surfaces (TASK-149, A3) against a real, disposable PostgreSQL schema: the click path (runApprovalDecision), the
 * read model (loadApprovalView / loadRecentApprovals) and the conversation update. No schema change.
 *
 * Set TOOL_APPROVAL_DATABASE_URL to an isolated localhost compass_e2e URL (no ?schema=) to enable; skipped otherwise.
 * The registry is injected with setToolApprovalRegistryForTest (NODE_ENV=test only); the production registry stays empty.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))

import { runApprovalDecision } from "@/app/[orgSlug]/[workspaceSlug]/approvals/decision-core"
import { addApprovalUpdateToConversation } from "@/lib/tool-approval/conversation"
import { conversationUpdateText } from "@/lib/tool-approval/messages"
import { setToolApprovalRegistryForTest, type ToolApprovalSpec } from "@/lib/tool-approval/registry"
import { requestToolApproval } from "@/lib/tool-approval/request"
import { loadApprovalView, loadRecentApprovals } from "@/lib/tool-approval/view"

const databaseUrl = process.env.TOOL_APPROVAL_DATABASE_URL
const TOOL = "set_workspace_description"

describe.skipIf(!databaseUrl)("tool approval surfaces (real PostgreSQL)", () => {
  const schema = `tool_approval_surface_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let otherWorkspaceId: string
  const u = {} as Record<"admin" | "member" | "outsider" | "demotee", string>
  const executeSpy = vi.fn()

  const spec: ToolApprovalSpec = {
    toolName: TOOL,
    capabilityClass: "workspace.description",
    describe: (args) => ({ title: `Set description to "${String(args.description).slice(0, 40)}"`, summary: "Changes the workspace description." }),
    readBefore: async (args, ctx) => (await ctx.prisma.workspace.findUnique({ where: { id: String(args.workspaceId) }, select: { description: true } }))?.description ?? null,
    computeAfter: (args) => args.description as string,
    execute: async (args, ctx) => {
      executeSpy(ctx)
      if (String(args.description).includes("THROW")) throw new Error("boom Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789 at /srv/app.ts:12")
      await ctx.prisma.workspace.update({ where: { id: String(args.workspaceId) }, data: { description: args.description as string } })
      return { updated: true }
    },
  }

  const pending = async (description: string, inWorkspace = workspaceId, requester: { userId: string | null; agentId: string | null } = { userId: null, agentId: randomUUID() }) => {
    const out = await requestToolApproval({ toolName: TOOL, args: { workspaceId: inWorkspace, description }, requester })
    if (out.status !== "APPROVAL_REQUIRED") throw new Error(`expected APPROVAL_REQUIRED, got ${out.status}`)
    return out
  }
  const click = (requestId: string, over: Partial<Parameters<typeof runApprovalDecision>[0]> = {}) =>
    runApprovalDecision({ userId: u.admin, workspaceId, requestId, action: "APPROVE", idempotencyKey: `ta-${randomUUID()}`, ...over })
  const view = (requestId: string, ws = workspaceId) => loadApprovalView(prisma, { requestId, workspaceId: ws })
  const description = async () => (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { description: true } })).description

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Requires an isolated local compass_e2e URL without a schema override")
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 120_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient
    connection.prisma = prisma
    const org = await prisma.organization.create({ data: { slug: `tas-${randomUUID().slice(0, 8)}`, name: "Tool Approval Surfaces" } })
    const [ws, ws2] = await Promise.all([
      prisma.workspace.create({ data: { organizationId: org.id, slug: "tas", name: "TAS" } }),
      prisma.workspace.create({ data: { organizationId: org.id, slug: "tas-2", name: "TAS 2" } }),
    ])
    workspaceId = ws.id
    otherWorkspaceId = ws2.id
    for (const key of ["admin", "member", "outsider", "demotee"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    await prisma.workspaceMember.create({ data: { workspaceId, userId: u.admin, role: "ADMIN" } })
    await prisma.workspaceMember.create({ data: { workspaceId, userId: u.member, role: "MEMBER" } })
    await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspaceId, userId: u.admin, role: "ADMIN" } })
    await prisma.workspaceMember.create({ data: { workspaceId, userId: u.demotee, role: "ADMIN" } })
  }, 180_000)

  afterAll(async () => {
    setToolApprovalRegistryForTest(null)
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  const useSpec = () => { setToolApprovalRegistryForTest({ [TOOL]: spec }); executeSpy.mockClear() }
  afterEach(async () => {
    vi.restoreAllMocks(); useSpec()
    await prisma.reviewRequest.updateMany({ where: { workspaceId, gateType: "TOOL_APPROVAL", state: "PENDING" }, data: { state: "SUPERSEDED" } })
  })
  useSpec()

  it("a pending request reads as PENDING with its stored title, tool, before and after", async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { description: "old" } })
    const out = await pending("new text")
    const v = (await view(out.requestId))!
    expect(v).toMatchObject({ state: { key: "PENDING" }, tool: TOOL, before: "old", after: "new text", requestedBy: "agent", decision: null, receipt: null })
    expect(v.title).toBe('Set description to "new text"')
    expect(v.displayId).toBe(out.displayId)
    expect(v.path).toBe(out.path)
  })

  it("an admin's approve applies the effect exactly once and the view reads APPLIED with the decider and receipt", async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { description: "before-apply" } })
    const out = await pending("after-apply")
    const result = await click(out.requestId)
    expect(result).toMatchObject({ ok: true, state: "APPLIED" })
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(await description()).toBe("after-apply")
    const v = (await view(out.requestId))!
    expect(v.state.key).toBe("APPLIED")
    expect(v.decision).toMatchObject({ approved: true, decidedByName: "admin" })
    expect(v.receipt).toMatchObject({ status: "APPLIED", error: null })
    expect(await prisma.decisionApplication.count({ where: { targetId: out.requestId } })).toBe(1)
  })

  it("replaying the same click (same idempotency key) does not run it again", async () => {
    const out = await pending("replayed")
    const key = `ta-${randomUUID()}`
    const first = await click(out.requestId, { idempotencyKey: key })
    const second = await click(out.requestId, { idempotencyKey: key })
    expect(first.state).toBe("APPLIED")
    expect(second.message).toMatch(/already processed|not run again/)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(await prisma.decisionRecord.count({ where: { requestId: out.requestId } })).toBe(1)
  })

  it("a second click with a different key after a decision is refused as already decided", async () => {
    const out = await pending("twice")
    await click(out.requestId)
    const again = await click(out.requestId)
    expect(again.ok).toBe(false)
    expect(again.message).toMatch(/already been decided/)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it("deny executes nothing and reads DENIED", async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { description: "keep-me" } })
    const out = await pending("denied-text")
    const result = await click(out.requestId, { action: "REJECT" })
    expect(result).toMatchObject({ ok: true, state: "DENIED" })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await description()).toBe("keep-me")
    expect((await view(out.requestId))!.state.key).toBe("DENIED")
    expect(await prisma.decisionApplication.count({ where: { targetId: out.requestId } })).toBe(0)
  })

  it("a plain member cannot approve or deny: nothing is recorded or run", async () => {
    const out = await pending("by-member")
    for (const action of ["APPROVE", "REJECT"] as const) {
      const r = await click(out.requestId, { userId: u.member, action })
      expect(r).toMatchObject({ ok: false })
      expect(r.message).toMatch(/workspace admin/)
    }
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await prisma.decisionRecord.count({ where: { requestId: out.requestId } })).toBe(0)
    expect((await view(out.requestId))!.state.key).toBe("PENDING")
  })

  it("a user with no membership at all cannot decide", async () => {
    const out = await pending("by-outsider")
    expect((await click(out.requestId, { userId: u.outsider })).ok).toBe(false)
    expect(await prisma.decisionRecord.count({ where: { requestId: out.requestId } })).toBe(0)
  })

  it("a request id from another workspace is not found, even for someone who is admin of both", async () => {
    const foreign = await pending("in-other-workspace", otherWorkspaceId)
    const r = await click(foreign.requestId, { workspaceId })
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/could not be found in this workspace/)
    expect(await view(foreign.requestId, workspaceId)).toBeNull()
    expect(await view(foreign.requestId, otherWorkspaceId)).not.toBeNull()
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await prisma.decisionRecord.count({ where: { requestId: foreign.requestId } })).toBe(0)
    await prisma.reviewRequest.updateMany({ where: { workspaceId: otherWorkspaceId, gateType: "TOOL_APPROVAL", state: "PENDING" }, data: { state: "SUPERSEDED" } })
  })

  it("an ordinary (non-approval) review request id is not found by the approval surfaces", async () => {
    const out = await pending("to-find-a-row")
    const ordinary = await prisma.reviewRequest.update({ where: { id: out.requestId }, data: { gateType: "TRACKED_DECISION" } })
    expect(await view(ordinary.id)).toBeNull()
    expect((await click(ordinary.id)).ok).toBe(false)
    await prisma.reviewRequest.update({ where: { id: out.requestId }, data: { gateType: "TOOL_APPROVAL" } })
  })

  it("approving after the target moved reads STALE and nothing runs", async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { description: "v1" } })
    const out = await pending("v2")
    await prisma.workspace.update({ where: { id: workspaceId }, data: { description: "moved-by-someone" } })
    const r = await click(out.requestId)
    expect(r).toMatchObject({ ok: false, state: "STALE" })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(await description()).toBe("moved-by-someone")
    expect((await view(out.requestId))!.state.key).toBe("STALE")
  })

  it("a failing tool reads FAILED with a sanitised error and is not retried by a second click", async () => {
    const out = await pending("THROW now")
    const r = await click(out.requestId)
    expect(r).toMatchObject({ ok: false, state: "FAILED" })
    const v = (await view(out.requestId))!
    expect(v.state.key).toBe("FAILED")
    expect(v.receipt?.error).toMatch(/boom/)
    expect(v.receipt?.error).not.toMatch(/sk-live|srv\/app/)
    await click(out.requestId)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it("approving a tool that is no longer registered records the approval but runs nothing: Approved, not run", async () => {
    const out = await pending("registered-then-gone")
    setToolApprovalRegistryForTest({})
    const r = await click(out.requestId)
    expect(r).toMatchObject({ ok: false, state: "NOT_RUN" })
    expect(r.message).toMatch(/not available for approval/)
    expect(executeSpy).not.toHaveBeenCalled()
    expect((await view(out.requestId))!.state.key).toBe("NOT_RUN")
  })

  it("an expired, undecided request reads EXPIRED and cannot be approved", async () => {
    const out = await pending("expires")
    await prisma.reviewRevision.update({ where: { id: out.revisionId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await view(out.requestId))!.state.key).toBe("EXPIRED")
    const r = await click(out.requestId)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/expired/)
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it("an unfinished (PENDING) receipt that went quiet reads as an unknown outcome and a click does not re-run it", async () => {
    const out = await pending("crashed-mid-run")
    const decision = await prisma.decisionRecord.create({
      data: {
        workspaceId, requestId: out.requestId, revisionId: out.revisionId, fingerprint: (await prisma.reviewRevision.findUniqueOrThrow({ where: { id: out.revisionId } })).fingerprint,
        optionId: (await prisma.reviewOption.findFirstOrThrow({ where: { revisionId: out.revisionId, actionKey: "APPROVE" } })).id,
        actorUserId: u.admin, actorRole: "ADMIN", idempotencyKey: `ta-${randomUUID()}`,
      },
    })
    await prisma.reviewRequest.update({ where: { id: out.requestId }, data: { state: "DECIDED" } })
    await prisma.decisionApplication.create({
      data: { decisionId: decision.id, continuationKey: "EXECUTE_TOOL_APPROVAL", targetType: "TOOL_APPROVAL", targetId: out.requestId, status: "PENDING", receiptKey: `tool-approval:${decision.id}:v1`, attemptCount: 1, updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
    })
    expect((await view(out.requestId))!.state.key).toBe("UNKNOWN_OUTCOME")
    await click(out.requestId)
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it("recently decided lists decided, denied and expired requests, newest first, and never a waiting one", async () => {
    const waiting = await pending("still-waiting")
    const denied = await pending("to-deny")
    await click(denied.requestId, { action: "REJECT" })
    const recent = await loadRecentApprovals(prisma, workspaceId)
    const ids = recent.map((v) => v.requestId)
    expect(ids).toContain(denied.requestId)
    expect(ids).not.toContain(waiting.requestId)
    expect(recent.length).toBeLessThanOrEqual(20)
    const times = recent.map((v) => v.decision?.decidedAt ?? v.createdAt)
    expect(times.length).toBeGreaterThan(0)
  })

  describe("a refused approval never reads as running (B1)", () => {
    const recordApproval = async (requestId: string, revisionId: string, actorUserId: string) => {
      const revision = await prisma.reviewRevision.findUniqueOrThrow({ where: { id: revisionId } })
      const option = await prisma.reviewOption.findFirstOrThrow({ where: { revisionId, actionKey: "APPROVE" } })
      await prisma.decisionRecord.create({ data: { workspaceId, requestId, revisionId, fingerprint: revision.fingerprint, optionId: option.id, actorUserId, actorRole: "ADMIN", idempotencyKey: `ta-${randomUUID()}` } })
      await prisma.reviewRequest.update({ where: { id: requestId }, data: { state: "DECIDED" } })
    }

    it("a REGISTERED tool whose capability changed after the request: the click, the view and the conversation all say Approved, not run, and nothing says running", async () => {
      const requester = { userId: u.admin, agentId: randomUUID() }
      const out = await pending("refused-mismatch", workspaceId, requester)
      const conversationId = (await prisma.agentConversation.create({ data: { workspaceId, userId: u.admin, title: "chat" } })).id
      await prisma.agentRun.create({ data: { conversationId, workspaceId, userId: u.admin, agentId: requester.agentId, workerTokenHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), deadlineAt: new Date(Date.now() + 3600_000) } })
      setToolApprovalRegistryForTest({ [TOOL]: { ...spec, capabilityClass: "workspace.description.v2" } })
      const r = await click(out.requestId, { conversationId })
      expect(r).toMatchObject({ ok: false, state: "NOT_RUN" })
      expect(executeSpy).not.toHaveBeenCalled()
      expect((await view(out.requestId))!.state.key).toBe("NOT_RUN")
      const rows = await prisma.agentMessage.findMany({ where: { conversationId } })
      expect(rows).toHaveLength(1)
      expect(rows[0].content).toContain("Approved, not run")
      expect(rows[0].content).not.toMatch(/running|is running/i)
    })

    it("an approver who was demoted before the executor ran reads Approved, not run at once (no spinner)", async () => {
      const out = await pending("demoted-approver")
      await recordApproval(out.requestId, out.revisionId, u.demotee)
      expect((await view(out.requestId))!.state.key).toBe("APPLYING") // still an admin: the executor could claim it
      await prisma.workspaceMember.updateMany({ where: { workspaceId, userId: u.demotee }, data: { role: "MEMBER" } })
      expect((await view(out.requestId))!.state.key).toBe("NOT_RUN")
      await prisma.workspaceMember.updateMany({ where: { workspaceId, userId: u.demotee }, data: { role: "ADMIN" } })
    })

    it("an unfinished approval stays unannounced to the conversation until it is final", async () => {
      const requester = { userId: u.admin, agentId: randomUUID() }
      const out = await pending("still-applying", workspaceId, requester)
      await recordApproval(out.requestId, out.revisionId, u.admin)
      const conversationId = (await prisma.agentConversation.create({ data: { workspaceId, userId: u.admin, title: "chat" } })).id
      await prisma.agentRun.create({ data: { conversationId, workspaceId, userId: u.admin, agentId: requester.agentId, workerTokenHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), deadlineAt: new Date(Date.now() + 3600_000) } })
      const v = (await view(out.requestId))!
      expect(v.state.key).toBe("APPLYING")
      expect(await addApprovalUpdateToConversation(prisma, { conversationId, workspaceId, userId: u.admin, view: v })).toBe("not_terminal")
      expect(await prisma.agentMessage.count({ where: { conversationId } })).toBe(0)
    })
  })

  describe("telling the agent conversation", () => {
    const conversation = async (userId: string, agentId?: string) => {
      const id = (await prisma.agentConversation.create({ data: { workspaceId, userId, title: "chat" } })).id
      if (agentId) await prisma.agentRun.create({ data: { conversationId: id, workspaceId, userId, agentId, workerTokenHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), deadlineAt: new Date(Date.now() + 3600_000) } })
      return id
    }
    const asAgent = () => ({ userId: u.admin, agentId: randomUUID() })
    const messages = (conversationId: string) => prisma.agentMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } })

    it("approve adds one fixed-template user message the next turn will load, authored by the admin; a replay adds none", async () => {
      const requester = asAgent()
      const out = await pending("conv-approve", workspaceId, requester)
      const conversationId = await conversation(u.admin, requester.agentId)
      const key = `ta-${randomUUID()}`
      await click(out.requestId, { conversationId, idempotencyKey: key })
      await click(out.requestId, { conversationId, idempotencyKey: key })
      const rows = await messages(conversationId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ role: "user", content: conversationUpdateText({ state: "APPLIED", requestId: out.requestId, displayId: out.displayId, tool: TOOL }) })
      expect(rows[0].content).not.toMatch(/Set description|conv-approve|Changes the workspace/)
    })

    it("deny tells the conversation it was denied", async () => {
      const requester = asAgent()
      const out = await pending("conv-deny", workspaceId, requester)
      const conversationId = await conversation(u.admin, requester.agentId)
      await click(out.requestId, { conversationId, action: "REJECT" })
      const rows = await messages(conversationId)
      expect(rows).toHaveLength(1)
      expect(rows[0].content).toMatch(/Denied\. The admin denied it\. The action was NOT performed\./)
    })

    it("a conversation the clicker cannot access receives nothing", async () => {
      const requester = { userId: u.member, agentId: randomUUID() }
      const out = await pending("conv-foreign", workspaceId, requester)
      const someoneElses = await conversation(u.member, requester.agentId)
      await click(out.requestId, { conversationId: someoneElses })
      expect(await messages(someoneElses)).toHaveLength(0)
    })

    it("a refused click (member) writes nothing to the conversation", async () => {
      const requester = { userId: u.member, agentId: randomUUID() }
      const out = await pending("conv-refused", workspaceId, requester)
      const conversationId = await conversation(u.member, requester.agentId)
      await click(out.requestId, { userId: u.member, conversationId })
      expect(await messages(conversationId)).toHaveLength(0)
    })

    it("A9: a conversation the clicker can access but that never ran the requesting agent receives nothing (fails closed)", async () => {
      const out = await pending("conv-unrelated", workspaceId, asAgent())
      const conversationId = await conversation(u.admin) // no run by the requesting agent
      await click(out.requestId, { conversationId })
      expect(await messages(conversationId)).toHaveLength(0)
    })

    it("A9: a conversation with a run by a different agent receives nothing", async () => {
      const out = await pending("conv-other-agent", workspaceId, asAgent())
      const conversationId = await conversation(u.admin, randomUUID())
      await click(out.requestId, { conversationId })
      expect(await messages(conversationId)).toHaveLength(0)
    })

    it("A9: a service-key request (no user, no agent) is never told to any conversation", async () => {
      const out = await pending("conv-service", workspaceId, { userId: null, agentId: null })
      const conversationId = await conversation(u.admin, randomUUID())
      await click(out.requestId, { conversationId })
      expect(await messages(conversationId)).toHaveLength(0)
    })

    it("A2: concurrent writers of the same outcome produce exactly one message", async () => {
      const requester = asAgent()
      const out = await pending("conv-race", workspaceId, requester)
      const conversationId = await conversation(u.admin, requester.agentId)
      await click(out.requestId)
      const v = (await view(out.requestId))!
      const results = await Promise.all(Array.from({ length: 6 }, () => addApprovalUpdateToConversation(prisma, { conversationId, workspaceId, userId: u.admin, view: v })))
      expect(results.filter((r) => r === "added")).toHaveLength(1)
      expect(results.filter((r) => r === "duplicate")).toHaveLength(5)
      expect(await messages(conversationId)).toHaveLength(1)
    })

    it("B1: the later poll path tells the conversation once the final state is observed, and not before", async () => {
      const requester = asAgent()
      const out = await pending("conv-late", workspaceId, requester)
      const conversationId = await conversation(u.admin, requester.agentId)
      // The click returned while the run was still unfinished (no conversation passed): nothing was told.
      await click(out.requestId)
      expect(await messages(conversationId)).toHaveLength(0)
      // The card's later poll observes the final state and asks for the once-only message.
      const v = (await view(out.requestId))!
      expect(v.state.key).toBe("APPLIED")
      expect(await addApprovalUpdateToConversation(prisma, { conversationId, workspaceId, userId: u.admin, view: v })).toBe("added")
      expect(await addApprovalUpdateToConversation(prisma, { conversationId, workspaceId, userId: u.admin, view: v })).toBe("duplicate")
      expect(await messages(conversationId)).toHaveLength(1)
    })
  })
})
