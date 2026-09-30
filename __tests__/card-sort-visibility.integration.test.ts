/**
 * Hidden-until-revealed, asserted at the HTTP boundary.
 *
 * The requirement is that an authenticated user who hits the endpoint directly
 * cannot read anybody else's proposals while the round is OPEN. A test against
 * `assertCanSeeOtherProposals` would not establish that: it would prove the
 * predicate is correct while saying nothing about whether the route actually
 * calls it. So these tests import the real route handlers and invoke them with
 * a real Request against a real PostgreSQL schema, mocking only `auth()` to
 * choose who is knocking.
 *
 * The payload assertions are deliberately paranoid. Rather than only checking
 * the status code, each one serializes the whole response body and asserts the
 * other participant's user id, display name and proposed value appear nowhere
 * in it — so a future refactor that returns 403 alongside a partially built
 * payload, or that leaks proposer identities into an error message, fails here.
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

// Imported after the mocks so the route handlers pick them up.
const { GET: getTally } = await import("@/app/api/card-sort/rounds/[roundId]/tally/route")
const { GET: getBoard, PATCH: patchRound } = await import(
  "@/app/api/card-sort/rounds/[roundId]/route"
)
const { POST: postProposals, GET: getMyProposals, DELETE: deleteProposal } = await import(
  "@/app/api/card-sort/rounds/[roundId]/proposals/route"
)
const { GET: getFactors } = await import("@/app/api/card-sort/factors/route")
const { POST: postRound, GET: getRounds } = await import("@/app/api/card-sort/rounds/route")

const ORG = "cardsort-vis-org"
const WS = "cardsort-vis-ws"

const MOSCOW = [
  { label: "Must Do", value: "must_do_(contractually_obligated)" },
  { label: "Should Do", value: "should_do_(top_strategic_initiative)" },
  { label: "Could Do", value: "could_do_(nice_to_have)" },
  { label: "Uncategorized", value: "uncategorized" },
]
const VERTICALS = [
  { label: "Mortgages", value: "mortgages" },
  { label: "Credit Cards", value: "credit_cards" },
]
const QUARTERS = [
  { label: "Q1", value: "q1" },
  { label: "Q2", value: "q2" },
]

const databaseUrl = process.env.CARD_SORT_DATABASE_URL

describe.skipIf(!databaseUrl)("card sort visibility at the route boundary", () => {
  const schema = `card_sort_vis_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false

  let facilitatorId: string
  let danaId: string
  let samId: string
  let outsiderId: string
  let priorityFieldId: string
  let verticalFieldId: string
  let quarterFieldId: string
  let objects: { id: string; title: string }[] = []

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
    // Existing integration-suite convention: schema push is local and
    // disposable. The registered-migration path (index names, uniqueness,
    // nullability) is verified separately in
    // __tests__/card-sort-rounds-migration.integration.test.ts.
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], {
        stdio: "pipe",
        timeout: 90_000,
      })
    } catch {
      throw new Error("Could not prepare the owned local card sort visibility schema")
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(
      injectUpdatedAtExtension
    )
    connection.prisma = prisma

    const org = await prisma.organization.create({ data: { slug: ORG, name: "Vis Org" } })
    const workspace = await prisma.workspace.create({
      data: { organizationId: org.id, slug: WS, name: "Vis Workspace" },
    })

    const people = await Promise.all(
      [
        ["facilitator@localhost.dev", "Fran Facilitator"],
        ["dana@localhost.dev", "Dana Participant"],
        ["sam@localhost.dev", "Sam Participant"],
        ["outsider@localhost.dev", "Ollie Outsider"],
      ].map(([email, name]) => prisma.user.create({ data: { email, name } }))
    )
    ;[facilitatorId, danaId, samId, outsiderId] = people.map((p) => p.id)
    // The outsider is deliberately NOT a member: getWorkspace filters on
    // membership, so this proves the tenancy gate runs before the round gate.
    for (const userId of [facilitatorId, danaId, samId]) {
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, role: "MEMBER" },
      })
    }

    const moscowSet = await prisma.sharedFieldOptionSet.create({
      data: { workspaceId: workspace.id, name: "MoSCoW", options: MOSCOW },
    })
    const verticalSet = await prisma.sharedFieldOptionSet.create({
      data: { workspaceId: workspace.id, name: "Vertical", options: VERTICALS },
    })
    const priority = await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "OPPORTUNITY",
        name: "Priority",
        fieldType: "SELECT",
        sharedOptionSetId: moscowSet.id,
        order: 0,
      },
    })
    const vertical = await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "OPPORTUNITY",
        name: "Vertical",
        fieldType: "SELECT",
        sharedOptionSetId: verticalSet.id,
        order: 1,
      },
    })
    // No shared option set. This is the factor that catches any assumption
    // that shared-option-set inheritance is always in play.
    const quarter = await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "OPPORTUNITY",
        name: "Quarter",
        fieldType: "SELECT",
        options: QUARTERS,
        order: 2,
      },
    })
    // A TEXT field, which must never be offered as a factor.
    await prisma.customFieldDefinition.create({
      data: {
        workspaceId: workspace.id,
        objectType: "OPPORTUNITY",
        name: "Notes",
        fieldType: "TEXT",
        order: 3,
      },
    })
    priorityFieldId = priority.id
    verticalFieldId = vertical.id
    quarterFieldId = quarter.id

    objects = []
    for (const [index, title] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
      const opportunity = await prisma.opportunity.create({
        data: { workspaceId: workspace.id, title, sortOrder: index },
      })
      objects.push({ id: opportunity.id, title })
      await prisma.customFieldValue.create({
        data: {
          fieldId: priority.id,
          objectId: opportunity.id,
          value: MOSCOW[index % MOSCOW.length].value,
        },
      })
      await prisma.customFieldValue.create({
        data: {
          fieldId: vertical.id,
          objectId: opportunity.id,
          value: VERTICALS[index % VERTICALS.length].value,
        },
      })
      // Charlie deliberately has no Quarter, so a proposal on it exercises the
      // null fromValue path end to end.
      if (title !== "Charlie") {
        await prisma.customFieldValue.create({
          data: {
            fieldId: quarter.id,
            objectId: opportunity.id,
            value: QUARTERS[index % QUARTERS.length].value,
          },
        })
      }
    }
  }, 120_000)

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    if (pool && !pool.ended) await pool.end()
  })

  const qs = `orgSlug=${ORG}&workspaceSlug=${WS}`
  const as = (userId: string | null) => {
    connection.userId = userId
  }
  const url = (path: string, extra = "") =>
    `http://localhost/api/card-sort${path}?${qs}${extra ? `&${extra}` : ""}`
  const roundParams = (roundId: string) => ({ params: Promise.resolve({ roundId }) })

  async function body(response: Response) {
    return (await response.json()) as Record<string, unknown>
  }

  async function createRound(name: string, fieldDefinitionId: string) {
    as(facilitatorId)
    const response = await postRound(
      new Request(url("/rounds"), {
        method: "POST",
        body: JSON.stringify({ name, fieldDefinitionId }),
      })
    )
    expect(response.status).toBe(200)
    const payload = await body(response)
    return (payload.round as { id: string }).id
  }

  async function propose(
    userId: string,
    roundId: string,
    objectIds: string[],
    proposedValue: string,
    rationale?: string
  ) {
    as(userId)
    return postProposals(
      new Request(url(`/rounds/${roundId}/proposals`), {
        method: "POST",
        body: JSON.stringify({ objectIds, proposedValue, rationale }),
      }),
      roundParams(roundId)
    )
  }

  it("refuses the tally to a participant while the round is OPEN, with no payload", async () => {
    const roundId = await createRound("Blind round", priorityFieldId)
    // Sam records an opinion with a distinctive rationale so we can grep for it.
    expect(
      (await propose(samId, roundId, [objects[0].id], MOSCOW[2].value, "SAM_SECRET_RATIONALE"))
        .status
    ).toBe(200)

    as(danaId)
    const response = await getTally(new Request(url(`/rounds/${roundId}/tally`)), roundParams(roundId))
    expect(response.status).toBe(403)
    const payload = await body(response)
    expect(payload.code).toBe("HIDDEN_UNTIL_REVEALED")
    expect(payload.objects).toBeUndefined()

    const raw = JSON.stringify(payload)
    for (const secret of [samId, "Sam Participant", "SAM_SECRET_RATIONALE", MOSCOW[2].value]) {
      expect(raw).not.toContain(secret)
    }
  })

  it("hides the round-wide proposal count from a participant until the reveal", async () => {
    const roundId = await createRound("Count redaction", priorityFieldId)
    await propose(samId, roundId, [objects[0].id], MOSCOW[2].value)
    await propose(samId, roundId, [objects[1].id], MOSCOW[3].value)

    const countsFor = async (userId: string) => {
      as(userId)
      const listed = await body(await getRounds(new Request(url("/rounds"))))
      const round = (listed.rounds as { id: string; proposalCount: number | null; myProposalCount: number }[]).find(
        (candidate) => candidate.id === roundId
      )!
      const board = await body(await getBoard(new Request(url(`/rounds/${roundId}`)), roundParams(roundId)))
      return { round, boardCount: (board.round as { proposalCount: number | null }).proposalCount }
    }

    // Dana has proposed nothing and must not learn that two proposals exist —
    // knowing the pile is big (or that she is first) is exactly the anchoring
    // the blind round exists to prevent. Null, not 0: a false zero would be
    // indistinguishable from "nobody has proposed anything".
    const dana = await countsFor(danaId)
    expect(dana.round.proposalCount).toBeNull()
    expect(dana.boardCount).toBeNull()
    expect(dana.round.myProposalCount).toBe(0)

    // Sam still sees his own count, which is his own information.
    const sam = await countsFor(samId)
    expect(sam.round.proposalCount).toBeNull()
    expect(sam.round.myProposalCount).toBe(2)

    // The facilitator sees the real total while OPEN.
    const facilitator = await countsFor(facilitatorId)
    expect(facilitator.round.proposalCount).toBe(2)

    as(facilitatorId)
    await patchRound(
      new Request(url(`/rounds/${roundId}`), { method: "PATCH", body: JSON.stringify({ state: "REVEALED" }) }),
      roundParams(roundId)
    )

    const danaAfter = await countsFor(danaId)
    expect(danaAfter.round.proposalCount).toBe(2)
    expect(danaAfter.boardCount).toBe(2)
  })

  it("does not put another participant's proposals on the board during an OPEN round", async () => {
    const roundId = await createRound("Board isolation", priorityFieldId)
    await propose(samId, roundId, [objects[1].id], MOSCOW[0].value, "SAM_BOARD_RATIONALE")
    await propose(danaId, roundId, [objects[1].id], MOSCOW[3].value, "DANA_BOARD_RATIONALE")

    as(danaId)
    const response = await getBoard(new Request(url(`/rounds/${roundId}`)), roundParams(roundId))
    expect(response.status).toBe(200)
    const raw = JSON.stringify(await body(response))

    // Dana sees her own proposal inline...
    expect(raw).toContain("DANA_BOARD_RATIONALE")
    // ...and nothing whatsoever of Sam's.
    for (const secret of [samId, "Sam Participant", "SAM_BOARD_RATIONALE"]) {
      expect(raw).not.toContain(secret)
    }
  })

  it("lets the facilitator see the tally while OPEN, and everyone once REVEALED", async () => {
    const roundId = await createRound("Reveal flow", priorityFieldId)
    await propose(samId, roundId, [objects[0].id], MOSCOW[2].value)
    await propose(danaId, roundId, [objects[0].id], MOSCOW[3].value)

    as(facilitatorId)
    const facilitatorView = await getTally(
      new Request(url(`/rounds/${roundId}/tally`)),
      roundParams(roundId)
    )
    expect(facilitatorView.status).toBe(200)
    const facilitatorPayload = await body(facilitatorView)
    expect(facilitatorPayload.proposalCount).toBe(2)
    expect(facilitatorPayload.participantCount).toBe(2)

    // Dana still cannot.
    as(danaId)
    expect(
      (await getTally(new Request(url(`/rounds/${roundId}/tally`)), roundParams(roundId))).status
    ).toBe(403)

    // A participant cannot reveal it for herself, either.
    as(danaId)
    const stolenReveal = await patchRound(
      new Request(url(`/rounds/${roundId}`), {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      roundParams(roundId)
    )
    expect(stolenReveal.status).toBe(403)
    expect((await body(stolenReveal)).code).toBe("FORBIDDEN")

    as(facilitatorId)
    const revealed = await patchRound(
      new Request(url(`/rounds/${roundId}`), {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      roundParams(roundId)
    )
    expect(revealed.status).toBe(200)

    as(danaId)
    const afterReveal = await getTally(
      new Request(url(`/rounds/${roundId}/tally`)),
      roundParams(roundId)
    )
    expect(afterReveal.status).toBe(200)
    const payload = await body(afterReveal)
    const tallied = payload.objects as {
      objectId: string
      targets: { value: string; count: number; proposers: { name: string }[] }[]
    }[]
    expect(tallied).toHaveLength(1)
    expect(tallied[0].objectId).toBe(objects[0].id)
    expect(tallied[0].targets.map((t) => t.value).sort()).toEqual(
      [MOSCOW[2].value, MOSCOW[3].value].sort()
    )
  })

  it("rejects a non-member before it ever consults the round", async () => {
    const roundId = await createRound("Tenancy", priorityFieldId)
    as(outsiderId)
    const response = await getTally(
      new Request(url(`/rounds/${roundId}/tally`)),
      roundParams(roundId)
    )
    expect(response.status).toBe(404)
    expect((await body(response)).code).toBeUndefined()
  })

  it("rejects an unauthenticated caller on every card sort endpoint", async () => {
    const roundId = await createRound("Anon", priorityFieldId)
    as(null)
    for (const response of [
      await getTally(new Request(url(`/rounds/${roundId}/tally`)), roundParams(roundId)),
      await getBoard(new Request(url(`/rounds/${roundId}`)), roundParams(roundId)),
      await getMyProposals(new Request(url(`/rounds/${roundId}/proposals`)), roundParams(roundId)),
      await getRounds(new Request(url("/rounds"))),
      await getFactors(new Request(url("/factors"))),
    ]) {
      expect(response.status).toBe(401)
    }
  })

  it("derives fromValue server-side and refuses a no-op or an invalid target", async () => {
    const roundId = await createRound("Validation", priorityFieldId)
    const alpha = objects[0]
    const currentValue = MOSCOW[0].value

    // A target equal to the current official value is not an opinion.
    const noop = await propose(danaId, roundId, [alpha.id], currentValue)
    expect(noop.status).toBe(400)
    const noopBody = (await body(noop)) as { code: string; error: string }
    expect(noopBody.code).toBe("NO_OP")
    // The refusal has to be readable by the person who clicked the menu item.
    // It names the object and quotes the bucket's *label*: echoing the stored
    // slug (must_do_(contractually_obligated)) back at someone who just clicked
    // "Must Do (contractually obligated)" reads as a different bucket, and in a
    // bulk skip list an unnamed "That object" identifies nothing.
    expect(noopBody.error).toContain(alpha.title)
    expect(noopBody.error).toContain(`"${MOSCOW[0].label}"`)
    expect(noopBody.error).not.toContain(currentValue)

    // A value outside the factor's effective options is rejected...
    const bogus = await propose(danaId, roundId, [alpha.id], "definitely_not_an_option")
    expect(bogus.status).toBe(400)
    expect((await body(bogus)).code).toBe("INVALID_VALUE")

    // ...including one that is valid for a *different* factor.
    const wrongFactor = await propose(danaId, roundId, [alpha.id], "mortgages")
    expect(wrongFactor.status).toBe(400)

    expect((await propose(danaId, roundId, [alpha.id], MOSCOW[2].value)).status).toBe(200)
    const stored = await prisma.cardSortProposal.findFirstOrThrow({
      where: { roundId, userId: danaId, objectId: alpha.id },
    })
    // Never taken from the request body.
    expect(stored.fromValue).toBe(currentValue)
    expect(stored.proposedValue).toBe(MOSCOW[2].value)
  })

  it("keeps one row per person per object, latest wins", async () => {
    const roundId = await createRound("Latest wins", priorityFieldId)
    const alpha = objects[0]
    await propose(danaId, roundId, [alpha.id], MOSCOW[2].value, "first thought")
    await propose(danaId, roundId, [alpha.id], MOSCOW[3].value, "changed my mind")

    const rows = await prisma.cardSortProposal.findMany({ where: { roundId, userId: danaId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].proposedValue).toBe(MOSCOW[3].value)
    expect(rows[0].rationale).toBe("changed my mind")
  })

  it("withdraws only the caller's own proposal", async () => {
    const roundId = await createRound("Withdraw", priorityFieldId)
    const alpha = objects[0]
    await propose(danaId, roundId, [alpha.id], MOSCOW[2].value)
    await propose(samId, roundId, [alpha.id], MOSCOW[3].value)

    as(danaId)
    const deleted = await deleteProposal(
      new Request(url(`/rounds/${roundId}/proposals`, `objectId=${alpha.id}`), {
        method: "DELETE",
      }),
      roundParams(roundId)
    )
    expect(deleted.status).toBe(200)

    const remaining = await prisma.cardSortProposal.findMany({ where: { roundId } })
    expect(remaining).toHaveLength(1)
    expect(remaining[0].userId).toBe(samId)
  })

  it("applies a bulk proposal to every eligible row and skips the no-ops", async () => {
    const roundId = await createRound("Bulk", priorityFieldId)
    // Alpha is already MoSCoW[0]; the other three are not. Selecting all four
    // and proposing MoSCoW[0] is exactly what a real multi-select does.
    const response = await propose(
      danaId,
      roundId,
      objects.map((o) => o.id),
      MOSCOW[0].value
    )
    expect(response.status).toBe(200)
    const payload = (await body(response)) as {
      applied: string[]
      skipped: { objectId: string; code: string }[]
    }
    expect(payload.applied).toHaveLength(3)
    expect(payload.skipped).toEqual([{ objectId: objects[0].id, code: "NO_OP", reason: expect.any(String) }])
    expect(await prisma.cardSortProposal.count({ where: { roundId, userId: danaId } })).toBe(3)
  })

  it("offers only SELECT fields as factors", async () => {
    as(danaId)
    const response = await getFactors(new Request(url("/factors", "objectType=OPPORTUNITY")))
    expect(response.status).toBe(200)
    const { factors } = (await body(response)) as {
      factors: { id: string; name: string; sharedOptionSetName: string | null; options: unknown[] }[]
    }
    expect(factors.map((f) => f.name).sort()).toEqual(["Priority", "Quarter", "Vertical"])
    expect(factors.find((f) => f.name === "Notes")).toBeUndefined()
    expect(factors.find((f) => f.name === "Priority")!.sharedOptionSetName).toBe("MoSCoW")
    expect(factors.find((f) => f.name === "Quarter")!.sharedOptionSetName).toBeNull()
    expect(factors.find((f) => f.name === "Quarter")!.options).toHaveLength(QUARTERS.length)
  })

  /**
   * The generality requirement, exercised rather than asserted. The same
   * handlers run three times over three differently shaped factors — shared
   * option set, a second shared option set, and local options with no set —
   * with nothing factor-specific in the test body but the option values.
   */
  it.each([
    ["Priority (shared MoSCoW set)", () => priorityFieldId, MOSCOW],
    ["Vertical (a different shared set)", () => verticalFieldId, VERTICALS],
    ["Quarter (local options, no shared set)", () => quarterFieldId, QUARTERS],
  ])("runs a whole round end to end on %s", async (label, fieldId, options) => {
    const roundId = await createRound(`Generality: ${label}`, fieldId())

    as(danaId)
    const board = (await body(
      await getBoard(new Request(url(`/rounds/${roundId}`)), roundParams(roundId))
    )) as {
      factor: { name: string; options: { value: string }[] }
      rows: { objectId: string; currentValue: string | null }[]
    }
    expect(board.factor.options.map((o) => o.value)).toEqual(options.map((o) => o.value))
    expect(board.rows).toHaveLength(objects.length)

    // Move each object to the first option that is not already its value, so
    // the test never depends on which bucket anything starts in.
    let proposed = 0
    for (const row of board.rows) {
      const target = options.find((o) => o.value !== row.currentValue)!.value
      const response = await propose(danaId, roundId, [row.objectId], target)
      expect(response.status).toBe(200)
      proposed += 1
    }
    expect(proposed).toBe(objects.length)

    as(facilitatorId)
    await patchRound(
      new Request(url(`/rounds/${roundId}`), {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      roundParams(roundId)
    )
    const tally = (await body(
      await getTally(new Request(url(`/rounds/${roundId}/tally`)), roundParams(roundId))
    )) as {
      proposalCount: number
      objects: { targets: { count: number }[] }[]
      flow: { edges: { count: number }[]; buckets: { value: string }[]; fromUnsetCount: number }
    }
    expect(tally.proposalCount).toBe(objects.length)
    expect(tally.objects).toHaveLength(objects.length)
    // Every declared bucket appears in the flow view even at zero traffic.
    expect(tally.flow.buckets.map((b) => b.value)).toEqual(
      expect.arrayContaining(options.map((o) => o.value))
    )
    const edgeTotal = tally.flow.edges.reduce((sum, edge) => sum + edge.count, 0)
    expect(edgeTotal).toBe(objects.length)
  })

  it("stops accepting proposals once the round is REVEALED", async () => {
    const roundId = await createRound("Frozen", priorityFieldId)
    as(facilitatorId)
    await patchRound(
      new Request(url(`/rounds/${roundId}`), {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      roundParams(roundId)
    )
    const late = await propose(danaId, roundId, [objects[0].id], MOSCOW[2].value)
    expect(late.status).toBe(409)
    expect((await body(late)).code).toBe("WRONG_STATE")
  })

  it("records a proposal on an object with no current value", async () => {
    const roundId = await createRound("Unset source", quarterFieldId)
    const charlie = objects.find((o) => o.title === "Charlie")!
    expect((await propose(danaId, roundId, [charlie.id], QUARTERS[0].value)).status).toBe(200)
    const stored = await prisma.cardSortProposal.findFirstOrThrow({
      where: { roundId, objectId: charlie.id },
    })
    expect(stored.fromValue).toBeNull()

    as(facilitatorId)
    await patchRound(
      new Request(url(`/rounds/${roundId}`), {
        method: "PATCH",
        body: JSON.stringify({ state: "REVEALED" }),
      }),
      roundParams(roundId)
    )
    const tally = (await body(
      await getTally(new Request(url(`/rounds/${roundId}/tally`)), roundParams(roundId))
    )) as { flow: { fromUnsetCount: number } }
    expect(tally.flow.fromUnsetCount).toBe(1)
  })
})
