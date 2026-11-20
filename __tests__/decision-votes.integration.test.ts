import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { integrationDatabaseUrl } from "./helpers/integration-database"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { withConflictRetry } from "@/lib/transaction-conflict"

const db = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock("@/lib/db", () => ({ default: () => db.current }))
import { castDecisionVote, getDecisionTally, retractDecisionVote } from "@/lib/decision-votes"

describe.skipIf(!integrationDatabaseUrl)("decision votes on PostgreSQL", () => {
  const schema = "votes_" + randomUUID().replaceAll("-", "")
  let pool: Pool
  let prisma: PrismaClient

  beforeAll(async () => {
    pool = new Pool({ connectionString: integrationDatabaseUrl, max: 8 })
    const replay = await replayAllMigrations(pool, schema)
    if (replay.status !== 200) throw new Error(await replay.text())
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
    db.current = prisma
  }, 120_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    if (pool) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
      finally { await pool.end() }
    }
  })

  async function fixture() {
    const org = await prisma.organization.create({ data: { slug: randomUUID(), name: "Vote regression" } })
    const workspace = await prisma.workspace.create({ data: { organizationId: org.id, slug: "votes", name: "Votes" } })
    const request = await prisma.reviewRequest.create({ data: {
      workspaceId: workspace.id, gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: randomUUID(),
    } })
    async function revision(revisionNumber: number, question: string) {
      return prisma.reviewRevision.create({ data: {
        requestId: request.id, revisionNumber, fingerprint: randomUUID(), title: question,
        packetJson: JSON.stringify({ question, options: [{ label: "Yes" }, { label: "No" }] }),
      } })
    }
    const first = await revision(1, "Original question")
    await prisma.reviewRequest.update({ where: { id: request.id }, data: { state: "PENDING", currentRevisionId: first.id } })
    return { revision, input: { workspaceId: workspace.id, requestId: request.id, revisionId: first.id, questionIndex: 0, voterUserId: randomUUID() } }
  }

  it("keeps one row per voter when opposing casts overlap", async () => {
    const { input } = await fixture()
    const results = await Promise.allSettled(["Yes", "No", "Yes", "No"].map(option =>
      withConflictRetry(() => castDecisionVote({ ...input, option })),
    ))
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: "fulfilled", value: undefined })))
    const rows = await prisma.decisionVote.findMany({ where: { requestId: input.requestId } })
    expect(rows).toHaveLength(1)
    const tally = await getDecisionTally({ ...input, viewerUserId: input.voterUserId })
    expect(tally?.questions[0].myVote).toBe(rows[0].chosenOption)
    expect(tally?.questions[0].options.reduce((sum, option) => sum + option.count, 0)).toBe(1)
  })

  it("rejects delayed casts and retractions after a revision with the same labels replaces the old one", async () => {
    const { input, revision } = await fixture()
    await castDecisionVote({ ...input, option: "Yes" })
    const next = await revision(2, "Replacement question")
    await prisma.reviewRequest.update({
      where: { id: input.requestId }, data: { currentRevisionId: next.id },
    })
    await castDecisionVote({ ...input, revisionId: next.id, option: "No" })
    const outcomes = await Promise.allSettled([
      withConflictRetry(() => castDecisionVote({ ...input, option: "Yes" })),
      withConflictRetry(() => retractDecisionVote(input)),
    ])
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: { code: "STALE_REVISION" } })
    }
    const rows = await prisma.decisionVote.findMany({ where: { requestId: input.requestId } })
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: input.revisionId, chosenOption: "Yes" }),
      expect.objectContaining({ revisionId: next.id, chosenOption: "No" }),
    ]))
  })
  it("preserves vote history when a cast overlaps revision replacement", async () => {
    const { input, revision } = await fixture()
    await castDecisionVote({ ...input, option: "Yes" })
    const next = await revision(2, "Replacement question")
    let release!: () => void
    let read!: () => void
    const resume = new Promise<void>(resolve => { release = resolve })
    const didRead = new Promise<void>(resolve => { read = resolve })
    let held = false
    db.current = prisma.$extends({
      query: { reviewRequest: { async findFirst({ args, query }) {
        const result = await query(args)
        if (!held) {
          held = true
          read()
          await resume
        }
        return result
      } } },
    })
    const outcome = withConflictRetry(() => castDecisionVote({ ...input, option: "No" })).then(
      () => ({ code: "ACCEPTED" }),
      (error: unknown) => error,
    )
    try {
      await Promise.race([didRead, outcome.then(error => { throw error })])
      await prisma.reviewRequest.update({
        where: { id: input.requestId }, data: { currentRevisionId: next.id },
      })
    } finally {
      release()
      await outcome
      db.current = prisma
    }
    expect(await outcome).toMatchObject({ code: "STALE_REVISION" })
    expect(await prisma.decisionVote.findMany({ where: { requestId: input.requestId } })).toEqual([
      expect.objectContaining({ revisionId: input.revisionId, chosenOption: "Yes" }),
    ])
  })

})
