import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { reconcilePersistedResearchVoiceCall } from "@/lib/research-voice-control-plane"
import { terminateResearchVoiceCall } from "@/lib/research-voice-termination"
import { provisionAllocatedResearchVoiceCall } from "@/lib/research-voice-provisioning"

const databaseUrl = process.env.RESEARCH_VOICE_TERMINATION_DATABASE_URL
const run = databaseUrl ? describe : describe.skip

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

run("voice termination on isolated real PostgreSQL", () => {
  const schema = `voice_cleanup_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 6 })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  let ownedSchemaCreated = false

  beforeAll(async () => {
    const target = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/compass_e2e") throw new Error("Voice termination integration requires local compass_e2e")
    await pool.query(`CREATE SCHEMA "${schema}"`)
    ownedSchemaCreated = true
    await pool.query(`CREATE TABLE "${schema}".research_sessions (id UUID PRIMARY KEY, voice_lease_id UUID, voice_lease_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL)`)
    const migration = readFileSync(new URL("../prisma/migrations/047_research_voice_control_plane/migration.sql", import.meta.url), "utf8")
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query(migration.match(/CREATE TABLE research_voice_calls[^;]+;/)![0])
      for (const ddl of migration.matchAll(/ALTER TABLE research_voice_calls[^;]+;/g)) await client.query(ddl[0])
      for (const ddl of migration.matchAll(/CREATE UNIQUE INDEX ASYNC idx_research_voice_calls[^;]+;/g)) await client.query(ddl[0].replace("INDEX ASYNC", "INDEX"))
    } finally { client.release() }
  })

  afterAll(async () => {
    try {
      if (ownedSchemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      try { await prisma.$disconnect() } finally { if (!pool.ended) await pool.end() }
    }
  })

  async function fixture(status = "ACTIVE") {
    const now = new Date()
    const id = randomUUID(); const sessionId = randomUUID()
    await pool.query(`INSERT INTO "${schema}".research_sessions VALUES ($1,$2,$3,$4)`, [sessionId, id, new Date(now.getTime() + 60_000), now])
    const call = await prisma.researchVoiceCall.create({ data: {
      id, sessionId, participantTokenId: randomUUID(), idempotencyKey: id,
      offerSha256: "a".repeat(64), workerTokenHash: randomUUID().replaceAll("-", "").repeat(2),
      attemptNumber: 1, status, leaseExpiresAt: new Date(now.getTime() - 1),
      statusChangedAt: now, updatedAt: now,
      providerCallId: status === "PROVISIONING" ? null : `provider-${id}`,
      sandboxName: status === "PROVISIONING" ? null : `sandbox-${id}`,
      sandboxCommandId: status === "PROVISIONING" ? null : `command-${id}`,
      nextProviderOrdinal: 3, lastProviderItemId: "finalized-item",
    } })
    const cleanup = {
      provider: { hangup: vi.fn(async () => {
        // A separate DB connection can see committed intent before external I/O.
        expect((await pool.query(`SELECT status FROM "${schema}".research_voice_calls WHERE id=$1`, [id])).rows[0].status).toBe("UNKNOWN")
        return { definite: true as const }
      }) },
      stopSandbox: vi.fn(async () => {}),
    }
    const input = { prisma, callId: id, voiceCallId: id, sessionId, cleanup, now }
    const read = () => prisma.researchVoiceCall.findUniqueOrThrow({ where: { id } })
    const lease = async () => (await pool.query(`SELECT voice_lease_id FROM "${schema}".research_sessions WHERE id=$1`, [sessionId])).rows[0].voice_lease_id
    return { call, cleanup, input, read, lease }
  }

  it("serializes two reconcilers and retains the old lease until one has both durable receipts", async () => {
    const { cleanup, input, read, lease } = await fixture()
    const entered = deferred<void>(); const finish = deferred<{ definite: true }>()
    cleanup.provider.hangup.mockImplementationOnce(async () => { entered.resolve(); return finish.promise })
    const first = reconcilePersistedResearchVoiceCall(input).then(() => null, (error: Error) => error)
    await entered.promise
    expect(await lease()).toBe(input.callId)
    await reconcilePersistedResearchVoiceCall(input)
    finish.resolve({ definite: true })
    expect(await first).toMatchObject({ code: "RECONCILIATION_RACE" })
    expect(await lease()).toBeNull()
    expect(await read()).toMatchObject({ status: "EXPIRED", providerStoppedAt: expect.any(Date), sandboxStoppedAt: expect.any(Date), nextProviderOrdinal: 3, lastProviderItemId: "finalized-item" })
    await reconcilePersistedResearchVoiceCall(input)
    expect(cleanup.provider.hangup).toHaveBeenCalledTimes(2)
    expect(cleanup.stopSandbox).toHaveBeenCalledOnce()
  })

  it("rolls back final status when session release fails, then retries without repeating stopped resources", async () => {
    const { input, cleanup, read, lease } = await fixture()
    const failing = prisma.$extends({ query: { researchSession: { updateMany() { throw new Error("release write failed") } } } })
    await expect(reconcilePersistedResearchVoiceCall({ ...input, prisma: failing as never })).rejects.toThrow("release write failed")
    expect(await read()).toMatchObject({ status: "UNKNOWN", providerStoppedAt: expect.any(Date), sandboxStoppedAt: expect.any(Date) })
    expect(await lease()).toBe(input.callId)
    await reconcilePersistedResearchVoiceCall(input)
    expect(await lease()).toBeNull()
    expect(cleanup.provider.hangup).toHaveBeenCalledOnce()
    expect(cleanup.stopSandbox).toHaveBeenCalledOnce()
  })

  it("preserves the lease after stop succeeds but its receipt write fails", async () => {
    const { input, cleanup, read, lease } = await fixture()
    const failing = prisma.$extends({ query: { researchVoiceCall: { updateMany({ args, query }) {
      if (args.data.providerStoppedAt instanceof Date) throw new Error("receipt lost")
      return query(args)
    } } } })
    await expect(reconcilePersistedResearchVoiceCall({ ...input, prisma: failing as never })).rejects.toThrow("receipt lost")
    expect(await read()).toMatchObject({ status: "UNKNOWN", providerStoppedAt: null })
    expect(await lease()).toBe(input.callId)
    await reconcilePersistedResearchVoiceCall(input)
    expect(cleanup.provider.hangup).toHaveBeenCalledTimes(2)
    expect(await lease()).toBeNull()
  })

  it.each(["heartbeat", "advanced worker"])("rejects stale cleanup after concurrent %s before any I/O", async (change) => {
    const { input, call, cleanup, lease } = await fixture()
    await prisma.researchVoiceCall.update({ where: { id: call.id }, data: change === "heartbeat" ?
      { lastHeartbeatAt: new Date(), updatedAt: new Date() } : { status: "WORKER_STARTING", updatedAt: new Date() } })
    await expect(terminateResearchVoiceCall({ ...input, expected: call })).rejects.toMatchObject({ code: "TERMINATION_RACE" })
    expect(cleanup.provider.hangup).not.toHaveBeenCalled()
    expect(cleanup.stopSandbox).not.toHaveBeenCalled()
    expect(await lease()).toBe(call.id)
  })

  it("never releases a concurrently replaced session lease", async () => {
    const { input, cleanup, lease } = await fixture()
    const newCall = randomUUID()
    cleanup.provider.hangup.mockImplementationOnce(async () => {
      await pool.query(`UPDATE "${schema}".research_sessions SET voice_lease_id=$1 WHERE id=$2`, [newCall, input.sessionId])
      return { definite: true }
    })
    await reconcilePersistedResearchVoiceCall(input)
    expect(await lease()).toBe(newCall)
  })

  it.each(["provider", "Sandbox"])("captures and cleans a late %s result after persisted reconciliation", async (stage) => {
    const { input, call, cleanup, read, lease } = await fixture("PROVISIONING")
    const entered = deferred<void>(); const finish = deferred<void>()
    const provider = { ...cleanup.provider, createCall: vi.fn(async () => {
      if (stage === "provider") { entered.resolve(); await finish.promise }
      return { providerCallId: `late-${call.id}`, answerSdp: "answer" }
    }) }
    const launcher = vi.fn(async () => {
      if (stage === "Sandbox") { entered.resolve(); await finish.promise }
      return { sandboxName: `sandbox-${call.id}`, sandboxCommandId: "late-command" }
    })
    const provisioning = provisionAllocatedResearchVoiceCall({
      prisma, provider, launcher, stopSandbox: cleanup.stopSandbox,
      allocation: { call, workerToken: "raw", replayed: false }, model: "gpt-realtime", offerSdp: "offer",
    }).then(() => null, (error: Error) => error)
    await entered.promise
    await reconcilePersistedResearchVoiceCall(input)
    expect(await lease()).toBe(call.id)
    expect((await read()).status).toBe("UNKNOWN")
    finish.resolve()
    expect(await provisioning).toMatchObject({ code: "PROVISIONING_RACE" })
    expect(await read()).toMatchObject({ providerCallId: `late-${call.id}`, providerStoppedAt: expect.any(Date), sandboxStoppedAt: expect.any(Date), answerSdp: null })
    expect(await lease()).toBeNull()
    if (stage === "provider") expect(launcher).not.toHaveBeenCalled()
  })
})
