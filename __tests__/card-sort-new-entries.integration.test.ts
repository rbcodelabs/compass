/**
 * Proposed new entries in a card sort round, asserted at the HTTP boundary.
 *
 * Same approach as card-sort-visibility.integration.test.ts: the real route
 * handlers run against a real PostgreSQL schema and only `auth()` is mocked.
 * What is being proved:
 *
 *   - a request is NOT an Opportunity until the facilitator accepts it;
 *   - while the round is OPEN, other participants' requests never appear in a
 *     participant's response (same blind-vote rule as move proposals);
 *   - only the round's creator can accept or reject;
 *   - the proposer's suggested bucket becomes an ordinary proposal and never an
 *     official CustomFieldValue.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"

const connection = vi.hoisted(() => ({
  prisma: null as AppPrismaClient | null,
  userId: null as string | null,
}))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))
vi.mock("@/auth", () => ({
  auth: async () =>
    connection.userId ? { user: { id: connection.userId, email: "x@localhost.dev" } } : null,
}))

const { GET, POST, PATCH, DELETE } = await import(
  "@/app/api/card-sort/rounds/[roundId]/new-entries/route"
)
const { PATCH: patchRound } = await import("@/app/api/card-sort/rounds/[roundId]/route")
const { POST: postRound } = await import("@/app/api/card-sort/rounds/route")

const ORG = "cardsort-new-org"
const WS = "cardsort-new-ws"
const BUCKETS = [
  { label: "Now", value: "now" },
  { label: "Later", value: "later" },
]

const databaseUrl = process.env.CARD_SORT_DATABASE_URL

describe.skipIf(!databaseUrl)("card sort: proposed new entries", () => {
  const schema = `card_sort_new_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false

  let workspaceId: string
  let facilitatorId: string
  let danaId: string
  let samId: string
  let oppFieldId: string
  let taskFieldId: string

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Requires an isolated local compass_e2e URL without a schema override")
    }
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    url.searchParams.set("schema", schema)
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], {
        stdio: "pipe",
        timeout: 90_000,
      })
    } catch {
      throw new Error("Could not prepare the owned local card sort new-entries schema")
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(
      injectUpdatedAtExtension
    )
    connection.prisma = prisma

    const org = await prisma.organization.create({ data: { slug: ORG, name: "New Entries Org" } })
    const workspace = await prisma.workspace.create({
      data: { organizationId: org.id, slug: WS, name: "New Entries Workspace" },
    })
    workspaceId = workspace.id
    const people = await Promise.all(
      [
        ["fran@localhost.dev", "Fran Facilitator"],
        ["dana@localhost.dev", "Dana Participant"],
        ["sam@localhost.dev", "Sam Participant"],
      ].map(([email, name]) => prisma.user.create({ data: { email, name } }))
    )
    ;[facilitatorId, danaId, samId] = people.map((p) => p.id)
    for (const userId of [facilitatorId, danaId, samId]) {
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, role: "MEMBER" },
      })
    }
    const oppField = await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "OPPORTUNITY",
        name: "Timing",
        fieldType: "SELECT",
        options: BUCKETS,
        order: 0,
      },
    })
    const taskField = await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "TASK",
        name: "Task timing",
        fieldType: "SELECT",
        options: BUCKETS,
        order: 1,
      },
    })
    oppFieldId = oppField.id
    taskFieldId = taskField.id
  }, 120_000)

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    if (pool && !pool.ended) await pool.end()
  })

  const qs = `orgSlug=${ORG}&workspaceSlug=${WS}`
  const as = (userId: string) => {
    connection.userId = userId
  }
  const entriesUrl = (roundId: string, extra = "") =>
    `http://localhost/api/card-sort/rounds/${roundId}/new-entries?${qs}${extra ? `&${extra}` : ""}`
  const params = (roundId: string) => ({ params: Promise.resolve({ roundId }) })
  const json = async (response: Response) => (await response.json()) as Record<string, unknown>

  async function createRound(name: string, fieldDefinitionId: string) {
    as(facilitatorId)
    const response = await postRound(
      new Request(`http://localhost/api/card-sort/rounds?${qs}`, {
        method: "POST",
        body: JSON.stringify({ name, fieldDefinitionId }),
      })
    )
    expect(response.status).toBe(200)
    return ((await json(response)).round as { id: string }).id
  }

  const propose = (
    userId: string,
    roundId: string,
    entry: { title: string; description?: string; suggestedValue?: string }
  ) => {
    as(userId)
    return POST(
      new Request(entriesUrl(roundId), { method: "POST", body: JSON.stringify(entry) }),
      params(roundId)
    )
  }
  const list = async (userId: string, roundId: string) => {
    as(userId)
    const response = await GET(new Request(entriesUrl(roundId)), params(roundId))
    expect(response.status).toBe(200)
    return (await json(response)).entries as { id: string; title: string; userId: string }[]
  }
  const resolve = (
    userId: string,
    roundId: string,
    entryId: string,
    action: "accept" | "reject",
    note?: string
  ) => {
    as(userId)
    return PATCH(
      new Request(entriesUrl(roundId), {
        method: "PATCH",
        body: JSON.stringify({ entryId, action, note }),
      }),
      params(roundId)
    )
  }
  const reveal = async (roundId: string) => {
    as(facilitatorId)
    const response = await patchRound(
      new Request(`http://localhost/api/card-sort/rounds/${roundId}?${qs}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      params(roundId)
    )
    expect(response.status).toBe(200)
  }
  const opportunityCount = (title: string) =>
    prisma.opportunity.count({ where: { workspaceId, title } })

  it("keeps a request pending: no Opportunity exists until it is accepted", async () => {
    const roundId = await createRound("Pending only", oppFieldId)
    const response = await propose(danaId, roundId, { title: "Pending idea" })
    expect(response.status).toBe(200)
    expect(await opportunityCount("Pending idea")).toBe(0)
    const stored = await prisma.cardSortNewEntry.findMany({ where: { roundId } })
    expect(stored).toHaveLength(1)
    expect(stored[0].status).toBe("PENDING")
  })

  it("is blind while OPEN: a participant sees only their own, the facilitator sees all", async () => {
    const roundId = await createRound("Blind entries", oppFieldId)
    await propose(samId, roundId, { title: "SAM_SECRET_TITLE", description: "SAM_SECRET_WHY" })
    await propose(danaId, roundId, { title: "Dana's idea" })

    const dana = await list(danaId, roundId)
    expect(dana.map((entry) => entry.title)).toEqual(["Dana's idea"])
    const raw = JSON.stringify(dana)
    for (const secret of [samId, "Sam Participant", "SAM_SECRET_TITLE", "SAM_SECRET_WHY"]) {
      expect(raw).not.toContain(secret)
    }

    expect((await list(samId, roundId)).map((entry) => entry.title)).toEqual(["SAM_SECRET_TITLE"])

    expect((await list(facilitatorId, roundId)).map((entry) => entry.title).sort()).toEqual([
      "Dana's idea",
      "SAM_SECRET_TITLE",
    ])

    await reveal(roundId)
    expect((await list(danaId, roundId)).map((entry) => entry.title).sort()).toEqual([
      "Dana's idea",
      "SAM_SECRET_TITLE",
    ])
  })

  it("is only available in OPPORTUNITY rounds", async () => {
    const roundId = await createRound("Task round", taskFieldId)
    const response = await propose(danaId, roundId, { title: "Nope" })
    expect(response.status).toBe(400)
    expect((await json(response)).code).toBe("INVALID_FACTOR")
    expect(await prisma.cardSortNewEntry.count({ where: { roundId } })).toBe(0)
  })

  it("refuses new requests once the round is revealed, and bad input", async () => {
    const roundId = await createRound("Validation", oppFieldId)
    expect((await propose(danaId, roundId, { title: "   " })).status).toBe(400)
    const badBucket = await propose(danaId, roundId, { title: "X", suggestedValue: "not_a_bucket" })
    expect(badBucket.status).toBe(400)
    expect((await json(badBucket)).code).toBe("INVALID_VALUE")

    await reveal(roundId)
    const late = await propose(danaId, roundId, { title: "Too late" })
    expect(late.status).toBe(409)
    expect((await json(late)).code).toBe("WRONG_STATE")
  })

  it("lets only the facilitator accept or reject", async () => {
    const roundId = await createRound("Authority", oppFieldId)
    const entryId = ((await json(await propose(danaId, roundId, { title: "Guarded idea" }))).id) as string

    for (const userId of [danaId, samId]) {
      const response = await resolve(userId, roundId, entryId, "accept")
      expect(response.status).toBe(403)
      expect((await json(response)).code).toBe("FORBIDDEN")
    }
    expect((await resolve(samId, roundId, entryId, "reject")).status).toBe(403)
    expect(await opportunityCount("Guarded idea")).toBe(0)
    expect((await prisma.cardSortNewEntry.findUnique({ where: { id: entryId } }))!.status).toBe("PENDING")
  })

  it("accept creates exactly one Opportunity and records the suggested bucket as an ordinary proposal", async () => {
    const roundId = await createRound("Accept", oppFieldId)
    const entryId = ((await json(
      await propose(danaId, roundId, {
        title: "Accepted idea",
        description: "Because customers ask",
        suggestedValue: "now",
      })
    )).id) as string

    const accepted = await resolve(facilitatorId, roundId, entryId, "accept")
    expect(accepted.status).toBe(200)
    const payload = await json(accepted)
    const opportunityId = payload.opportunityId as string
    expect(payload.suggestionRecorded).toBe(true)

    const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId } })
    expect(opportunity?.title).toBe("Accepted idea")
    expect(opportunity?.description).toBe("Because customers ask")
    expect(opportunity?.workspaceId).toBe(workspaceId)

    const entry = await prisma.cardSortNewEntry.findUnique({ where: { id: entryId } })
    expect(entry?.status).toBe("ACCEPTED")
    expect(entry?.acceptedObjectId).toBe(opportunityId)
    expect(entry?.resolvedById).toBe(facilitatorId)

    // The suggestion is Dana's ordinary vote on the new object...
    const vote = await prisma.cardSortProposal.findMany({ where: { roundId, objectId: opportunityId } })
    expect(vote).toHaveLength(1)
    expect(vote[0]).toMatchObject({ userId: danaId, proposedValue: "now", fromValue: null })
    // ...and never an official value: card sort does not write those.
    expect(await prisma.customFieldValue.count({ where: { objectId: opportunityId } })).toBe(0)

    // A second accept (double click / two tabs) must not create a second one.
    const again = await resolve(facilitatorId, roundId, entryId, "accept")
    expect(again.status).toBe(409)
    expect(await opportunityCount("Accepted idea")).toBe(1)
  })

  it("reject keeps the entry for the record and creates nothing", async () => {
    const roundId = await createRound("Reject", oppFieldId)
    const entryId = ((await json(await propose(samId, roundId, { title: "Rejected idea" }))).id) as string

    const response = await resolve(facilitatorId, roundId, entryId, "reject", "Out of scope")
    expect(response.status).toBe(200)
    expect(await opportunityCount("Rejected idea")).toBe(0)
    const entry = await prisma.cardSortNewEntry.findUnique({ where: { id: entryId } })
    expect(entry).toMatchObject({ status: "REJECTED", resolutionNote: "Out of scope" })

    // Resolved entries cannot be resolved again or withdrawn.
    expect((await resolve(facilitatorId, roundId, entryId, "accept")).status).toBe(409)
    as(samId)
    const withdraw = await DELETE(
      new Request(entriesUrl(roundId, `entryId=${entryId}`), { method: "DELETE" }),
      params(roundId)
    )
    expect(withdraw.status).toBe(404)
    expect(await prisma.cardSortNewEntry.count({ where: { id: entryId } })).toBe(1)
  })

  it("lets a proposer withdraw only their own pending entry", async () => {
    const roundId = await createRound("Withdraw", oppFieldId)
    const entryId = ((await json(await propose(danaId, roundId, { title: "Mine to withdraw" }))).id) as string

    as(samId)
    const others = await DELETE(
      new Request(entriesUrl(roundId, `entryId=${entryId}`), { method: "DELETE" }),
      params(roundId)
    )
    expect(others.status).toBe(404)
    expect(await prisma.cardSortNewEntry.count({ where: { id: entryId } })).toBe(1)

    as(danaId)
    const own = await DELETE(
      new Request(entriesUrl(roundId, `entryId=${entryId}`), { method: "DELETE" }),
      params(roundId)
    )
    expect(own.status).toBe(200)
    expect(await prisma.cardSortNewEntry.count({ where: { id: entryId } })).toBe(0)
  })
})
