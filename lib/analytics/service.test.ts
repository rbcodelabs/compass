import { beforeEach, describe, expect, it, vi } from "vitest"
const { db, member, admin, providerFetch, projectValidate } = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() })
  return { db: { workspace: model(), experiment: model(), roadmapItem: model(), keyResult: model(), analyticsConnection: model(), metricDefinition: model(), metricRevision: model(), metricBinding: model(), metricObservation: model(), workspaceActivationState: model() }, member: vi.fn(), admin: vi.fn(), providerFetch: vi.fn(), projectValidate: vi.fn() }
})
vi.mock("@/lib/db", () => ({ default: () => ({ ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) }) }))
vi.mock("@/lib/mcp-tool-db", () => ({ getToolPrisma: () => db, hasToolTransaction: () => false }))
vi.mock("@/lib/mcp-authz", () => ({ assertWorkspaceMember: member, assertWorkspaceAdmin: admin }))
vi.mock("./transport", () => ({ analyticsFetch: vi.fn(), validateVercelProject: projectValidate }))
vi.mock("./providers", async (importOriginal) => ({ ...await importOriginal<typeof import("./providers")>(), fetchVercelObservation: providerFetch }))
import { archiveMetric, createMetric, disconnectConnection, getBinding, getMetric, getObservation, linkMetric, listBindings, listConnections, listObservations, updateBinding, updateMetric, refreshBinding, saveVercelConnection, deleteWorkspaceAnalytics } from "./service"
import { encrypt } from "@/lib/crypto-secrets"
import { AnalyticsError } from "./providers"
const actor = { userId: "user", purpose: "USER" as const }
const workspace = "ab630faf-1d90-4725-bff9-488cc6c4b721"
const input = { name: "Views", unit: "pageviews", provider: "vercel" as const, connectionId: "72babb15-32b3-4eeb-9ce2-eedff1758971", query: { metric: "pageviews" as const } }
beforeEach(() => { vi.clearAllMocks(); db.workspace.findFirst.mockResolvedValue({ id: workspace }); db.workspace.updateMany.mockResolvedValue({ count: 1 }); db.metricDefinition.findFirst.mockResolvedValue(null); db.metricObservation.findMany.mockResolvedValue([]) })
describe("analytics service boundaries", () => {
  it("links rolling 30-day tracking without baseline or date entry", async () => {
    const metricId = "dbe8c029-f793-4544-b7a9-bfc01a853cc9"
    const targetId = "9bc31432-917f-4ab3-95db-6a66509fe336"
    db.experiment.findFirst.mockResolvedValue({ id: targetId })
    db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricDefinition.findFirst.mockResolvedValue({ id: metricId, workspaceId: workspace, currentRevisionId: "rev", archived: false })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", revision: 1, queryJson: JSON.stringify(input.query) })
    db.metricBinding.create.mockImplementation(async ({ data }) => ({ id: "tracking", ...data }))
    const linked = await linkMetric(actor, workspace, { metricId, targetType: "EXPERIMENT", targetId })
    expect(linked).toMatchObject({ mode: "tracking", baseline: null, followup: { version: 1, mode: "rolling", days: 30 } })
    expect(db.metricBinding.create).toHaveBeenCalledWith({ data: expect.objectContaining({ baselineJson: "null", followupJson: '{"version":1,"mode":"rolling","days":30}' }) })
  })
  it("rejects a misleading seven-day native activation policy", async () => {
    const metricId = "dbe8c029-f793-4544-b7a9-bfc01a853cc9", targetId = "9bc31432-917f-4ab3-95db-6a66509fe336"
    vi.stubEnv("COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID", workspace)
    db.experiment.findFirst.mockResolvedValue({ id: targetId }); db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricDefinition.findFirst.mockResolvedValue({ id: metricId, workspaceId: workspace, currentRevisionId: "rev", archived: false })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", provider: "compass_activation", queryJson: '{"metric":"active_discovery_teams"}' })
    try {
      await expect(linkMetric(actor, workspace, { metricId, targetType: "EXPERIMENT", targetId, followup: { version: 1, mode: "rolling", days: 7 } })).rejects.toThrow("ACTIVATION_WINDOW")
      expect(db.metricBinding.create).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
  it("does not let trusted service credentials link a foreign connection", async () => {
    db.analyticsConnection.findFirst.mockResolvedValue(null)
    await expect(createMetric({ userId: null, purpose: "SERVICE" }, workspace, input)).rejects.toThrow("NOT_FOUND")
    expect(db.metricDefinition.create).not.toHaveBeenCalled()
  })
  it("returns sanitized connection metadata", async () => {
    db.analyticsConnection.findMany.mockResolvedValue([{ id: "connection", provider: "vercel", projectId: "p", teamId: null, enabled: true, health: "CONNECTED", generation: 1, secretEncrypted: "never return me" }])
    expect(JSON.stringify(await listConnections(actor, workspace))).not.toContain("never return me")
  })
  it("clears credentials on disconnect and retains observations", async () => {
    db.analyticsConnection.updateMany.mockResolvedValue({ count: 1 })
    await disconnectConnection(actor, workspace, input.connectionId)
    expect(admin).toHaveBeenCalled()
    expect(db.analyticsConnection.updateMany.mock.calls[0][0].data).toMatchObject({ secretEncrypted: null, enabled: false })
    expect(db.metricObservation.deleteMany).not.toHaveBeenCalled()
  })
  it("denies scoped research actors even when a membership gate would allow them", async () => {
    await expect(listConnections({ ...actor, purpose: "RESEARCH", scopeWorkspaceId: workspace }, workspace)).rejects.toThrow("ACCESS_DENIED")
  })
  it("rejects concurrent revision edits", async () => {
    db.metricDefinition.findFirst.mockResolvedValue({ id: "metric", workspaceId: workspace, currentRevisionId: "rev", revision: 2 })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", queryJson: JSON.stringify(input.query) })
    await expect(updateMetric(actor, workspace, "metric", { ...input, expectedRevision: 1 })).rejects.toThrow("REVISION_CONFLICT")
  })
  it("does not expose native aggregate metric outside the configured reporting workspace", async () => {
    process.env.COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID = "other"
    db.metricDefinition.findFirst.mockResolvedValue({ id: "metric", currentRevisionId: "rev", revision: 1 })
    db.metricRevision.findFirst.mockResolvedValue({ id: "rev", provider: "compass_activation", queryJson: '{"metric":"active_discovery_teams"}' })
    await expect(getMetric({ userId: null, purpose: "SERVICE" }, workspace, "metric")).rejects.toThrow("OPERATOR_ONLY")
    delete process.env.COMPASS_ANALYTICS_REPORTING_WORKSPACE_ID
  })
  it("does not silently change the project behind existing revisions", async () => {
    db.analyticsConnection.findFirst.mockResolvedValue({ projectId: "old", teamId: null })
    await expect(saveVercelConnection(actor, workspace, { projectId: "new", token: "secret" })).rejects.toThrow("PROJECT_IDENTITY_IMMUTABLE")
    expect(projectValidate).not.toHaveBeenCalled()
  })
  it("cleans up every tenant-owned analytics table without crossing the workspace boundary", async () => {
    await deleteWorkspaceAnalytics(db as never, workspace)
    for (const model of [db.metricObservation, db.metricBinding, db.metricRevision, db.metricDefinition, db.analyticsConnection, db.workspaceActivationState]) expect(model.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: { in: [workspace] } } })
  })

  it.each([
    ["service", { userId: null, purpose: "SERVICE" as const }, "HUMAN_ADMIN_REQUIRED"],
    ["agent", { userId: "agent-user", purpose: "AGENT" as const }, "HUMAN_ADMIN_REQUIRED"],
    ["agent turn", { userId: "agent-user", purpose: "AGENT_TURN" as const }, "ACCESS_DENIED"],
  ])("rejects %s connection changes before validation or writes", async (_label, deniedActor, errorCode) => {
    await expect(saveVercelConnection(deniedActor, workspace, { projectId: "project", token: "secret" })).rejects.toThrow(errorCode)
    await expect(disconnectConnection(deniedActor, workspace, input.connectionId)).rejects.toThrow(errorCode)
    expect(projectValidate).not.toHaveBeenCalled()
    expect(db.analyticsConnection.findFirst).not.toHaveBeenCalled()
    expect(db.analyticsConnection.create).not.toHaveBeenCalled()
    expect(db.analyticsConnection.updateMany).not.toHaveBeenCalled()
  })

  it("stops a non-admin human before validating or storing connection credentials", async () => {
    admin.mockRejectedValue(new Error("Forbidden: workspace admin required."))
    await expect(saveVercelConnection(actor, workspace, { projectId: "project", token: "secret" })).rejects.toThrow("workspace admin required")
    await expect(disconnectConnection(actor, workspace, input.connectionId)).rejects.toThrow("workspace admin required")
    expect(projectValidate).not.toHaveBeenCalled()
    expect(db.analyticsConnection.findFirst).not.toHaveBeenCalled()
    expect(db.analyticsConnection.create).not.toHaveBeenCalled()
    expect(db.analyticsConnection.updateMany).not.toHaveBeenCalled()
  })

  it("keeps existing bindings on the old revision while new bindings use the successful edit", async () => {
    const metricId = "dbe8c029-f793-4544-b7a9-bfc01a853cc9"
    const oldRevision = { ...input, id: "old-revision", metricId, workspaceId: workspace, revision: 1, queryJson: JSON.stringify(input.query) }
    const revisions = new Map([[oldRevision.id, oldRevision]])
    const definition = { id: metricId, workspaceId: workspace, currentRevisionId: oldRevision.id, revision: 1, archived: false }
    const oldTarget = "9bc31432-917f-4ab3-95db-6a66509fe336"
    const newTarget = "ae459cd4-31eb-46d7-a9a2-cc6d76f34947"
    const oldBinding = { id: "old-binding", workspaceId: workspace, metricId: definition.id, revisionId: oldRevision.id, targetType: "EXPERIMENT", targetId: oldTarget, baselineJson: '{"since":"2026-01-01","until":"2026-01-01"}', followupJson: '{"since":"2026-01-02","until":"2026-01-02"}', active: true }
    db.metricDefinition.findFirst.mockImplementation(async () => ({ ...definition }))
    db.metricRevision.findFirst.mockImplementation(async ({ where }) => revisions.get(where.id))
    db.analyticsConnection.findFirst.mockResolvedValue({ id: input.connectionId, workspaceId: workspace, provider: "vercel", enabled: true })
    db.metricDefinition.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.revision !== definition.revision) return { count: 0 }
      definition.revision += 1
      definition.currentRevisionId = data.currentRevisionId
      return { count: 1 }
    })
    db.metricRevision.create.mockImplementation(async ({ data }) => { revisions.set(data.id, data); return data })
    db.experiment.findFirst.mockResolvedValue({ id: oldTarget })
    db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricBinding.findMany.mockResolvedValue([oldBinding])
    db.metricBinding.create.mockImplementation(async ({ data }) => ({ id: "new-binding", ...data }))

    const edited = await updateMetric(actor, workspace, definition.id, { ...input, name: "Edited views", expectedRevision: 1 })
    const existing = await listBindings(actor, workspace, { targetType: "EXPERIMENT", targetId: oldTarget })
    const linked = await linkMetric(actor, workspace, { metricId: definition.id, targetType: "EXPERIMENT", targetId: newTarget, baseline: { since: "2026-02-01", until: "2026-02-01" }, followup: { since: "2026-02-02", until: "2026-02-02" } })

    expect(edited).toMatchObject({ revision: 2, name: "Edited views" })
    expect(existing[0].metric).toMatchObject({ revisionId: oldRevision.id, revision: 1, name: "Views" })
    expect(linked.metric).toMatchObject({ revisionId: definition.currentRevisionId, revision: 2, name: "Edited views" })
  })

  it("keeps SERVICE leaf access scoped to the caller-supplied workspace", async () => {
    const service = { userId: null, purpose: "SERVICE" as const }
    const foreignMetric = "0a5d280d-2c3f-4c20-83f2-7e0a70516b66"
    const foreignBinding = "26e82033-901a-4f22-a1b6-62cc35025ab8"
    const foreignTarget = "f43979ad-02c0-4ae0-bdd9-a2369690b10d"
    db.metricDefinition.findFirst.mockResolvedValue(null)
    db.metricBinding.findFirst.mockResolvedValue(null)
    db.experiment.findFirst.mockResolvedValue(null)

    await expect(getMetric(service, workspace, foreignMetric)).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    await expect(updateMetric(service, workspace, foreignMetric, { ...input, expectedRevision: 1 })).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    await expect(archiveMetric(service, workspace, foreignMetric)).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    await expect(linkMetric(service, workspace, { metricId: foreignMetric, targetType: "EXPERIMENT", targetId: foreignTarget, baseline: { since: "2026-01-01", until: "2026-01-01" }, followup: { since: "2026-01-02", until: "2026-01-02" } })).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    await expect(refreshBinding(service, workspace, foreignBinding, "a34a9eb8-3d99-49a3-b306-9f5e0e87a0cb")).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    await expect(listObservations(service, workspace, foreignBinding)).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")

    expect(db.metricDefinition.findFirst).toHaveBeenCalledWith({ where: { id: foreignMetric, workspaceId: workspace } })
    expect(db.metricBinding.findFirst).toHaveBeenCalledWith({ where: { id: foreignBinding, workspaceId: workspace } })
    expect(db.metricDefinition.create).not.toHaveBeenCalled()
    expect(db.metricRevision.create).not.toHaveBeenCalled()
    expect(db.metricBinding.create).not.toHaveBeenCalled()
    expect(db.metricObservation.create).not.toHaveBeenCalled()
  })

  it("reads a binding only after traversing its workspace-scoped target", async () => {
    const binding = { id: "binding", workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: "709655a2-35de-436b-a371-a170781445d7", baselineJson: '{"since":"2026-01-01","until":"2026-01-01"}', followupJson: '{"since":"2026-01-02","until":"2026-01-02"}', targetValue: null, active: true }
    db.metricBinding.findFirst.mockResolvedValue(binding)
    db.experiment.findFirst.mockResolvedValue(null)

    await expect(getBinding(actor, workspace, binding.id)).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    expect(db.metricDefinition.findFirst).not.toHaveBeenCalled()
  })

  it("returns the same active binding for a semantic no-op replacement", async () => {
    const binding = { id: "binding", workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: "709655a2-35de-436b-a371-a170781445d7", baselineJson: '{"since":"2026-01-01","until":"2026-01-01"}', followupJson: '{"since":"2026-01-02","until":"2026-01-02"}', targetValue: 10, active: true }
    db.metricBinding.findFirst.mockResolvedValue(binding)
    db.experiment.findFirst.mockResolvedValue({ id: binding.targetId })
    db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricDefinition.findFirst.mockResolvedValue({ id: "metric", workspaceId: workspace, currentRevisionId: "newer-rev", revision: 2, archived: false })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", metricId: "metric", workspaceId: workspace, revision: 1, queryJson: JSON.stringify(input.query) })

    const result = await updateBinding(actor, workspace, binding.id, { target: 10 })

    expect(result.id).toBe(binding.id)
    expect(result.metric.revisionId).toBe("rev")
    expect(db.metricBinding.updateMany).not.toHaveBeenCalled()
    expect(db.metricBinding.create).not.toHaveBeenCalled()
  })

  it("atomically replaces an active binding while pinning metric revision and product target", async () => {
    const binding = { id: "binding", workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: "709655a2-35de-436b-a371-a170781445d7", baselineJson: '{"since":"2026-01-01","until":"2026-01-01"}', followupJson: '{"since":"2026-01-02","until":"2026-01-02"}', targetValue: 10, active: true }
    db.metricBinding.findFirst.mockResolvedValue(binding)
    db.experiment.findFirst.mockResolvedValue({ id: binding.targetId })
    db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricDefinition.findFirst.mockResolvedValue({ id: "metric", workspaceId: workspace, currentRevisionId: "newer-rev", revision: 2, archived: false })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", metricId: "metric", workspaceId: workspace, revision: 1, queryJson: JSON.stringify(input.query) })
    db.metricBinding.updateMany.mockResolvedValue({ count: 1 })
    db.metricBinding.create.mockImplementation(async ({ data }) => ({ id: "replacement", ...data }))

    const result = await updateBinding(actor, workspace, binding.id, { followup: { since: "2026-02-01", until: "2026-02-07" }, target: null })

    expect(db.metricBinding.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: binding.id, workspaceId: workspace, active: true }), data: expect.objectContaining({ active: false }) }))
    expect(db.metricBinding.create).toHaveBeenCalledWith({ data: expect.objectContaining({ metricId: binding.metricId, revisionId: binding.revisionId, targetType: binding.targetType, targetId: binding.targetId, baselineJson: binding.baselineJson, followupJson: '{"since":"2026-02-01","until":"2026-02-07"}', targetValue: null }) })
    expect(result).toMatchObject({ id: "replacement", replacesBindingId: binding.id, metricId: binding.metricId, revisionId: binding.revisionId, targetId: binding.targetId, targetValue: null })
    expect(db.metricObservation.deleteMany).not.toHaveBeenCalled()
  })

  it("optionally lists inactive bindings without changing the default", async () => {
    const targetId = "709655a2-35de-436b-a371-a170781445d7"
    db.experiment.findFirst.mockResolvedValue({ id: targetId })
    db.metricBinding.findMany.mockResolvedValue([])

    await listBindings(actor, workspace, { targetType: "EXPERIMENT", targetId })
    expect(db.metricBinding.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ active: true }) }))

    await listBindings(actor, workspace, { targetType: "EXPERIMENT", targetId }, { includeInactive: true })
    expect(db.metricBinding.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { workspaceId: workspace, targetType: "EXPERIMENT", targetId } }))
  })

  it("authorizes a single observation through its binding and product target", async () => {
    const observation = { id: "observation", workspaceId: workspace, bindingId: "binding", revisionId: "rev", refreshKey: "key", windowKind: "BASELINE", snapshotJson: "{}", dataJson: '{"value":1,"series":[],"completeness":"COMPLETE","provenance":{}}', retrievedAt: new Date() }
    db.metricObservation.findFirst.mockResolvedValue(observation)
    db.metricBinding.findFirst.mockResolvedValue({ id: "binding", workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: "709655a2-35de-436b-a371-a170781445d7", baselineJson: '{}', followupJson: '{}', active: false })
    db.experiment.findFirst.mockResolvedValue(null)

    await expect(getObservation(actor, workspace, observation.id)).rejects.toThrow("NOT_FOUND_OR_ACCESS_DENIED")
    expect(db.metricObservation.findFirst).toHaveBeenCalledWith({ where: { id: observation.id, workspaceId: workspace } })
  })
})

