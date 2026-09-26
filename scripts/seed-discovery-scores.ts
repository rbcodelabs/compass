#!/usr/bin/env node
/**
 * Local-dev only. Seeds a scoring model, attaches it to a workspace, and scores
 * some (not all) of that workspace's opportunities — including one deliberately
 * stale score — so all four Discovery-board score states can be eyeballed:
 * scored / unscored / stale / no-active-model.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-discovery-scores.ts <workspaceSlug>
 *   node --env-file=.env.local scripts/seed-discovery-scores.ts <workspaceSlug> --detach
 *
 * --detach removes the workspace's active model (the "no active scoring model"
 * state) without deleting any score rows.
 */
import getPrisma from "../lib/db"

const slug = process.argv[2]
const detach = process.argv.includes("--detach")
if (!slug) {
  console.error("usage: seed-discovery-scores.ts <workspaceSlug> [--detach]")
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error("refusing to run without DATABASE_URL (local dev only)")
  process.exit(1)
}

async function main() {
  const prisma = getPrisma()

  const workspace = await prisma.workspace.findFirst({
    where: { slug },
    select: { id: true, name: true, organizationId: true },
  })
  if (!workspace) throw new Error(`no workspace with slug "${slug}"`)

  if (detach) {
    await prisma.workspaceScoringConfig.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id, opportunityScoringModelId: null },
      update: { opportunityScoringModelId: null },
    })
    console.log(`detached scoring model from ${workspace.name}`)
    process.exit(0)
  }

  // Version 2 so a score saved at modelVersion 1 reads as stale.
  const MODEL_NAME = "RICE (local seed)"
  let model = await prisma.scoringModel.findFirst({
    where: { organizationId: workspace.organizationId, name: MODEL_NAME },
  })
  if (!model) {
    model = await prisma.scoringModel.create({
      data: {
        organizationId: workspace.organizationId,
        name: MODEL_NAME,
        description: "Seeded for local visual verification of the board score badge.",
        formulaType: "WEIGHTED_SUM",
        version: 2,
      },
    })
    await prisma.scoringModelMetric.createMany({
      data: [
        { scoringModelId: model.id, key: "reach", label: "Reach", minValue: 0, maxValue: 10, weight: 2, direction: "POSITIVE", order: 0 },
        { scoringModelId: model.id, key: "impact", label: "Impact", minValue: 0, maxValue: 10, weight: 3, direction: "POSITIVE", order: 1 },
        { scoringModelId: model.id, key: "effort", label: "Effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE", order: 2 },
      ],
    })
  }

  await prisma.workspaceScoringConfig.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, opportunityScoringModelId: model.id },
    update: { opportunityScoringModelId: model.id },
  })

  const metrics = await prisma.scoringModelMetric.findMany({
    where: { scoringModelId: model.id },
    orderBy: { order: "asc" },
  })
  const snapshot = metrics.map((m) => ({
    key: m.key,
    label: m.label,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction,
  }))

  const opportunities = await prisma.opportunity.findMany({
    where: { workspaceId: workspace.id, status: { not: "ARCHIVED" } },
    orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
    select: { id: true, title: true, status: true },
  })

  // Deliberately uneven: score roughly two of every three, and make every third
  // scored one stale, so a single board shows all three card states at once.
  // Includes a deliberately non-integer normalizedScore to prove rounding.
  const rawScores = [11.971830985915492, 88.4, 51.5, 72.49, 0, 99.6, 34.2, 66.7]
  let scored = 0
  let stale = 0

  for (const [i, o] of opportunities.entries()) {
    if (i % 3 === 2) continue // leave every third unscored
    const normalizedScore = rawScores[scored % rawScores.length]
    const isStale = scored % 3 === 1
    await prisma.opportunityScore.upsert({
      where: { opportunityId: o.id },
      create: {
        opportunityId: o.id,
        scoringModelId: model.id,
        modelVersion: isStale ? 1 : model.version,
        formulaSnapshot: snapshot,
        rawValues: { reach: 5, impact: 5, effort: 2 },
        rawScore: normalizedScore / 2,
        normalizedScore,
      },
      update: {
        scoringModelId: model.id,
        modelVersion: isStale ? 1 : model.version,
        formulaSnapshot: snapshot,
        rawValues: { reach: 5, impact: 5, effort: 2 },
        rawScore: normalizedScore / 2,
        normalizedScore,
      },
    })
    console.log(
      `${isStale ? "STALE " : "fresh "} ${normalizedScore.toString().padEnd(20)} ${o.status.padEnd(12)} ${o.title}`
    )
    scored++
    if (isStale) stale++
  }

  console.log(
    `\nworkspace: ${workspace.name} (${slug})\nmodel: ${MODEL_NAME} v${model.version}\n` +
      `opportunities: ${opportunities.length}  scored: ${scored} (stale: ${stale})  unscored: ${opportunities.length - scored}`
  )
  process.exit(0)

}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
