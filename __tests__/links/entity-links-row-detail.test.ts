/**
 * entityLinksRowDetail in GET /api/admin/migrate: read-only metadata for specific entity_links rows. These tests need no database (the
 * real-Postgres behaviour is in __tests__/entity-links-row-detail.integration.test.ts).
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import { describe, expect, it } from "vitest"
import { readParitySetsSql } from "@/lib/migrations/entity-links-read-parity"
import { TASK_ORIGIN_TARGET_TYPES, TASK_REFERENCE_TARGET_TYPES } from "@/lib/links/registry"
import {
  ROW_DETAIL_CAP,
  ROW_DETAIL_ENDPOINT_TYPES,
  TASK_OWNED_LINK_TYPES,
  collectParityIds,
  LEGACY_SOURCES,
  getEntityLinksRowDetailStatus,
  getLegacyOnlyStatus,
  legacyOnlyCte,
  legacyOnlySql,
  rowDetailSql,
} from "@/lib/migrations/entity-links-row-detail"

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8")

describe("registration and shape", () => {
  it("is reported by GET /api/admin/migrate next to the parity block, fed by the same parity result, and cannot fail the GET", () => {
    const runner = read("lib/migrations/runner.ts")
    expect(runner).toContain("entityLinksRowDetail: await getEntityLinksRowDetailStatus(client, schema, entityLinksReadParity).catch(")
    expect(runner.indexOf("entityLinksRowDetail:")).toBeGreaterThan(runner.indexOf("      entityLinksReadParity,"))
  })

  it("writes nothing and touches no legacy table, lock or session setting", () => {
    const full = read("lib/migrations/entity-links-row-detail.ts").replace(/\/\*[\s\S]*?\*\//g, "")
    const source = full.slice(0, full.indexOf("// ── Legacy-only rows"))
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\s/)
    // The hidden-row scan and the id lookups never read a legacy table; only the legacy-only section below does (and tolerates their absence).
    expect(source).not.toMatch(/task_links|artifact_links|opportunity_objective_links|solution_key_result_links/)
    expect(full).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\s/)
    expect(source).not.toMatch(/statement_timeout|advisory|pg_sleep|SET LOCAL|BEGIN/i)
    const sql = [rowDetailSql.hiddenIds("s"), rowDetailSql.detail("s", "$1::uuid")].join("\n")
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/)
  })

  it("selects no content columns", () => {
    const sql = rowDetailSql.detail("s", "$1::uuid")
    expect(sql).not.toMatch(/\be\.(title|body|name|description|attrs)\b/)
    expect(sql).not.toMatch(/SELECT x\.(title|body|name)/)
  })
})

describe("which link types the hidden scan covers", () => {
  it("is every registry type a Task owns, and includes TASK_REFERENCES and TASK_CREATED_FROM", () => {
    expect(TASK_OWNED_LINK_TYPES).toEqual(expect.arrayContaining(["TASK_REFERENCES", "TASK_CREATED_FROM"]))
    for (const key of TASK_OWNED_LINK_TYPES) expect(rowDetailSql.hiddenIds("s")).toContain(`'${key}'`)
  })

  it("can resolve every endpoint type the task-owned types name, and the resolution mirrors endpoints.ts", () => {
    const needed = ["TASK", ...TASK_REFERENCE_TARGET_TYPES, ...TASK_ORIGIN_TARGET_TYPES]
    for (const type of needed) expect(ROW_DETAIL_ENDPOINT_TYPES).toContain(type)
    // endpoints.ts handles each of these types in its own `case`, so a type removed there fails here until this status follows.
    const endpoints = read("lib/links/endpoints.ts")
    const found = endpoints.slice(endpoints.indexOf("async function find"), endpoints.indexOf("export async function resolveEndpoints"))
    for (const type of ROW_DETAIL_ENDPOINT_TYPES) expect(found, type).toContain(`case "${type}"`)
  })

  it("applies the reader's rules: same workspace as the link, a Key Result through its Objective, a tool approval is not linkable", () => {
    const sql = rowDetailSql.hiddenIds("s")
    expect(sql).toContain("x.workspace_id = e.workspace_id")
    expect(sql).toContain('JOIN "s"."objectives" AS o ON o.id = k.objective_id')
    expect(sql).toContain("gate_type IS DISTINCT FROM 'TOOL_APPROVAL' AS ok")
    expect(sql).toContain("AND x.ok")
  })
})

describe("collectParityIds", () => {
  it("keeps which family and set named each id, and reports a parity failure instead of throwing", () => {
    const entry = (ids: { onlyLegacy: string[]; onlyEntityLinks: string[]; originDrift: string[] }) => ({ family: "TASK" as const, legacyLive: 0, mirrorLive: 0, onlyLegacy: 0, onlyEntityLinks: 0, originDrift: 0, ids })
    const { ids } = collectParityIds({
      unmovedTaskOriginLinks: 0,
      totalMismatches: 0,
      families: {
        taskReferences: entry({ onlyLegacy: ["a"], onlyEntityLinks: ["b"], originDrift: [] }),
        taskCreatedFrom: entry({ onlyLegacy: [], onlyEntityLinks: ["b"], originDrift: ["c"] }),
      },
    })
    expect(ids.get("a")).toEqual([{ family: "taskReferences", set: "onlyLegacy" }])
    expect(ids.get("b")).toEqual([{ family: "taskReferences", set: "onlyEntityLinks" }, { family: "taskCreatedFrom", set: "onlyEntityLinks" }])
    expect(ids.get("c")).toEqual([{ family: "taskCreatedFrom", set: "originDrift" }])
    expect(collectParityIds({ error: "boom" })).toEqual({ ids: new Map(), error: "boom" })
  })
})

// A scripted client: the first query is the hidden scan, the rest are id lookups.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const detailRow = (id: string) => ({
  id, link_type: "TASK_REFERENCES", from_type: "TASK", from_id: uuid(900), to_type: "DOC", to_id: uuid(901), workspace_id: uuid(1),
  created_at: new Date("2026-01-01T00:00:00Z"), created_by_id: null, source: "UI", origin: "DIRECT",
  from_exists: true, to_exists: false, same_workspace: false, from_resolves: true, to_resolves: false,
})
function scriptedClient(hidden: string[]): PoolClient {
  let calls = 0
  return {
    query: async (_sql: string, params?: string[]) => {
      calls += 1
      if (calls === 1) return { rows: hidden.map((id) => ({ id })) }
      return { rows: (params ?? []).map(detailRow) }
    },
  } as unknown as PoolClient
}

describe("cap and truncation", () => {
  it("returns at most the cap and says so when more qualified", async () => {
    const hidden = Array.from({ length: ROW_DETAIL_CAP + 1 }, (_, i) => uuid(i + 1))
    const status = await getEntityLinksRowDetailStatus(scriptedClient(hidden), "s")
    expect(status.rows).toHaveLength(ROW_DETAIL_CAP)
    expect(status.truncated).toBe(true)
    expect(status.rows[0]).toMatchObject({ hiddenTaskLink: true, wouldBeReturnedByTaskLinkReaders: false, toExists: false, fromExists: true, createdAt: "2026-01-01T00:00:00.000Z" })
  })

  it("is not truncated at exactly the cap, and puts parity ids first without duplicates", async () => {
    const parity = {
      unmovedTaskOriginLinks: 0,
      totalMismatches: 1,
      families: { taskReferences: { family: "TASK" as const, legacyLive: 0, mirrorLive: 0, onlyLegacy: 0, onlyEntityLinks: 1, originDrift: 0, ids: { onlyLegacy: [], onlyEntityLinks: [uuid(7)], originDrift: [] } } },
    }
    const hidden = [uuid(7), ...Array.from({ length: ROW_DETAIL_CAP - 1 }, (_, i) => uuid(100 + i))]
    const status = await getEntityLinksRowDetailStatus(scriptedClient(hidden), "s", parity)
    expect(status.rows).toHaveLength(ROW_DETAIL_CAP)
    expect(status.truncated).toBe(false)
    expect(status.rows[0]).toMatchObject({ id: uuid(7), parity: [{ family: "taskReferences", set: "onlyEntityLinks" }], hiddenTaskLink: true })
  })

  it("propagates a database error so the runner's catch reports it as the block's `error` and the GET still succeeds", async () => {
    const client = { query: async () => { throw new Error("relation does not exist") } } as unknown as PoolClient
    await expect(getEntityLinksRowDetailStatus(client, "s")).rejects.toThrow("relation does not exist")
  })
})

describe("legacy-only rows", () => {
  it("covers the four legacy tables and the opportunity pointer", () => {
    expect([...LEGACY_SOURCES]).toEqual(["artifact_links", "solution_key_result_links", "opportunity_objective_links", "task_links", "opportunities.linked_key_result_id"])
  })

  it("defines live and twin with the parity check's OWN legacy and mirror sets, per family", () => {
    const families: Record<string, string[]> = {
      artifact_links: ["artifactSolution", "artifactDecision"],
      solution_key_result_links: ["solutionKeyResult"],
      opportunity_objective_links: ["opportunityObjective"],
      task_links: ["taskReferences", "taskCreatedFrom"],
      "opportunities.linked_key_result_id": ["opportunityKeyResultPointer"],
    }
    for (const source of LEGACY_SOURCES) {
      const cte = legacyOnlyCte("s", source)
      for (const name of families[source]) {
        const sets = readParitySetsSql(name, "s")
        expect(cte, `${source}/${name} legacy`).toContain(sets.legacy)
        expect(cte, `${source}/${name} mirror`).toContain(sets.mirror)
      }
      expect(cte).toContain("m.f = r.f AND m.tt = r.tt AND m.t = r.t") // the parity pair match
    }
  })

  it("is SELECT only and keeps to the DSQL-safe subset", () => {
    for (const source of LEGACY_SOURCES) {
      const sql = `${legacyOnlySql.counts("s", source)}\n${legacyOnlySql.rows("s", source)}`
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|LOCK)\b/)
      expect(sql).not.toMatch(/statement_timeout|advisory/i)
      expect(sql).toContain(`LIMIT ${ROW_DETAIL_CAP + 1}`)
    }
  })

  it("reports legacyDropped for every source whose table is missing, without querying it", async () => {
    const queries: string[] = []
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: sql.includes("information_schema.columns") ? [{ n: "0" }] : [] } } } as unknown as PoolClient
    const status = await getLegacyOnlyStatus(client, "s")
    for (const source of LEGACY_SOURCES) expect(status.sources[source]).toEqual({ legacyDropped: true, legacyTotalCount: 0, legacyLiveCount: 0, legacyOnlyCount: 0, legacyOnlyLiveCount: 0, legacyOnlyNotLiveCount: 0, rows: [], truncated: false })
    expect(queries).toHaveLength(2) // only the two catalog reads
  })

  it("isolates a failing source in its own `error`", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "artifact_links" }, { table_name: "task_links" }] }
        if (sql.includes("information_schema.columns")) return { rows: [{ n: "0" }] }
        if (sql.includes('"artifact_links"')) throw new Error("boom")
        if (sql.includes("AS total")) return { rows: [{ total: "3", live_n: "2", only_n: "1", only_live_n: "1" }] }
        return { rows: [] }
      },
    } as unknown as PoolClient
    const status = await getLegacyOnlyStatus(client, "s")
    expect(status.sources.artifact_links).toEqual({ error: "boom" })
    expect(status.sources.task_links).toMatchObject({ legacyDropped: false, legacyTotalCount: 3, legacyLiveCount: 2, legacyOnlyCount: 1, legacyOnlyLiveCount: 1, legacyOnlyNotLiveCount: 0, rows: [], truncated: false })
    expect(status.sources.solution_key_result_links).toMatchObject({ legacyDropped: true })
  })
})
