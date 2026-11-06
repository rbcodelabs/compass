/**
 * Wide-coverage round trip: seeds a row in most exported models (research, decisions, metrics, OKRs, roadmap,
 * launch checklists, card sort, capability packs, ...) and proves that, after import,
 *   - every model keeps its row count,
 *   - NO column of any imported row still contains an id from the source workspace (nothing leaks or dangles),
 *   - every parent reference in the declared PARENT map resolves inside the new workspace.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { zipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import type { BlobAdapters } from "@/lib/workspace-export/blobs"
import { BundleReader } from "@/lib/workspace-export/bundle"
import { exportWorkspaceToBuffer } from "@/lib/workspace-export/export"
import { importWorkspaceBundle } from "@/lib/workspace-export/import"
import { encodeRow } from "@/lib/workspace-export/codec"
import { PARENT, delegateFor, exportOrder, modelHasId, modelHasWorkspaceId } from "@/lib/workspace-export/scope"

const databaseUrl = process.env.WORKSPACE_EXPORT_DATABASE_URL

function memoryStorage(): ArtifactStorage {
  const files = new Map<string, Uint8Array>()
  return { async put(p, b) { files.set(p, b); return { pathname: p } }, async get(p) { return files.get(p) ?? null }, async del(p) { files.delete(p) } }
}

describe.skipIf(!databaseUrl)("workspace export: wide model coverage", () => {
  const schema = `wxc_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  const research = memoryStorage()
  const blobs: BlobAdapters = {
    artifact: memoryStorage(),
    research,
    async fetchPublic() { return null },
    async putPublic(p) { return `https://public.example/${p}` },
    async delPublic() {},
  }
  let wsId: string
  let adminId: string
  let orgId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = () => prisma as any

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires isolated local compass_e2e")
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 120_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient

    const org = await db().organization.create({ data: { slug: "cov", name: "Cov" } })
    orgId = org.id
    const admin = await db().user.create({ data: { email: "cov@x.dev", name: "Cov" } })
    adminId = admin.id
    await db().organizationMember.create({ data: { organizationId: orgId, userId: adminId, role: "ADMIN" } })
    const ws = await db().workspace.create({ data: { organizationId: orgId, slug: "wide", name: "Wide" } })
    wsId = ws.id

    const opp = await db().opportunity.create({ data: { workspaceId: wsId, title: "O", createdById: adminId } })
    const sol = await db().solution.create({ data: { workspaceId: ws.id, opportunityId: opp.id, title: "S" } })
    const task = await db().task.create({ data: { workspaceId: wsId, title: "T" } })
    await db().task.create({ data: { workspaceId: wsId, title: "child", parentTaskId: task.id } })
    await db().assumption.create({ data: { solutionId: sol.id, workspaceId: wsId, title: "A" } })
    await db().experiment.create({ data: { workspaceId: wsId, title: "E", hypothesis: "h", method: "m", killCondition: "k" } })

    const cycle = await db().oKRCycle.create({ data: { workspaceId: wsId, title: "Q", startDate: new Date(), endDate: new Date() } })
    const obj = await db().objective.create({ data: { workspaceId: ws.id, cycleId: cycle.id, title: "Obj" } })
    const kr = await db().keyResult.create({ data: { workspaceId: wsId, objectiveId: obj.id, title: "KR", target: 10 } })
    await db().checkIn.create({ data: { keyResultId: kr.id, value: 3 } })

    // Research
    const study = await db().researchStudy.create({ data: { workspaceId: wsId, name: "St", goal: "g", guide: "gd" } })
    const session = await db().researchSession.create({ data: { studyId: study.id } })
    const turn = await db().researchTurn.create({ data: { sessionId: session.id, role: "user", content: "hi", sequence: 1 } })
    const attPath = `research/${wsId}/${study.id}/${session.id}/att-abc.png`
    research.put(attPath, new Uint8Array([7, 7]))
    await db().researchAttachment.create({
      data: { workspaceId: wsId, studyId: study.id, sessionId: session.id, kind: "IMAGE", blobPathname: attPath, originalName: "a.png", mimeType: "image/png", sizeBytes: 2, sha256: "ab", idempotencyKey: "ik" },
    })
    const ev = await db().evidence.create({ data: { workspaceId: wsId, sourceType: "RESEARCH", excerpt: "x", opportunityId: opp.id } })
    await db().evidenceResearchSource.create({ data: { evidenceId: ev.id, researchTurnId: turn.id } })

    // Roadmap + launch checklist
    const rm = await db().roadmapItem.create({ data: { workspaceId: wsId, title: "RM", solutionId: sol.id } })
    await db().roadmapVote.create({ data: { roadmapItemId: rm.id, voterEmail: "v@x.dev" } })
    const tpl = await db().checklistTemplate.create({ data: { workspaceId: wsId, tier: "T1", name: "Tpl" } })
    await db().checklistTemplateItem.create({ data: { checklistTemplateId: tpl.id, label: "L" } })
    const lc = await db().launchChecklist.create({ data: { roadmapItemId: rm.id, checklistTemplateId: tpl.id, tier: "T1", templateSnapshot: JSON.stringify({ t: tpl.id }) } })
    await db().launchChecklistItem.create({ data: { launchChecklistId: lc.id, label: "L" } })

    // Decisions (bare, cross-linked ids inside JSON text)
    const req = await db().reviewRequest.create({ data: { workspaceId: wsId, gateType: "TRACKED_DECISION", subjectType: "TRACKED_DECISION", subjectId: randomUUID() } })
    const rev = await db().reviewRevision.create({ data: { requestId: req.id, revisionNumber: 1, fingerprint: "fp", title: "t", packetJson: JSON.stringify({ about: opp.id }) } })
    await db().reviewRequest.update({ where: { id: req.id }, data: { currentRevisionId: rev.id } })
    const opt = await db().reviewOption.create({ data: { revisionId: rev.id, actionKey: "A", label: "A", outcomeClass: "APPROVE", continuationKey: "NO_ACTION" } })
    const rec = await db().decisionRecord.create({ data: { workspaceId: wsId, requestId: req.id, revisionId: rev.id, optionId: opt.id, fingerprint: "f", actorUserId: adminId, actorRole: "ADMIN", idempotencyKey: "k" } })
    await db().decisionApplication.create({ data: { decisionId: rec.id, continuationKey: "NO_ACTION", targetType: "TASK", targetId: task.id, receiptKey: "r" } })
    await db().roadmapItem.update({ where: { id: rm.id }, data: { nowDecisionRecordId: rec.id } })

    // Metrics
    const revId = randomUUID()
    const metric = await db().metricDefinition.create({ data: { workspaceId: wsId, currentRevisionId: revId } })
    await db().metricRevision.create({ data: { id: revId, workspaceId: wsId, metricId: metric.id, revision: 1, name: "M", unit: "u", provider: "POSTHOG", queryJson: "{}" } })
    const bind = await db().metricBinding.create({ data: { workspaceId: wsId, metricId: metric.id, revisionId: revId, targetType: "OPPORTUNITY", targetId: opp.id, baselineJson: "{}", followupJson: "{}" } })
    await db().metricObservation.create({ data: { workspaceId: wsId, bindingId: bind.id, revisionId: revId, refreshKey: "r", windowKind: "W", snapshotJson: "{}", dataJson: "{}" } })

    // Card sort, fields, follow, modules, links
    const field = await db().customFieldDefinition.create({ data: { workspaceId: wsId, objectType: "OPPORTUNITY", name: "F", fieldType: "SELECT", options: [], order: 0 } })
    const round = await db().cardSortRound.create({ data: { workspaceId: wsId, name: "R", objectType: "OPPORTUNITY", fieldDefinitionId: field.id, createdById: adminId } })
    await db().cardSortProposal.create({ data: { roundId: round.id, userId: adminId, objectId: opp.id, proposedValue: "now" } })
    await db().follow.create({ data: { workspaceId: wsId, userId: adminId, subjectType: "OPPORTUNITY", subjectId: opp.id, state: "FOLLOWING", source: "MANUAL" } })
    await db().workspaceModule.create({ data: { workspaceId: wsId, moduleKey: "m", enabled: true } })
    await db().canvasNodePosition.create({ data: { workspaceId: wsId, entityType: "OPPORTUNITY", entityId: opp.id, x: 1, y: 2 } })
    const art = await db().artifact.create({ data: { workspaceId: wsId, title: "Art", sourceType: "EXTERNAL_LINK" } })
    await db().artifactLink.create({ data: { workspaceId: wsId, artifactId: art.id, linkedType: "OPPORTUNITY", linkedId: opp.id } })
    const fb = await db().feedbackItem.create({ data: { workspaceId: wsId, title: "FB" } })
    await db().feedbackVote.create({ data: { feedbackId: fb.id, voterEmail: "v@x.dev" } })
    await db().feedbackSource.create({ data: { workspaceId: wsId, name: "Src", allowedOrigins: [] } })
    const cm = await db().comment.create({ data: { workspaceId: wsId, targetType: "OPPORTUNITY", targetId: opp.id, body: "b", authorName: "A" } })
    await db().comment.create({ data: { workspaceId: wsId, targetType: "OPPORTUNITY", targetId: opp.id, body: "r", authorName: "A", parentId: cm.id } })
    await db().commentExternalAuthor.create({ data: { commentId: cm.id, embedTokenId: randomUUID() } })
    await db().commentElementAnchor.create({ data: { commentId: cm.id, artifactId: art.id, pageUrl: "u", pagePath: "/" } })
    await db().agent.create({ data: { name: "Bot", ownerType: "WORKSPACE", ownerWorkspaceId: wsId } })
    const wsAgent = await db().agent.findFirst({ where: { ownerWorkspaceId: wsId } })
    await db().workspaceDefaultAgent.create({ data: { workspaceId: wsId, agentId: wsAgent.id } })
    await db().opportunityObjectiveLink.create({ data: { workspaceId: wsId, opportunityId: opp.id, objectiveId: obj.id, origin: "MANUAL" } })
    await db().solutionKeyResultLink.create({ data: { workspaceId: wsId, solutionId: sol.id, keyResultId: kr.id } })
    await db().pMInterview.create({ data: { workspaceId: wsId, studyId: study.id, sessionId: session.id, initiatingUserId: adminId, targetType: "OPPORTUNITY", targetId: opp.id, contextSnapshotJson: "{}", fieldBaselineJson: "{}" } })
    await db().portalHomeLayout.create({ data: { workspaceId: wsId } })
    await db().savedView.create({ data: { organizationId: orgId, workspaceId: wsId, ownerId: adminId, name: "View" } })
    await db().sharedFieldOptionSet.create({ data: { workspaceId: wsId, name: "Set", options: [] } })
    await db().workspaceScoringConfig.create({ data: { workspaceId: wsId } })
    await db().cardSortNewEntry.create({ data: { roundId: round.id, userId: adminId, title: "New" } })
    const sc = await db().solutionComment.create({ data: { solutionId: sol.id, body: "b", authorName: "A" } })
    expect(sc.id).toBeTruthy()
    const docX = await db().doc.create({ data: { workspaceId: wsId, title: "Dx", content: "" } })
    await db().docComment.create({ data: { docId: docX.id, body: "b", authorName: "A" } })
    await db().docCommentAnchor.create({ data: { commentId: cm.id, anchorText: "t" } })
    await db().solutionPlanProposal.create({ data: { commentId: (await db().comment.create({ data: { workspaceId: wsId, targetType: "SOLUTION", targetId: sol.id, body: "p", authorName: "A" } })).id } })
    await db().experimentResult.create({ data: { experimentId: (await db().experiment.findFirst({ where: { workspaceId: wsId } })).id, note: "n" } })
    await db().feedbackElementAnchor.create({ data: { feedbackItemId: fb.id, feedbackSourceId: (await db().feedbackSource.findFirst({ where: { workspaceId: wsId } })).id, pageUrl: "u", pagePath: "/" } })
    await db().researchSynthesis.create({ data: { studyId: study.id, content: "c" } })
    const sm = await db().scoringModel.create({ data: { organizationId: orgId, name: "M" } })
    await db().solutionScore.create({ data: { solutionId: sol.id, scoringModelId: sm.id, modelVersion: 1, formulaSnapshot: {}, rawValues: {}, rawScore: 1, normalizedScore: 1 } })
    await db().decisionEvidenceRef.create({
      data: { reviewRevisionId: rev.id, evidenceType: "E", authorityProvider: "compass_decisions", authorityRecordId: randomUUID(), authorityLocator: "l", authorityChecksum: "c", subjectType: "TASK", subjectId: task.id, decisionOutcome: "APPROVE", decisionSourceVersion: "1", applicationStatus: "APPLIED", appliedAt: new Date(), applicationReceiptId: randomUUID(), verifiedAt: new Date(), verifierVersion: "1" },
    })
    const pack = await db().capabilityPack.create({ data: { workspaceId: wsId, packId: "p", sourceKey: "s", displayName: "Pack" } })
    const packVer = await db().capabilityPackVersion.create({
      data: { capabilityPackId: pack.id, semanticVersion: "1.0.0", sourceRepository: "r", sourceCommit: "c", sourcePath: "p", artifactSha256: "a", artifactPathname: "capability-packs/sha256/a.json", sdkCompatibility: "1", manifestJson: "{}", createdById: adminId },
    })
    await db().workspaceCapabilityPack.create({ data: { workspaceId: wsId, capabilityPackId: pack.id, capabilityPackVersionId: packVer.id, enabledSkillIds: "[]" } })
    const parentDoc = await db().doc.create({ data: { workspaceId: wsId, title: "P", content: "" } })
    await db().doc.create({ data: { workspaceId: wsId, title: "C", content: "", parentId: parentDoc.id } })
  }, 240_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await pool.end()
    }
  })

  it("keeps every row, leaks no source id, and every parent reference resolves in the new workspace", async () => {
    const bundle = await exportWorkspaceToBuffer(prisma, wsId, blobs)
    const report = await importWorkspaceBundle(prisma, bundle, { organizationId: orgId, importerUserId: adminId, blobs, nonce: "cov" })
    const newWs = report.workspaceId

    // Gather source ids and imported rows per model through the same scoping the exporter uses.
    const selectAll = async (workspaceId: string, model: string, known: Map<string, string[]>) => {
      const d = delegateFor(prisma, model)
      if (model === "Agent") return d.findMany({ where: { ownerType: "WORKSPACE", ownerWorkspaceId: workspaceId } })
      if (modelHasWorkspaceId(model)) return d.findMany({ where: { workspaceId } })
      const p = PARENT[model]
      return d.findMany({ where: { [p.fk]: { in: known.get(p.model) ?? [] } } })
    }
    const collect = async (workspaceId: string) => {
      const ids = new Map<string, string[]>()
      const rows = new Map<string, Record<string, unknown>[]>()
      for (const model of exportOrder()) {
        const r = await selectAll(workspaceId, model, ids)
        rows.set(model, r)
        if (modelHasId(model)) ids.set(model, r.map((x) => x.id as string))
      }
      return { ids, rows }
    }
    const source = await collect(wsId)
    const imported = await collect(newWs)

    const seeded = [...source.rows].filter(([, r]) => r.length > 0).map(([m]) => m)
    console.info("UNSEEDED:", exportOrder().filter((m) => !seeded.includes(m)).join(" "))
    expect(seeded.length).toBeGreaterThanOrEqual(62)
    for (const model of seeded) expect(imported.rows.get(model)?.length, `row count for ${model}`).toBe(source.rows.get(model)!.length)

    // No source id (row ids or the source workspace id) survives anywhere in imported data.
    const oldIds = new Set<string>([wsId, ...[...source.ids.values()].flat()])
    const leaks: string[] = []
    for (const [model, rows] of imported.rows) {
      for (const row of rows) {
        const text = JSON.stringify(encodeRow(model, row))
        for (const id of oldIds) if (text.includes(id)) leaks.push(`${model}: ${id}`)
      }
    }
    expect(leaks).toEqual([])

    // Parent references resolve to imported parents.
    for (const [model, p] of Object.entries(PARENT)) {
      const parents = new Set(imported.ids.get(p.model) ?? [])
      for (const row of imported.rows.get(model) ?? []) expect(parents.has(row[p.fk] as string), `${model}.${p.fk} dangling`).toBe(true)
    }

    // Cross-org import: org-scoped rows belong to the target org, never the source.
    const org2 = await db().organization.create({ data: { slug: "cov2", name: "Cov2" } })
    await db().organizationMember.create({ data: { organizationId: org2.id, userId: adminId, role: "ADMIN" } })
    const cross = await importWorkspaceBundle(prisma, bundle, { organizationId: org2.id, importerUserId: adminId, blobs, nonce: "cov-cross" })
    const crossWs = await db().workspace.findUnique({ where: { id: cross.workspaceId } })
    expect(crossWs.organizationId).toBe(org2.id)
    const crossViews = await db().savedView.findMany({ where: { workspaceId: cross.workspaceId } })
    expect(crossViews.length).toBe(1)
    expect(crossViews[0].organizationId).toBe(org2.id)

    // Spot checks on the trickiest links.
    const revs = imported.rows.get("ReviewRequest")![0]
    expect(imported.ids.get("ReviewRevision")).toContain(revs.currentRevisionId)
    const rm = imported.rows.get("RoadmapItem")![0]
    expect(imported.ids.get("DecisionRecord")).toContain(rm.nowDecisionRecordId)
    const att = imported.rows.get("ResearchAttachment")![0]
    expect(String(att.blobPathname)).toContain(newWs)
    expect(await research.get(String(att.blobPathname))).toBeTruthy()
    const ext = imported.rows.get("CommentExternalAuthor")![0]
    expect(ext.embedTokenId).toBeNull()
    const tasks = imported.rows.get("Task")!
    expect(tasks.filter((t) => t.parentTaskId).every((t) => imported.ids.get("Task")!.includes(t.parentTaskId as string))).toBe(true)
  }, 180_000)

  it("imports legacy rows that hold NULL in columns the schema now declares required (the column default applies)", async () => {
    const bundle = await exportWorkspaceToBuffer(prisma, wsId, blobs)
    const reader = new BundleReader(bundle)
    const files: Record<string, Uint8Array> = {}
    for (const n of reader.list("")) files[n] = reader.read(n)!
    // Assumption.source is `String @default("UI")`; real databases contain NULLs there from before the column existed.
    const name = reader.list("data/Assumption.")[0]
    const rows = reader.readText(name)!.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) r.source = null
    files[name] = new TextEncoder().encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const report = await importWorkspaceBundle(prisma, zipSync(files), { organizationId: orgId, importerUserId: adminId, blobs, nonce: "legacy-null", slug: "legacy-null" })
    const imported = await db().assumption.findMany({ where: { workspaceId: report.workspaceId } })
    expect(imported.length).toBe(rows.length)
    expect(imported.every((a: { source: string }) => a.source === "UI")).toBe(true)
  }, 120_000)
})
