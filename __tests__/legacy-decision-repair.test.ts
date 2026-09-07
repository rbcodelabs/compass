import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DecisionLongForm } from "@/components/decisions/decision-long-form"
import {
  buildLegacyDecisionRepairPlan,
  repairLegacyDecisionRequests,
  type LegacyDecisionRepairManifest,
} from "@/lib/legacy-decision-repair"

const IDS = {
  workspace: "10000000-0000-4000-8000-000000000001",
  request: "10000000-0000-4000-8000-000000000002",
  revision: "10000000-0000-4000-8000-000000000003",
  experiment: "10000000-0000-4000-8000-000000000004",
  assumption: "10000000-0000-4000-8000-000000000005",
  solution: "10000000-0000-4000-8000-000000000006",
  opportunity: "10000000-0000-4000-8000-000000000007",
  result: "10000000-0000-4000-8000-000000000008",
  task: "10000000-0000-4000-8000-000000000009",
}

const fingerprint = "a".repeat(64)

function legacyContext() {
  return "Tracking-only experiment prerequisite review. Recommendation: proceed with the smallest test. Evidence remains incomplete. "
    + `Source IDs: experiment ${IDS.experiment}; assumption ${IDS.assumption}; solution ${IDS.solution}; opportunity ${IDS.opportunity}; result ${IDS.result}. `
    + "Source version: experiment 2026-08-01T00:00:00.000Z; result 2026-08-02T00:00:00.000Z; evidence none. Every outcome maps to NO_ACTION."
}

function manifest(overrides: Partial<LegacyDecisionRepairManifest["requests"][number]> = {}): LegacyDecisionRepairManifest {
  return {
    workspaceId: IDS.workspace,
    requests: [{
      requestId: IDS.request,
      expectedRevisionId: IDS.revision,
      expectedFingerprint: fingerprint,
      references: [
        { type: "EXPERIMENT", id: IDS.experiment },
        { type: "ASSUMPTION", id: IDS.assumption },
        { type: "SOLUTION", id: IDS.solution },
        { type: "OPPORTUNITY", id: IDS.opportunity },
        { type: "EXPERIMENT_RESULT", id: IDS.result },
      ],
      ...overrides,
    }],
  }
}

function legacyRequest(overrides: Record<string, unknown> = {}) {
  const packet = {
    schemaVersion: "tracked-decision/v1",
    question: "Should we proceed?",
    context: legacyContext(),
    entity: { type: "EXPERIMENT", id: IDS.experiment, title: "Old experiment label" },
  }
  return {
    id: IDS.request,
    workspaceId: IDS.workspace,
    gateType: "TRACKED_DECISION",
    state: "PENDING",
    currentRevisionId: IDS.revision,
    revisionCount: 1,
    decisionCycle: 1,
    currentRevision: {
      id: IDS.revision,
      revisionNumber: 1,
      fingerprint,
      sourceFingerprint: null,
      title: "Should we proceed?",
      summary: legacyContext(),
      packetJson: JSON.stringify(packet),
      requiredRole: "ADMIN",
      expiresAt: null,
      supersededAt: null,
      options: [
        { actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
        { actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
      ],
      decisions: [],
    },
    decisions: [],
    workspace: { id: IDS.workspace, slug: "compass", organization: { slug: "rbcodelabs" } },
    ...overrides,
  }
}

function prisma(request = legacyRequest()) {
  const tx = {
    reviewRequest: { findFirst: vi.fn().mockResolvedValue(request), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    reviewRevision: { create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "10000000-0000-4000-8000-000000000099", ...data })), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  return {
    reviewRequest: { findFirst: vi.fn().mockResolvedValue(request) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ id: IDS.workspace, name: "Compass", slug: "compass", updatedAt: new Date("2026-08-01T00:00:00Z"), organization: { slug: "rbcodelabs" } }) },
    experiment: { findFirst: vi.fn().mockResolvedValue({ id: IDS.experiment, title: "Clickable experiment", updatedAt: new Date("2026-08-01T00:00:00Z"), workspaceId: IDS.workspace }) },
    assumption: { findFirst: vi.fn().mockResolvedValue({ id: IDS.assumption, title: "Riskiest assumption", updatedAt: new Date("2026-08-02T00:00:00Z"), solution: { opportunity: { workspaceId: IDS.workspace } } }) },
    solution: { findFirst: vi.fn().mockResolvedValue({ id: IDS.solution, title: "Candidate solution", updatedAt: new Date("2026-08-03T00:00:00Z"), opportunity: { workspaceId: IDS.workspace } }) },
    opportunity: { findFirst: vi.fn().mockResolvedValue({ id: IDS.opportunity, title: "Customer opportunity", updatedAt: new Date("2026-08-04T00:00:00Z"), workspaceId: IDS.workspace }) },
    experimentResult: { findFirst: vi.fn().mockResolvedValue({ id: IDS.result, note: "8 of 10 succeeded", createdAt: new Date("2026-08-05T00:00:00Z"), experiment: { id: IDS.experiment, workspaceId: IDS.workspace } }) },
    task: { findFirst: vi.fn().mockResolvedValue({ id: IDS.task, title: "Legacy [Decision] <Review> & task", updatedAt: new Date("2026-08-06T00:00:00Z"), workspaceId: IDS.workspace }) },
    evidence: { findFirst: vi.fn() },
    roadmapItem: { findFirst: vi.fn() },
    doc: { findFirst: vi.fn() },
    feedbackItem: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback) => callback(tx)),
    _tx: tx,
  }
}

