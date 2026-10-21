#!/usr/bin/env node
/**
 * Local-dev only. Seeds the SAMPLE workspace used by the introductory demo video
 * (demo/demo.config.json): a fictional product team ("Ember" at "Northstar
 * Software") with an OKR cycle, a handful of open Opportunities, a Feedback
 * inbox, and the demo login user.
 *
 * Everything here is invented sample data. No customer or personal data.
 *
 * The seed deliberately stops short of the story the video tells: the new
 * Opportunity, its Key Result link, the Solution, the assumption, the Test and
 * the roadmap item are all created ON CAMERA through the real UI.
 *
 * Refuses to run unless DATABASE_URL is set to a non-production Postgres and
 * the workspace schema is `compass_dev` (see lib/schema.ts). It never touches
 * Aurora DSQL, preview or production. Idempotent: `--reset` removes the demo
 * org's data first so every take starts from the same state.
 *
 * Usage (after `prisma db push` against the dev schema):
 *   DATABASE_URL=postgres://…/compass_demo?schema=compass_dev \
 *     npx tsx scripts/seed-demo-intro.ts [--reset]
 */
import getPrisma from "../lib/db"
import { allocateOneSeq, allocateSeq, withSeq } from "../lib/work-item-sequence"

if (!process.env.DATABASE_URL) {
  console.error("refusing to run without DATABASE_URL (local dev only; never Aurora DSQL)")
  process.exit(1)
}
if (process.env.PGHOST || process.env.AWS_ROLE_ARN || process.env.VERCEL_ENV) {
  console.error("refusing to run: PGHOST / AWS_ROLE_ARN / VERCEL_ENV is set, this looks like a deployed environment")
  process.exit(1)
}
if (/amazonaws|dsql|vercel/i.test(process.env.DATABASE_URL)) {
  console.error("refusing to run against a hosted database")
  process.exit(1)
}

export const DEMO = {
  userEmail: "maya@northstar.test",
  userName: "Maya Chen",
  orgSlug: "northstar",
  orgName: "Northstar Software",
  workspaceSlug: "ember",
  workspaceName: "Ember",
} as const

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)

