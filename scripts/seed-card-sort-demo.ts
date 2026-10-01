#!/usr/bin/env node
/**
 * Local-dev only. Seeds a workspace that can exercise the card sort screen
 * against all three factor shapes the feature has to handle:
 *
 *   Priority  — SELECT backed by a SharedFieldOptionSet (the MoSCoW set)
 *   Vertical  — SELECT backed by a different SharedFieldOptionSet
 *   Quarter   — SELECT with LOCAL options and no shared set at all
 *
 * That third one is the point. If anything in the feature quietly assumes a
 * shared option set (or assumes MoSCoW's specific values), picking Quarter as
 * the factor breaks and the generality claim is false. Quarter also leaves some
 * opportunities deliberately unset, so the "proposal on an object with no
 * current value" path — the one from_value's nullability exists for — is
 * reachable by hand in the UI.
 *
 * Idempotent: re-running updates in place rather than duplicating.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-card-sort-demo.ts
 *
 * (tsx, not bare `node` — the repo's TS scripts use extensionless relative
 * imports, which Node's native TS loader rejects. See the `preview:*` scripts.)
 */
import getPrisma from "../lib/db"

if (!process.env.DATABASE_URL) {
  console.error("refusing to run without DATABASE_URL (local dev only)")
  process.exit(1)
}

const ORG_SLUG = "card-sort-demo"
const WORKSPACE_SLUG = "strategic-initiatives"

/** A MoSCoW-style option set, the first factor the feature was built for. */
const MOSCOW = [
  { label: "Must Do (contractually obligated)", value: "must_do_(contractually_obligated)" },
  { label: "Should Do (top strategic initiative)", value: "should_do_(top_strategic_initiative)" },
  { label: "Could Do (nice to have)", value: "could_do_(nice_to_have)" },
  { label: "Shouldn't Do", value: "shouldn't_do" },
  { label: "In Flight", value: "in_flight" },
  { label: "Q3 / Done / BAU", value: "q3_/_done_/_bau" },
  { label: "Uncategorized", value: "uncategorized" },
]

const VERTICALS = [
  { label: "Mortgages", value: "mortgages" },
  { label: "Credit Cards", value: "credit_cards" },
  { label: "Banking", value: "banking" },
  { label: "Insurance", value: "insurance" },
  { label: "Loans", value: "loans" },
  { label: "Investing", value: "investing" },
]

const QUARTERS = [
  { label: "Q1", value: "q1" },
  { label: "Q2", value: "q2" },
  { label: "Q3", value: "q3" },
  { label: "Q4", value: "q4" },
]

/**
 * Titles with a Priority bucket each, roughly mirroring the real spread
 * (Should > Could > Must > Uncategorized > Shouldn't > In Flight > Q3/BAU) so
 * the grouped board looks like the real thing rather than a uniform block.
 */
const OPPORTUNITIES: { title: string; priority: string; vertical?: string; quarter?: string }[] = [
  ["Rate table redesign", 0, "mortgages", "q1"],
  ["Lender compliance disclosures", 0, "mortgages", "q1"],
  ["CARD Act audit remediation", 0, "credit_cards", "q2"],
  ["Savings hub personalization", 1, "banking", "q1"],
  ["HELOC calculator overhaul", 1, "mortgages", "q2"],
  ["Insurance quote funnel rebuild", 1, "insurance", "q2"],
  ["Cross-vertical account linking", 1, "banking", undefined],
  ["Mortgage pre-approval wizard", 1, "mortgages", "q3"],
  ["Credit score simulator", 2, "credit_cards", "q3"],
  ["CD ladder builder", 2, "banking", "q4"],
  ["Auto loan refinance nudges", 2, "loans", undefined],
  ["Robo-advisor comparison grid", 2, "investing", "q4"],
  ["Student loan payoff planner", 2, "loans", "q4"],
  ["Legacy forum migration", 3, "banking", undefined],
  ["Fax-based lead intake", 3, undefined, undefined],
  ["Realtime rate alerts", 4, "mortgages", "q1"],
  ["Partner offer API v2", 4, "credit_cards", "q2"],
  ["Homepage hero carousel", 5, undefined, "q1"],
  ["Email preference centre", 5, "banking", "q3"],
  ["Unsorted discovery backlog item A", 6, undefined, undefined],
  ["Unsorted discovery backlog item B", 6, "investing", undefined],
  ["Unsorted discovery backlog item C", 6, undefined, "q4"],
].map(([title, priorityIndex, vertical, quarter]) => ({
  title: title as string,
  priority: MOSCOW[priorityIndex as number].value,
  vertical: vertical as string | undefined,
  quarter: quarter as string | undefined,
}))

