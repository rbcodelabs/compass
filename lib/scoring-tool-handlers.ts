/**
 * Handler functions for the 10 Scoring MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer,
 * following the same shape as lib/feedback-tool-handlers.ts.
 *
 * No extra role/membership gate beyond validateMcpAuth (API-key auth only) — matches
 * every other existing MCP tool. UI-path mutations (app/[orgSlug]/settings/actions.ts,
 * app/[orgSlug]/[workspaceSlug]/settings/actions.ts) enforce org/workspace admin roles
 * via lib/permissions.ts; the MCP path intentionally does not.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { getMcpActor } from "@/lib/mcp-authz"
import { agentWorkspaceWhere } from "@/lib/agent-access"
import { Prisma } from "@prisma/client"
import { computeScore, validateMetricsForFormula, type ScoringMetricDef } from "@/lib/scoring"
import { isScoreStale } from "@/lib/scoring-model"
import type { ScoringFormulaType, MetricDirection, FormulaSnapshotMetric } from "@/lib/types"

interface MetricInput {
  key: string
  label: string
  description?: string
  minValue: number
  maxValue: number
  weight: number
  direction: MetricDirection
}

function formatMetricSummary(m: {
  key: string
  label: string
  minValue: number
  maxValue: number
  weight: number
  direction: string
}) {
  return `${m.label} (${m.key}) [${m.direction}] range ${m.minValue}-${m.maxValue}, weight ${m.weight}`
}

// ─── list_scoring_models ────────────────────────────────────────────────────

export async function listScoringModels({ orgSlug }: { orgSlug: string }) {
  const prisma = getPrisma()
  const actor = getMcpActor()
  const agentConfigs = actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN"
    ? await prisma.workspaceScoringConfig.findMany({ where: { workspace: await agentWorkspaceWhere(actor) }, select: { scoringModelId: true } }) : null
  const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
  if (!org) {
    return fail(`Organization "${orgSlug}" not found.`)
  }

  const models = await prisma.scoringModel.findMany({
    where: { organizationId: org.id, ...(agentConfigs ? { id: { in: agentConfigs.flatMap(c => c.scoringModelId ? [c.scoringModelId] : []) } } : {}) },
    include: { metrics: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "asc" },
  })

  if (!models.length) {
    return fail("No scoring models in this organization.")
  }

  const lines = models.map((m) =>
    `• **${m.name}** [${m.status}] v${m.version} (${m.formulaType}) — ${m.metrics.length} metric(s)\n` +
      `  ID: ${m.id}` +
      (m.description ? `\n  ${m.description}` : "")
  )
  const items = models.map((m) => ({
    id: m.id,
    name: m.name,
    status: m.status,
    version: m.version,
    formulaType: m.formulaType,
    description: m.description,
    metrics: m.metrics,
  }))
  return ok(lines.join("\n\n"), { items, count: items.length })
}

// ─── get_scoring_model ───────────────────────────────────────────────────────

export async function getScoringModel({ scoringModelId }: { scoringModelId: string }) {
  const prisma = getPrisma()
  const model = await prisma.scoringModel.findUnique({
    where: { id: scoringModelId },
    include: { metrics: { orderBy: { order: "asc" } } },
  })
  if (!model) {
    return fail(`Scoring model "${scoringModelId}" not found.`)
  }

  const lines = [
    `## ${model.name}`,
    `ID: ${model.id}`,
    `Status: ${model.status}`,
    `Formula: ${model.formulaType}`,
    `Version: ${model.version}`,
    model.description ? `Description: ${model.description}` : null,
    "",
    "Metrics:",
    ...model.metrics.map((m) => `• ${formatMetricSummary(m)}`),
  ].filter((line): line is string => line !== null)

  return ok(lines.join("\n"), {
    id: model.id,
    name: model.name,
    status: model.status,
    formulaType: model.formulaType,
    version: model.version,
    description: model.description,
    metrics: model.metrics,
  })
}

// ─── create_scoring_model ────────────────────────────────────────────────────

export async function createScoringModel({
  orgSlug,
  name,
  description,
  formulaType,
  metrics,
}: {
  orgSlug: string
  name: string
  description?: string
  formulaType: ScoringFormulaType
  metrics: MetricInput[]
}) {
  const prisma = getPrisma()
  const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } })
  if (!org) {
    return fail(`Organization "${orgSlug}" not found.`)
  }

  const metricDefs: ScoringMetricDef[] = metrics.map((m) => ({
    key: m.key,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction,
  }))
  try {
    validateMetricsForFormula(metricDefs, formulaType)
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Invalid metrics")
  }

  const model = await prisma.scoringModel.create({
    data: { organizationId: org.id, name, description, formulaType },
  })

  if (metrics.length > 0) {
    await prisma.scoringModelMetric.createMany({
      data: metrics.map((m, i) => ({
        scoringModelId: model.id,
        key: m.key,
        label: m.label,
        description: m.description,
        minValue: m.minValue,
        maxValue: m.maxValue,
        weight: m.weight,
        direction: m.direction,
        order: i,
      })),
    })
  }

  return ok(
    `**Scoring model created:** ${name}\n` +
      `Formula: ${formulaType}\n` +
      `Metrics: ${metrics.length}\n` +
      `ID: ${model.id}`,
    { id: model.id, name: model.name, formulaType: model.formulaType, version: model.version, metrics },
  )
}

// ─── update_scoring_model ────────────────────────────────────────────────────

export async function updateScoringModel({
  scoringModelId,
  name,
  description,
  formulaType,
  metrics,
}: {
  scoringModelId: string
  name?: string
  description?: string
  formulaType?: ScoringFormulaType
  metrics?: MetricInput[]
}) {
  const prisma = getPrisma()
  const existing = await prisma.scoringModel.findUnique({ where: { id: scoringModelId } })
  if (!existing) {
    return fail(`Scoring model "${scoringModelId}" not found.`)
  }

  const data: Prisma.ScoringModelUpdateInput = {}
  if (name !== undefined) data.name = name
  if (description !== undefined) data.description = description

  // Only metric/formula-shape edits bump version — matches the versioning
  // decision in updateScoringModelDetails/updateScoringModelMetrics
  // (app/[orgSlug]/settings/actions.ts).
  let versionBumped = false
  if (metrics !== undefined) {
    const effectiveFormulaType = formulaType ?? (existing.formulaType as ScoringFormulaType)
    const metricDefs: ScoringMetricDef[] = metrics.map((m) => ({
      key: m.key,
      minValue: m.minValue,
      maxValue: m.maxValue,
      weight: m.weight,
      direction: m.direction,
    }))
    try {
      validateMetricsForFormula(metricDefs, effectiveFormulaType)
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Invalid metrics")
    }

    await prisma.scoringModelMetric.deleteMany({ where: { scoringModelId } })
    await prisma.scoringModelMetric.createMany({
      data: metrics.map((m, i) => ({
        scoringModelId,
        key: m.key,
        label: m.label,
        description: m.description,
        minValue: m.minValue,
        maxValue: m.maxValue,
        weight: m.weight,
        direction: m.direction,
        order: i,
      })),
    })
    data.formulaType = effectiveFormulaType
    data.version = existing.version + 1
    versionBumped = true
  }

  data.updatedAt = new Date()
  await prisma.scoringModel.update({ where: { id: scoringModelId }, data })

  return ok(
    `**Scoring model updated**\n` +
      (versionBumped ? `Version bumped to ${existing.version + 1}\n` : "") +
      `ID: ${scoringModelId}`,
    {
      id: scoringModelId,
      name: name ?? existing.name,
      formulaType: data.formulaType ?? existing.formulaType,
      version: versionBumped ? existing.version + 1 : existing.version,
      metrics: metrics ?? null,
    },
  )
}

// ─── archive_scoring_model ────────────────────────────────────────────────────

export async function archiveScoringModel({ scoringModelId }: { scoringModelId: string }) {
  const prisma = getPrisma()
  const existing = await prisma.scoringModel.findUnique({
    where: { id: scoringModelId },
    select: { id: true, name: true },
  })
  if (!existing) {
    return fail(`Scoring model "${scoringModelId}" not found.`)
  }

  await prisma.scoringModel.update({
    where: { id: scoringModelId },
    data: { status: "ARCHIVED", updatedAt: new Date() },
  })

  return ok(`**Scoring model archived:** ${existing.name}\nID: ${scoringModelId}`, {
    id: existing.id,
    name: existing.name,
    status: "ARCHIVED",
  })
}

// ─── get_workspace_scoring_model ────────────────────────────────────────────

export async function getWorkspaceScoringModel({ workspaceId }: { workspaceId: string }) {
  const prisma = getPrisma()
  const config = await prisma.workspaceScoringConfig.findUnique({
    where: { workspaceId },
    include: { scoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  })

  if (!config?.scoringModel) {
    return fail("This workspace has no active scoring model.")
  }

  const model = config.scoringModel
  const lines = [
    `**Active scoring model:** ${model.name}`,
    `Formula: ${model.formulaType}`,
    `Version: ${model.version}`,
    "Metrics:",
    ...model.metrics.map((m) => `• ${formatMetricSummary(m)}`),
    `ID: ${model.id}`,
  ]
  return ok(lines.join("\n"), {
    id: model.id,
    name: model.name,
    formulaType: model.formulaType,
    version: model.version,
    metrics: model.metrics,
  })
}

// ─── set_workspace_scoring_model ────────────────────────────────────────────

export async function setWorkspaceScoringModel({
  workspaceId,
  scoringModelId,
}: {
  workspaceId: string
  scoringModelId: string | null
}) {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (!workspace) {
    return fail(`Workspace "${workspaceId}" not found.`)
  }

  if (scoringModelId) {
    const model = await prisma.scoringModel.findUnique({
      where: { id: scoringModelId },
      select: { id: true },
    })
    if (!model) {
      return fail(`Scoring model "${scoringModelId}" not found.`)
    }
  }

  await prisma.workspaceScoringConfig.upsert({
    where: { workspaceId },
    create: { workspaceId, scoringModelId },
    update: { scoringModelId, updatedAt: new Date() },
  })

  return ok(
    scoringModelId
      ? `**Active scoring model set.**\nWorkspace ID: ${workspaceId}\nScoring Model ID: ${scoringModelId}`
      : `**Active scoring model cleared.**\nWorkspace ID: ${workspaceId}`,
    { workspaceId, scoringModelId },
  )
}

// ─── score_opportunity ───────────────────────────────────────────────────────

export async function scoreOpportunity({
  opportunityId,
  rawValues,
}: {
  opportunityId: string
  rawValues: Record<string, number>
}) {
  const prisma = getPrisma()
  const opportunity = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: { id: true, title: true, workspaceId: true },
  })
  if (!opportunity) {
    return fail(`Opportunity "${opportunityId}" not found.`)
  }

  const config = await prisma.workspaceScoringConfig.findUnique({
    where: { workspaceId: opportunity.workspaceId },
    include: { scoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  })
  if (!config?.scoringModel) {
    return fail(`The workspace for opportunity "${opportunityId}" has no active scoring model.`)
  }

  const model = config.scoringModel
  const formulaType = model.formulaType as ScoringFormulaType
  const metricDefs: ScoringMetricDef[] = model.metrics.map((m) => ({
    key: m.key,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }))

  for (const metric of metricDefs) {
    const value = rawValues[metric.key]
    if (typeof value !== "number" || Number.isNaN(value)) {
      return fail(`Missing value for metric "${metric.key}".`)
    }
    if (value < metric.minValue || value > metric.maxValue) {
      return fail(`Value for "${metric.key}" must be between ${metric.minValue} and ${metric.maxValue}.`)
    }
  }

  const { rawScore, normalizedScore } = computeScore(metricDefs, rawValues, formulaType)
  const formulaSnapshot: FormulaSnapshotMetric[] = model.metrics.map((m) => ({
    key: m.key,
    label: m.label,
    minValue: m.minValue,
    maxValue: m.maxValue,
    weight: m.weight,
    direction: m.direction as MetricDirection,
  }))

  const score = await prisma.opportunityScore.upsert({
    where: { opportunityId },
    create: {
      opportunityId,
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
    },
    update: {
      scoringModelId: model.id,
      modelVersion: model.version,
      formulaSnapshot: formulaSnapshot as unknown as Prisma.InputJsonValue,
      rawValues: rawValues as unknown as Prisma.InputJsonValue,
      rawScore,
      normalizedScore,
      scoredAt: new Date(),
      updatedAt: new Date(),
    },
  })

  return ok(
    `**Scored** "${opportunity.title}"\n` +
      `Raw score: ${rawScore.toFixed(2)}\n` +
      `Normalized score: ${normalizedScore.toFixed(1)} / 100\n` +
      `ID: ${score.id}`,
    {
      id: score.id,
      opportunityId,
      scoringModelId: model.id,
      modelVersion: model.version,
      rawScore,
      normalizedScore,
    },
  )
}

// ─── get_opportunity_score ───────────────────────────────────────────────────

export async function getOpportunityScore({ opportunityId }: { opportunityId: string }) {
  const prisma = getPrisma()
  const score = await prisma.opportunityScore.findUnique({
    where: { opportunityId },
    include: { scoringModel: { select: { name: true, version: true } } },
  })
  if (!score) {
    return fail(`No score found for opportunity "${opportunityId}".`)
  }

  const stale = isScoreStale(score.modelVersion, score.scoringModel.version)
  const lines = [
    `**Score for opportunity ${opportunityId}**`,
    `Model: ${score.scoringModel.name} (scored at v${score.modelVersion}, live v${score.scoringModel.version})`,
    `Raw score: ${score.rawScore}`,
    `Normalized score: ${score.normalizedScore}`,
    `Scored at: ${score.scoredAt.toISOString()}`,
    `Stale: ${stale}`,
    `ID: ${score.id}`,
  ]
  return ok(lines.join("\n"), {
    id: score.id,
    opportunityId,
    modelName: score.scoringModel.name,
    modelVersion: score.modelVersion,
    liveVersion: score.scoringModel.version,
    rawScore: score.rawScore,
    normalizedScore: score.normalizedScore,
    scoredAt: score.scoredAt.toISOString(),
    stale,
  })
}

// ─── list_top_opportunities ──────────────────────────────────────────────────

export async function listTopOpportunities({
  workspaceId,
  orgSlug,
  limit,
}: {
  workspaceId?: string
  orgSlug?: string
  limit?: number
}) {
  if (!workspaceId && !orgSlug) {
    return fail("Provide either workspaceId or orgSlug.")
  }

  const prisma = getPrisma()
  const take = limit ?? 20

  // In the cross-workspace (orgSlug) view, scope results to the caller's own
  // workspace memberships so the ranking never surfaces opportunities from
  // workspaces the user isn't in. The service key sees all. (The workspaceId
  // view is already gated to a member of that single workspace.)
  const actor = getMcpActor()
  const memberScope = await agentWorkspaceWhere(actor)
  const where: Prisma.OpportunityScoreWhereInput = workspaceId
    ? { opportunity: { workspaceId } }
    : { opportunity: { workspace: { organization: { slug: orgSlug }, ...memberScope } } }

  const scores = await prisma.opportunityScore.findMany({
    where,
    include: {
      opportunity: {
        select: {
          id: true,
          title: true,
          status: true,
          workspace: { select: { name: true } },
        },
      },
    },
    orderBy: { normalizedScore: "desc" },
    take,
  })

  if (!scores.length) {
    return fail("No scored opportunities found.")
  }

  // Cross-workspace view (orgSlug, no workspaceId) shows which workspace each
  // opportunity belongs to — the whole point of normalizedScore comparability.
  const showWorkspace = !workspaceId
  const lines = scores.map(
    (s, i) =>
      `${i + 1}. **${s.opportunity.title}** [${s.opportunity.status}] — ${s.normalizedScore.toFixed(1)}/100` +
      (showWorkspace ? ` (${s.opportunity.workspace.name})` : "") +
      `\n   ID: ${s.opportunity.id}`
  )
  const items = scores.map((s) => ({
    opportunityId: s.opportunity.id,
    title: s.opportunity.title,
    status: s.opportunity.status,
    normalizedScore: s.normalizedScore,
    workspace: s.opportunity.workspace.name,
  }))
  return ok(lines.join("\n"), { items, count: items.length })
}
