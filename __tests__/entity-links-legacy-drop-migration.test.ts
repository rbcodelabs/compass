import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { ENTITY_LINKS_LEGACY_DROP_MIGRATION, assertLegacyDropPreflight, assertLegacyDropped, dropLegacyLinkRelations, evaluateLegacyDropPreflight } from "@/lib/migrations/entity-links-legacy-drop"
import { LEGACY_LINK_TABLES, LEGACY_SOURCES_BY_MIGRATION, missingLegacyRelations } from "@/lib/migrations/legacy-link-relations"
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner"

const ROOT = process.cwd()
const NAME = "116_entity_links_drop_legacy_tables"
const HOOK = "lib/migrations/entity-links-legacy-drop.ts"
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8")

describe("116 registration", () => {
  const runner = read("lib/migrations/runner.ts")

  it("uses the next free number, registers last, and its SQL file has no executable statement (the DDL runs only after the preflight)", () => {
    expect(ENTITY_LINKS_LEGACY_DROP_MIGRATION).toBe(NAME)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "115_entity_links_task_link_move"'))
    const sql = read(`prisma/migrations/${NAME}/migration.sql`)
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([])
  })

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "117_other" }, { name: NAME }]
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["117_other"])
    expect(skippedExplicitOnly(pending)).toEqual([NAME])
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME])
    expect(runner).toMatch(/EXPLICIT_ONLY_MIGRATIONS: readonly string\[\] = \[[^\]]*ENTITY_LINKS_LEGACY_DROP_MIGRATION/)
  })

  it("runs the preflighted drop and its postcondition before the receipt, and is in the replay skip list", () => {
    const drop = runner.indexOf("await dropLegacyLinkRelations(client, schema, log)")
    const assertion = runner.indexOf("await assertLegacyDropped(client, schema)")
    expect(drop).toBeGreaterThan(-1)
    expect(assertion).toBeGreaterThan(drop)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME)
  })

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(runner).toContain("entityLinksLegacyDrop: await getEntityLinksLegacyDropStatus(client, schema)")
  })

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts")
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex")
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`)
    expect(manifest).toContain(`"${HOOK}": "${digest(HOOK)}"`)
    expect(manifest).toContain(`"lib/migrations/legacy-link-relations.ts": "${digest("lib/migrations/legacy-link-relations.ts")}"`)
    expect(manifest).toContain(`"lib/migrations/entity-links-read-parity.ts": "${digest("lib/migrations/entity-links-read-parity.ts")}"`)
  })

  it("every older hook that reads a legacy source is guarded, and the guard covers every legacy-reading migration", () => {
    expect(runner).toContain("LEGACY_SOURCES_BY_MIGRATION[migration.name]")
    expect((runner.match(/!legacySourceGone/g) ?? []).length).toBe(7)
    expect(Object.keys(LEGACY_SOURCES_BY_MIGRATION).sort()).toEqual([
      "071_typed_link_tables", "072_typed_links_residual_backfill", "095_entity_links_backfill_opportunity", "096_entity_links_backfill_artifact",
      "097_entity_links_backfill_task", "098_entity_links_backfill_solution_key_result", "106_entity_links_residual_opportunity",
      "113_entity_links_backfill_conversation", "115_entity_links_task_link_move",
    ])
  })
})

describe("DSQL and Postgres safety of the drop", () => {
  const code = read(HOOK).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("issues only IF EXISTS drops, one DDL per statement, with no CASCADE, no transaction wrapper, no SET and no advisory lock", () => {
    const ddl = [...code.matchAll(/`(DROP TABLE[^`]*|ALTER TABLE[^`]*)`/g)].map((m) => m[1])
    expect(ddl).toEqual([
      'DROP TABLE IF EXISTS "${schema}"."${table}"',
      'ALTER TABLE "${schema}"."opportunities" DROP COLUMN IF EXISTS "${LEGACY_POINTER_COLUMN}"',
    ])
    expect(code).not.toMatch(/CASCADE/i)
    expect(code).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/)
    expect(code).not.toMatch(/SET\s+LOCAL|statement_timeout|advisory/i)
  })

  it("never modifies entity_links", () => {
    expect(code).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"\$\{schema\}"\."entity_links"/i)
  })
})

type Reply = { rows?: unknown[]; rowCount?: number }
function fakeClient(handler: (sql: string, params: unknown[]) => Reply | undefined) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: [], rowCount: 0, ...(handler(sql, params) ?? {}) }))
  return { client: { query } as unknown as PoolClient, query }
}

const ALL_PRESENT = { tables: [...LEGACY_LINK_TABLES], column: true }
/** A database where the receipts, the catalog and the parity / 115 / 113 numbers are all configurable. */
function world(opts: { receipts?: string[]; present?: { tables: string[]; column: boolean }; onlyLegacy?: number; originDrift?: number; unmoved?: number; conversationUnmatched?: number } = {}) {
  const receipts = opts.receipts ?? ["091_entity_links", "115_entity_links_task_link_move"]
  const present = opts.present ?? ALL_PRESENT
  return fakeClient((sql, params) => {
    if (/_prisma_migrations/.test(sql)) return { rows: [{ n: receipts.includes(String(params[0])) ? "1" : "0" }] }
    if (/information_schema\.tables/.test(sql) && /entity_links', 'opportunities'/.test(sql)) return { rows: [{ n: "4" }] }
    if (/information_schema\.tables/.test(sql)) return { rows: present.tables.map((table_name) => ({ table_name })) }
    if (/information_schema\.columns/.test(sql)) return { rows: [{ n: present.column ? "1" : "0" }] }
    if (/^\s*WITH/.test(sql)) {
      const row = { legacy_live: "1", mirror_live: "1", only_legacy: String(opts.onlyLegacy ?? 0), only_legacy_ids: (opts.onlyLegacy ? ["legacy-1"] : []), only_entity_links: "0", only_entity_links_ids: [], origin_drift: String(opts.originDrift ?? 0), origin_drift_ids: [] }
      return { rows: [row] }
    }
    // 115 status: unmatched (unmoved) rows; 113 status: unmatched rows. Both are count(*) AS n over task_links.
    if (/CONVERSATION_CREATED/.test(sql) && /e\.id IS NULL AND/.test(sql)) return { rows: [{ n: String(opts.conversationUnmatched ?? 0) }] }
    if (/TASK_CREATED_FROM/.test(sql) && /e\.id IS NULL OR e\.workspace_id/.test(sql)) return { rows: [{ n: String(opts.unmoved ?? 0) }] }
    return { rows: [{ n: "0", id: undefined }] }
  })
}

describe("the preflight refuses (nothing dropped) unless every check passes", () => {
  const dropStatements = (query: ReturnType<typeof world>["query"]) => query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /^\s*(DROP|ALTER)\b/i.test(sql))

  it("passes on a clean world and lists what is present", async () => {
    const { client } = world()
    const result = await evaluateLegacyDropPreflight(client, "s")
    expect(result.blockers).toEqual([])
    expect(result.present).toEqual([...LEGACY_LINK_TABLES, "opportunities.linked_key_result_id"])
  })

  it("refuses without a 115 receipt", async () => {
    const { client, query } = world({ receipts: ["091_entity_links"] })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/migration 115_entity_links_task_link_move has no finished receipt/)
    expect(dropStatements(query)).toEqual([])
  })

  it("refuses without a 091 receipt", async () => {
    const { client, query } = world({ receipts: ["115_entity_links_task_link_move"] })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/091_entity_links has no finished receipt/)
    expect(dropStatements(query)).toEqual([])
  })

  it("refuses when a live legacy row has no entity_links twin, naming the ids", async () => {
    const { client, query } = world({ onlyLegacy: 2 })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/NOTHING was dropped[\s\S]*parity: 2 live \w+ legacy row\(s\) have no entity_links row \(legacy ids: legacy-1/)
    expect(dropStatements(query)).toEqual([])
  })

  it("refuses when migration 115 still has unmoved rows", async () => {
    const { client, query } = world({ unmoved: 3 })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/entityLinksTaskLinkMove\.unmoved = 6, must be 0/)
    expect(dropStatements(query)).toEqual([])
  })

  it("refuses when migration 113 left a conversation link unmatched", async () => {
    const { client, query } = world({ conversationUnmatched: 1 })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/entityLinksConversationBackfill\.unmatched = 1/)
    expect(dropStatements(query)).toEqual([])
  })

  it("refuses when the preflight itself cannot be evaluated", async () => {
    const { client, query } = fakeClient((sql) => {
      if (/_prisma_migrations/.test(sql)) return { rows: [{ n: "1" }] }
      if (/information_schema/.test(sql)) throw new Error("catalog unreachable")
      return undefined
    })
    await expect(assertLegacyDropPreflight(client, "s")).rejects.toThrow(/preflight could not be evaluated, nothing was dropped: catalog unreachable/)
    expect(dropStatements(query)).toEqual([])
  })

  it("reports origin drift without refusing", async () => {
    const { client } = world({ originDrift: 2 })
    const result = await evaluateLegacyDropPreflight(client, "s")
    expect(result.blockers).toEqual([])
    expect(result.notes.join("\n")).toMatch(/different origin \(reported, not blocking\)/)
  })

  it("entity_links-only rows are not a blocker (parity reports only legacy-only rows as blockers)", async () => {
    const { client } = world()
    expect((await evaluateLegacyDropPreflight(client, "s")).blockers).toEqual([])
  })
})

describe("the drop", () => {
  it("drops the four tables, then the column, one statement each, after a clean preflight", async () => {
    const { client, query } = world()
    const log: string[] = []
    const dropped = await dropLegacyLinkRelations(client, "s", log)
    expect(dropped).toEqual([...LEGACY_LINK_TABLES, "opportunities.linked_key_result_id"])
    const ddl = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /^\s*(DROP|ALTER)\b/i.test(sql))
    expect(ddl).toEqual([
      ...LEGACY_LINK_TABLES.map((table) => `DROP TABLE IF EXISTS "s"."${table}"`),
      'ALTER TABLE "s"."opportunities" DROP COLUMN IF EXISTS "linked_key_result_id"',
    ])
    // The preflight's queries all come before the first DDL.
    const firstDdl = query.mock.calls.findIndex(([sql]) => /^\s*(DROP|ALTER)\b/i.test(String(sql)))
    expect(query.mock.calls.slice(firstDdl).every(([sql]) => !/^\s*WITH/.test(String(sql)))).toBe(true)
  })

  it("resumes: only the relations that are still there are dropped", async () => {
    const { client, query } = world({ present: { tables: ["artifact_links", "task_links"], column: true } })
    const dropped = await dropLegacyLinkRelations(client, "s", [])
    expect(dropped).toEqual(["task_links", "artifact_links", "opportunities.linked_key_result_id"])
    expect(query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /^\s*DROP\b/i.test(sql))).toHaveLength(2)
  })

  it("is a no-op when everything is already gone (a rerun)", async () => {
    const { client, query } = world({ present: { tables: [], column: false } })
    expect(await dropLegacyLinkRelations(client, "s", [])).toEqual([])
    expect(query.mock.calls.some(([sql]) => /^\s*(DROP|ALTER)\b/i.test(String(sql)))).toBe(false)
    // No parity read at all: nothing to compare.
    expect(query.mock.calls.some(([sql]) => /^\s*WITH/.test(String(sql)))).toBe(false)
  })

  it("a rerun still needs the 115 receipt (it is part of the contract, not just of the first run)", async () => {
    const { client } = world({ receipts: ["091_entity_links"], present: { tables: [], column: false } })
    await expect(dropLegacyLinkRelations(client, "s", [])).rejects.toThrow(/115_entity_links_task_link_move has no finished receipt/)
  })
})

describe("the postcondition refuses the receipt", () => {
  it("passes when all five relations are gone and the store is intact", async () => {
    const { client } = world({ present: { tables: [], column: false } })
    await expect(assertLegacyDropped(client, "s")).resolves.toBeUndefined()
  })

  it("refuses while any relation is still present", async () => {
    const { client } = world({ present: { tables: ["task_links"], column: false } })
    await expect(assertLegacyDropped(client, "s")).rejects.toThrow(/still present after the drop: task_links/)
  })

  it("refuses when the surviving store is missing a table", async () => {
    const { client } = fakeClient((sql) => {
      if (/entity_links', 'opportunities'/.test(sql)) return { rows: [{ n: "3" }] }
      if (/information_schema\.columns/.test(sql)) return { rows: [{ n: "0" }] }
      return { rows: [] }
    })
    await expect(assertLegacyDropped(client, "s")).rejects.toThrow(/entity_links, opportunities, tasks or artifacts is missing/)
  })
})

describe("legacy relation catalog", () => {
  it("reports which of the needed relations are gone", async () => {
    const { client } = world({ present: { tables: ["task_links"], column: false } })
    expect(await missingLegacyRelations(client, "s", ["task_links", "artifact_links", "opportunities.linked_key_result_id"])).toEqual(["artifact_links", "opportunities.linked_key_result_id"])
  })
})
