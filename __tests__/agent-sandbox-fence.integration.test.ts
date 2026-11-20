import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { createAgentRun, agentConversationSandboxName, reapIdleConversationSandboxes } from "@/lib/agent-runs"
import { dispatchPersistentSandboxLaunch, releasePersistentSandboxLaunch, reservePersistentSandboxLaunch } from "@/lib/agent-sandbox-fence"
import type { AppPrismaClient } from "@/lib/db"
import { applyMigrations } from "@/lib/migrations/runner"
import { AGENT_SANDBOX_OPERATIONS_MIGRATION } from "@/lib/migrations/agent-sandbox-operations"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"

const config = vi.hoisted(() => ({ schema: "" }))
vi.mock("@/lib/schema", async (original) => ({
  ...(await original<object>()),
  getActiveSchema: () => config.schema,
}))

const now = new Date("2026-11-20T12:00:00Z")
const idle = new Date(now.getTime() - 20 * 60_000)
const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("durable sandbox fence on PostgreSQL", () => {
  const schema = `agent_fence_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  const userId = randomUUID()
  const workspaceId = randomUUID()
  let prisma: AppPrismaClient
  let owned = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 180_000 })
    // Build the preceding schema using the current client, removing only the 130 additions.
    await pool.query(`DROP TABLE "${schema}".agent_sandbox_operations, "${schema}".agent_sandbox_generations`)
    await pool.query(`ALTER TABLE "${schema}".agent_conversations DROP COLUMN sandbox_coordination_token`)
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = databaseUrl
    try {
      const result = await applyMigrations(pool, schema, AGENT_SANDBOX_OPERATIONS_MIGRATION)
      expect(result.status, await result.text()).toBe(200)
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
    config.schema = schema
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension)
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await prisma?.$disconnect()
    await pool.end()
  })

  async function makeConversation() {
    const { id } = await prisma.agentConversation.create({
      data: { workspaceId, userId, title: "Sandbox fence", updatedAt: idle },
      select: { id: true },
    })
    return id
  }

  async function seedRun(conversationId: string, sandboxName: string, status = "SUCCEEDED", createdAt = idle) {
    const id = randomUUID()
    await prisma.agentRun.create({
      data: {
        id, conversationId, sandboxName, workspaceId, userId, status,
        workerTokenHash: id, deadlineAt: now, createdAt, finishedAt: createdAt,
      },
      select: { id: true },
    })
    return id
  }

  const launch = (conversationId: string, at = now) => createAgentRun({ prisma, conversationId, workspaceId, userId, now: at })
  const marker = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id }, select: { sandboxStoppedAt: true } })

  it("fences launch and a second sweeper across an actual provider call boundary", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const oldRun = await seedRun(conversationId, sandboxName)
    const dispatched = Promise.withResolvers<void>()
    const response = Promise.withResolvers<void>()
    const stopSandbox = vi.fn(async () => {
      dispatched.resolve()
      await response.promise
    })
    const cleanup = { stopSandbox }
    const sweep = reapIdleConversationSandboxes({ prisma, now, cleanup })
    try {
      await Promise.race([dispatched.promise, sweep.then(() => { throw new Error("stop did not dispatch") })])
      await expect(launch(conversationId)).rejects.toMatchObject({ code: "SANDBOX_OPERATION_IN_FLIGHT" })
      expect((await reapIdleConversationSandboxes({ prisma, now, cleanup })).stopped).toEqual([])
      expect(stopSandbox).toHaveBeenCalledTimes(1)
      expect(await marker(oldRun)).toEqual({ sandboxStoppedAt: null })
    } finally {
      response.resolve()
      await sweep
    }
    expect(await marker(oldRun)).toEqual({ sandboxStoppedAt: now })
    const next = await launch(conversationId)
    expect(await marker(next.run.id)).toEqual({ sandboxStoppedAt: null })
    const conversation = await prisma.agentConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { updatedAt: true } })
    expect(conversation.updatedAt).toEqual(idle)
  })

  it("pages eligible sandbox generations and backs off retries without blocking other sandboxes", async () => {
    const conv = await makeConversation()
    const other = await makeConversation()
    const shared = agentConversationSandboxName(conv)
    const developer = agentConversationSandboxName(conv, { developer: true })
    const unrelated = agentConversationSandboxName(other)
    const history = await Promise.all(Array.from({ length: 32 }, (_, i) =>
      seedRun(conv, shared, "SUCCEEDED", new Date(idle.getTime() - 10_000 + i))))
    const failed = await seedRun(conv, shared, "FAILED", new Date(idle.getTime() - 1000))
    const dev = await seedRun(conv, developer, "SUCCEEDED", new Date(idle.getTime() + 100))
    const separate = await seedRun(other, unrelated)
    let failLookup = true
    const stop = vi.fn(async () => {})
    const cleanup = { preparePersistentStop: vi.fn(async (name: string) => {
      if (name === shared && failLookup) throw new Error("lookup unavailable")
      return { sessionId: "session-fixture", stop }
    }) }
    expect(await reapIdleConversationSandboxes({ prisma, now, limit: 1, cleanup })).toMatchObject({
      examined: 1, failed: [{ sandboxName: shared, error: "lookup unavailable" }],
    })
    expect(await reapIdleConversationSandboxes({ prisma, now, limit: 1, cleanup })).toMatchObject({ stopped: [unrelated] })
    expect(await marker(separate)).toEqual({ sandboxStoppedAt: now })
    failLookup = false
    const later = new Date(now.getTime() + 60_001)
    expect(await reapIdleConversationSandboxes({ prisma, now: later, limit: 1, cleanup })).toMatchObject({ stopped: [shared] })
    expect(await reapIdleConversationSandboxes({ prisma, now: later, limit: 1, cleanup })).toMatchObject({ stopped: [developer] })
    expect(await marker(failed)).toEqual({ sandboxStoppedAt: later })
    expect(await marker(dev)).toEqual({ sandboxStoppedAt: later })
    expect(await marker(history[0])).toEqual({ sandboxStoppedAt: null })
  })

  it("keeps an ambiguous stop fenced past its retry time until the provider confirms quiescence", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const runId = await seedRun(conversationId, sandboxName)
    const stopSandbox = vi.fn(async () => { throw new Error("stop response lost") })
    const isPersistentSandboxQuiescent = vi.fn().mockResolvedValue(false)
    const cleanup = { stopSandbox, isPersistentSandboxQuiescent }
    expect(await reapIdleConversationSandboxes({ prisma, now, cleanup })).toMatchObject({
      failed: [{ sandboxName, error: "stop response lost" }],
    })
    const later = new Date(now.getTime() + 120_000)
    await expect(launch(conversationId, later)).rejects.toMatchObject({ code: "SANDBOX_OPERATION_IN_FLIGHT" })
    expect(await reapIdleConversationSandboxes({ prisma, now: later, cleanup })).toMatchObject({ stopped: [] })
    expect(await marker(runId)).toEqual({ sandboxStoppedAt: null })
    isPersistentSandboxQuiescent.mockResolvedValue(true)
    const confirmed = new Date(later.getTime() + 120_000)
    expect(await reapIdleConversationSandboxes({ prisma, now: confirmed, cleanup })).toMatchObject({ stopped: [sandboxName] })
    expect(stopSandbox).toHaveBeenCalledTimes(1)
    expect(await marker(runId)).toEqual({ sandboxStoppedAt: confirmed })
    await expect(launch(conversationId, confirmed)).resolves.toMatchObject({ run: { status: "QUEUED" } })
  })

  it("retries bookkeeping for the exact confirmed generation without sending a second stop", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const runId = await seedRun(conversationId, sandboxName)
    const stopSandbox = vi.fn(async () => {})
    const cleanup = { stopSandbox }
    await pool.query(`ALTER TABLE "${schema}".agent_runs ADD CONSTRAINT fixture_reject_receipt CHECK (sandbox_stopped_at IS NULL) NOT VALID`)
    try {
      expect((await reapIdleConversationSandboxes({ prisma, now, cleanup })).failed).toHaveLength(1)
      expect(await marker(runId)).toEqual({ sandboxStoppedAt: null })
      await expect(launch(conversationId)).rejects.toMatchObject({ code: "SANDBOX_OPERATION_IN_FLIGHT" })
    } finally {
      await pool.query(`ALTER TABLE "${schema}".agent_runs DROP CONSTRAINT fixture_reject_receipt`)
    }
    const later = new Date(now.getTime() + 60_001)
    expect((await reapIdleConversationSandboxes({ prisma, now: later, cleanup })).stopped).toEqual([sandboxName])
    expect(stopSandbox).toHaveBeenCalledTimes(1)
    expect(await marker(runId)).toEqual({ sandboxStoppedAt: later })
  })

  it("does not sweep a named sandbox while an in-flight launch owns it", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const oldRun = await seedRun(conversationId, sandboxName)
    const queued = await launch(conversationId)
    const token = await reservePersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName)
    expect(token).toBeTruthy()
    expect(await dispatchPersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName, token!)).toBe(true)
    const stopSandbox = vi.fn()
    expect(await reapIdleConversationSandboxes({ prisma, now, cleanup: { stopSandbox } })).toMatchObject({ stopped: [] })
    await releasePersistentSandboxLaunch(prisma, conversationId, token!)
    expect(stopSandbox).not.toHaveBeenCalled()
    expect(await marker(oldRun)).toEqual({ sandboxStoppedAt: null })
  })

  it("cancels stale pre-dispatch reservations and prevents their owners from launching later", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const queued = await launch(conversationId)
    const token = await reservePersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName, now)
    expect(token).toBeTruthy()
    const later = new Date(now.getTime() + 60_001)
    await reapIdleConversationSandboxes({ prisma, now: later, cleanup: { stopSandbox: vi.fn() } })
    expect(await dispatchPersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName, token!)).toBe(false)
    expect(await prisma.agentSandboxOperation.findUnique({ where: { conversationId } })).toBeNull()
  })

  it("stops the durably recorded generation even when its host clock precedes an older turn", async () => {
    const conversationId = await makeConversation()
    const sandboxName = agentConversationSandboxName(conversationId)
    const older = await seedRun(conversationId, sandboxName, "SUCCEEDED", idle)
    const queued = await launch(conversationId, new Date(idle.getTime() - 1000))
    const token = await reservePersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName, idle)
    expect(token).toBeTruthy()
    expect(await dispatchPersistentSandboxLaunch(prisma, conversationId, queued.run.id, sandboxName, token!)).toBe(true)
    await prisma.agentRun.update({ where: { id: queued.run.id }, data: { status: "SUCCEEDED", finishedAt: idle } })
    await releasePersistentSandboxLaunch(prisma, conversationId, token!)
    const stopSandbox = vi.fn(async () => {})
    expect((await reapIdleConversationSandboxes({ prisma, now, cleanup: { stopSandbox } })).stopped).toEqual([sandboxName])
    expect(await marker(queued.run.id)).toEqual({ sandboxStoppedAt: now })
    expect(await marker(older)).toEqual({ sandboxStoppedAt: null })
  })
})