async function main() {
  const prisma = getPrisma()
  const reset = process.argv.includes("--reset")

  const org = await prisma.organization.findUnique({ where: { slug: DEMO.orgSlug } })
  if (org && reset) {
    const workspaces = await prisma.workspace.findMany({ where: { organizationId: org.id }, select: { id: true } })
    for (const { id: workspaceId } of workspaces) await wipeWorkspace(prisma, workspaceId)
    await prisma.workspace.deleteMany({ where: { organizationId: org.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }

  const user = await prisma.user.upsert({
    where: { email: DEMO.userEmail },
    update: { name: DEMO.userName },
    create: { email: DEMO.userEmail, name: DEMO.userName, emailVerified: new Date() },
  })
  const organization =
    (await prisma.organization.findUnique({ where: { slug: DEMO.orgSlug } })) ??
    (await prisma.organization.create({ data: { slug: DEMO.orgSlug, name: DEMO.orgName } }))
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: { role: "OWNER" },
    create: { organizationId: organization.id, userId: user.id, role: "OWNER" },
  })

  // Explicit selects keep this working on a schema that predates the newest Workspace columns.
  const select = { id: true } as const
  const existing = await prisma.workspace.findFirst({
    where: { organizationId: organization.id, slug: DEMO.workspaceSlug },
    select,
  })
  if (existing) {
    console.log(`workspace ${DEMO.orgSlug}/${DEMO.workspaceSlug} already seeded (use --reset to rebuild)`)
    await prisma.$disconnect()
    return
  }
  const workspace = await prisma.workspace.create({
    data: {
      organizationId: organization.id,
      slug: DEMO.workspaceSlug,
      name: DEMO.workspaceName,
      description: "Ember helps small teams plan and ship work together.",
      feedbackEnabled: true,
    },
    select,
  })
  const workspaceId = workspace.id
  // Single-user local seed: the counter is incremented outside a transaction, which is fine without concurrent writers.
  await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: "OWNER" } })

  // ── Outcomes and key results ──────────────────────────────────────────────
  const cycle = await prisma.oKRCycle.create({
    data: { workspaceId, title: "Q4 2026", startDate: day(-12), endDate: day(80), status: "ACTIVE" },
  })
  const onboarding = await prisma.objective.create({
    data: {
      ...(await allocateOneSeq(prisma, workspaceId, "objective")),
      workspaceId,
      cycleId: cycle.id,
      title: "Make Ember effortless for new teams",
      description: "New teams should reach their first win in their first week.",
      owner: DEMO.userName,
      status: "ON_TRACK",
      sortOrder: 1,
    },
  })
  const growth = await prisma.objective.create({
    data: {
      ...(await allocateOneSeq(prisma, workspaceId, "objective")),
      workspaceId,
      cycleId: cycle.id,
      title: "Grow paid team plans",
      description: "Turn happy small teams into paying customers.",
      owner: DEMO.userName,
      status: "AT_RISK",
      sortOrder: 2,
    },
  })
  const activation = await prisma.keyResult.create({
    data: { workspaceId, ...(await allocateOneSeq(prisma, workspaceId, "keyResult")), objectiveId: onboarding.id, title: "Week-1 activation rate", target: 55, current: 38, unit: "%", sortOrder: 1 },
  })
  await prisma.keyResult.create({
    data: { workspaceId, ...(await allocateOneSeq(prisma, workspaceId, "keyResult")), objectiveId: onboarding.id, title: "Median minutes to first project", target: 10, current: 26, unit: "min", sortOrder: 2 },
  })
  const upgrades = await prisma.keyResult.create({
    data: { workspaceId, ...(await allocateOneSeq(prisma, workspaceId, "keyResult")), objectiveId: growth.id, title: "Team plan upgrades per month", target: 120, current: 74, unit: "", sortOrder: 1 },
  })
  await prisma.checkIn.createMany({
    data: [
      { keyResultId: activation.id, value: 34, note: "Baseline at cycle start.", createdAt: day(-10) },
      { keyResultId: activation.id, value: 38, note: "Holding steady; onboarding is the bottleneck.", createdAt: day(-2) },
    ],
  })

  // ── Opportunities already in the backlog (context for the tree) ───────────
  const invite = await prisma.opportunity.create({
    data: {
      ...(await allocateOneSeq(prisma, workspaceId, "opportunity")),
      workspaceId,
      title: "Admins struggle to bring teammates on board",
      description: "Team admins say inviting colleagues takes too many steps.",
      status: "EXPLORING",
      linkedKeyResultId: upgrades.id,
      sortOrder: 1,
    },
  })
  const sharing = await prisma.opportunity.create({
    data: {
      ...(await allocateOneSeq(prisma, workspaceId, "opportunity")),
      workspaceId,
      title: "Reports are hard to share outside the team",
      description: "Managers export screenshots because there is no share link.",
      status: "EXPLORING",
      sortOrder: 2,
    },
  })
  const inviteSolution = await prisma.solution.create({
    data: { ...(await allocateOneSeq(prisma, workspaceId, "solution")), workspaceId, opportunityId: invite.id, title: "Invite by link", description: "One shareable invite link per workspace.", status: "IDEA", sortOrder: 1 },
  })
  await prisma.assumption.create({
    data: { workspaceId, ...(await allocateOneSeq(prisma, workspaceId, "assumption")), solutionId: inviteSolution.id, title: "Admins are comfortable sharing a link in chat", riskLevel: "LOW", status: "UNTESTED", sortOrder: 1 },
  })
  await prisma.solution.create({
    data: { ...(await allocateOneSeq(prisma, workspaceId, "solution")), workspaceId, opportunityId: sharing.id, title: "Public read-only report links", status: "IDEA", sortOrder: 1 },
  })

  // ── Feedback inbox: the signal that starts the story ──────────────────────
  const feedbackRows = [
      {
        workspaceId,
        title: "I signed up and had no idea what to do first",
        description:
          "Created our team space, then stared at an empty screen. I almost gave up before finding the Projects tab.",
        type: "IDEA",
        submitterName: "Priya N.",
        submitterEmail: "priya@example.test",
        voteCount: 14,
        createdAt: day(-3),
      },
      {
        workspaceId,
        title: "Setup feels like a maze for new teammates",
        description: "Three of my teammates joined and none of them knew where to start. A short checklist would help.",
        type: "IDEA",
        submitterName: "Tomas R.",
        submitterEmail: "tomas@example.test",
        voteCount: 9,
        createdAt: day(-2),
      },
      {
        workspaceId,
        title: "Dark mode flickers when switching tabs",
        description: "On my laptop the page flashes white for a moment.",
        type: "BUG",
        submitterName: "Jo W.",
        submitterEmail: "jo@example.test",
        voteCount: 3,
        createdAt: day(-5),
      },
      {
        workspaceId,
        title: "Let me export a project to CSV",
        description: "Our finance lead wants the task list in a spreadsheet.",
        type: "IDEA",
        submitterName: "Dana K.",
        submitterEmail: "dana@example.test",
        voteCount: 6,
        createdAt: day(-6),
      },
  ]
  await prisma.feedbackItem.createMany({ data: withSeq(await allocateSeq(prisma, workspaceId, "feedback", feedbackRows.length), feedbackRows) })

  console.log(`seeded ${DEMO.orgSlug}/${DEMO.workspaceSlug}; login as ${DEMO.userEmail} (dev credentials)`)
  await prisma.$disconnect()
}

