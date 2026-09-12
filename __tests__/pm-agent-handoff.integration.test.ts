import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"
import { runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { finishInterviewProcessing, withInterviewMutation } from "@/lib/pm-agent-service"
import { updateOpportunity } from "@/lib/opportunity-tool-handlers"

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))

const databaseUrl = process.env.PM_AGENT_HANDOFF_DATABASE_URL
describe.skipIf(!databaseUrl)("PM handoff atomicity on owned real PostgreSQL", () => {
  const schema = `pm_handoff_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires local compass_e2e without schema override")
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    url.searchParams.set("schema", schema)
    // Existing integration-suite convention: schema push is local/disposable
    // only, never a substitute for deployed registered-migration verification.
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 60_000 })
    } catch {
      throw new Error("Could not prepare owned local PM handoff test schema")
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension)
    connection.prisma = prisma
  }, 90_000)
  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    if (pool && !pool.ended) await pool.end()
  })

  async function fixture() {
    const workspaceId = randomUUID(), userId = randomUUID(), interviewId = randomUUID(), claimId = randomUUID()
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "ADMIN" } })
    const target = await prisma.opportunity.create({ data: { workspaceId, title: "Before", description: "Original", customerSegment: "Operators" } })
    const state = { status: "RUNNING", interviewId, claimId, deadline: Date.now() + 240_000, targetUrl: "/synthetic/discovery" }
    const conversation = await prisma.agentConversation.create({ data: { workspaceId, userId, interviewProcessingJson: JSON.stringify(state) } })
    await prisma.pMInterview.create({ data: { id: interviewId, workspaceId, initiatingUserId: userId, studyId: randomUUID(), sessionId: randomUUID(), targetType: "OPPORTUNITY", targetId: target.id, agentConversationId: conversation.id, contextSnapshotJson: "{}", fieldBaselineJson: "{}" } })
    const actor: McpActor = { purpose: "AGENT_TURN", userId, scopeWorkspaceId: workspaceId, scopeConversationId: conversation.id, scopeClaimId: claimId }
    const args = { opportunityId: target.id, title: "After", expectedUpdatedAt: target.updatedAt.toISOString(), expectedFieldsFingerprint: createHash("sha256").update(JSON.stringify([["title", target.title], ["description", target.description], ["customerSegment", target.customerSegment], ["status", target.status]])).digest("hex") }
    const readState = async () => JSON.parse((await prisma.agentConversation.findUniqueOrThrow({ where: { id: conversation.id } })).interviewProcessingJson!)
    const mutate = (input = args, handler = () => updateOpportunity(input)) => runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, handler))
    return { target, actor, args, state, conversation, mutate, readState }
  }

  it("commits the normal edit and its durable before/after receipt together", async () => {
    const f = await fixture()
    await f.mutate()
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).title).toBe("After")
    expect(await f.readState()).toMatchObject({ status: "SUCCEEDED", receipt: { changedFields: ["title"], before: { title: "Before" }, after: { title: "After" } } })
  })

  it("rolls back the real normal-handler target write when finalization throws", async () => {
    const f = await fixture()
    // Owned-schema constraint fails precisely on the production receipt write,
    // after the unchanged normal edit handler has updated the target.
    await pool.query(`ALTER TABLE "${schema}".agent_conversations ADD CONSTRAINT reject_test_receipt CHECK (id <> '${f.conversation.id}'::uuid OR interview_processing_json::jsonb->>'status' <> 'SUCCEEDED')`)
    let targetWritten = false
    try {
      await expect(f.mutate(f.args, async () => {
        const result = await updateOpportunity(f.args)
        targetWritten = result.structuredContent.ok
        return result
      })).rejects.toThrow()
    } finally {
      await pool.query(`ALTER TABLE "${schema}".agent_conversations DROP CONSTRAINT reject_test_receipt`)
    }
    expect(targetWritten).toBe(true)
    expect(await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).toMatchObject({ title: "Before", updatedAt: f.target.updatedAt })
    expect(await f.readState()).toEqual(f.state)
  })

  it("replays the same payload without invoking the handler twice and rejects a changed payload", async () => {
    const f = await fixture()
    const handler = vi.fn(() => updateOpportunity(f.args))
    await f.mutate(f.args, handler)
    const saved = await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })
    await f.mutate(f.args, handler)
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).updatedAt).toEqual(saved.updatedAt)
    await expect(f.mutate({ ...f.args, title: "Second edit" })).rejects.toThrow("already updated")
  })

  it.each(["claim", "deadline", "fingerprint", "owner"])("rejects a stale or mismatched %s before a write", async reason => {
    const f = await fixture()
    if (reason === "claim") f.actor.scopeClaimId = randomUUID()
    if (reason === "owner") f.actor.userId = randomUUID()
    if (reason === "fingerprint") f.args.expectedFieldsFingerprint = "stale"
    if (reason === "deadline") await prisma.agentConversation.update({ where: { id: f.conversation.id }, data: { interviewProcessingJson: JSON.stringify({ ...f.state, deadline: 1 }) } })
    await expect(f.mutate()).rejects.toThrow()
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).title).toBe("Before")
    expect((await f.readState()).receipt).toBeUndefined()
  })

  it.each([false, true])("rejects an external edit before normal-handler CAS (preserve timestamp: %s)", async preserveTimestamp => {
    const f = await fixture()
    await expect(f.mutate(f.args, async () => {
      await prisma.opportunity.update({ where: { id: f.target.id }, data: { title: "Concurrent human edit", updatedAt: preserveTimestamp ? f.target.updatedAt : new Date(f.target.updatedAt.getTime() + 1000) } })
      return updateOpportunity(f.args)
    })).rejects.toThrow()
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).title).toBe("Concurrent human edit")
    expect((await f.readState()).receipt).toBeUndefined()
  })

  it("does not convert normal-handler validation failure into a success receipt", async () => {
    const f = await fixture()
    const result = await f.mutate({ ...f.args, title: " " })
    expect(result.structuredContent.ok).toBe(false)
    expect((await f.readState()).receipt).toBeUndefined()
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: f.target.id } })).title).toBe("Before")
  })

  it("retains a committed success receipt when the runtime subsequently fails", async () => {
    const f = await fixture()
    await f.mutate()
    const saved = await f.readState()
    await finishInterviewProcessing(f.conversation.id, f.state.claimId, false)
    expect(await f.readState()).toEqual(saved)
  })
})
