/** Synthetic, disposable local integration proof. Never targets cloud databases. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { Pool } from "pg"
import getPrisma from "../lib/db"
import { createDocument, updateDocument, hydrateDocument, snapshotDocument, restoreDocument, deleteDocument } from "../lib/document-service"
import { applyMigrations } from "../lib/migrations/runner"
import { assertGeodeDocumentStorageMigration } from "../lib/migrations/geode-document-storage"

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "")
  assert(process.env.E2E_ISOLATED_DATABASE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname === "/compass_e2e", "Only disposable local compass_e2e is allowed")
  assert(!process.env.VERCEL_ENV && process.env.NODE_ENV !== "production", "Cloud/production execution refused")
  process.env.PGSCHEMA = "compass"
  const db = getPrisma()
  if (process.argv[2] === "read") {
    try {
      const doc = await db.doc.findUniqueOrThrow({ where: { id: process.argv[3] } })
      assert.equal((await hydrateDocument(doc.workspaceId, doc)).content, "After restart 日本語\n")
      console.log("Fresh process: exact persisted body verified")
    } finally { await db.$disconnect() }
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const root = await mkdtemp(join(tmpdir(), "compass-geode-proof-"))
  const workspaceId = randomUUID()
  const orgId = randomUUID()
  process.env.GEODE_DOCS_LOCAL_ROOT = root
  process.env.GEODE_DOCS_PILOT_WORKSPACE_ID = workspaceId
  const opts = (revision?: string | null) => ({ operationId: randomUUID(), expectedRevision: revision ?? undefined, authorName: "Synthetic verifier", actorKey: "synthetic-verifier" })
  try {
    for (let pass = 0; pass < 2; pass++) {
      const result = await applyMigrations(pool, "compass_dev", "059_geode_document_storage")
      const body = await result.json()
      assert.equal(result.status, 200, JSON.stringify(body))
    }
    const client = await pool.connect()
    try { await assertGeodeDocumentStorageMigration(client, "compass_dev") } finally { client.release() }
    console.log("Registered migration and idempotent rerun: passed")
    await db.organization.create({ data: { id: orgId, slug: `geode-proof-${orgId}`, name: "Synthetic Geode proof" } })
    await db.workspace.create({ data: { id: workspaceId, organizationId: orgId, slug: "pilot", name: "Synthetic pilot" } })
    const createOpts = opts()
    const doc = await createDocument({ workspaceId, title: "Synthetic", content: "\uFEFF  initial 日本語\n", metadata: { createdAt: "not a date" } }, createOpts)
    const replay = await createDocument({ workspaceId, title: "Synthetic", content: "\uFEFF  initial 日本語\n", metadata: { createdAt: "not a date" }, sortOrder: 99 }, createOpts)
    assert.equal(replay.id, doc.id)
    assert.equal((await hydrateDocument(workspaceId, doc)).content, "\uFEFF  initial 日本語\n")
    const named = await snapshotDocument(doc.id, { ...opts(doc.revision), label: "Initial" })
    const saveOpts = opts(doc.revision)
    const saved = await updateDocument(doc.id, { content: "saved" }, saveOpts)
    assert.equal((await updateDocument(doc.id, { content: "saved" }, saveOpts)).revision, saved.revision)
    await assert.rejects(updateDocument(doc.id, { content: "changed retry" }, saveOpts), /operation-conflict/)
    const race = await Promise.allSettled([
      updateDocument(doc.id, { content: "racer one" }, opts(saved.revision)),
      updateDocument(doc.id, { content: "racer two" }, opts(saved.revision)),
    ])
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1)
    const afterRace = await db.doc.findUniqueOrThrow({ where: { id: doc.id } })
    const versionsBefore = await db.docVersion.count({ where: { docId: doc.id } })
    await assert.rejects(updateDocument(doc.id, { content: "uploaded but transaction fails", title: "x".repeat(300) }, opts(afterRace.revision)))
    assert.equal((await db.doc.findUniqueOrThrow({ where: { id: doc.id } })).revision, afterRace.revision)
    assert.equal(await db.docVersion.count({ where: { docId: doc.id } }), versionsBefore)
    const restored = await restoreDocument(named!.id, opts(afterRace.revision))
    assert.equal((await hydrateDocument(workspaceId, await db.doc.findUniqueOrThrow({ where: { id: doc.id } }))).content, "\uFEFF  initial 日本語\n")
    await updateDocument(doc.id, { content: "After restart 日本語\n" }, opts(restored!.revision))
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-geode-documents.ts", "read", doc.id], { env: process.env, stdio: "inherit" })
    assert.equal(child.status, 0)
    const final = await db.doc.findUniqueOrThrow({ where: { id: doc.id } })
    const deleteOpts = { ...opts(final.revision), workspaceId }
    await deleteDocument(doc.id, deleteOpts)
    await deleteDocument(doc.id, deleteOpts)
    assert.equal(await db.doc.count({ where: { workspaceId } }), 0)
    console.log("Create/replay, CAS race, failed commit rollback, named history, restore, process restart and delete replay: passed")
  } finally {
    await db.docVersion.deleteMany({ where: { doc: { workspaceId } } })
    await db.docComment.deleteMany({ where: { doc: { workspaceId } } })
    await db.doc.deleteMany({ where: { workspaceId } })
    await db.docOperation.deleteMany({ where: { workspaceId } })
    await db.docStorageObject.deleteMany({ where: { workspaceId } })
    await db.workspace.deleteMany({ where: { id: workspaceId, organizationId: orgId } })
    await db.organization.deleteMany({ where: { id: orgId } })
    assert.equal(await db.docOperation.count({ where: { workspaceId } }), 0)
    await db.$disconnect()
    await pool.end()
    await rm(root, { recursive: true, force: true })
    console.log("Synthetic rows and script-owned local objects cleaned")
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