describe("analytics refresh concurrency", () => {
  const bindingId = "f3f35aa4-2cb5-4d36-9b45-bc3d45f1771d"
  const requestId = "bcf303f0-7740-413a-9f08-9c857b184c35"
  beforeEach(() => {
    process.env.ANALYTICS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
    db.experiment.findFirst.mockResolvedValue({ id: bindingId })
    db.experiment.updateMany.mockResolvedValue({ count: 1 })
    db.metricBinding.findFirst.mockResolvedValue({ id: bindingId, workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: bindingId, baselineJson: '{"since":"2026-01-01","until":"2026-01-01"}', followupJson: '{"since":"2026-01-02","until":"2026-01-02"}', active: true })
    db.metricDefinition.findFirst.mockResolvedValue({ id: "metric", workspaceId: workspace, revision: 1, currentRevisionId: "rev", archived: false })
    db.metricRevision.findFirst.mockResolvedValue({ ...input, id: "rev", revision: 1, queryJson: JSON.stringify(input.query) })
    db.analyticsConnection.findFirst.mockResolvedValue({ id: input.connectionId, workspaceId: workspace, projectId: "p", teamId: null, generation: 1, secretEncrypted: encrypt("secret", process.env.ANALYTICS_SECRET_ENCRYPTION_KEY), enabled: true })
    db.analyticsConnection.updateMany.mockResolvedValue({ count: 1 }); db.metricBinding.updateMany.mockResolvedValue({ count: 1 }); db.metricDefinition.updateMany.mockResolvedValue({ count: 1 })
    db.metricObservation.create.mockImplementation(({ data }) => ({ id: "observation", ...data }))
    providerFetch.mockResolvedValue({ value: 12, series: [], completeness: "COMPLETE", provenance: {}, note: null })
  })
  it("replaces comparison with tracking and back without changing original evidence", async () => {
    const original = await db.metricBinding.findFirst()
    db.metricBinding.create.mockImplementation(async ({ data }) => ({ id: "replacement", active: true, ...data }))
    const tracked = await updateBinding(actor, workspace, bindingId, { baseline: null, followup: { version: 1, mode: "rolling", days: 7 } })
    expect(tracked).toMatchObject({ mode: "tracking", baseline: null, metricId: original.metricId, revisionId: original.revisionId, replacesBindingId: bindingId })
    const persisted = { ...original, id: tracked.id, baselineJson: "null", followupJson: JSON.stringify(tracked.followup), targetValue: 10 }
    db.metricBinding.findFirst.mockResolvedValue(persisted)
    const targetOnly = await updateBinding(actor, workspace, tracked.id, { target: 12 })
    expect(targetOnly).toMatchObject({ mode: "tracking", followup: tracked.followup, baseline: null, targetValue: 12 })
    const compared = await updateBinding(actor, workspace, tracked.id, { baseline: { since: "2026-01-01", until: "2026-01-07" }, followup: { since: "2026-01-08", until: "2026-01-14" } })
    expect(compared).toMatchObject({ mode: "comparison", metricId: original.metricId, revisionId: original.revisionId })
    expect(db.metricObservation.deleteMany).not.toHaveBeenCalled()
    expect(db.metricBinding.updateMany.mock.calls.every(([call]) => call.data.active === false)).toBe(true)
  })
  it("replays a competing tracking refresh with exactly one persisted observation", async () => {
    const original = await db.metricBinding.findFirst()
    db.metricBinding.findFirst.mockResolvedValue({ ...original, baselineJson: "null", followupJson: '{"version":1,"mode":"rolling","days":30}' })
    const saved = new Map<string, Record<string, unknown>>()
    db.metricObservation.findMany.mockImplementation(async () => [...saved.values()])
    db.metricObservation.create.mockImplementation(async ({ data }) => {
      if (saved.has(data.refreshKey)) throw new Error("unique key")
      const row = { id: "observation", ...data }; saved.set(data.refreshKey, row); return row
    })
    const [first, second] = await Promise.all([refreshBinding(actor, workspace, bindingId, requestId), refreshBinding(actor, workspace, bindingId, requestId)])
    expect(saved.size).toBe(1)
    expect(first).toEqual(second)
    expect(first[0].windowKind).toBe("FOLLOWUP")
  })
  it("replays the same refresh without fetching or adding evidence again", async () => {
    const result = await refreshBinding(actor, workspace, bindingId, requestId)
    expect(result).toHaveLength(2)
    const saved = db.metricObservation.create.mock.calls.map(([call]) => ({ id: "observation", ...call.data }))
    db.metricObservation.findMany.mockResolvedValue(saved)
    providerFetch.mockClear(); db.metricObservation.create.mockClear()
    expect(await refreshBinding(actor, workspace, bindingId, requestId)).toHaveLength(2)
    expect(providerFetch).not.toHaveBeenCalled(); expect(db.metricObservation.create).not.toHaveBeenCalled()
  })
  it("captures only follow-up for tracking and replays the original dates after UTC midnight", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-09-24T23:59:59Z"))
      db.metricBinding.findFirst.mockResolvedValue({ id: bindingId, workspaceId: workspace, metricId: "metric", revisionId: "rev", targetType: "EXPERIMENT", targetId: bindingId, baselineJson: "null", followupJson: '{"version":1,"mode":"rolling","days":30}', active: true })
      const result = await refreshBinding(actor, workspace, bindingId, requestId)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ windowKind: "FOLLOWUP", snapshot: { window: { since: "2026-08-25", until: "2026-09-23" }, logicalWindow: { version: 1, mode: "rolling", days: 30 }, attemptStartedAt: "2026-09-24T23:59:59.000Z" } })
      expect(providerFetch).toHaveBeenCalledTimes(1)
      const saved = db.metricObservation.create.mock.calls.map(([call]) => ({ id: "observation", ...call.data }))
      db.metricObservation.findMany.mockResolvedValue(saved)
      providerFetch.mockClear()
      vi.setSystemTime(new Date("2026-09-25T00:00:01Z"))
      expect(await refreshBinding(actor, workspace, bindingId, requestId)).toEqual(result)
      expect(providerFetch).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it("rejects a connection rotated during the external fetch", async () => {
    db.analyticsConnection.updateMany.mockResolvedValue({ count: 0 })
    db.analyticsConnection.findFirst
      .mockResolvedValueOnce({ id: input.connectionId, workspaceId: workspace, projectId: "p", teamId: null, generation: 1, secretEncrypted: encrypt("secret", process.env.ANALYTICS_SECRET_ENCRYPTION_KEY!), enabled: true })
      .mockResolvedValueOnce(null)
    await expect(refreshBinding(actor, workspace, bindingId, requestId)).rejects.toThrow("CONNECTION_CHANGED")
    expect(db.metricObservation.create).not.toHaveBeenCalled()
  })
  it("fails closed when the workspace is deleted while the provider is fetching", async () => {
    db.workspace.updateMany.mockResolvedValue({ count: 0 })
    await expect(refreshBinding(actor, workspace, bindingId, requestId)).rejects.toThrow("NOT_FOUND")
    expect(db.metricObservation.create).not.toHaveBeenCalled()
  })
  it("rejects archiving during fetch before persisting evidence", async () => {
    db.metricDefinition.updateMany.mockResolvedValue({ count: 0 })
    await expect(refreshBinding(actor, workspace, bindingId, requestId)).rejects.toThrow("METRIC_ARCHIVED")
    expect(db.metricObservation.create).not.toHaveBeenCalled()
  })
  it("does not overwrite a newer attempt status when an older fetch fails", async () => {
    providerFetch.mockRejectedValue(new Error("do not leak this token"))
    await expect(refreshBinding(actor, workspace, bindingId, requestId)).rejects.toThrow("REFRESH_FAILED")
    const failureWrite = db.metricBinding.updateMany.mock.calls.at(-1)![0]
    expect(failureWrite.where.lastAttemptId).toMatch(/^[a-f0-9-]{36}$/)
    expect(failureWrite.data).not.toHaveProperty("lastAttemptAt")
  })
  it("surfaces credential failures in connection health without overwriting a newer success or rotation", async () => {
    providerFetch.mockRejectedValue(new AnalyticsError("AUTHENTICATION"))
    await expect(refreshBinding(actor, workspace, bindingId, requestId)).rejects.toThrow("AUTHENTICATION")
    expect(db.analyticsConnection.updateMany).toHaveBeenCalledWith({ where: { id: input.connectionId, workspaceId: workspace, generation: 1, enabled: true, updatedAt: { lte: expect.any(Date) } }, data: { health: "AUTHENTICATION", updatedAt: expect.any(Date) } })
  })
  it("does not let an older success overwrite a newer failed connection health", async () => {
    let resolveOld!: (value: { value: number; series: never[]; completeness: "COMPLETE"; provenance: object; note: null }) => void
    const oldFetch = new Promise<{ value: number; series: never[]; completeness: "COMPLETE"; provenance: object; note: null }>(resolve => { resolveOld = resolve })
    providerFetch
      .mockImplementationOnce(() => oldFetch)
      .mockImplementationOnce(() => oldFetch)
      .mockRejectedValue(new AnalyticsError("AUTHENTICATION"))
    let health = "CONNECTED"
    let healthUpdatedAt = new Date(0)
    db.analyticsConnection.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.updatedAt?.lte && healthUpdatedAt > where.updatedAt.lte) return { count: 0 }
      if (data.health) health = data.health
      if (data.updatedAt) healthUpdatedAt = data.updatedAt
      return { count: 1 }
    })

    const oldRefresh = refreshBinding(actor, workspace, bindingId, requestId)
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(2))
    await expect(refreshBinding(actor, workspace, bindingId, "a3b6ea42-b8e8-4f17-8cda-c537acdf22f7")).rejects.toThrow("AUTHENTICATION")
    expect(health).toBe("AUTHENTICATION")

    resolveOld({ value: 12, series: [], completeness: "COMPLETE", provenance: {}, note: null })
    await expect(oldRefresh).resolves.toHaveLength(2)
    expect(health).toBe("AUTHENTICATION")
  })
})