const PEOPLE = [
  { email: "dev@localhost.dev", name: "Dev Facilitator", role: "OWNER" },
  { email: "dana@localhost.dev", name: "Dana Participant", role: "MEMBER" },
  { email: "sam@localhost.dev", name: "Sam Participant", role: "MEMBER" },
]

async function main() {
  const prisma = getPrisma()

  const org =
    (await prisma.organization.findUnique({ where: { slug: ORG_SLUG } })) ??
    (await prisma.organization.create({ data: { slug: ORG_SLUG, name: "Card sort demo (local)" } }))

  let workspace = await prisma.workspace.findFirst({
    where: { slug: WORKSPACE_SLUG, organizationId: org.id },
  })
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: { organizationId: org.id, slug: WORKSPACE_SLUG, name: "Strategic Initiatives" },
    })
  }

  for (const person of PEOPLE) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      create: { email: person.email, name: person.name, emailVerified: new Date() },
      update: { name: person.name },
    })
    const existing = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: user.id },
    })
    if (!existing) {
      await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: person.role },
      })
    }
  }

  // Two shared option sets, so the "inherited options" path is real rather than
  // theoretical, plus one field that deliberately has none.
  async function upsertSharedSet(name: string, options: unknown) {
    return prisma.sharedFieldOptionSet.upsert({
      where: { workspaceId_name: { workspaceId: workspace!.id, name } },
      create: { workspaceId: workspace!.id, name, options: options as never },
      update: { options: options as never },
    })
  }
  const moscowSet = await upsertSharedSet("MoSCoW", MOSCOW)
  const verticalSet = await upsertSharedSet("Vertical", VERTICALS)

  async function upsertField(
    name: string,
    order: number,
    config: { sharedOptionSetId?: string; options?: unknown }
  ) {
    const found = await prisma.customFieldDefinition.findFirst({
      where: { workspaceId: workspace!.id, objectType: "OPPORTUNITY", name },
    })
    const data = {
      workspaceId: workspace!.id,
      objectType: "OPPORTUNITY",
      name,
      fieldType: "SELECT",
      order,
      // A definition never holds both a local list and a shared set — see the
      // comment on CustomFieldDefinition.options in schema.prisma.
      options: (config.options ?? null) as never,
      sharedOptionSetId: config.sharedOptionSetId ?? null,
    }
    if (found) return prisma.customFieldDefinition.update({ where: { id: found.id }, data })
    return prisma.customFieldDefinition.create({ data })
  }

  const priority = await upsertField("Priority", 0, { sharedOptionSetId: moscowSet.id })
  const vertical = await upsertField("Vertical", 1, { sharedOptionSetId: verticalSet.id })
  const quarter = await upsertField("Quarter", 2, { options: QUARTERS })

  for (const [index, spec] of OPPORTUNITIES.entries()) {
    let opportunity = await prisma.opportunity.findFirst({
      where: { workspaceId: workspace.id, title: spec.title },
    })
    if (!opportunity) {
      opportunity = await prisma.opportunity.create({
        data: { workspaceId: workspace.id, title: spec.title, sortOrder: index },
      })
    }
    const assignments: [string, string | undefined][] = [
      [priority.id, spec.priority],
      [vertical.id, spec.vertical],
      [quarter.id, spec.quarter],
    ]
    for (const [fieldId, value] of assignments) {
      if (value === undefined) continue
      await prisma.customFieldValue.upsert({
        where: { fieldId_objectId: { fieldId, objectId: opportunity.id } },
        create: { fieldId, objectId: opportunity.id, value },
        update: { value },
      })
    }
  }

  const counts = await prisma.customFieldValue.groupBy({
    by: ["fieldId"],
    where: { fieldId: { in: [priority.id, vertical.id, quarter.id] } },
    _count: { _all: true },
  })
  const byField = new Map(counts.map((row) => [row.fieldId, row._count._all]))

  console.log(`org/workspace: /${ORG_SLUG}/${WORKSPACE_SLUG}`)
  console.log(`opportunities: ${OPPORTUNITIES.length}`)
  console.log(`  Priority (shared "MoSCoW", ${MOSCOW.length} options) values: ${byField.get(priority.id) ?? 0}`)
  console.log(`  Vertical (shared "Vertical", ${VERTICALS.length} options) values: ${byField.get(vertical.id) ?? 0}`)
  console.log(`  Quarter  (local options, ${QUARTERS.length} options)   values: ${byField.get(quarter.id) ?? 0}`)
  console.log(`users: ${PEOPLE.map((p) => p.email).join(", ")}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
