import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { AnalyticsConnection, MetricBinding, MetricDefinition, MetricRevision, MetricObservation } from "@prisma/client"
import getPrisma, { type AppTransactionClient } from "@/lib/db"
import { assertWorkspaceAdmin, assertWorkspaceMember, type McpActor } from "@/lib/mcp-authz"
import { getToolPrisma, hasToolTransaction } from "@/lib/mcp-tool-db"
import { encrypt, decrypt } from "@/lib/crypto-secrets"
import { AnalyticsError, fetchVercelObservation, validateQuery, querySchema, windowSchema, type ProviderId, type MetricQuery, type ObservationData } from "./providers"
import { analyticsFetch, validateVercelProject } from "./transport"
import { ANALYTICS_PROVIDERS, effectiveObservationWindow, type ProviderContext } from "./registry"
import { decodeBindingWindows, followupPolicySchema, resolveFollowupWindow, type BindingWindows } from "./windows"
import { clampLayout, dashboardLayoutInputSchema, dashboardSortOrderSchema, DEFAULT_DASHBOARD_STATE, type DashboardLayoutInput } from "./dashboard-layout"
import { computeCardStatus, computeDelta, headlineValue, type CardStatus, type CardDelta } from "./dashboard-status"

export const metricInputSchema = z.object({ name: z.string().trim().min(1).max(255), unit: z.string().trim().min(1).max(80), provider: z.enum(["vercel", "compass_activation"]), connectionId: z.string().uuid().optional(), query: querySchema }).strict()
export type MetricInput = z.infer<typeof metricInputSchema>
export const targetSchema = z.object({ targetType: z.enum(["EXPERIMENT", "ROADMAP_ITEM", "KEY_RESULT"]), targetId: z.string().uuid() })
export type MetricTarget = z.infer<typeof targetSchema>
export const linkMetricSchema = targetSchema.extend({ metricId: z.string().uuid(), baseline: windowSchema.nullable().optional(), followup: followupPolicySchema.optional(), target: z.number().finite().optional() }).strict()
export type LinkMetricInput = z.infer<typeof linkMetricSchema>
export const updateMetricBindingSchema = z.object({ baseline: windowSchema.nullable().optional(), followup: followupPolicySchema.optional(), target: z.number().finite().nullable().optional() }).strict()
  .refine(input => input.baseline !== undefined || input.followup !== undefined || input.target !== undefined, "At least one binding field is required.")
