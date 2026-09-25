/** Local-only prerequisite proof using the unchanged production Prisma models. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { Pool } from "pg"
import { Prisma } from "@prisma/client"
import getPrisma from "../lib/db"
import { maybeSnapshotDocVersion, restoreDocVersionCore } from "../lib/doc-versions"
import { applyMigrations, getMigrationStatus } from "../lib/migrations/runner"
import { getGeodeDocumentStorageHealth } from "../lib/migrations/geode-document-storage"
import { withE2ERunLock } from "./e2e-run-lock.mjs"

const migration = "059_geode_document_storage"

async function main() {
  // This prerequisite proof intentionally certifies the pre-integration client.
  // Run it on the migration-only revision; the pilot branch uses the new client.
  assert(!Prisma.dmmf.datamodel.models.find(model => model.name === "Doc")?.fields.some(field => field.name === "storageProvider"), "Old-Prisma proof requires the migration-only revision/client; use verify-geode-documents.ts for the integration client")
  const url = new URL(process.env.DATABASE_URL ?? "")
  assert(process.env.E2E_ISOLATED_DATABASE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/compass_e2e", "Only disposable local compass_e2e is allowed")
  assert(!process.env.VERCEL_ENV && process.env.NODE_ENV !== "production" && process.env.PREVIEW_AUTOMATION_ENABLED !== "1", "Cloud/production execution refused")
  await withE2ERunLock(process.env, async () => {
    const prefix = `compass_geode_${randomUUID().replaceAll("-", "")}`
    const schema = `${prefix}_dev`
    process.env.PGSCHEMA = prefix
    const pool = new Pool({ connectionString: url.toString() })
    const db = getPrisma()
    let created = false
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`)
      created = true
      const bootstrapUrl = new URL(url)
      bootstrapUrl.searchParams.set("schema", schema)
      const setup = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push"], {
        env: { ...process.env, DATABASE_URL: bootstrapUrl.toString() }, stdio: "inherit",
      })
      assert.equal(setup.status, 0, "Old production-model schema bootstrap failed")
      const client = await pool.connect()
      try { assert.equal((await getGeodeDocumentStorageHealth(client, schema)).status, "absent") } finally { client.release() }
      const org = await db.organization.create({ data: { slug: `migration-${randomUUID()}`, name: "Synthetic migration proof" } })
      const workspace = await db.workspace.create({ data: { organizationId: org.id, slug: "legacy-docs", name: "Synthetic legacy docs" } })
      const initial = "\uFEFF legacy 日本語\r\n  whitespace preserved\n"
      const doc = await db.doc.create({ data: { workspaceId: workspace.id, title: "Before migration", content: initial, metadata: { synthetic: true } } })
      assert(!Object.hasOwn(doc, "storageProvider"), "Proof must use the old production Prisma model")
      await maybeSnapshotDocVersion(doc.id, { authorName: "Synthetic proof", label: "Before migration" })
      const originalVersion = await db.docVersion.findFirstOrThrow({ where: { docId: doc.id } })
      await db.doc.update({ where: { id: doc.id }, data: { content: "Before migration edit", updatedAt: new Date() } })
      assert.equal((await db.doc.findUniqueOrThrow({ where: { id: doc.id } })).content, "Before migration edit")
      await restoreDocVersionCore(originalVersion.id, { authorName: "Synthetic proof" })
      assert.equal((await db.doc.findUniqueOrThrow({ where: { id: doc.id } })).content, initial)
      const before = await db.doc.findUniqueOrThrow({ where: { id: doc.id } })
      const versionsBefore = await db.docVersion.findMany({ where: { docId: doc.id }, orderBy: { id: "asc" } })
      console.log("Old production-model Docs create/read/update/snapshot/history/restore before migration: passed")

      // Fail after additive columns and the unique index have actually committed.
      const failingPool = { connect: async () => {
        const client = await pool.connect()
        return new Proxy(client, { get(target, property) {
          if (property === "query") return (...args: unknown[]) => {
            if (String(args[0]).startsWith("CREATE TABLE IF NOT EXISTS doc_storage_objects")) throw new Error("Synthetic partial DDL failure")
            return Reflect.apply(target.query, target, args)
          }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        } })
      } } as unknown as Pool
      assert.equal((await applyMigrations(failingPool, schema, migration)).status, 500)
      const partial = await (await getMigrationStatus(pool, schema)).json()
      assert.equal(partial.geodeDocumentStorage.status, "partial")
      assert(partial.unresolvedMigrations.includes(migration))
      assert(!partial.appliedMigrations.includes(migration))
      assert.deepEqual(await db.doc.findUniqueOrThrow({ where: { id: doc.id } }), before)

      for (let pass = 0; pass < 2; pass++) {
        const response = await applyMigrations(pool, schema, migration)
        const body = await response.json()
        assert.equal(response.status, 200, JSON.stringify(body))
      }
      const status = await (await getMigrationStatus(pool, schema)).json()
      assert.deepEqual({ status: status.geodeDocumentStorage.status, ready: status.geodeDocumentStorage.ready, drift: status.geodeDocumentStorage.drift }, { status: "complete", ready: true, drift: false })
      assert(status.appliedMigrations.includes(migration))
      assert(!status.unresolvedMigrations.includes(migration))
      const receipts = await pool.query(`SELECT finished_at IS NOT NULL AS finished FROM "${schema}"._prisma_migrations WHERE migration_name=$1`, [migration])
      assert.equal(receipts.rows.filter(row => row.finished).length, 1)
      assert.equal(receipts.rows.filter(row => !row.finished).length, 1)
      assert.deepEqual(await db.doc.findUniqueOrThrow({ where: { id: doc.id } }), before)
      assert.deepEqual(await db.docVersion.findMany({ where: { docId: doc.id }, orderBy: { id: "asc" } }), versionsBefore)
      const nullable = await pool.query(`SELECT storage_provider, content_ref, revision FROM "${schema}".docs WHERE id=$1`, [doc.id])
      assert.deepEqual(nullable.rows, [{ storage_provider: null, content_ref: null, revision: null }])
      console.log("Partial failure leaves unfinished receipt; resume/idempotence, catalog and exact legacy bytes preserved: passed")

      const after = await db.doc.create({ data: { workspaceId: workspace.id, title: "After migration", content: initial } })
      await maybeSnapshotDocVersion(after.id, { authorName: "Synthetic proof", label: "After migration" })
      const version = await db.docVersion.findFirstOrThrow({ where: { docId: after.id } })
      await db.doc.update({ where: { id: after.id }, data: { content: "After migration edit", updatedAt: new Date() } })
      assert.equal((await db.doc.findUniqueOrThrow({ where: { id: after.id } })).content, "After migration edit")
      await restoreDocVersionCore(version.id, { authorName: "Synthetic proof" })
      assert.equal((await db.doc.findUniqueOrThrow({ where: { id: after.id } })).content, initial)
      assert.equal((await db.docVersion.findMany({ where: { docId: after.id } })).length, 2)
      console.log("Old production-model Docs create/read/update/snapshot/history/restore after migration: passed")

      const operation = randomUUID()
      const insert = `INSERT INTO "${schema}".doc_operations (id,workspace_id,operation_id,doc_id,payload_digest,result) VALUES ($1,$2,$3,$4,$5,$6)`
      await pool.query(insert, [randomUUID(), workspace.id, operation, doc.id, "a".repeat(64), "{}"])
      await assert.rejects(pool.query(insert, [randomUUID(), workspace.id, operation, doc.id, "a".repeat(64), "{}"]), /duplicate key/)
      await pool.query(`DROP INDEX "${schema}".doc_operations_workspace_id_operation_id_key`)
      const drift = await (await getMigrationStatus(pool, schema)).json()
      assert.equal(drift.geodeDocumentStorage.drift, true)
      assert.equal(drift.geodeDocumentStorage.ready, false)
      console.log("Unique receipt enforcement and already-receipted catalog drift detection: passed")
      return 0
    } finally {
      await db.$disconnect()
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
      await pool.end()
      console.log("Only the exact script-created schema and its synthetic data removed")
    }
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
