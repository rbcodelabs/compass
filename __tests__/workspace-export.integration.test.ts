/**
 * Workspace export -> import round trip against a real PostgreSQL schema.
 * Proves: content is copied with fresh ids and consistent references, secrets
 * and runtime data are not exported, polymorphic and embedded ids are rewritten,
 * blobs are copied and their paths rewritten, work-item numbers and counters are
 * preserved, users are matched by email, a failed import leaves nothing behind,
 * and a retry with the same nonce is idempotent.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { zipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"
import type { AppPrismaClient } from "@/lib/db"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import type { BlobAdapters } from "@/lib/workspace-export/blobs"
import { BundleReader } from "@/lib/workspace-export/bundle"
import { WorkspaceExportRefusal, exportWorkspaceToBuffer } from "@/lib/workspace-export/export"
import { WorkspaceImportError, importWorkspaceBundle } from "@/lib/workspace-export/import"
import { MODEL_BUCKETS } from "@/lib/workspace-export/model-registry"

const databaseUrl = process.env.WORKSPACE_EXPORT_DATABASE_URL

function memoryStorage(): ArtifactStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async put(p, bytes) {
      files.set(p, bytes)
      return { pathname: p }
    },
    async get(p) {
      return files.get(p) ?? null
    },
    async del(p) {
      files.delete(p)
    },
  }
}

describe.skipIf(!databaseUrl)("workspace export/import round trip", () => {
  const schema = `wx_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
    let prisma: AppPrismaClient
  const artifact = memoryStorage()
  const research = memoryStorage()
  const publicBlobs = new Map<string, Uint8Array>()
  const blobs: BlobAdapters = {
    artifact,
    research,
    async fetchPublic(url) {
      const b = publicBlobs.get(url)
      return b ? { bytes: b, contentType: "image/png" } : null
    },
    async putPublic(path, bytes) {
      const url = `https://public.example/${path}`
      publicBlobs.set(url, bytes)
      return url
    },
    async delPublic(url) {
      publicBlobs.delete(url)
    },
  }

  let orgId: string
  let otherOrgId: string
  let wsId: string
  let aliceId: string
  let bobId: string
  let importerId: string
  let scoringModelId: string
  let oppId: string
  let docId: string
  let artifactId: string
  let bundle: Uint8Array

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Requires an isolated local compass_e2e URL without a schema override")
    }
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 120_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension)

    const org = await prisma.organization.create({ data: { slug: "src-org", name: "Source Org" } })
    const other = await prisma.organization.create({ data: { slug: "other-org", name: "Other Org" } })
    orgId = org.id
    otherOrgId = other.id
    const alice = await prisma.user.create({ data: { email: "alice@example.com", name: "Alice" } })
    const bob = await prisma.user.create({ data: { email: "bob@example.com", name: "Bob" } })
    const importer = await prisma.user.create({ data: { email: "importer@example.com", name: "Importer" } })
    aliceId = alice.id
    bobId = bob.id
    importerId = importer.id
    for (const u of [alice, bob]) await prisma.organizationMember.create({ data: { organizationId: orgId, userId: u.id, role: "MEMBER" } })

    const ws = await prisma.workspace.create({
      data: {
        organizationId: orgId,
        slug: "alpha",
        name: "Alpha",
        ssoEnabled: true,
        ssoSecretEncrypted: "SECRET-SSO",
        anthropicApiKeyEncrypted: "SECRET-KEY",
        anthropicApiKeyLast4: "1234",
      },
    })
    wsId = ws.id
    const sm = await prisma.scoringModel.create({ data: { organizationId: orgId, name: "RICE" } })
    scoringModelId = sm.id

    const squad = await prisma.squad.create({ data: { workspaceId: wsId, name: "Core", createdById: aliceId } })
    const opp = await prisma.opportunity.create({
      data: { workspaceId: wsId, title: "Faster onboarding", squadId: squad.id, createdById: aliceId, seqPrefix: "OPP", seqNumber: 42 },
    })
    oppId = opp.id
    const sol = await prisma.solution.create({ data: { workspaceId: wsId, opportunityId: opp.id, title: "Wizard", createdById: bobId } })
    await prisma.opportunityScore.create({ data: { opportunityId: opp.id, scoringModelId, scoredByUserId: bobId, modelVersion: 1, formulaSnapshot: {}, rawValues: {}, rawScore: 1, normalizedScore: 1 } })
    const task = await prisma.task.create({ data: { workspaceId: wsId, title: "Build wizard", createdById: aliceId, seqPrefix: "TASK", seqNumber: 7 } })
    await prisma.taskLink.create({ data: { taskId: task.id, linkedType: "SOLUTION", linkedId: sol.id } })
    await prisma.entityLink.create({
      data: { workspaceId: wsId, linkType: "RELATES_TO", fromType: "TASK", fromId: task.id, toType: "OPPORTUNITY", toId: opp.id },
    })
    await prisma.comment.create({
      data: { workspaceId: wsId, targetType: "OPPORTUNITY", targetId: opp.id, body: `See ${opp.id} and OPP-42`, authorId: aliceId, authorName: "Alice" },
    })
    await prisma.workspaceSequence.create({ data: { workspaceId: wsId, entityType: "opportunity", nextValue: 50 } })

    const imageName = `${randomUUID()}.png`
    artifact.files.set(`docs/${wsId}/images/${imageName}`, new Uint8Array([1, 2, 3]))
    const doc = await prisma.doc.create({
      data: {
        workspaceId: wsId,
        title: "Spec",
        content: `![x](/api/docs/images/${wsId}/${imageName}) and compass://opportunity/${opp.id}`,
        createdById: aliceId,
      },
    })
    docId = doc.id
    await prisma.docVersion.create({ data: { docId: doc.id, title: "Spec", content: "v1", createdById: aliceId } })

    const art = await prisma.artifact.create({ data: { workspaceId: wsId, title: "Mock", sourceType: "HTML_UPLOAD", createdById: aliceId } })
    artifactId = art.id
    const revId = randomUUID()
    const blobPath = `artifacts/${wsId}/${art.id}/${revId}-page.html`
    artifact.files.set(blobPath, new TextEncoder().encode("<!doctype html><p>hi</p>"))
    await prisma.artifactRevision.create({ data: { id: revId, artifactId: art.id, revisionNumber: 1, blobPathname: blobPath, createdById: aliceId } })

    const fb = await prisma.feedbackItem.create({ data: { workspaceId: wsId, title: "Bug", opportunityId: opp.id } })
    const fbUrl = "https://public.example/feedback/old/shot.png"
    publicBlobs.set(fbUrl, new Uint8Array([9, 9]))
    await prisma.feedbackAttachment.create({
      data: { feedbackItemId: fb.id, url: fbUrl, filename: "shot.png", fileType: "image/png", fileSize: 2 },
    })

    const field = await prisma.customFieldDefinition.create({
      data: { workspaceId: wsId, objectType: "OPPORTUNITY", name: "Timing", fieldType: "SELECT", options: [{ label: "Now", value: "now" }], order: 0 },
    })
    await prisma.customFieldValue.create({ data: { fieldId: field.id, objectId: opp.id, value: "now" } })
    await prisma.analyticsConnection.create({
      data: { workspaceId: wsId, provider: "POSTHOG", projectId: "p1", secretEncrypted: "SECRET-ANALYTICS", enabled: true },
    })

    // Data that must NOT be exported.
    await prisma.notification.create({ data: { workspaceId: wsId, recipientUserId: aliceId, kind: "X", actorType: "SYSTEM", dedupeKey: "k1", subjectType: "TASK", subjectId: task.id } })

    bundle = await exportWorkspaceToBuffer(prisma, wsId, blobs)
  }, 180_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await pool.end()
    }
  })

  it("exports only content models, with secrets stripped and no secret text anywhere", () => {
    const reader = new BundleReader(bundle)
    const models = reader
      .list("data/")
      .map((n) => /^data\/(\w+)\./.exec(n)![1])
    for (const m of new Set(models)) expect(MODEL_BUCKETS[m], m).toBe("CONTENT")
    expect(models).not.toContain("Notification")
    const everything = reader.list("data/").map((n) => reader.readText(n)).join("\n")
    for (const s of ["SECRET-SSO", "SECRET-KEY", "SECRET-ANALYTICS"]) expect(everything).not.toContain(s)
    expect(reader.manifest().users.map((u) => u.email).sort()).toEqual(["alice@example.com", "bob@example.com"])
    expect(reader.manifest().blobs.length).toBe(3)
  })

  it("imports as a new workspace in the same org with fresh ids, preserved numbers and rewritten references", async () => {
    const report = await importWorkspaceBundle(prisma, bundle, { organizationId: orgId, importerUserId: importerId, blobs, nonce: "n1" })
    expect(report.alreadyImported).toBe(false)
    expect(report.workspaceId).not.toBe(wsId)
    expect(report.slug).toBe("alpha-imported")
    expect(report.usersMatched).toBe(2)

    const ws = await prisma.workspace.findUnique({ where: { id: report.workspaceId } })
    expect(ws.ssoEnabled).toBe(false)
    expect(ws.ssoSecretEncrypted).toBeNull()
    expect(ws.anthropicApiKeyEncrypted).toBeNull()

    const opp = await prisma.opportunity.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(opp.id).not.toBe(oppId)
    expect(opp.seqNumber).toBe(42)
    expect(opp.createdById).toBe(aliceId) // matched by email
    const squad = await prisma.squad.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(opp.squadId).toBe(squad.id)

    // Polymorphic + text-embedded ids follow the new rows.
    const link = await prisma.entityLink.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(link.toId).toBe(opp.id)
    const comment = await prisma.comment.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(comment.targetId).toBe(opp.id)
    expect(comment.body).toBe(`See ${opp.id} and OPP-42`)
    const cfv = await prisma.customFieldValue.findFirst({ where: { fieldId: { in: (await prisma.customFieldDefinition.findMany({ where: { workspaceId: report.workspaceId } })).map((f: { id: string }) => f.id) } } })
    expect(cfv.objectId).toBe(opp.id)

    // Same-org scoring model is kept; counters never behind imported numbers.
    const score = await prisma.opportunityScore.findFirst({ where: { opportunityId: opp.id } })
    expect(score.scoringModelId).toBe(scoringModelId)
    const seq = await prisma.workspaceSequence.findUnique({ where: { workspaceId_entityType: { workspaceId: report.workspaceId, entityType: "opportunity" } } })
    expect(seq.nextValue).toBeGreaterThanOrEqual(50)
    const taskSeq = await prisma.workspaceSequence.findUnique({ where: { workspaceId_entityType: { workspaceId: report.workspaceId, entityType: "task" } } })
    expect(taskSeq.nextValue).toBeGreaterThanOrEqual(8)

    // Docs: embedded compass:// ref and image path rewritten, image blob copied.
    const doc = await prisma.doc.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(doc.id).not.toBe(docId)
    expect(doc.content).toContain(`compass://opportunity/${opp.id}`)
    expect(doc.content).toContain(`/api/docs/images/${report.workspaceId}/`)
    expect(doc.content).not.toContain(wsId)
    const imageName = /images\/[^/]+\/([^ )]+)/.exec(doc.content)![1]
    expect(artifact.files.has(`docs/${report.workspaceId}/images/${imageName}`)).toBe(true)

    // Artifact HTML blob copied to the rewritten path.
    const rev = await prisma.artifactRevision.findFirst({ where: { artifactId: { not: artifactId }, blobPathname: { not: null } } })
    expect(rev.blobPathname).toContain(report.workspaceId)
    expect(artifact.files.has(rev.blobPathname)).toBe(true)

    // Feedback attachment re-uploaded and URL rewritten.
    const att = await prisma.feedbackAttachment.findFirst({ where: { url: { contains: report.workspaceId } } })
    expect(att).toBeTruthy()
    expect(publicBlobs.has(att.url)).toBe(true)

    // Analytics connection arrives disabled with no secret.
    const conn = await prisma.analyticsConnection.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(conn.enabled).toBe(false)
    expect(conn.secretEncrypted).toBeNull()

    // Source workspace is untouched and Notification was not copied.
    expect(await prisma.opportunity.count({ where: { workspaceId: wsId } })).toBe(1)
    expect(await prisma.notification.count({ where: { workspaceId: report.workspaceId } })).toBe(0)
    // Members: org members + importer as admin.
    const importerMember = await prisma.workspaceMember.findFirst({ where: { workspaceId: report.workspaceId, userId: importerId } })
    expect(importerMember.role).toBe("ADMIN")
  }, 120_000)

  it("is idempotent when retried with the same nonce, and makes a fresh copy with a new nonce", async () => {
    const again = await importWorkspaceBundle(prisma, bundle, { organizationId: orgId, importerUserId: importerId, blobs, nonce: "n1" })
    expect(again.alreadyImported).toBe(true)
    const before = await prisma.opportunity.count()
    const fresh = await importWorkspaceBundle(prisma, bundle, { organizationId: orgId, importerUserId: importerId, blobs, nonce: "n2", slug: "alpha-two", name: "Alpha Two" })
    expect(fresh.alreadyImported).toBe(false)
    expect(fresh.slug).toBe("alpha-two")
    expect(await prisma.opportunity.count()).toBe(before + 1)
  }, 120_000)

  it("imports into a different org: unmatched users fall back to the importer, foreign scoring models are cleared", async () => {
    await prisma.organizationMember.create({ data: { organizationId: otherOrgId, userId: importerId, role: "ADMIN" } })
    const report = await importWorkspaceBundle(prisma, bundle, { organizationId: otherOrgId, importerUserId: importerId, blobs, nonce: "n3" })
    expect(report.usersFallbackToImporter).toBe(2)
    const opp = await prisma.opportunity.findFirst({ where: { workspaceId: report.workspaceId } })
    expect(opp.createdById).toBe(importerId)
        expect(report.warnings.join(" ")).toMatch(/Skipped 1 OpportunityScore/)
    expect(await prisma.opportunityScore.count({ where: { opportunityId: opp.id } })).toBe(0)
  }, 120_000)

  it("rolls back completely when validation fails", async () => {
    const reader = new BundleReader(bundle)
    // Tamper: a duplicate-id row makes the per-model count disagree with the manifest.
    const manifest = reader.manifest()
    manifest.counts.Opportunity = 99
    const files: Record<string, Uint8Array> = {}
    for (const n of reader.list("")) files[n] = reader.read(n)!
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest))
    const tampered = zipSync(files)
    const beforeRows = await prisma.opportunity.count()
    const beforeBlobs = artifact.files.size
    await expect(
      importWorkspaceBundle(prisma, tampered, { organizationId: orgId, importerUserId: importerId, blobs, nonce: "n4", slug: "will-fail" }),
    ).rejects.toThrow(/Validation failed for Opportunity/)
    expect(await prisma.opportunity.count()).toBe(beforeRows)
    expect(await prisma.workspace.count({ where: { slug: "will-fail" } })).toBe(0)
    expect(artifact.files.size).toBe(beforeBlobs)
  }, 120_000)

  it("rejects bundles that try to write outside the content models", async () => {
    const reader = new BundleReader(bundle)
    const files: Record<string, Uint8Array> = {}
    for (const n of reader.list("")) files[n] = reader.read(n)!
    files["data/User.0000.ndjson"] = new TextEncoder().encode(JSON.stringify({ id: randomUUID(), email: "evil@example.com" }) + "\n")
    await expect(
      importWorkspaceBundle(prisma, zipSync(files), { organizationId: orgId, importerUserId: importerId, blobs }),
    ).rejects.toBeInstanceOf(WorkspaceImportError)
    expect(await prisma.user.count({ where: { email: "evil@example.com" } })).toBe(0)
    await expect(importWorkspaceBundle(prisma, new Uint8Array([1, 2, 3]), { organizationId: orgId, importerUserId: importerId, blobs })).rejects.toBeInstanceOf(WorkspaceImportError)
  })

  it("refuses to export Geode-hosted documents", async () => {
    const ws = await prisma.workspace.create({ data: { organizationId: orgId, slug: "geode", name: "Geode" } })
    await prisma.doc.create({ data: { workspaceId: ws.id, title: "g", content: "", storageProvider: "GEODE" } })
    await expect(exportWorkspaceToBuffer(prisma, ws.id, blobs)).rejects.toBeInstanceOf(WorkspaceExportRefusal)
  })
})