describe("legacy tracked-decision presentation repair", () => {
  beforeEach(() => vi.clearAllMocks())

  it("builds a deterministic v2 plan while preserving prose and reference order", async () => {
    const first = await buildLegacyDecisionRepairPlan(prisma(), manifest().requests[0], IDS.workspace)
    const second = await buildLegacyDecisionRepairPlan(prisma(), manifest().requests[0], IDS.workspace)

    expect(first.status).toBe("READY")
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.packet?.sources.map((source) => `${source.type}:${source.id}`)).toEqual([
      `ASSUMPTION:${IDS.assumption}`,
      `SOLUTION:${IDS.solution}`,
      `OPPORTUNITY:${IDS.opportunity}`,
    ])
    expect(first.packet?.context).toContain("Recommendation: proceed with the smallest test.")
    expect(first.packet?.context).toContain("## Sources")
    expect(first.packet?.context).toContain("- Experiment: [Clickable experiment]")
    expect(first.packet?.context).toContain(`[Clickable experiment](/rbcodelabs/compass?detail=experiment%3A${IDS.experiment})`)
    expect(first.packet?.context).toContain(`[Result: 8 of 10 succeeded](/rbcodelabs/compass?detail=experiment%3A${IDS.experiment})`)
    expect(first.packet?.context).not.toContain("Source IDs:")
    expect(first.packet?.context).not.toContain("Source version:")
    expect(first.packet?.repair.audit).toEqual({ sourceVersion: "experiment 2026-08-01T00:00:00.000Z; result 2026-08-02T00:00:00.000Z; evidence none" })
    expect(first.packet?.context).toContain("titles and destinations were resolved during presentation repair")
    const visibleText = first.packet?.context.replace(/\]\([^)]+\)/g, "]")
    expect(visibleText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
    const rendered = renderToStaticMarkup(createElement(DecisionLongForm, { content: first.packet?.context ?? "" }))
    expect(rendered).toContain("<h2>Sources</h2>")
    expect(rendered).toContain("<ul>")
    expect(rendered.replace(/<[^>]+>/g, "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
  })

  it("defaults to dry-run and performs no transaction or writes", async () => {
    const db = prisma()
    const report = await repairLegacyDecisionRequests(db, manifest())

    expect(report.mode).toBe("DRY_RUN")
    expect(report.requests[0].status).toBe("READY")
    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db._tx.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("applies with a pending v1 CAS, clones options, and preserves the decision cycle", async () => {
    const db = prisma()
    const report = await repairLegacyDecisionRequests(db, manifest(), { apply: true })

    expect(report.requests[0].status).toBe("APPLIED")
    const revision = db._tx.reviewRevision.create.mock.calls[0][0].data
    expect(revision).toMatchObject({
      requestId: IDS.request,
      revisionNumber: 2,
      title: "Should we proceed?",
      summary: expect.stringContaining("[Clickable experiment]"),
      requiredRole: "ADMIN",
      options: { create: legacyRequest().currentRevision.options },
    })
    expect(db._tx.reviewRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: IDS.request,
        workspaceId: IDS.workspace,
        gateType: "TRACKED_DECISION",
        state: "PENDING",
        currentRevisionId: IDS.revision,
        revisionCount: 1,
        decisionCycle: 1,
        currentRevision: { is: { fingerprint, decisions: { none: {} } } },
        decisions: { none: {} },
      },
      data: expect.objectContaining({ currentRevisionId: "10000000-0000-4000-8000-000000000099", revisionCount: 2, decisionCycle: 1 }),
    })
    expect(db._tx.reviewRevision.updateMany).toHaveBeenCalledWith({
      where: { id: IDS.revision, requestId: IDS.request, fingerprint, supersededAt: null, decisions: { none: {} } },
      data: { supersededAt: expect.any(Date) },
    })
    expect(legacyRequest().currentRevision.summary).toBe(legacyContext())
  })

  it("fails closed when a referenced object is missing or outside the workspace", async () => {
    const db = prisma()
    db.opportunity.findFirst.mockResolvedValue(null)

    const report = await repairLegacyDecisionRequests(db, manifest())

    expect(report.requests[0]).toMatchObject({ status: "ERROR", code: "REFERENCE_NOT_FOUND" })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("fails closed when prose contains a UUID absent from the typed allowlist", async () => {
    const unknown = "20000000-0000-4000-8000-000000000001"
    const request = legacyRequest()
    request.currentRevision.packetJson = JSON.stringify({
      ...JSON.parse(request.currentRevision.packetJson),
      context: `${legacyContext()}\n\nUnknown source: ${unknown}`,
    })
    const db = prisma(request)

    const report = await repairLegacyDecisionRequests(db, manifest())

    expect(report.requests[0]).toMatchObject({ status: "ERROR", code: "UNMAPPED_UUID" })
  })

  it.each([
    ["DECIDED", "SKIPPED_DECIDED"],
    ["DRAFT", "NOT_ELIGIBLE"],
  ])("does not repair a %s request", async (state, status) => {
    const db = prisma(legacyRequest({ state }))
    const report = await repairLegacyDecisionRequests(db, manifest(), { apply: true })

    expect(report.requests[0].status).toBe(status)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("is idempotent when the expected revision is already superseded by its repair", async () => {
    const db = prisma(legacyRequest({
      currentRevisionId: "10000000-0000-4000-8000-000000000099",
      currentRevision: {
        ...legacyRequest().currentRevision,
        id: "10000000-0000-4000-8000-000000000099",
        revisionNumber: 2,
        fingerprint: "c".repeat(64),
        packetJson: JSON.stringify({ schemaVersion: "tracked-decision/v2", repair: { kind: "legacy-presentation/v1", sourceRevisionId: IDS.revision, sourceFingerprint: fingerprint } }),
      },
    }))

    const report = await repairLegacyDecisionRequests(db, manifest(), { apply: true })

    expect(report.requests[0].status).toBe("ALREADY_APPLIED")
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("rolls back when the request changes after dry-run planning", async () => {
    const db = prisma()
    db._tx.reviewRequest.findFirst.mockResolvedValue({ ...legacyRequest(), currentRevisionId: "10000000-0000-4000-8000-000000000088" })

    const report = await repairLegacyDecisionRequests(db, manifest(), { apply: true })

    expect(report.requests[0]).toMatchObject({ status: "ERROR", code: "CAS_CONFLICT" })
    expect(db._tx.reviewRevision.create).not.toHaveBeenCalled()
  })

  it("does not supersede history when the final request CAS loses a race", async () => {
    const db = prisma()
    db._tx.reviewRequest.updateMany.mockResolvedValue({ count: 0 })

    const report = await repairLegacyDecisionRequests(db, manifest(), { apply: true })

    expect(report.requests[0]).toMatchObject({ status: "ERROR", code: "CAS_CONFLICT" })
    expect(db._tx.reviewRevision.updateMany).not.toHaveBeenCalled()
  })

  it("keeps all ordered roadmap refs linked while limiting source cards to twelve", async () => {
    const opportunityIds = Array.from({ length: 13 }, (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)
    const context = `ACTIVE Opportunity IDs:\n${opportunityIds.join("\n")}\n\nLegacy Task UUID: ${IDS.task}\nFingerprint: ${"d".repeat(64)}.`
    const request = legacyRequest()
    request.currentRevision.packetJson = JSON.stringify({ ...JSON.parse(request.currentRevision.packetJson), context, entity: { type: "WORKSPACE", id: IDS.workspace, title: "Compass" } })
    const refs = [...opportunityIds.map((id) => ({ type: "OPPORTUNITY" as const, id })), { type: "TASK" as const, id: IDS.task }]
    const db = prisma(request)
    db.opportunity.findFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id, title: `Opportunity ${opportunityIds.indexOf(where.id) + 1}`, updatedAt: new Date("2026-08-04T00:00:00Z"), workspaceId: IDS.workspace }))

    const plan = await buildLegacyDecisionRepairPlan(db, manifest({ references: refs }).requests[0], IDS.workspace)

    expect(plan.status).toBe("READY")
    expect(plan.packet?.sources).toHaveLength(12)
    expect(plan.packet?.sources.map((source) => source.id)).toEqual(opportunityIds.slice(0, 12))
    expect(plan.packet?.context).toContain("## ACTIVE Opportunities (original order)")
    expect(plan.packet?.context).toContain("1. [Opportunity 1]")
    expect(plan.packet?.context).toContain("13. [Opportunity 13]")
    expect(plan.packet?.context).not.toContain("ACTIVE Opportunity IDs:")
    expect(plan.packet?.context).not.toContain("Fingerprint: " + "d".repeat(64))
    expect(plan.packet?.repair.audit).toEqual({ sourceFingerprint: "d".repeat(64) })
    for (let index = 0; index < opportunityIds.length; index += 1) {
      expect(plan.packet?.context).toContain(`[Opportunity ${index + 1}]`)
    }
    expect(plan.packet?.context).toContain("[Legacy \\[Decision\\] &lt;Review&gt; &amp; task]")
    const visibleText = plan.packet?.context.replace(/\]\([^)]+\)/g, "]")
    expect(visibleText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
    const rendered = renderToStaticMarkup(createElement(DecisionLongForm, { content: plan.packet?.context ?? "" }))
    expect(rendered).toContain("<ol>")
    expect(rendered).toContain("Legacy [Decision] &lt;Review&gt; &amp; task")
  })

  it("formats the historical NEXT queue as an ordered roadmap-item list", async () => {
    const roadmapIds = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"]
    const context = `Tracking-only roadmap capacity decision.\n\nCurrent NEXT IDs in order:\n${roadmapIds.join("\n")}\n\nRecommendation: keep the explicit order. Source fingerprint: sha256:${"f".repeat(64)}. Legacy non-authoritative Task ${IDS.task} is stale.`
    const request = legacyRequest()
    request.currentRevision.packetJson = JSON.stringify({ ...JSON.parse(request.currentRevision.packetJson), context, entity: { type: "WORKSPACE", id: IDS.workspace, title: "Compass" } })
    const db = prisma(request)
    db.roadmapItem.findFirst.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id, title: `Queue item ${roadmapIds.indexOf(where.id) + 1}`, updatedAt: new Date("2026-08-04T00:00:00Z"), workspaceId: IDS.workspace }))
    const references = [...roadmapIds.map((id) => ({ type: "ROADMAP_ITEM" as const, id })), { type: "TASK" as const, id: IDS.task }]

    const plan = await buildLegacyDecisionRepairPlan(db, manifest({ references }).requests[0], IDS.workspace)

    expect(plan.status).toBe("READY")
    expect(plan.packet?.context).toContain("## Current NEXT queue (original order)")
    expect(plan.packet?.context).toContain("1. [Queue item 1]")
    expect(plan.packet?.context).toContain("2. [Queue item 2]")
    expect(plan.packet?.repair.audit).toEqual({ sourceFingerprint: `sha256:${"f".repeat(64)}` })
  })
})
