import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { WORK_ITEM_REGISTRY, WORK_ITEM_TYPES } from "@/lib/work-item-ids"
import {
  NUMBERED_DELEGATES,
  listSourceFiles,
  readSource,
  scanRawInserts,
  scanSource,
  stripComments,
} from "./helpers/work-item-create-scan"

/**
 * Bypass guard (ADR "Human-readable work item IDs", section 6). Every row of a numbered model must get
 * its seq_prefix and seq_number from lib/work-item-sequence.ts inside the creating transaction. A bare
 * `.create` outside the allocator leaves a NULL ID that nothing fixes until the 094 residual backfill.
 *
 * This test fails on any create, createMany or upsert of a numbered model whose argument list does not
 * call the allocator, unless the site is listed in NOT_NUMBERED with a reason. Adding a creation path?
 * Call `allocateOneSeq(tx, workspaceId, type)` (or `allocateSeq` + `withSeq` for createMany) inside the
 * same transaction, on the transaction client.
 */

const ROOT = process.cwd()
const ALLOCATOR_CALL = /\b(allocateOneSeq|allocateSeq|withSeq)\s*\(/

/** Sites that deliberately skip the allocator. The row stays NULL-numbered until the 094 residual pass. */
const NOT_NUMBERED: { site: string; count: number; reason: string }[] = [
  {
    site: "scripts/oauth-mcp-probe.ts::opportunity.create",
    count: 1,
    reason: "Probe fixture run with Node's native TS loader, which rejects the '@/' alias the allocator uses; the row is deleted by the probe's cleanup.",
  },
  {
    site: "scripts/verify-geode-document-migration.ts::doc.create",
    count: 2,
    reason: "Runs against a schema that deliberately predates migration 092 (old production model), so the seq columns do not exist.",
  },
]

const files = listSourceFiles(ROOT, ["lib", "app", "scripts", "components", "hooks", "plugins"])
const sites = files.flatMap((file) => scanSource(file, readSource(ROOT, file)))
const keyOf = (site: { file: string; model: string; operation: string }) => `${site.file}::${site.model}.${site.operation}`

describe("work item ID bypass guard", () => {
  it("scans the delegate names the schema really has", () => {
    for (const type of WORK_ITEM_TYPES) {
      const { table } = WORK_ITEM_REGISTRY[type]
      const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.dbName === table)
      expect(model, `no Prisma model maps to ${table}`).toBeDefined()
      const delegate = model!.name[0].toLowerCase() + model!.name.slice(1)
      expect(NUMBERED_DELEGATES as readonly string[], `${table} -> ${delegate}`).toContain(delegate)
    }
    expect(NUMBERED_DELEGATES).toHaveLength(WORK_ITEM_TYPES.length)
  })

  it("finds the creation paths it is meant to guard", () => {
    // A scanner that silently matches nothing would pass the real check below.
    expect(sites.length).toBeGreaterThanOrEqual(40)
    const models = new Set(sites.map((site) => site.model))
    for (const delegate of NUMBERED_DELEGATES) expect(models, delegate).toContain(delegate)
  })

  it("has no create of a numbered model outside the allocator", () => {
    const allowed = new Map(NOT_NUMBERED.map((entry) => [entry.site, entry.count]))
    const unnumbered = sites.filter((site) => !ALLOCATOR_CALL.test(site.args))
    const counts = new Map<string, number>()
    for (const site of unnumbered) counts.set(keyOf(site), (counts.get(keyOf(site)) ?? 0) + 1)
    const violations = [...counts].filter(([site, count]) => (allowed.get(site) ?? 0) !== count)
    expect(
      violations.map(([site, count]) => `${site} x${count}`),
      "Allocate a work item ID with allocateOneSeq inside the creating transaction (see lib/work-item-sequence.ts)",
    ).toEqual([])
  })

  it("keeps every NOT_NUMBERED entry accurate", () => {
    const present = new Set(sites.filter((site) => !ALLOCATOR_CALL.test(site.args)).map(keyOf))
    for (const entry of NOT_NUMBERED) expect(present.has(entry.site), `stale entry ${entry.site}`).toBe(true)
  })

  it("allocates on the transaction client in application code, never on a bare client", () => {
    // allocateOneSeq(prisma, ...) outside a transaction would burn a number when the insert fails.
    // Seed scripts are single-user and exempt.
    const bare = sites
      .filter((site) => !site.file.startsWith("scripts/"))
      .filter((site) => /\ballocate(One)?Seq\s*\(\s*(?!tx\b|db\b)/.test(site.args))
      .map(keyOf)
    expect(bare).toEqual([])
  })

  it("has no raw SQL insert into a numbered table", () => {
    const tables = WORK_ITEM_TYPES.map((type) => WORK_ITEM_REGISTRY[type].table)
    const inserts = files.flatMap((file) => scanRawInserts(file, readSource(ROOT, file), tables))
    // The managed-migration driver inserts into docs only inside its own sentinel proof (scripts/verify-managed-pilot-migrations.ts).
    expect(inserts.filter((insert) => insert.file !== "scripts/verify-managed-pilot-migrations.ts")).toEqual([])
  })
})

describe("work item create scanner", () => {
  it("flags a bare create", () => {
    const [site] = scanSource("x.ts", "await tx.task.create({ data: { workspaceId, title } })")
    expect(site).toMatchObject({ model: "task", operation: "create" })
    expect(ALLOCATOR_CALL.test(site.args)).toBe(false)
  })

  it("accepts an allocated create, including one that spans lines and nests parentheses", () => {
    const [site] = scanSource(
      "x.ts",
      'await tx.doc.create({\n  data: {\n    ...(await allocateOneSeq(tx, wsId, "doc")),\n    title: fn("(x)"),\n  },\n})',
    )
    expect(ALLOCATOR_CALL.test(site.args)).toBe(true)
  })

  it("does not credit an allocator call that sits outside the create's arguments", () => {
    const [site] = scanSource("x.ts", 'const seq = await allocateOneSeq(tx, ws, "task")\nawait tx.task.create({ data: { title } })')
    expect(ALLOCATOR_CALL.test(site.args)).toBe(false)
  })

  it("flags createMany and upsert and ignores other models and operations", () => {
    const found = scanSource(
      "x.ts",
      "tx.feedbackItem.createMany({ data })\ntx.roadmapItem.upsert({ where })\ntx.task.update({ where })\ntx.comment.create({ data })",
    )
    expect(found.map((site) => `${site.model}.${site.operation}`)).toEqual(["feedbackItem.createMany", "roadmapItem.upsert"])
  })

  it("ignores creates that only appear in comments", () => {
    expect(scanSource("x.ts", "// tx.task.create({ data })\n/* tx.doc.create({}) */")).toEqual([])
    expect(stripComments('const url = "https://x.test"; // tail')).toBe('const url = "https://x.test"; ')
  })

  it("reports the line of the call", () => {
    const [site] = scanSource("x.ts", "a\nb\nawait db.metricDefinition.create({ data })")
    expect(site.line).toBe(3)
  })

  it("finds raw inserts into numbered tables", () => {
    const hits = scanRawInserts("x.ts", 'await q(`INSERT INTO "${schema}".tasks (id) VALUES ($1)`)\nINSERT INTO other (id)', ["tasks", "docs"])
    expect(hits).toEqual([{ file: "x.ts", line: 1, table: "tasks" }])
  })
})