type Prisma = ReturnType<typeof getPrisma>

/** Remove the rows that hang off a demo workspace, children first (relationMode=prisma has no cascades). */
async function wipeWorkspace(prisma: Prisma, workspaceId: string) {
  const byWorkspace = { where: { workspaceId } }
  const solutions = await prisma.solution.findMany({ ...byWorkspace, select: { id: true } })
  const solutionIds = solutions.map((s) => s.id)
  const assumptions = await prisma.assumption.findMany({ where: { solutionId: { in: solutionIds } }, select: { id: true } })
  const experiments = await prisma.experiment.findMany({ ...byWorkspace, select: { id: true } })
  const objectives = await prisma.objective.findMany({ ...byWorkspace, select: { id: true } })
  const keyResults = await prisma.keyResult.findMany({ where: { objectiveId: { in: objectives.map((o) => o.id) } }, select: { id: true } })
  await prisma.experimentResult.deleteMany({ where: { experimentId: { in: experiments.map((e) => e.id) } } })
  await prisma.evidence.deleteMany(byWorkspace)
  await prisma.roadmapItem.deleteMany(byWorkspace)
  await prisma.experiment.deleteMany(byWorkspace)
  await prisma.assumption.deleteMany({ where: { id: { in: assumptions.map((a) => a.id) } } })
  await prisma.solutionComment.deleteMany({ where: { solutionId: { in: solutionIds } } })
  await prisma.feedbackItem.deleteMany(byWorkspace)
  await prisma.solution.deleteMany(byWorkspace)
  await prisma.opportunity.deleteMany(byWorkspace)
  await prisma.checkIn.deleteMany({ where: { keyResultId: { in: keyResults.map((k) => k.id) } } })
  await prisma.keyResult.deleteMany({ where: { id: { in: keyResults.map((k) => k.id) } } })
  await prisma.objective.deleteMany(byWorkspace)
  await prisma.oKRCycle.deleteMany(byWorkspace)
  await prisma.workspaceMember.deleteMany(byWorkspace)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