export type UpdateMetricBindingInput = z.infer<typeof updateMetricBindingSchema>
export type MetricDTO = { id: string; workspaceId: string; revisionId: string; revision: number; name: string; unit: string; provider: ProviderId; connectionId: string | null; query: MetricQuery; archived: boolean }
export type ConnectionDTO = Pick<AnalyticsConnection, "id" | "provider" | "projectId" | "teamId" | "enabled" | "health" | "generation">
export type BindingDTO = Omit<MetricBinding, "baselineJson" | "followupJson"> & BindingWindows & { metric: MetricDTO; replacesBindingId?: string }
export type ObservationDTO = Omit<MetricObservation, "snapshotJson" | "dataJson"> & { snapshot: Record<string, unknown>; data: ObservationData }
const denied = () => new AnalyticsError("NOT_FOUND_OR_ACCESS_DENIED")
const connectionDTO = (row: AnalyticsConnection): ConnectionDTO => ({ id: row.id, provider: row.provider, projectId: row.projectId, teamId: row.teamId, enabled: row.enabled, health: row.health, generation: row.generation })
const observationDTO = (row: MetricObservation): ObservationDTO => {
  const { snapshotJson, dataJson, ...rest } = row
  return { ...rest, snapshot: JSON.parse(snapshotJson), data: JSON.parse(dataJson) }
}
function operatorOnly(workspaceId: string, provider: string) {
  if (provider === "compass_activation" && (!process.env.COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID || workspaceId !== process.env.COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID)) throw new AnalyticsError("OPERATOR_ONLY")
}
async function authorize(actor: McpActor, workspaceId: string, write = false) {
  if (actor.purpose === "RESEARCH" || actor.purpose === "AGENT_TURN" || (!actor.userId && actor.purpose !== "SERVICE")) throw new AnalyticsError("ACCESS_DENIED")
  await assertWorkspaceMember({ ...actor, requiredAgentAccess: write ? "WRITE" : "READ" }, workspaceId)
  if (!await getToolPrisma().workspace.findFirst({ where: { id: workspaceId }, select: { id: true } })) throw denied()
}
async function administrator(actor: McpActor, workspaceId: string) {
  await authorize(actor, workspaceId, true)
  if (!actor.userId || (actor.purpose && actor.purpose !== "USER")) throw new AnalyticsError("HUMAN_ADMIN_REQUIRED")
  await assertWorkspaceAdmin(actor, workspaceId)
}
async function transaction<T>(fn: (tx: AppTransactionClient) => Promise<T>): Promise<T> {
  return hasToolTransaction() ? fn(getToolPrisma()) : getPrisma().$transaction(fn)
}
async function fenceWorkspace(db: AppTransactionClient, workspaceId: string) {
  // A write conflicts with final workspace deletion on DSQL (there are no FKs).
  const found = await db.workspace.updateMany({ where: { id: workspaceId }, data: { updatedAt: new Date() } })
  if (!found.count) throw denied()
}
function encryptionKey() {
  const key = process.env.ANALYTICS_SECRET_ENCRYPTION_KEY
  if (!key) throw new AnalyticsError("ENCRYPTION_NOT_CONFIGURED")
  return key
}
export async function listConnections(actor: McpActor, workspaceId: string): Promise<ConnectionDTO[]> {
  await authorize(actor, workspaceId)
  return (await getToolPrisma().analyticsConnection.findMany({ where: { workspaceId }, take: 100 })).map(connectionDTO)
}
export async function saveVercelConnection(actor: McpActor, workspaceId: string, input: { projectId: string; teamId?: string; token: string }): Promise<ConnectionDTO> {
  await administrator(actor, workspaceId)
  if (hasToolTransaction()) throw new AnalyticsError("NETWORK_INSIDE_TRANSACTION")
  const data = z.object({ projectId: z.string().trim().min(1).max(255), teamId: z.string().trim().min(1).max(255).optional(), token: z.string().trim().min(1).max(4096) }).strict().parse(input)
  const existing = await getToolPrisma().analyticsConnection.findFirst({ where: { workspaceId, provider: "vercel" } })
  if (existing && (existing.projectId !== data.projectId || existing.teamId !== (data.teamId ?? null))) throw new AnalyticsError("PROJECT_IDENTITY_IMMUTABLE")
  const encrypted = encrypt(data.token, encryptionKey())
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await validateVercelProject(data)
  await fetchVercelObservation(data, { metric: "pageviews" }, { since: yesterday, until: yesterday }, analyticsFetch)
  return transaction(async db => {
    await fenceWorkspace(db, workspaceId)
    if (!existing) return connectionDTO(await db.analyticsConnection.create({ data: { workspaceId, provider: "vercel", projectId: data.projectId, teamId: data.teamId, secretEncrypted: encrypted } }))
    const updated = await db.analyticsConnection.updateMany({ where: { id: existing.id, workspaceId, generation: existing.generation }, data: { secretEncrypted: encrypted, enabled: true, health: "CONNECTED", generation: { increment: 1 }, updatedAt: new Date() } })
    if (!updated.count) throw new AnalyticsError("CONNECTION_CHANGED")
    return connectionDTO({ ...existing, enabled: true, health: "CONNECTED", generation: existing.generation + 1 })
  })
}
export async function disconnectConnection(actor: McpActor, workspaceId: string, connectionId: string) {
  await administrator(actor, workspaceId)
  const result = await getToolPrisma().analyticsConnection.updateMany({ where: { id: connectionId, workspaceId }, data: { enabled: false, secretEncrypted: null, health: "DISCONNECTED", generation: { increment: 1 }, updatedAt: new Date() } })
  if (!result.count) throw denied()
  return { id: connectionId }
}
function metricDTO(definition: MetricDefinition, revision: MetricRevision): MetricDTO {
  operatorOnly(definition.workspaceId, revision.provider)
  return { id: definition.id, workspaceId: definition.workspaceId, revisionId: revision.id, revision: revision.revision, name: revision.name, unit: revision.unit, provider: revision.provider as ProviderId, connectionId: revision.connectionId, query: validateQuery(revision.provider as ProviderId, JSON.parse(revision.queryJson)), archived: definition.archived }
}
async function loadMetric(db: AppTransactionClient, workspaceId: string, metricId: string, revisionId?: string): Promise<MetricDTO> {
  const definition = await db.metricDefinition.findFirst({ where: { id: metricId, workspaceId } })
  if (!definition) throw denied()
  const revision = await db.metricRevision.findFirst({ where: { id: revisionId ?? definition.currentRevisionId, metricId, workspaceId } })
  if (!revision) throw denied()
  return metricDTO(definition, revision)
}
async function validateMetricConnection(db: AppTransactionClient, workspaceId: string, input: MetricInput) {
  operatorOnly(workspaceId, input.provider)
  validateQuery(input.provider, input.query)
  if (input.provider === "vercel") {
    if (!input.connectionId || !await db.analyticsConnection.findFirst({ where: { id: input.connectionId, workspaceId, provider: "vercel", enabled: true } })) throw denied()
  } else if (input.connectionId) throw new AnalyticsError("UNSUPPORTED_CONNECTION")
}
export async function listMetrics(actor: McpActor, workspaceId: string): Promise<MetricDTO[]> {
  await authorize(actor, workspaceId)
  const db = getToolPrisma()
  const definitions = await db.metricDefinition.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 200 })
  const revisions = await db.metricRevision.findMany({ where: { workspaceId, id: { in: definitions.map(d => d.currentRevisionId) } } })
  return definitions.flatMap(d => { const r = revisions.find(r => r.id === d.currentRevisionId); return r ? [metricDTO(d, r)] : [] })
}
export async function getMetric(actor: McpActor, workspaceId: string, metricId: string) {
  await authorize(actor, workspaceId)
  return loadMetric(getToolPrisma(), workspaceId, metricId)
}
export async function createMetric(actor: McpActor, workspaceId: string, raw: MetricInput): Promise<MetricDTO> {
  await authorize(actor, workspaceId, true)
  const input = metricInputSchema.parse(raw)
  return transaction(async db => {
    await fenceWorkspace(db, workspaceId)
    await validateMetricConnection(db, workspaceId, input)
    const id = randomUUID(), revisionId = randomUUID()
    const definition = await db.metricDefinition.create({ data: { id, workspaceId, currentRevisionId: revisionId } })
    const revision = await db.metricRevision.create({ data: { id: revisionId, workspaceId, metricId: id, revision: 1, name: input.name, unit: input.unit, provider: input.provider, connectionId: input.connectionId, queryJson: JSON.stringify(input.query) } })
    return metricDTO(definition, revision)
  })
}
export async function updateMetric(actor: McpActor, workspaceId: string, metricId: string, raw: MetricInput & { expectedRevision: number }): Promise<MetricDTO> {
  await authorize(actor, workspaceId, true)
  const { expectedRevision, ...rest } = raw
  z.number().int().positive().parse(expectedRevision)
  const input = metricInputSchema.parse(rest)
  return transaction(async db => {
    await fenceWorkspace(db, workspaceId)
    const previous = await loadMetric(db, workspaceId, metricId)
    if (previous.revision !== expectedRevision) throw new AnalyticsError("REVISION_CONFLICT")
    await validateMetricConnection(db, workspaceId, input)
    if (previous.provider !== input.provider) throw new AnalyticsError("PROVIDER_IMMUTABLE")
    const revisionId = randomUUID()
    const updated = await db.metricDefinition.updateMany({ where: { id: metricId, workspaceId, revision: expectedRevision, archived: false }, data: { revision: { increment: 1 }, currentRevisionId: revisionId, updatedAt: new Date() } })
    if (!updated.count) throw new AnalyticsError("REVISION_CONFLICT")
    await db.metricRevision.create({ data: { id: revisionId, workspaceId, metricId, revision: expectedRevision + 1, name: input.name, unit: input.unit, provider: input.provider, connectionId: input.connectionId, queryJson: JSON.stringify(input.query) } })
    return { ...previous, ...input, connectionId: input.connectionId ?? null, revisionId, revision: expectedRevision + 1 }
  })
}
export async function archiveMetric(actor: McpActor, workspaceId: string, metricId: string) {
  await authorize(actor, workspaceId, true)
  await loadMetric(getToolPrisma(), workspaceId, metricId)
  await getToolPrisma().metricDefinition.updateMany({ where: { id: metricId, workspaceId }, data: { archived: true, updatedAt: new Date() } })
  return { id: metricId }
}
async function assertTarget(db: AppTransactionClient, workspaceId: string, target: MetricTarget, fence = false) {
  targetSchema.parse(target)
  const found = target.targetType === "EXPERIMENT" ? await db.experiment.findFirst({ where: { id: target.targetId, workspaceId }, select: { id: true } }) : target.targetType === "ROADMAP_ITEM" ? await db.roadmapItem.findFirst({ where: { id: target.targetId, workspaceId }, select: { id: true } }) : await db.keyResult.findFirst({ where: { id: target.targetId, objective: { cycle: { workspaceId } } }, select: { id: true } })
  if (!found) throw denied()
  if (fence) {
    const data = { updatedAt: new Date() }
    const updated = target.targetType === "EXPERIMENT" ? await db.experiment.updateMany({ where: { id: target.targetId, workspaceId }, data }) : target.targetType === "ROADMAP_ITEM" ? await db.roadmapItem.updateMany({ where: { id: target.targetId, workspaceId }, data }) : await db.keyResult.updateMany({ where: { id: target.targetId, objective: { cycle: { workspaceId } } }, data })
    if (!updated.count) throw denied()
  }
}
async function bindingDTO(db: AppTransactionClient, row: MetricBinding): Promise<BindingDTO> {
  const { baselineJson, followupJson, ...rest } = row
  return { ...rest, ...decodeBindingWindows(JSON.parse(baselineJson), JSON.parse(followupJson)), metric: await loadMetric(db, row.workspaceId, row.metricId, row.revisionId) }
}
function validateProviderPolicy(metric: MetricDTO, windows: BindingWindows) {
  if (metric.provider === "compass_activation" && windows.mode === "tracking" && windows.followup.days !== 30) throw new AnalyticsError("ACTIVATION_WINDOW")
}
async function loadBinding(db: AppTransactionClient, workspaceId: string, bindingId: string) {
  const binding = await db.metricBinding.findFirst({ where: { id: bindingId, workspaceId } })
  if (!binding) throw denied()
  await assertTarget(db, workspaceId, { targetType: binding.targetType as MetricTarget["targetType"], targetId: binding.targetId })
  return bindingDTO(db, binding)
}
export async function getBinding(actor: McpActor, workspaceId: string, bindingId: string): Promise<BindingDTO> {
  await authorize(actor, workspaceId)
  return loadBinding(getToolPrisma(), workspaceId, bindingId)
}
export async function listBindings(actor: McpActor, workspaceId: string, target: MetricTarget, options: { includeInactive?: boolean } = {}): Promise<BindingDTO[]> {
  await authorize(actor, workspaceId)
  const db = getToolPrisma()
  await assertTarget(db, workspaceId, target)
  const rows = await db.metricBinding.findMany({ where: { workspaceId, ...target, ...(options.includeInactive ? {} : { active: true }) }, take: 100, orderBy: { createdAt: "asc" } })
  return Promise.all(rows.map(row => bindingDTO(db, row)))
}
export async function linkMetric(actor: McpActor, workspaceId: string, raw: LinkMetricInput): Promise<BindingDTO> {
  await authorize(actor, workspaceId, true)
  const input = linkMetricSchema.parse(raw)
  const windows = decodeBindingWindows(input.baseline, input.followup)
  return transaction(async db => {
    await fenceWorkspace(db, workspaceId)
    await assertTarget(db, workspaceId, { targetType: input.targetType, targetId: input.targetId }, true)
    const metric = await loadMetric(db, workspaceId, input.metricId)
    if (metric.archived) throw new AnalyticsError("METRIC_ARCHIVED")
    validateProviderPolicy(metric, windows)
    const row = await db.metricBinding.create({ data: { workspaceId, metricId: metric.id, revisionId: metric.revisionId, targetType: input.targetType, targetId: input.targetId, baselineJson: JSON.stringify(windows.baseline), followupJson: JSON.stringify(windows.followup), targetValue: input.target } })
    return { ...row, ...windows, metric }
  })
}
export async function unlinkMetric(actor: McpActor, workspaceId: string, bindingId: string) {
  await authorize(actor, workspaceId, true)
  await loadBinding(getToolPrisma(), workspaceId, bindingId)
  await getToolPrisma().metricBinding.updateMany({ where: { id: bindingId, workspaceId }, data: { active: false, updatedAt: new Date() } })
  return { id: bindingId }
}
export async function updateBinding(actor: McpActor, workspaceId: string, bindingId: string, raw: UpdateMetricBindingInput): Promise<BindingDTO> {
  await authorize(actor, workspaceId, true)
  const input = updateMetricBindingSchema.parse(raw)
  return transaction(async db => {
    await fenceWorkspace(db, workspaceId)
    const previous = await loadBinding(db, workspaceId, bindingId)
    if (!previous.active) throw new AnalyticsError("BINDING_INACTIVE")
    await assertTarget(db, workspaceId, { targetType: previous.targetType as MetricTarget["targetType"], targetId: previous.targetId }, true)
    const windows = decodeBindingWindows(input.baseline === undefined ? previous.baseline : input.baseline, input.followup ?? previous.followup)
    const { baseline, followup } = windows
    validateProviderPolicy(previous.metric, windows)
    const targetValue = input.target === undefined ? previous.targetValue : input.target
    if (JSON.stringify(baseline) === JSON.stringify(previous.baseline) && JSON.stringify(followup) === JSON.stringify(previous.followup) && targetValue === previous.targetValue) return previous
    const replacedAt = new Date()
    const retired = await db.metricBinding.updateMany({ where: { id: bindingId, workspaceId, active: true, revisionId: previous.revisionId }, data: { active: false, updatedAt: replacedAt } })
    if (!retired.count) throw new AnalyticsError("BINDING_INACTIVE")
    const row = await db.metricBinding.create({ data: { workspaceId, metricId: previous.metricId, revisionId: previous.revisionId, targetType: previous.targetType, targetId: previous.targetId, baselineJson: JSON.stringify(baseline), followupJson: JSON.stringify(followup), targetValue } })
    return { ...row, ...windows, metric: previous.metric, replacesBindingId: previous.id }
  })
}
export async function listObservations(actor: McpActor, workspaceId: string, bindingId: string): Promise<ObservationDTO[]> {
  await authorize(actor, workspaceId)
  await loadBinding(getToolPrisma(), workspaceId, bindingId)
  return (await getToolPrisma().metricObservation.findMany({ where: { workspaceId, bindingId }, orderBy: { retrievedAt: "desc" }, take: 100 })).map(observationDTO)
}
export async function getObservation(actor: McpActor, workspaceId: string, observationId: string): Promise<ObservationDTO> {
  await authorize(actor, workspaceId)
  const db = getToolPrisma()
  const observation = await db.metricObservation.findFirst({ where: { id: observationId, workspaceId } })
  if (!observation) throw denied()
  await loadBinding(db, workspaceId, observation.bindingId)
  return observationDTO(observation)
}
export async function refreshBinding(actor: McpActor, workspaceId: string, bindingId: string, requestId: string): Promise<ObservationDTO[]> {
  await authorize(actor, workspaceId, true)
  z.string().uuid().parse(requestId)
  if (hasToolTransaction()) throw new AnalyticsError("NETWORK_INSIDE_TRANSACTION")
  const db = getPrisma()
  const binding = await loadBinding(db, workspaceId, bindingId)
  if (!binding.active || binding.metric.archived) throw new AnalyticsError("BINDING_INACTIVE")
  const kinds: ("BASELINE" | "FOLLOWUP")[] = binding.mode === "tracking" ? ["FOLLOWUP"] : ["BASELINE", "FOLLOWUP"]
  const keys = kinds.map(kind => createHash("sha256").update(`${workspaceId}:${bindingId}:${binding.revisionId}:${requestId}:${kind}`).digest("hex"))
  const cached = await db.metricObservation.findMany({ where: { workspaceId, bindingId, refreshKey: { in: keys } } })
  if (cached.length === keys.length) return cached.map(observationDTO)
  const attemptStartedAt = new Date()
  const attemptId = randomUUID()
  await db.metricBinding.updateMany({ where: { id: bindingId, workspaceId, active: true, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: attemptStartedAt } }] }, data: { lastAttemptAt: attemptStartedAt, lastAttemptId: attemptId, lastError: null, updatedAt: attemptStartedAt } })
  const metric = binding.metric
  let connection: AnalyticsConnection | null = null
  try {
    const context: Omit<ProviderContext, "window"> = { query: metric.query, fetcher: analyticsFetch }
    if (metric.provider === "vercel") {
      connection = await db.analyticsConnection.findFirst({ where: { id: metric.connectionId ?? "", workspaceId, provider: "vercel", enabled: true } })
      if (!connection?.secretEncrypted) throw new AnalyticsError("DISCONNECTED")
      const credentials = { projectId: connection.projectId, teamId: connection.teamId, token: decrypt(connection.secretEncrypted, encryptionKey()) }
      await validateVercelProject(credentials)
      context.credentials = credentials
    } else {
      operatorOnly(workspaceId, metric.provider)
      if (process.env.VERCEL_ENV !== "production") throw new AnalyticsError("PRODUCTION_ONLY")
      const excluded = (process.env.COMPASS_ANALYTICS_EXCLUDED_WORKSPACE_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean)
      context.activation = { now: attemptStartedAt, count: async (cutoff, now) => {
        const bounds = { gte: cutoff, lte: now }
        // Join to live workspaces prevents deleted tenants contributing stale state.
        const states = await db.workspaceActivationState.findMany({ where: { workspaceId: { notIn: excluded }, discoveryAt: bounds, deliveryAt: bounds, learningAt: bounds }, select: { workspaceId: true }, take: 10001 })
        if (states.length > 10000) throw new AnalyticsError("POPULATION_LIMIT")
        return db.workspace.count({ where: { id: { in: states.map(s => s.workspaceId) } } })
      } }
    }
    const adapter = ANALYTICS_PROVIDERS[metric.provider]
    const windows = kinds.map(kind => effectiveObservationWindow(metric.provider, kind, kind === "BASELINE" && binding.baseline ? binding.baseline : resolveFollowupWindow(binding.followup, attemptStartedAt), attemptStartedAt))
    const results = await Promise.all(windows.map(window => adapter.fetch({ ...context, window })))
    const retrievedAt = new Date()
    return await db.$transaction(async tx => {
      await fenceWorkspace(tx, workspaceId)
      await assertTarget(tx, workspaceId, { targetType: binding.targetType as MetricTarget["targetType"], targetId: binding.targetId }, true)
      const definition = await tx.metricDefinition.updateMany({ where: { id: metric.id, workspaceId, archived: false }, data: { updatedAt: retrievedAt } })
      if (!definition.count) throw new AnalyticsError("METRIC_ARCHIVED")
      if (connection) {
        const healthUpdated = await tx.analyticsConnection.updateMany({ where: { id: connection.id, workspaceId, enabled: true, generation: connection.generation, updatedAt: { lte: attemptStartedAt } }, data: { health: "CONNECTED", updatedAt: retrievedAt } })
        if (!healthUpdated.count) {
          // A newer same-generation attempt owns connection health, but this
          // successful fetch is still valid evidence. Rotation/disconnect is
          // different: it invalidates the credentials and blocks persistence.
          const stillValid = await tx.analyticsConnection.findFirst({ where: { id: connection.id, workspaceId, enabled: true, generation: connection.generation }, select: { id: true } })
          if (!stillValid) throw new AnalyticsError("CONNECTION_CHANGED")
        }
      }
      const active = await tx.metricBinding.updateMany({ where: { id: bindingId, workspaceId, active: true, revisionId: binding.revisionId }, data: { updatedAt: retrievedAt } })
      if (!active.count) throw new AnalyticsError("BINDING_INACTIVE")
      await tx.metricBinding.updateMany({ where: { id: bindingId, workspaceId, lastAttemptId: attemptId }, data: { lastError: null, updatedAt: retrievedAt } })
      const observations: ObservationDTO[] = []
      for (let i = 0; i < results.length; i++) {
        const row = await tx.metricObservation.create({ data: { workspaceId, bindingId, revisionId: metric.revisionId, refreshKey: keys[i], windowKind: kinds[i], snapshotJson: JSON.stringify({ metric, window: windows[i], logicalWindow: kinds[i] === "BASELINE" ? binding.baseline : binding.followup, windowMode: adapter.capabilities.windowMode, attemptStartedAt, connectionGeneration: connection?.generation ?? null }), dataJson: JSON.stringify(results[i]), retrievedAt } })
        observations.push(observationDTO(row))
      }
      return observations
    })
  } catch (error) {
    // Unique-key races replay the first committed result, never duplicate evidence.
    const replay = await db.metricObservation.findMany({ where: { workspaceId, bindingId, refreshKey: { in: keys } } })
    if (replay.length === keys.length) return replay.map(observationDTO)
    const code = error instanceof AnalyticsError ? error.code : "REFRESH_FAILED"
    if (connection && ["AUTHENTICATION", "PLAN_REQUIRED", "ACCESS_DENIED", "PROJECT_NOT_FOUND", "ANALYTICS_DISABLED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(code)) {
      await db.analyticsConnection.updateMany({ where: { id: connection.id, workspaceId, generation: connection.generation, enabled: true, updatedAt: { lte: attemptStartedAt } }, data: { health: code, updatedAt: new Date() } })
    }
    await db.metricBinding.updateMany({ where: { id: bindingId, workspaceId, lastAttemptId: attemptId }, data: { lastError: code, updatedAt: new Date() } })
    throw new AnalyticsError(code)
  }
}

