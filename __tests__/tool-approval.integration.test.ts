/**
 * TOOL_APPROVAL core (TASK-148, A2) against a real, disposable PostgreSQL schema (repo integration-test pattern).
 * No schema change: the gate reuses ReviewRequest / ReviewRevision / ReviewOption / DecisionRecord / DecisionApplication.
 *
 * Set TOOL_APPROVAL_DATABASE_URL to an isolated localhost compass_e2e URL (no ?schema=) to enable; skipped otherwise.
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

import { recordDecision } from "@/lib/decision-service"
import { applyTrackedDecision, createTrackedDecisionRequest, getTrackedDecision, listTrackedDecisions } from "@/lib/tracked-decisions"
import { applyRecordedDecision, getDecision, getReviewRequest, listDecisions, listReviewRequests } from "@/lib/decision-tool-handlers"
import { decideToolApproval } from "@/lib/tool-approval/decide"
import { executeApprovedToolCall } from "@/lib/tool-approval/executor"
import { fingerprintOf, type EffectPacket } from "@/lib/tool-approval/packet"
import { setToolApprovalRegistryForTest, type ToolApprovalSpec } from "@/lib/tool-approval/registry"
import { listPendingToolApprovals, MAX_PENDING_PER_REQUESTER, MAX_PENDING_TOOL_APPROVALS, requestToolApproval } from "@/lib/tool-approval/request"

const databaseUrl = process.env.TOOL_APPROVAL_DATABASE_URL
const TOOL = "set_workspace_description"

describe.skipIf(!databaseUrl)("tool approval core (real PostgreSQL)", () => {
  const schema = `tool_approval_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let orgId: string
  let workspaceId: string
  let otherWorkspaceId: string
  let orgSlug: string
  const u = {} as Record<"admin" | "admin2" | "orgOwner" | "member" | "outsider" | "demotee", string>
  const executeSpy = vi.fn()

  const spec: ToolApprovalSpec = {
    toolName: TOOL,
    capabilityClass: "workspace.description",
    describe: (args) => ({ title: `Set description to "${String(args.description).slice(0, 40)}"`, summary: "Changes the workspace description." }),
    readBefore: async (args, ctx) => (await ctx.prisma.workspace.findUnique({ where: { id: String(args.workspaceId) }, select: { description: true } }))?.description ?? null,
    computeAfter: (args) => args.description as string,
    floors: (args) => (String(args.description).includes("FORBIDDEN") ? ["description contains a forbidden word"] : []),
    execute: async (args, ctx) => {
      executeSpy(ctx)
      if (String(args.description).includes("THROW")) throw new Error("boom Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789 at /srv/app.ts:12")
      await ctx.prisma.workspace.update({ where: { id: String(args.workspaceId) }, data: { description: args.description as string } })
      return { updated: true }
    },
  }

  const service = { userId: null, agentId: null }
  const agent = () => ({ userId: u.member, agentId: randomUUID() })
  const call = (description: string, over: { workspaceId?: string; requester?: { userId: string | null; agentId: string | null } } = {}) =>
    requestToolApproval({ toolName: TOOL, args: { workspaceId: over.workspaceId ?? workspaceId, description }, requester: over.requester ?? { userId: null, agentId: randomUUID() } })
  const pending = async (description: string, over: Parameters<typeof call>[1] = {}) => {
    const outcome = await call(description, over)
    if (outcome.status !== "APPROVAL_REQUIRED") throw new Error(`expected APPROVAL_REQUIRED, got ${outcome.status}`)
    return outcome
  }
  const approve = (requestId: string, userId = u.admin, extra: { key?: string; action?: "APPROVE" | "REJECT" } = {}) =>
    decideToolApproval({ requestId, optionActionKey: extra.action ?? "APPROVE", actingUserId: userId, idempotencyKey: extra.key ?? randomUUID() })
  const description = async () => (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { description: true } }))!.description
  const setDescription = (value: string | null) => prisma.workspace.update({ where: { id: workspaceId }, data: { description: value } })

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
    orgSlug = `ta-${randomUUID().slice(0, 8)}`
    const org = await prisma.organization.create({ data: { slug: orgSlug, name: "Tool Approval Org" } })
    orgId = org.id
    const [ws, ws2] = await Promise.all([
      prisma.workspace.create({ data: { organizationId: org.id, slug: "ta", name: "TA" } }),
      prisma.workspace.create({ data: { organizationId: org.id, slug: "ta-2", name: "TA 2" } }),
    ])
    workspaceId = ws.id
    otherWorkspaceId = ws2.id
    for (const key of ["admin", "admin2", "orgOwner", "member", "outsider", "demotee"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    for (const [key, role] of [["admin", "ADMIN"], ["admin2", "ADMIN"], ["member", "MEMBER"], ["demotee", "ADMIN"]] as const) await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role } })
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: u.orgOwner, role: "OWNER" } })
  }, 180_000)

  afterAll(async () => {
    setToolApprovalRegistryForTest(null)
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  const useSpec = () => { setToolApprovalRegistryForTest({ [TOOL]: spec }); executeSpy.mockClear() }
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks(); useSpec()
    // Keep the shared workspace under its pending caps between tests.
    await prisma.reviewRequest.updateMany({ where: { workspaceId, gateType: "TOOL_APPROVAL", state: "PENDING" }, data: { state: "SUPERSEDED" } })
  })
  useSpec()

  describe("requesting approval (the MCP hook's core)", () => {
    it("service actor with no approval gets APPROVAL_REQUIRED and nothing is written", async () => {
      await setDescription("old")
      const out = await pending("new")
      expect(out).toMatchObject({ status: "APPROVAL_REQUIRED", reused: false, before: "old", after: "new" })
      expect(out.displayId).toMatch(/^DEC-\d+$/)
      expect(out.path).toBe(`/${orgSlug}/ta/approvals/${out.requestId}`)
      expect(await description()).toBe("old")
      expect(executeSpy).not.toHaveBeenCalled()
      const request = await prisma.reviewRequest.findUniqueOrThrow({ where: { id: out.requestId }, include: { currentRevision: { include: { options: true } } } })
      expect(request).toMatchObject({ gateType: "TOOL_APPROVAL", subjectType: "TOOL_APPROVAL", state: "PENDING", workspaceId })
      expect(request.currentRevision).toMatchObject({ requiredRole: "ADMIN" })
      expect(request.currentRevision!.expiresAt!.getTime()).toBeGreaterThan(Date.now())
      expect(request.currentRevision!.options.map((o) => [o.actionKey, o.outcomeClass, o.continuationKey]).sort()).toEqual([
        ["APPROVE", "APPROVE", "EXECUTE_TOOL_APPROVAL"],
        ["REJECT", "REJECT", "NO_ACTION"],
      ])
      const packet = JSON.parse(request.currentRevision!.packetJson) as EffectPacket
      expect(packet).toEqual({ schemaVersion: "tool-approval/v1", tool: TOOL, capabilityClass: "workspace.description", workspaceId, args: { workspaceId, description: "new" }, before: "old", after: "new" })
      expect(request.currentRevision!.fingerprint).toBe(fingerprintOf(request.id, 1, 1, packet))
    })

    it("an agent-key actor gets the same result, attributed to the agent, with no side effects", async () => {
      const requester = agent()
      const out = await pending("agent-new", { requester })
      const row = await prisma.reviewRequest.findUniqueOrThrow({ where: { id: out.requestId } })
      expect(row).toMatchObject({ requestedById: requester.userId, requestedByAgentId: requester.agentId })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("the same call twice while pending reuses one request (argument key order is irrelevant)", async () => {
      const first = await pending("dup")
      const second = await requestToolApproval({ toolName: TOOL, args: { description: "dup", workspaceId }, requester: agent() })
      expect(second).toMatchObject({ status: "APPROVAL_REQUIRED", reused: true, requestId: first.requestId })
      expect(await prisma.reviewRequest.count({ where: { workspaceId, gateType: "TOOL_APPROVAL", subjectId: (await prisma.reviewRequest.findUniqueOrThrow({ where: { id: first.requestId } })).subjectId } })).toBe(1)
    })

    it("concurrent identical calls converge on one pending request", async () => {
      const outs = await Promise.all(Array.from({ length: 4 }, () => call("race-dup")))
      expect(new Set(outs.map((o) => (o as { requestId: string }).requestId)).size).toBe(1)
    })

    it("different arguments get a different request; a decided request is never reused", async () => {
      const a = await pending("diff-a")
      const b = await pending("diff-b")
      expect(a.requestId).not.toBe(b.requestId)
      await approve(a.requestId, u.admin, { action: "REJECT" })
      const again = await pending("diff-a")
      expect(again.requestId).not.toBe(a.requestId)
      expect(again.reused).toBe(false)
    })

    it("a pending request whose live before-state drifted is superseded and a fresh one is created", async () => {
      await setDescription("v1")
      const first = await pending("drift-target")
      await setDescription("v2")
      const second = await pending("drift-target")
      expect(second.requestId).not.toBe(first.requestId)
      expect(second.before).toBe("v2")
      const old = await prisma.reviewRequest.findUniqueOrThrow({ where: { id: first.requestId }, include: { currentRevision: true } })
      expect(old.state).toBe("SUPERSEDED")
      expect(old.currentRevision!.supersededAt).not.toBeNull()
      await expect(approve(first.requestId)).rejects.toMatchObject({ code: "REVISION_NOT_PENDING" })
    })

    it("caps pending approvals per workspace but still reuses an existing pending call at the cap", async () => {
      const capWorkspace = (await prisma.workspace.create({ data: { organizationId: orgId, slug: `cap-${randomUUID().slice(0, 6)}`, name: "Cap" } })).id
      const agents = Array.from({ length: MAX_PENDING_TOOL_APPROVALS / MAX_PENDING_PER_REQUESTER }, () => ({ userId: null, agentId: randomUUID() }))
      for (let i = 0; i < MAX_PENDING_TOOL_APPROVALS; i += 1) await pending(`cap-${i}`, { workspaceId: capWorkspace, requester: agents[Math.floor(i / MAX_PENDING_PER_REQUESTER)] })
      await expect(call("one-too-many", { workspaceId: capWorkspace })).rejects.toMatchObject({ code: "TOO_MANY_PENDING" })
      expect(await call("cap-3", { workspaceId: capWorkspace, requester: agents[0] })).toMatchObject({ status: "APPROVAL_REQUIRED", reused: true })
      expect(await call("other-workspace-unaffected")).toMatchObject({ status: "APPROVAL_REQUIRED" })
    })

    it("caps pending approvals per requesting agent so one caller cannot fill the workspace queue", async () => {
      const greedy = { userId: u.member, agentId: randomUUID() }
      for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i += 1) await pending(`greedy-${i}`, { requester: greedy })
      await expect(call("greedy-over", { requester: greedy })).rejects.toMatchObject({ code: "REQUESTER_LIMIT" })
      expect(await call("greedy-0", { requester: greedy })).toMatchObject({ status: "APPROVAL_REQUIRED", reused: true })
      expect(await call("polite", { requester: { userId: u.member, agentId: randomUUID() } })).toMatchObject({ status: "APPROVAL_REQUIRED", reused: false })
      // A user (no agent) and the service key are counted separately from every agent.
      for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i += 1) await pending(`user-${i}`, { requester: { userId: u.admin, agentId: null } })
      await expect(call("user-over", { requester: { userId: u.admin, agentId: null } })).rejects.toMatchObject({ code: "REQUESTER_LIMIT" })
      for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i += 1) await pending(`svc-${i}`, { requester: service })
      await expect(call("svc-over", { requester: service })).rejects.toMatchObject({ code: "REQUESTER_LIMIT" })
    })

    it("creates nothing when the workspace does not exist (no orphan pending row)", async () => {
      const ghost = randomUUID()
      await expect(call("ghost", { workspaceId: ghost })).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" })
      expect(await prisma.reviewRequest.count({ where: { workspaceId: ghost } })).toBe(0)
    })

    it("a decision that lands between finding the stale request and superseding it is not dropped, and no duplicate pending request appears", async () => {
      await setDescription("race-v1")
      const first = await pending("race-supersede")
      await setDescription("race-v2")
      const realUpdateMany = prisma.reviewRequest.updateMany.bind(prisma.reviewRequest)
      let decided: Awaited<ReturnType<typeof approve>> | null = null
      vi.spyOn(prisma.reviewRequest, "updateMany").mockImplementationOnce(((args: never) =>
        approve(first.requestId).then((result) => { decided = result; return realUpdateMany(args) })) as never)
      const second = await pending("race-supersede")
      expect(decided).not.toBeNull()
      expect(decided!.decision.actorRole).toBe("ADMIN")
      expect(decided!.execution).toMatchObject({ status: "STALE" }) // the world moved, so the approval is honoured as STALE, not silently lost
      const old = await prisma.reviewRequest.findUniqueOrThrow({ where: { id: first.requestId }, include: { currentRevision: true } })
      expect(old.state).toBe("DECIDED")
      expect(old.currentRevision!.supersededAt).toBeNull()
      expect(second.requestId).not.toBe(first.requestId)
      expect(second.before).toBe("race-v2")
      const live = await prisma.reviewRequest.count({ where: { workspaceId, gateType: "TOOL_APPROVAL", state: "PENDING", subjectId: (await prisma.reviewRequest.findUniqueOrThrow({ where: { id: second.requestId } })).subjectId } })
      expect(live).toBe(1)
    })

    it("a floor violation at request time blocks without creating a request", async () => {
      const before = await prisma.reviewRequest.count({ where: { workspaceId, gateType: "TOOL_APPROVAL" } })
      expect(await call("FORBIDDEN word")).toMatchObject({ status: "BLOCKED", floors: ["description contains a forbidden word"] })
      expect(await prisma.reviewRequest.count({ where: { workspaceId, gateType: "TOOL_APPROVAL" } })).toBe(before)
    })

    it("an unlisted tool is NOT_REGISTERED and touches nothing", async () => {
      const before = await prisma.reviewRequest.count()
      expect(await requestToolApproval({ toolName: "get_task", args: { workspaceId }, requester: service })).toEqual({ status: "NOT_REGISTERED" })
      setToolApprovalRegistryForTest({})
      expect(await call("anything")).toEqual({ status: "NOT_REGISTERED" })
      expect(await prisma.reviewRequest.count()).toBe(before)
    })

    it("fails closed without a workspace id", async () => {
      await expect(requestToolApproval({ toolName: TOOL, args: { description: "x" }, requester: service })).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" })
    })

    it("approvals share the DEC-n counter with decisions, and numbers stay unique and dense", async () => {
      const numbers = async () => (await prisma.reviewRequest.findMany({ where: { workspaceId }, select: { seqNumber: true }, orderBy: { seqNumber: "asc" } })).map((r) => r.seqNumber!)
      const tracked = await createTrackedDecisionRequest({ workspaceId, subjectType: "WORKSPACE", subjectId: workspaceId, question: "Q?", context: "c", idempotencyKey: randomUUID(), requestedById: u.admin } as never)
      const out = await pending("numbering")
      const all = await numbers()
      expect(new Set(all).size).toBe(all.length)
      expect(all[all.length - 1] - all[0] + 1).toBe(all.length)
      expect(tracked.requestId).toBeTruthy()
      expect(out.displayId).toBe(`DEC-${(await prisma.reviewRequest.findUniqueOrThrow({ where: { id: out.requestId } })).seqNumber}`)
    })
  })

  describe("approve and execute", () => {
    it("a workspace admin approves: the tool runs once, as that admin, and the receipt records APPLIED", async () => {
      await setDescription("before-approve")
      const out = await pending("approved-value")
      const { decision, execution } = await approve(out.requestId, u.admin)
      expect(decision.actorRole).toBe("ADMIN")
      expect(execution).toMatchObject({ status: "EXECUTED", result: { updated: true } })
      expect(await description()).toBe("approved-value")
      expect(executeSpy).toHaveBeenCalledTimes(1)
      expect(executeSpy.mock.calls[0][0]).toMatchObject({ workspaceId, approverUserId: u.admin, decisionId: decision.id, requestId: out.requestId })
      const receipt = await prisma.decisionApplication.findUniqueOrThrow({ where: { receiptKey: `tool-approval:${decision.id}:v1` } })
      expect(receipt).toMatchObject({ status: "APPLIED", continuationKey: "EXECUTE_TOOL_APPROVAL", targetType: "TOOL_APPROVAL", targetId: out.requestId, lastError: null })
      expect(receipt.appliedAt).not.toBeNull()
    })

    it("an org owner who is not a workspace member can approve", async () => {
      const out = await pending("by-owner")
      expect((await approve(out.requestId, u.orgOwner)).execution).toMatchObject({ status: "EXECUTED" })
    })

    it("deny executes nothing and writes no receipt", async () => {
      await setDescription("keep")
      const out = await pending("denied-value")
      const { decision, execution } = await approve(out.requestId, u.admin, { action: "REJECT" })
      expect(execution).toBeNull()
      expect(await description()).toBe("keep")
      expect(executeSpy).not.toHaveBeenCalled()
      expect(await prisma.decisionApplication.count({ where: { decisionId: decision.id } })).toBe(0)
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "NOT_AN_APPROVAL" })
    })

    it("a non-admin member and an outsider cannot decide; the request stays pending", async () => {
      const out = await pending("member-try")
      await expect(approve(out.requestId, u.member)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" })
      await expect(approve(out.requestId, u.outsider)).rejects.toMatchObject({ code: "ACCESS_DENIED" })
      expect((await prisma.reviewRequest.findUniqueOrThrow({ where: { id: out.requestId } })).state).toBe("PENDING")
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("a service or agent actor can never record the decision", async () => {
      const out = await pending("svc-try")
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const optionId = revision.options.find((o) => o.actionKey === "APPROVE")!.id
      for (const actor of [{ kind: "SERVICE" }, { kind: "AGENT", agentId: randomUUID() }] as never[]) {
        await expect(recordDecision({ actor, revisionId: revision.id, fingerprint: revision.fingerprint, optionId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "HUMAN_ACTOR_REQUIRED" })
      }
    })

    it("the generic recordDecision path refuses a TOOL_APPROVAL request even for a real admin", async () => {
      const out = await pending("generic-try")
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      await expect(recordDecision({ actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint, optionId: revision.options[0].id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "TOOL_APPROVAL_SURFACE_REQUIRED" })
      expect(await prisma.decisionRecord.count({ where: { requestId: out.requestId } })).toBe(0)
      expect((await prisma.reviewRequest.findUniqueOrThrow({ where: { id: out.requestId } })).state).toBe("PENDING")
    })

    it("replaying the same decision submission executes exactly once", async () => {
      const out = await pending("replay-key")
      const key = randomUUID()
      const first = await approve(out.requestId, u.admin, { key })
      const replay = await approve(out.requestId, u.admin, { key })
      expect(replay.decision.id).toBe(first.decision.id)
      expect(first.execution).toMatchObject({ status: "EXECUTED" })
      expect(replay.execution).toMatchObject({ status: "ALREADY_APPLIED", receiptStatus: "APPLIED" })
      expect(executeSpy).toHaveBeenCalledTimes(1)
    })

    it("replaying the decision id directly into the executor never re-runs it", async () => {
      const out = await pending("replay-id")
      const { decision } = await approve(out.requestId)
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "ALREADY_APPLIED" })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "ALREADY_APPLIED" })
      expect(executeSpy).toHaveBeenCalledTimes(1)
    })

    it("two admins approving at once yields one decision and one execution", async () => {
      const out = await pending("double-approve")
      const results = await Promise.allSettled([approve(out.requestId, u.admin), approve(out.requestId, u.admin2)])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      expect(await prisma.decisionRecord.count({ where: { requestId: out.requestId } })).toBe(1)
      expect(executeSpy).toHaveBeenCalledTimes(1)
    })

    it("two executors racing on one approved decision: exactly one wins the receipt and runs the tool", async () => {
      const out = await pending("race-exec")
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const decision = await recordDecision({
        actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint,
        optionId: revision.options.find((o) => o.actionKey === "APPROVE")!.id, idempotencyKey: randomUUID(),
        toolApprovalChannel: (await import("@/lib/tool-approval/channel")).TOOL_APPROVAL_DECISION_CHANNEL,
      })
      const results = await Promise.all([executeApprovedToolCall(decision.id), executeApprovedToolCall(decision.id), executeApprovedToolCall(decision.id)])
      expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1)
      // A loser either sees the finished receipt or the winner's still-PENDING one; neither may look like a second success.
      expect(results.filter((r) => r.status === "ALREADY_APPLIED" || r.status === "UNKNOWN_OUTCOME")).toHaveLength(2)
      expect(executeSpy).toHaveBeenCalledTimes(1)
      expect(await prisma.decisionApplication.count({ where: { decisionId: decision.id } })).toBe(1)
    })

    it("an approver demoted after approving can no longer cause execution", async () => {
      const out = await pending("demoted")
      // Approve without executing: drive recordDecision directly through the sanctioned channel, then demote.
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const decision = await recordDecision({
        actor: { kind: "USER", userId: u.demotee }, revisionId: revision.id, fingerprint: revision.fingerprint,
        optionId: revision.options.find((o) => o.actionKey === "APPROVE")!.id, idempotencyKey: randomUUID(),
        toolApprovalChannel: (await import("@/lib/tool-approval/channel")).TOOL_APPROVAL_DECISION_CHANNEL,
      })
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: u.demotee } }, data: { role: "MEMBER" } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "APPROVER_NOT_ADMIN_NOW" })
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: u.demotee } }, data: { role: "ADMIN" } })
      expect(executeSpy).not.toHaveBeenCalled()
      expect(await prisma.decisionApplication.count({ where: { decisionId: decision.id } })).toBe(0)
    })

    // Approves via the sanctioned channel without executing, so the stored rows can be tampered with first.
    const approveWithoutExecuting = async (value: string) => {
      const out = await pending(value)
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const decision = await recordDecision({
        actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint,
        optionId: revision.options.find((o) => o.actionKey === "APPROVE")!.id, idempotencyKey: randomUUID(),
        toolApprovalChannel: (await import("@/lib/tool-approval/channel")).TOOL_APPROVAL_DECISION_CHANNEL,
      })
      return { out, revision, decision }
    }

    it("a packet tampered after approval is refused (fingerprint recomputed from the stored packet)", async () => {
      const { revision, decision } = await approveWithoutExecuting("tamper")
      const packet = JSON.parse(revision.packetJson) as EffectPacket
      await prisma.reviewRevision.update({ where: { id: revision.id }, data: { packetJson: JSON.stringify({ ...packet, args: { ...(packet.args as object), description: "evil" }, after: "evil" }) } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "FINGERPRINT_MISMATCH" })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("a malformed packet is refused", async () => {
      const { revision, decision } = await approveWithoutExecuting("malformed")
      await prisma.reviewRevision.update({ where: { id: revision.id }, data: { packetJson: "{not json" } })
      const result = await executeApprovedToolCall(decision.id)
      expect(result.status).toBe("REFUSED")
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("a packet naming another workspace is refused even if its fingerprints were forged consistently", async () => {
      const { out, revision, decision } = await approveWithoutExecuting("cross-ws")
      const packet = { ...(JSON.parse(revision.packetJson) as EffectPacket), workspaceId: otherWorkspaceId }
      const fingerprint = fingerprintOf(out.requestId, 1, 1, packet)
      await prisma.reviewRevision.update({ where: { id: revision.id }, data: { packetJson: JSON.stringify(packet), fingerprint } })
      await prisma.decisionRecord.update({ where: { id: decision.id }, data: { fingerprint } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "WORKSPACE_MISMATCH" })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("a tool that left the registry, or whose capability class changed, is refused", async () => {
      const a = await approveWithoutExecuting("unregistered")
      setToolApprovalRegistryForTest({})
      expect(await executeApprovedToolCall(a.decision.id)).toMatchObject({ status: "REFUSED", reason: "TOOL_NOT_REGISTERED" })
      useSpec()
      const b = await approveWithoutExecuting("reclassified")
      setToolApprovalRegistryForTest({ [TOOL]: { ...spec, capabilityClass: "workspace.other" } })
      expect(await executeApprovedToolCall(b.decision.id)).toMatchObject({ status: "REFUSED", reason: "TOOL_MISMATCH" })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("an expired approval is refused", async () => {
      const { revision, decision } = await approveWithoutExecuting("expired")
      await prisma.reviewRevision.update({ where: { id: revision.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "EXPIRED" })
    })

    it("an approval older than the 15 minute execution window is refused", async () => {
      const { decision } = await approveWithoutExecuting("old-approval")
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 16 * 60_000) })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "APPROVAL_STALE" })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("a decision on a non-TOOL_APPROVAL request, or a missing decision, is refused", async () => {
      const tracked = await createTrackedDecisionRequest({ workspaceId, subjectType: "WORKSPACE", subjectId: workspaceId, question: "Q2?", context: "c", idempotencyKey: randomUUID(), requestedById: u.admin } as never)
      const revision = await prisma.reviewRevision.findUniqueOrThrow({ where: { id: tracked.id }, include: { options: true } })
      const decision = await recordDecision({ actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint, optionId: revision.options[0].id, idempotencyKey: randomUUID() })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "WRONG_GATE" })
      expect(await executeApprovedToolCall(randomUUID())).toMatchObject({ status: "REFUSED", reason: "NO_DECISION" })
    })

    it("execute() throwing records a sanitized FAILED receipt and is never silently re-run", async () => {
      const out = await pending("THROW now")
      const { decision, execution } = await approve(out.requestId)
      expect(execution).toMatchObject({ status: "FAILED" })
      const receipt = await prisma.decisionApplication.findUniqueOrThrow({ where: { receiptKey: `tool-approval:${decision.id}:v1` } })
      expect(receipt.status).toBe("FAILED")
      expect(receipt.lastError).toContain("boom")
      expect(receipt.lastError).not.toContain("sk-live")
      expect(receipt.lastError).not.toMatch(/\bat \//)
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "ALREADY_APPLIED", receiptStatus: "FAILED" })
      expect(executeSpy).toHaveBeenCalledTimes(1)
      // Retry semantics: a FAILED receipt is terminal; the same call needs a brand-new approval request.
      const retry = await call("THROW now")
      expect(retry).toMatchObject({ status: "APPROVAL_REQUIRED", reused: false })
      expect((retry as { requestId: string }).requestId).not.toBe(out.requestId)
    })

    it("a floor that appears between approval and execution hard-blocks", async () => {
      const { decision } = await approveWithoutExecuting("floor-later")
      setToolApprovalRegistryForTest({ [TOOL]: { ...spec, floors: () => ["now forbidden: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789"] } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "BLOCKED", floors: ["now forbidden: [redacted]"] })
      expect((await prisma.decisionApplication.findFirstOrThrow({ where: { decisionId: decision.id } })).lastError).toBe("now forbidden: [redacted]")
      expect(executeSpy).not.toHaveBeenCalled()
      expect((await prisma.decisionApplication.findFirstOrThrow({ where: { decisionId: decision.id } })).status).toBe("BLOCKED")
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "ALREADY_APPLIED", receiptStatus: "BLOCKED" })
    })

    it("live before-state that drifted from the approved packet is STALE: nothing runs, a fresh approval is needed", async () => {
      await setDescription("approved-from")
      const { out, decision } = await approveWithoutExecuting("stale-target")
      await setDescription("someone-else-changed-it")
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "STALE" })
      expect(executeSpy).not.toHaveBeenCalled()
      expect(await description()).toBe("someone-else-changed-it")
      expect((await prisma.decisionApplication.findFirstOrThrow({ where: { decisionId: decision.id } })).status).toBe("STALE")
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "ALREADY_APPLIED", receiptStatus: "STALE" })
      const fresh = await pending("stale-target")
      expect(fresh.requestId).not.toBe(out.requestId)
      expect(fresh.before).toBe("someone-else-changed-it")
    })
  })

  describe("executor hardening", () => {
    const approveQuietly = async (value: string) => {
      const out = await pending(value)
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const decision = await recordDecision({
        actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint,
        optionId: revision.options.find((o) => o.actionKey === "APPROVE")!.id, idempotencyKey: randomUUID(),
        toolApprovalChannel: (await import("@/lib/tool-approval/channel")).TOOL_APPROVAL_DECISION_CHANNEL,
      })
      return { out, revision, decision }
    }

    it("a receipt stuck in PENDING is reported as UNKNOWN_OUTCOME needing an operator, never as a success-looking ALREADY_APPLIED", async () => {
      const { out, decision } = await approveQuietly("stuck")
      await prisma.decisionApplication.create({ data: { decisionId: decision.id, continuationKey: "EXECUTE_TOOL_APPROVAL", targetType: "TOOL_APPROVAL", targetId: out.requestId, status: "PENDING", receiptKey: `tool-approval:${decision.id}:v1`, attemptCount: 1, updatedAt: new Date() } })
      expect(await executeApprovedToolCall(decision.id)).toEqual({ status: "UNKNOWN_OUTCOME", receiptStatus: "PENDING", needsOperator: true })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("decideToolApproval surfaces the same UNKNOWN_OUTCOME when a replay meets a stuck receipt", async () => {
      const out = await pending("stuck-replay")
      const key = randomUUID()
      const first = await approve(out.requestId, u.admin, { key })
      await prisma.decisionApplication.update({ where: { receiptKey: `tool-approval:${first.decision.id}:v1` }, data: { status: "PENDING" } })
      const replay = await approve(out.requestId, u.admin, { key })
      expect(replay.execution).toMatchObject({ status: "UNKNOWN_OUTCOME", needsOperator: true })
    })

    it("a decision whose option belongs to a different revision is refused", async () => {
      const { decision } = await approveQuietly("option-owner")
      const other = await pending("option-other")
      const otherRevision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: other.requestId }, include: { options: true } })
      await prisma.decisionRecord.update({ where: { id: decision.id }, data: { optionId: otherRevision.options.find((o) => o.actionKey === "APPROVE")!.id } })
      expect(await executeApprovedToolCall(decision.id)).toMatchObject({ status: "REFUSED", reason: "OPTION_MISMATCH" })
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("redact() keeps secrets out of the stored packet and the returned result, and the redacted before still matches at execution", async () => {
      const seen = vi.fn()
      const strip = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(strip)
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "apiToken" && k !== "internalToken").map(([k, v]) => [k, strip(v)]))
        return value
      }
      setToolApprovalRegistryForTest({ [TOOL]: {
        ...spec,
        readBefore: async (args, ctx) => ({ description: (await ctx.prisma.workspace.findUnique({ where: { id: String(args.workspaceId) }, select: { description: true } }))?.description ?? null, internalToken: "hidden-internal-one" }),
        computeAfter: (args) => ({ description: args.description, internalToken: "hidden-internal-one" }),
        redact: (_kind, value) => strip(value) as never,
        execute: async (args, ctx) => { seen(args); await ctx.prisma.workspace.update({ where: { id: String(args.workspaceId) }, data: { description: args.description as string } }); return { ok: true } },
      } })
      const out = await requestToolApproval({ toolName: TOOL, args: { workspaceId, description: "redacted-run", apiToken: "hidden-api-two" }, requester: { userId: null, agentId: randomUUID() } })
      if (out.status !== "APPROVAL_REQUIRED") throw new Error("expected approval")
      expect(JSON.stringify(out)).not.toMatch(/hidden-internal-one|hidden-api-two/)
      const stored = (await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId } })).packetJson
      expect(stored).not.toMatch(/hidden-internal-one|hidden-api-two/)
      const { execution } = await approve(out.requestId)
      expect(execution).toMatchObject({ status: "EXECUTED" })
      expect(seen.mock.calls[0][0]).toEqual({ workspaceId, description: "redacted-run" })
      expect(await description()).toBe("redacted-run")
    })
  })

  describe("generic review surfaces and readers", () => {
    it("the tracked-decision apply path and the apply_recorded_decision tool refuse an approval and write no receipt", async () => {
      const out = await pending("apply-generic")
      const revision = await prisma.reviewRevision.findFirstOrThrow({ where: { requestId: out.requestId }, include: { options: true } })
      const decision = await recordDecision({
        actor: { kind: "USER", userId: u.admin }, revisionId: revision.id, fingerprint: revision.fingerprint,
        optionId: revision.options.find((o) => o.actionKey === "APPROVE")!.id, idempotencyKey: randomUUID(),
        toolApprovalChannel: (await import("@/lib/tool-approval/channel")).TOOL_APPROVAL_DECISION_CHANNEL,
      })
      await expect(applyTrackedDecision(decision.id)).rejects.toMatchObject({ code: "DECISION_MISMATCH" })
      const tool = await applyRecordedDecision({ decisionId: decision.id })
      expect(tool.structuredContent.ok).toBe(false)
      expect(tool.content[0].text).toMatch(/approval page/i)
      expect(await prisma.decisionApplication.count({ where: { decisionId: decision.id } })).toBe(0)
      expect(executeSpy).not.toHaveBeenCalled()
    })

    it("MCP list/get review requests and decisions never expose a TOOL_APPROVAL row", async () => {
      const out = await pending("hidden-from-readers")
      const listed = await listReviewRequests({ workspaceId })
      expect(JSON.stringify(listed.structuredContent)).not.toContain(out.requestId)
      expect(JSON.stringify(await listReviewRequests({ workspaceId, state: "PENDING" }))).not.toContain(out.requestId)
      const got = await getReviewRequest({ requestId: out.requestId })
      expect(got.structuredContent.ok).toBe(false)
      expect(got.content[0].text).toContain("not found")
      expect(JSON.stringify(await listDecisions({ workspaceId }))).not.toContain(out.requestId)
      expect((await getDecision({ workspaceId, requestId: out.requestId })).structuredContent.ok).toBe(false)
      expect(JSON.stringify(await listTrackedDecisions({ workspaceId, includeLegacy: true } as never))).not.toContain(out.requestId)
      expect(JSON.stringify(await listTrackedDecisions({ workspaceId, tab: "PENDING" } as never))).not.toContain(out.requestId)
      expect(await getTrackedDecision(workspaceId, out.requestId)).toBeNull()
    })

    it("listPendingToolApprovals is admin-only and shows only live pending approvals", async () => {
      const fresh = (await prisma.workspace.create({ data: { organizationId: orgId, slug: `lp-${randomUUID().slice(0, 6)}`, name: "LP" } })).id
      await prisma.workspaceMember.create({ data: { workspaceId: fresh, userId: u.admin, role: "ADMIN" } })
      await prisma.workspaceMember.create({ data: { workspaceId: fresh, userId: u.member, role: "MEMBER" } })
      const live = await pending("lp-live", { workspaceId: fresh })
      const decided = await pending("lp-decided", { workspaceId: fresh })
      await approve(decided.requestId, u.admin, { action: "REJECT" })
      const expired = await pending("lp-expired", { workspaceId: fresh })
      await prisma.reviewRevision.updateMany({ where: { requestId: expired.requestId }, data: { expiresAt: new Date(Date.now() - 1000) } })
      const rows = await listPendingToolApprovals(fresh, { userId: u.admin })
      expect(rows.map((r) => r.requestId)).toEqual([live.requestId])
      expect(rows[0]).toMatchObject({ tool: TOOL, displayId: live.displayId, path: live.path })
      await expect(listPendingToolApprovals(fresh, { userId: u.member })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" })
      await expect(listPendingToolApprovals(fresh, { userId: u.outsider })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" })
    })
  })
})
