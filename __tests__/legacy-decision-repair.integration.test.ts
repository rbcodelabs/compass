import { randomUUID } from "node:crypto"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { repairLegacyDecisionRequests, type LegacyDecisionRepairClient } from "@/lib/legacy-decision-repair"

const databaseUrl = process.env.LEGACY_DECISION_REPAIR_DATABASE_URL
const run = databaseUrl ? describe : describe.skip

run("legacy decision repair PostgreSQL transaction", () => {
  const ids = { organization: randomUUID(), workspace: randomUUID(), experiment: randomUUID(), request: randomUUID(), revision: randomUUID() }
  const sourceFingerprint = "e".repeat(64)
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "compass_dev" }) })

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: ids.organization, slug: `repair-${ids.organization}`, name: "Repair integration" } })
    await prisma.workspace.create({ data: { id: ids.workspace, organizationId: ids.organization, slug: "repair", name: "Repair workspace" } })
    await prisma.experiment.create({ data: { id: ids.experiment, workspaceId: ids.workspace, title: "Readable experiment", hypothesis: "Safe repair", method: "Integration test", killCondition: "Any write outside the fixture" } })
    await prisma.reviewRequest.create({ data: { id: ids.request, workspaceId: ids.workspace, gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: randomUUID(), state: "DRAFT", revisionCount: 0, decisionCycle: 1 } })
    await prisma.reviewRevision.create({ data: {
      id: ids.revision,
      requestId: ids.request,
      revisionNumber: 1,
      fingerprint: sourceFingerprint,
      title: "Repair this context?",
      summary: `Source IDs: experiment ${ids.experiment}. Source version: experiment old. Every outcome maps to NO_ACTION.`,
      packetJson: JSON.stringify({ schemaVersion: "tracked-decision/v1", question: "Repair this context?", context: `Source IDs: experiment ${ids.experiment}. Source version: experiment old. Every outcome maps to NO_ACTION.`, entity: { type: "EXPERIMENT", id: ids.experiment, title: "Old label" } }),
      requiredRole: "ADMIN",
      options: { create: [{ actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 }] },
    } })
    await prisma.reviewRequest.update({ where: { id: ids.request }, data: { state: "PENDING", currentRevisionId: ids.revision, revisionCount: 1 } })
  })

  afterAll(async () => {
    await prisma.reviewOption.deleteMany({ where: { revision: { requestId: ids.request } } })
    await prisma.reviewRequest.updateMany({ where: { id: ids.request }, data: { currentRevisionId: null } })
    await prisma.reviewRevision.deleteMany({ where: { requestId: ids.request } })
    await prisma.reviewRequest.deleteMany({ where: { id: ids.request } })
    await prisma.experiment.deleteMany({ where: { id: ids.experiment } })
    await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.organization.deleteMany({ where: { id: ids.organization } })
    await prisma.$disconnect()
    if (!pool.ended) await pool.end()
  })

  it("atomically appends a repaired revision and preserves the pending cycle", async () => {
    const report = await repairLegacyDecisionRequests(prisma as unknown as LegacyDecisionRepairClient, {
      workspaceId: ids.workspace,
      requests: [{ requestId: ids.request, expectedRevisionId: ids.revision, expectedFingerprint: sourceFingerprint, references: [{ type: "EXPERIMENT", id: ids.experiment }] }],
    }, { apply: true })

    expect(report.requests[0].status).toBe("APPLIED")
    const request = await prisma.reviewRequest.findUniqueOrThrow({ where: { id: ids.request }, include: { currentRevision: { include: { options: true } }, revisions: { orderBy: { revisionNumber: "asc" } }, decisions: true } })
    expect(request).toMatchObject({ state: "PENDING", decisionCycle: 1, revisionCount: 2, decisions: [] })
    expect(request.currentRevision).toMatchObject({ revisionNumber: 2, title: "Repair this context?" })
    expect(request.currentRevision?.options).toHaveLength(1)
    expect(request.revisions[0]).toMatchObject({ id: ids.revision, fingerprint: sourceFingerprint, supersededAt: expect.any(Date) })
    expect(JSON.parse(request.revisions[0].packetJson)).toMatchObject({ schemaVersion: "tracked-decision/v1", entity: { title: "Old label" } })

    const replay = await repairLegacyDecisionRequests(prisma as unknown as LegacyDecisionRepairClient, {
      workspaceId: ids.workspace,
      requests: [{ requestId: ids.request, expectedRevisionId: ids.revision, expectedFingerprint: sourceFingerprint, references: [{ type: "EXPERIMENT", id: ids.experiment }] }],
    }, { apply: true })
    expect(replay.requests[0].status).toBe("ALREADY_APPLIED")
    expect(await prisma.reviewRevision.count({ where: { requestId: ids.request } })).toBe(2)
  })
})