// ─── Metrics dashboard (standalone /metrics page) ──────────────────────────
// Layout (visible/col/row/sortOrder) is workspace-level, not per-user -- see
// MetricDefinition.dashboardVisible et al in schema.prisma. Every reader
// coalesces a NULL layout column to the same default DASHBOARD default the
// 062_metrics_dashboard backfill used, since DSQL forbids a DB-level DEFAULT
// on ALTER TABLE ADD COLUMN.
export type DashboardLayoutDTO = { id: string; dashboardVisible: boolean; dashboardCol: number; dashboardRow: number; dashboardSortOrder: number }
export type DashboardBindingDTO = { id: string; targetType: MetricTarget["targetType"]; targetId: string; targetTitle: string }
export type DashboardMetricDTO = DashboardLayoutDTO & {
  metric: MetricDTO
  status: CardStatus
  statusCaption: string
  value: number | null
  delta: CardDelta | null
  sparkline: (number | null)[]
  bindings: DashboardBindingDTO[]
}
function layoutDTO(definition: MetricDefinition): DashboardLayoutDTO {
  return {
    id: definition.id,
    dashboardVisible: definition.dashboardVisible ?? DEFAULT_DASHBOARD_STATE.visible,
    dashboardCol: definition.dashboardCol ?? DEFAULT_DASHBOARD_STATE.col,
    dashboardRow: definition.dashboardRow ?? DEFAULT_DASHBOARD_STATE.row,
    dashboardSortOrder: definition.dashboardSortOrder ?? DEFAULT_DASHBOARD_STATE.sortOrder,
  }
}
export async function listDashboardMetrics(actor: McpActor, workspaceId: string): Promise<DashboardMetricDTO[]> {
  await authorize(actor, workspaceId)
  const db = getToolPrisma()
  const definitions = await db.metricDefinition.findMany({ where: { workspaceId, archived: false }, orderBy: { createdAt: "asc" }, take: 200 })
  if (!definitions.length) return []
  const revisions = await db.metricRevision.findMany({ where: { workspaceId, id: { in: definitions.map(d => d.currentRevisionId) } } })
  const rows = definitions.flatMap(d => { const r = revisions.find(r => r.id === d.currentRevisionId); return r ? [{ definition: d, metric: metricDTO(d, r) }] : [] })
    // In-memory sort (not orderBy) so a not-yet-backfilled NULL sorts the same
    // way the rest of this module treats it -- as 0 -- rather than however
    // Postgres/DSQL happens to place NULLs in an ORDER BY.
    .sort((a, b) => (a.definition.dashboardSortOrder ?? 0) - (b.definition.dashboardSortOrder ?? 0))
  const metricIds = rows.map(r => r.metric.id)
  const bindings = await db.metricBinding.findMany({ where: { workspaceId, active: true, metricId: { in: metricIds } }, orderBy: { updatedAt: "desc" } })
  const observations = bindings.length ? await db.metricObservation.findMany({ where: { workspaceId, bindingId: { in: bindings.map(b => b.id) } }, orderBy: { retrievedAt: "desc" }, take: bindings.length * 6 + 6 }) : []
  const connections = await db.analyticsConnection.findMany({ where: { workspaceId } })
  const experimentIds = [...new Set(bindings.filter(b => b.targetType === "EXPERIMENT").map(b => b.targetId))]
  const roadmapIds = [...new Set(bindings.filter(b => b.targetType === "ROADMAP_ITEM").map(b => b.targetId))]
  const keyResultIds = [...new Set(bindings.filter(b => b.targetType === "KEY_RESULT").map(b => b.targetId))]
  const [experiments, roadmapItems, keyResults] = await Promise.all([
    experimentIds.length ? db.experiment.findMany({ where: { id: { in: experimentIds }, workspaceId }, select: { id: true, title: true } }) : Promise.resolve([]),
    roadmapIds.length ? db.roadmapItem.findMany({ where: { id: { in: roadmapIds }, workspaceId }, select: { id: true, title: true } }) : Promise.resolve([]),
    keyResultIds.length ? db.keyResult.findMany({ where: { id: { in: keyResultIds }, objective: { cycle: { workspaceId } } }, select: { id: true, title: true } }) : Promise.resolve([]),
  ])
  const targetTitle = (targetType: string, targetId: string): string =>
    (targetType === "EXPERIMENT" ? experiments.find(e => e.id === targetId)?.title
      : targetType === "ROADMAP_ITEM" ? roadmapItems.find(r => r.id === targetId)?.title
      : keyResults.find(k => k.id === targetId)?.title) ?? "Unknown item"
  const now = new Date()
  return rows.map(({ definition, metric }) => {
    const myBindings = bindings.filter(b => b.metricId === metric.id)
    // Bindings are already ordered updatedAt desc; prefer an ongoing tracking
    // binding for the card's headline value/sparkline, falling back to the
    // most recently touched comparison binding.
    const representative = myBindings.find(b => decodeBindingWindows(JSON.parse(b.baselineJson), JSON.parse(b.followupJson)).mode === "tracking") ?? myBindings[0] ?? null
    const myObservations = representative ? observations.filter(o => o.bindingId === representative.id) : []
    const followups = myObservations.filter(o => o.windowKind === "FOLLOWUP")
    const baselines = myObservations.filter(o => o.windowKind === "BASELINE")
    const latest = followups[0] ?? null
    const latestData = latest ? (JSON.parse(latest.dataJson) as ObservationData) : null
    const value = latestData ? headlineValue(metric.query, latestData) : null
    const sparkline = latestData?.series.map(point => point.value) ?? []
    let delta: CardDelta | null = null
    if (representative && latestData) {
      const mode = decodeBindingWindows(JSON.parse(representative.baselineJson), JSON.parse(representative.followupJson)).mode
      if (mode === "tracking") {
        const previous = followups[1] ? headlineValue(metric.query, JSON.parse(followups[1].dataJson) as ObservationData) : null
        delta = computeDelta(value, previous)
      } else {
        const baseline = baselines[0] ? headlineValue(metric.query, JSON.parse(baselines[0].dataJson) as ObservationData) : null
        delta = computeDelta(value, baseline)
      }
    }
    const connection = metric.provider === "vercel" ? connections.find(c => c.id === metric.connectionId) ?? null : null
    const connectionHealthy = metric.provider === "vercel" ? Boolean(connection?.enabled && connection.health === "CONNECTED") : null
    const { status, caption } = computeCardStatus({
      hasActiveBinding: myBindings.length > 0,
      connectionHealthy,
      lastError: representative?.lastError ?? null,
      lastAttemptAt: representative?.lastAttemptAt ?? null,
      latestObservationAt: latest?.retrievedAt ?? null,
      now,
    })
    return {
      ...layoutDTO(definition),
      metric,
      status,
      statusCaption: caption,
      value,
      delta,
      sparkline,
      bindings: myBindings.map(b => ({ id: b.id, targetType: b.targetType as MetricTarget["targetType"], targetId: b.targetId, targetTitle: targetTitle(b.targetType, b.targetId) })),
    }
  })
}
export async function getDashboardMetric(actor: McpActor, workspaceId: string, metricId: string): Promise<DashboardMetricDTO> {
  const found = (await listDashboardMetrics(actor, workspaceId)).find(row => row.metric.id === metricId)
  if (!found) throw denied()
  return found
}
export async function updateMetricDashboardLayout(actor: McpActor, workspaceId: string, metricId: string, raw: DashboardLayoutInput): Promise<DashboardLayoutDTO> {
  await authorize(actor, workspaceId, true)
  const { col, row } = clampLayout(dashboardLayoutInputSchema.parse(raw))
  const db = getToolPrisma()
  const existing = await db.metricDefinition.findFirst({ where: { id: metricId, workspaceId, archived: false } })
  if (!existing) throw denied()
  const updated = await db.metricDefinition.updateMany({ where: { id: metricId, workspaceId, archived: false }, data: { dashboardCol: col, dashboardRow: row, updatedAt: new Date() } })
  if (!updated.count) throw denied()
  return { ...layoutDTO(existing), dashboardCol: col, dashboardRow: row }
}
export async function setMetricDashboardVisible(actor: McpActor, workspaceId: string, metricId: string, visible: boolean): Promise<DashboardLayoutDTO> {
  await authorize(actor, workspaceId, true)
  const db = getToolPrisma()
  const existing = await db.metricDefinition.findFirst({ where: { id: metricId, workspaceId, archived: false } })
  if (!existing) throw denied()
  // Re-adding a hidden metric resets it to the default medium size and
  // appends it after whatever is currently on the dashboard, mirroring the
  // approved design prototype's "Add widget" behavior.
  const data: { dashboardVisible: boolean; updatedAt: Date; dashboardCol?: number; dashboardRow?: number; dashboardSortOrder?: number } = { dashboardVisible: visible, updatedAt: new Date() }
  if (visible) {
    // Sibling rows may still carry a NULL sortOrder pre-backfill; coalesce the
    // same way listDashboardMetrics does so "append to the end" is correct
    // even against an unmigrated or partially migrated row.
    const rows = await db.metricDefinition.findMany({ where: { workspaceId, archived: false }, select: { dashboardSortOrder: true } })
    const maxSortOrder = rows.reduce((max, row) => Math.max(max, row.dashboardSortOrder ?? DEFAULT_DASHBOARD_STATE.sortOrder), -1)
    data.dashboardCol = DEFAULT_DASHBOARD_STATE.col
    data.dashboardRow = DEFAULT_DASHBOARD_STATE.row
    data.dashboardSortOrder = maxSortOrder + 1
  }
  const updated = await db.metricDefinition.updateMany({ where: { id: metricId, workspaceId, archived: false }, data })
  if (!updated.count) throw denied()
  return { ...layoutDTO(existing), dashboardVisible: visible, ...(visible ? { dashboardCol: data.dashboardCol!, dashboardRow: data.dashboardRow!, dashboardSortOrder: data.dashboardSortOrder! } : {}) }
}
export async function reorderDashboardMetric(actor: McpActor, workspaceId: string, metricId: string, sortOrder: number): Promise<DashboardLayoutDTO> {
  await authorize(actor, workspaceId, true)
  const parsed = dashboardSortOrderSchema.parse(sortOrder)
  const db = getToolPrisma()
  const existing = await db.metricDefinition.findFirst({ where: { id: metricId, workspaceId, archived: false } })
  if (!existing) throw denied()
  const updated = await db.metricDefinition.updateMany({ where: { id: metricId, workspaceId, archived: false }, data: { dashboardSortOrder: parsed, updatedAt: new Date() } })
  if (!updated.count) throw denied()
  return { ...layoutDTO(existing), dashboardSortOrder: parsed }
}

/** Call inside the existing workspace/organization deletion transaction. */
export async function deleteWorkspaceAnalytics(db: AppTransactionClient, workspaceIds: string | string[]) {
  const where = { workspaceId: { in: typeof workspaceIds === "string" ? [workspaceIds] : workspaceIds } }
  await db.metricObservation.deleteMany({ where })
  await db.metricBinding.deleteMany({ where })
  await db.metricRevision.deleteMany({ where })
  await db.metricDefinition.deleteMany({ where })
  await db.analyticsConnection.deleteMany({ where })
  await db.workspaceActivationState.deleteMany({ where })
}
