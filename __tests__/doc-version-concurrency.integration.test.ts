/**
 * PR #598 hypothesis regressions. PREPARED, NOT EXECUTED.
 * Real Prisma queries and PostgreSQL persistence; the only mock routes getPrisma
 * to the owned schema. The query extension delays delivery of a real latest-row
 * read, never manufactures its result. No shared/preview/production database.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "./helpers/integration-database"
import { withToolTransaction } from "@/lib/mcp-tool-db"

const holder = vi.hoisted(() => ({ client: null as unknown, schema: "" }))
vi.mock("@/lib/db", () => ({ default: () => holder.client }))
vi.mock("@/lib/schema", () => ({ getActiveSchema: () => holder.schema }))

import { pinDocVersion } from "@/lib/doc-versions"
import { createTrackedDecisionRequest, reviseTrackedDecisionRequest } from "@/lib/tracked-decisions"

// The second arrival releases both completed DB reads. A serialized repair may
// prevent that second read until the first commits: the deadline releases the
// first caller instead, so the test does not introduce a repair-only deadlock.
function latestReadBarrier(docId: string) {
  let arrivals = 0
  const priorSnapshots: ({ id: string; versionNumber: number | null } | null)[] = []
  let resolveReady!: () => void
  let evidence: { arrivalsAtRelease: number; releaseReason: "both-read" | "deadline" | "cleanup"; priorSnapshots: typeof priorSnapshots } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  const release = (releaseReason: "both-read" | "deadline" | "cleanup") => {
    if (evidence) return
    evidence = { arrivalsAtRelease: arrivals, releaseReason, priorSnapshots: [...priorSnapshots] }
    clearTimeout(timer)
    resolveReady()
  }
  return {
    get evidence() { return evidence },
    async wait(readDocId: unknown, snapshot: { id: string; versionNumber: number | null } | null) {
      if (readDocId !== docId || evidence) return
      arrivals++
      priorSnapshots.push(snapshot ? { id: snapshot.id, versionNumber: snapshot.versionNumber } : null)
      if (arrivals === 1) timer = setTimeout(() => release("deadline"), 750)
      else release("both-read")
      await ready
    },
    close() { release("cleanup") },
  }
}

// An unexpected rejection must not leave another request using holder.client
// after the barrier resets or while teardown drops the owned schema.
async function settleTogether<T>(operations: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations)
  const failure = outcomes.find((outcome) => outcome.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
  return outcomes.map((outcome) => {
    if (outcome.status !== "fulfilled") throw new Error("Unreachable rejected operation")
    return outcome.value
  })
}

// Each teardown operation must get its own attempt. Preserve failures by name
// and cause, then report them together only after restoring the environment.
async function cleanupOwnedDatabase(
  steps: ReadonlyArray<readonly [string, () => unknown | Promise<unknown>]>,
  previousUrl: string | undefined,
) {
  const failures: Error[] = []
  for (const [operation, run] of steps) {
    try { await run() }
    catch (cause) { failures.push(new Error(`Cleanup failed: ${operation}`, { cause })) }
  }
  try {
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  } catch (cause) {
    failures.push(new Error("Cleanup failed: restore DATABASE_URL", { cause }))
  }
  if (failures.length) throw new AggregateError(failures, "Owned database cleanup failed")
}

describe.skipIf(!integrationDatabaseUrl)("numbered doc pins and decision atomicity on real PostgreSQL", () => {
  const schema = `doc_pin_${randomUUID().replaceAll("-", "")}`
  const admin = new Pool({ connectionString: integrationDatabaseUrl, max: 2 })
  // Bound SQL lock waits as well as the application-side barrier. This pool is
  // used only by the owned test client; migration replay uses admin instead.
  const appPool = new Pool({ connectionString: integrationDatabaseUrl, max: 8, options: "-c statement_timeout=8000 -c lock_timeout=6000" })
  const orgId = randomUUID(), workspaceId = randomUUID()
  const previousUrl = process.env.DATABASE_URL
  let owned = false
  let base: PrismaClient | undefined
  const client = () => base!.$extends(injectUpdatedAtExtension)

  beforeAll(async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    await admin.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const replay = await replayAllMigrations(admin, schema)
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200)
    base = new PrismaClient({ adapter: new PrismaPg(appPool, { schema }) })
    holder.schema = schema
    holder.client = client()
    await admin.query(`INSERT INTO "${schema}".organizations (id,name,slug) VALUES ($1,'Pin QA','pin-qa')`, [orgId])
    await admin.query(`INSERT INTO "${schema}".workspaces (id,organization_id,name,slug) VALUES ($1,$2,'Pin QA','pin-qa')`, [workspaceId, orgId])
    // An actual SQL failure at the revision write, after the request and pin
    // paths have started. The constraint exists only in this throwaway schema.
    await admin.query(`ALTER TABLE "${schema}".review_revisions ADD CONSTRAINT qa_reject_revision CHECK (title <> 'QA reject revision')`)
  }, 180_000)

  afterAll(async () => {
    holder.client = null
    await cleanupOwnedDatabase([
      ["Prisma disconnect", () => base?.$disconnect()],
      ["owned schema drop", () => owned ? admin.query(`DROP SCHEMA "${schema}" CASCADE`) : undefined],
      ["application pool close", () => appPool.end()],
      ["admin pool close", () => admin.end()],
    ], previousUrl)
  })

  const newDoc = () => client().doc.create({ data: { workspaceId, title: "Synthetic pin doc", content: "first content" } })
  const numbered = (docId: string) => client().docVersion.findMany({ where: { docId, versionNumber: { not: null } }, orderBy: { versionNumber: "asc" } })
  const requestInput = (docId: string, idempotencyKey = randomUUID()) => ({ workspaceId, subjectType: "DOC" as const, subjectId: docId, question: "Review synthetic doc?", context: "Isolated QA fixture", idempotencyKey })
  const ref = (packetJson: string) => (JSON.parse(packetJson) as { entity: { docVersion: { id: string; number: number } } }).entity.docVersion

  async function withReadBarrier<T>(docId: string, run: () => Promise<T>) {
    const barrier = latestReadBarrier(docId)
    holder.client = client().$extends({
      name: "qa-delay-real-latest-read",
      query: { docVersion: { async findFirst({ args, query }) {
        const row = await query(args)
        // Query extensions may select a partial row. Check the real result at
        // runtime before using it as evidence; never cast away missing fields.
        if (row === null) {
          await barrier.wait(args.where?.docId, null)
        } else if (typeof row === "object" && "id" in row && "versionNumber" in row) {
          const id = row.id, versionNumber = row.versionNumber
          if (typeof id === "string" && (versionNumber === null || typeof versionNumber === "number")) {
            await barrier.wait(args.where?.docId, { id, versionNumber })
          } else {
            throw new Error("Latest-version query did not return id and nullable versionNumber")
          }
        } else {
          throw new Error("Latest-version query did not return id and nullable versionNumber")
        }
        return row
      } } },
    })
    try {
      const result = await run()
      if (process.env.DOC_PIN_REQUIRE_FORCED_RACE === "1") {
        expect(barrier.evidence, "Original-head reproduction requires both real latest reads before release").toMatchObject({ arrivalsAtRelease: 2, releaseReason: "both-read" })
        expect(barrier.evidence!.priorSnapshots).toHaveLength(2)
        expect(barrier.evidence!.priorSnapshots[0], "Both requests must have observed the same actual latest row").toEqual(barrier.evidence!.priorSnapshots[1])
      }
      return result
    }
    finally {
      barrier.close()
      holder.client = client()
      // Evidence freezes at release; a later second read cannot turn a deadline
      // release into a claimed forced interleaving.
      console.info(`[doc-pin-qa] barrier release: ${JSON.stringify(barrier.evidence)}`)
    }
  }

  it.each([false, true])("concurrent pins share one version when content is unchanged (prior pin: %s)", async (priorPin) => {
    const doc = await newDoc()
    if (priorPin) {
      await pinDocVersion(doc.id, { authorName: "Synthetic QA" })
      await client().doc.update({ where: { id: doc.id }, data: { content: "second content", updatedAt: new Date() } })
    }
    const before = await client().doc.findUniqueOrThrow({ where: { id: doc.id } })
    const results = await withReadBarrier(doc.id, () => settleTogether([
      pinDocVersion(doc.id, { authorName: "Synthetic A" }),
      pinDocVersion(doc.id, { authorName: "Synthetic B" }),
    ]))
    expect(results[0]).not.toBeNull()
    expect(results[1]).not.toBeNull()
    const rows = await numbered(doc.id)
    expect(rows.map((row) => row.versionNumber)).toEqual(priorPin ? [1, 2] : [1])
    expect(results[0]!.id).toBe(results[1]!.id)
    expect(results.map((result) => result!.created).sort()).toEqual([false, true])
    const after = await client().doc.findUniqueOrThrow({ where: { id: doc.id } })
    expect(after).toEqual(before)
  })

  it("two independent concurrent decision requests pin the same unchanged doc only once", async () => {
    const doc = await newDoc()
    const revisions = await withReadBarrier(doc.id, () => settleTogether([
      createTrackedDecisionRequest(requestInput(doc.id)),
      createTrackedDecisionRequest(requestInput(doc.id)),
    ]))
    expect(new Set(revisions.map((revision) => revision.requestId)).size).toBe(2)
    const rows = await numbered(doc.id)
    expect(rows).toHaveLength(1)
    for (const revision of revisions) expect(ref(revision.packetJson)).toEqual({ id: rows[0].id, number: rows[0].versionNumber })
    expect(rows[0]).toMatchObject({ title: doc.title, content: doc.content, metadata: doc.metadata, icon: doc.icon })
  })

  it("concurrent idempotent requests commit one request and one referenced version", async () => {
    const doc = await newDoc(), input = requestInput(doc.id)
    const revisions = await withReadBarrier(doc.id, () => settleTogether([
      createTrackedDecisionRequest(input), createTrackedDecisionRequest(input),
    ]))
    expect(revisions[0].id).toBe(revisions[1].id)
    expect(await client().reviewRequest.count({ where: { workspaceId, subjectId: input.idempotencyKey } })).toBe(1)
    const rows = await numbered(doc.id)
    expect(rows).toHaveLength(1)
    expect(ref(revisions[0].packetJson)).toEqual({ id: rows[0].id, number: 1 })
  })

  it("sequential unchanged pins reuse a row and request replay preserves its original version after an edit", async () => {
    const doc = await newDoc()
    const first = await pinDocVersion(doc.id, { authorName: "Synthetic QA" })
    expect(await pinDocVersion(doc.id, { authorName: "Synthetic QA" })).toEqual({ ...first, created: false })
    const input = requestInput(doc.id), revision = await createTrackedDecisionRequest(input)
    await client().doc.update({ where: { id: doc.id }, data: { content: "edited after request", updatedAt: new Date() } })
    const replay = await createTrackedDecisionRequest(input)
    expect(replay.id).toBe(revision.id)
    expect(ref(replay.packetJson)).toEqual(ref(revision.packetJson))
    expect(await numbered(doc.id)).toHaveLength(1)
    expect(await pinDocVersion(doc.id, { authorName: "Synthetic QA" })).toMatchObject({ versionNumber: 2, created: true })
  })

  it("rolls back a fresh pin when the request revision insert fails in PostgreSQL", async () => {
    const doc = await newDoc(), input = { ...requestInput(doc.id), question: "QA reject revision" }
    const history = await client().docVersion.create({ data: { docId: doc.id, title: "Earlier unnumbered snapshot", content: "historical content", label: "Synthetic preserved history" } })
    await expect(createTrackedDecisionRequest(input)).rejects.toThrow(/qa_reject_revision/)
    expect(await client().reviewRequest.count({ where: { workspaceId, subjectId: input.idempotencyKey } })).toBe(0)
    expect(await numbered(doc.id)).toHaveLength(0)
    expect(await client().docVersion.findMany({ where: { docId: doc.id } })).toEqual([history])
  })

  it("does not pin a version for a revision whose request does not exist", async () => {
    const doc = await newDoc()
    await expect(reviseTrackedDecisionRequest({ ...requestInput(doc.id), requestId: randomUUID(), expectedDecisionId: randomUUID(), reason: "Synthetic revision" })).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" })
    expect(await numbered(doc.id)).toHaveLength(0)
  })

  it("rolls back the pin and request with their enclosing MCP tool transaction", async () => {
    const doc = await newDoc(), input = requestInput(doc.id)
    await expect(client().$transaction(async (tx) => withToolTransaction(tx, async () => {
      await createTrackedDecisionRequest(input)
      throw new Error("Synthetic outer tool rollback")
    }))).rejects.toThrow("Synthetic outer tool rollback")
    expect(await numbered(doc.id)).toHaveLength(0)
    expect(await client().reviewRequest.count({ where: { workspaceId, subjectId: input.idempotencyKey } })).toBe(0)
  })

  it("preserves history when a revision conflicts with a pending request", async () => {
    const doc = await newDoc(), revision = await createTrackedDecisionRequest(requestInput(doc.id))
    const before = await numbered(doc.id)
    await client().doc.update({ where: { id: doc.id }, data: { content: "unreviewed edit", updatedAt: new Date() } })
    await expect(reviseTrackedDecisionRequest({ ...requestInput(doc.id), requestId: revision.requestId, expectedDecisionId: randomUUID(), reason: "Synthetic revision" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
    expect((await numbered(doc.id)).map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(await client().reviewRequest.findUnique({ where: { id: revision.requestId } })).toMatchObject({ currentRevisionId: revision.id, state: "PENDING", revisionCount: 1 })
  })

  it("rolls back a new pin and preserves the decided cycle when a revision insert fails", async () => {
    const doc = await newDoc(), revision = await createTrackedDecisionRequest(requestInput(doc.id))
    const option = await client().reviewOption.findFirstOrThrow({ where: { revisionId: revision.id, outcomeClass: "REQUEST_CHANGES" } })
    const decision = await client().decisionRecord.create({ data: {
      workspaceId, requestId: revision.requestId, revisionId: revision.id, optionId: option.id,
      fingerprint: revision.fingerprint, actorUserId: randomUUID(), actorRole: "ADMIN", idempotencyKey: randomUUID(),
    } })
    await client().reviewRequest.update({ where: { id: revision.requestId }, data: { state: "DECIDED", updatedAt: new Date() } })
    const before = await numbered(doc.id)
    await client().doc.update({ where: { id: doc.id }, data: { content: "revision content", updatedAt: new Date() } })
    await expect(reviseTrackedDecisionRequest({ ...requestInput(doc.id), requestId: revision.requestId, expectedDecisionId: decision.id, reason: "Synthetic revision", question: "QA reject revision" })).rejects.toThrow(/qa_reject_revision/)
    expect((await numbered(doc.id)).map((row) => row.id)).toEqual(before.map((row) => row.id))
    expect(await client().reviewRevision.count({ where: { requestId: revision.requestId } })).toBe(1)
    expect(await client().reviewRevision.findUnique({ where: { id: revision.id } })).toMatchObject({ supersededAt: null })
    expect(await client().reviewRequest.findUnique({ where: { id: revision.requestId } })).toMatchObject({ currentRevisionId: revision.id, state: "DECIDED", decisionCycle: 1, revisionCount: 1 })
  })
})
