import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  OCC_MAX_ATTEMPTS,
  isOccConflict,
  withOccRetry,
  TYPED_LINK_BACKFILL_BATCH_SIZE,
  TYPED_LINK_RESIDUAL_MIGRATION,
  TYPED_LINK_TABLES_MIGRATION,
  assertTypedLinkPreconditions,
  assertTypedLinkTables,
  backfillOpportunityObjectiveLinks,
  getDirectLinkReport,
  getTypedLinkStatus,
} from "@/lib/migrations/typed-link-tables";
import { REVIEWED_MIGRATION_CODE_SHA256, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest";

const noSleep = async () => {};
const conflict = () => Object.assign(new Error("change conflicts with another transaction, please retry: (OC000)"), { code: "40001" });

type Reply = { rows?: unknown[]; rowCount?: number } | Error | undefined;
function fakeClient(handler: (sql: string, params: unknown[]) => Reply) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const result = handler(sql, params);
    if (result instanceof Error) throw result;
    return { rows: [], rowCount: 0, ...result };
  });
  return { client: { query } as unknown as PoolClient, query };
}

// SQL shape markers shared between the module and these tests.
const isCrossWorkspaceQuery = (sql: string) => /obj\.workspace_id <> o\.workspace_id/.test(sql) && sql.startsWith("SELECT o.id");
const isDanglingQuery = (sql: string) => /kr\.id IS NULL OR obj\.id IS NULL/.test(sql) && sql.startsWith("SELECT o.id");
const isPruneSelect = (sql: string) => sql.startsWith("SELECT l.id AS id") && sql.includes("l.origin = 'LEGACY'");
const isPruneDelete = (sql: string) => sql.startsWith("DELETE FROM");
const isCandidateQuery =(sql: string) => /l\.id IS NULL/.test(sql) && sql.includes("linked_key_result_id");
// The read-only report of user-made (DIRECT / solution) links the backfill logs at the end.
const isDirectReportQuery = (sql: string) =>
  sql.startsWith("SELECT count(*)") &&
  ((sql.includes("opportunity_objective_links") && sql.includes("l.origin = 'DIRECT'")) || sql.includes("solution_key_result_links"));

describe("batch size", () => {
  it("stays inside DSQL's 3,000-row write limit once each link row's three secondary index entries are counted", () => {
    expect(TYPED_LINK_BACKFILL_BATCH_SIZE).toBeGreaterThanOrEqual(250);
    expect(TYPED_LINK_BACKFILL_BATCH_SIZE).toBeLessThanOrEqual(500);
    // 1 table row + 3 secondary index entries per inserted link.
    expect(TYPED_LINK_BACKFILL_BATCH_SIZE * 4).toBeLessThan(3000);
  });
});

describe("withOccRetry (private copy, same behaviour as the 068 hook's)", () => {
  it("recognises DSQL optimistic-concurrency conflicts by SQLSTATE or message, and nothing else", () => {
    expect(isOccConflict(conflict())).toBe(true);
    expect(isOccConflict(Object.assign(new Error("x"), { code: "40001" }))).toBe(true);
    expect(isOccConflict(new Error("OC001 conflict"))).toBe(true);
    expect(isOccConflict(Object.assign(new Error("boom"), { code: "23505" }))).toBe(false);
    expect(isOccConflict(null)).toBe(false);
  });

  it("retries with growing backoff, is bounded, and does not retry non-conflicts", async () => {
    const work = vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValue("ok");
    const sleeps: number[] = [];
    await expect(withOccRetry(work, async (ms) => { sleeps.push(ms); })).resolves.toBe("ok");
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] - 1);

    const never = vi.fn().mockRejectedValue(conflict());
    await expect(withOccRetry(never, noSleep)).rejects.toThrow(/OC000/);
    expect(never).toHaveBeenCalledTimes(OCC_MAX_ATTEMPTS);

    const syntax = vi.fn().mockRejectedValue(Object.assign(new Error("syntax error"), { code: "42601" }));
    await expect(withOccRetry(syntax, noSleep)).rejects.toThrow("syntax error");
    expect(syntax).toHaveBeenCalledTimes(1);
  });

  it("does not import the 068 hook, so an edit there cannot break this hook's digest pin", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/migrations/typed-link-tables.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*workspace-id-on-solution-objective/);
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256[TYPED_LINK_TABLES_MIGRATION])).toEqual(["lib/migrations/typed-link-tables.ts"]);
  });
});

describe("assertTypedLinkPreconditions (fail closed before any DDL)", () => {
  const healthy = (sql: string): Reply => {
    if (sql.includes("_prisma_migrations")) return { rows: [{ n: "1" }] };
    if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
    return { rows: [{ n: "0" }] };
  };

  it("passes when 068 has a receipt, the column exists and no objective has a NULL workspace_id", async () => {
    const { client } = fakeClient(healthy);
    await expect(assertTypedLinkPreconditions(client, "s")).resolves.toBeUndefined();
  });

  it("throws a clear message when 068 is not applied", async () => {
    const { client } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "0" }] } : healthy(sql)));
    await expect(assertTypedLinkPreconditions(client, "s")).rejects.toThrow(/071_typed_link_tables[\s\S]*068_workspace_id_on_solution_objective[\s\S]*not applied/);
  });

  it("throws when objectives.workspace_id is missing", async () => {
    const { client } = fakeClient((sql) => (sql.includes("information_schema.columns") ? { rows: [] } : healthy(sql)));
    await expect(assertTypedLinkPreconditions(client, "s")).rejects.toThrow(/objectives\.workspace_id does not exist/);
  });

  it("throws when any objective still has a NULL workspace_id", async () => {
    const { client } = fakeClient((sql) => (sql.includes("IS NULL") ? { rows: [{ n: "3" }] } : healthy(sql)));
    await expect(assertTypedLinkPreconditions(client, "s")).rejects.toThrow(/3 objectives rows have a NULL workspace_id/);
  });
});

describe("backfillOpportunityObjectiveLinks", () => {
  const candidate = (i: number) => ({ opportunity_id: `o${i}`, workspace_id: "wa", objective_id: `b${i}` });
  const preconditionsOk = (sql: string): Reply => {
    if (sql.includes("_prisma_migrations")) return { rows: [{ n: "1" }] };
    if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
    if (/"objectives"\s+WHERE workspace_id IS NULL/.test(sql)) return { rows: [{ n: "0" }] };
    return undefined;
  };
  const quietQuarantine = (sql: string): Reply =>
    preconditionsOk(sql) ?? (isCrossWorkspaceQuery(sql) || isDanglingQuery(sql) || isPruneSelect(sql) || isDirectReportQuery(sql) ? { rows: [] } : undefined);

  it("inserts candidates as LEGACY/MIGRATION rows in bounded batches, looping until a batch is empty", async () => {
    const pending = Array.from({ length: TYPED_LINK_BACKFILL_BATCH_SIZE + 3 }, (_, i) => candidate(i));
    const inserts: unknown[][] = [];
    const { client, query } = fakeClient((sql, params) => {
      const quiet = quietQuarantine(sql);
      if (quiet) return quiet;
      if (isCandidateQuery(sql)) return { rows: pending.splice(0, params[0] as number) };
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain("'LEGACY'");
      expect(sql).toContain("'MIGRATION'");
      inserts.push(params);
      return { rowCount: params.length / 3 };
    });
    const log: string[] = [];
    const result = await backfillOpportunityObjectiveLinks(client, "s", log, noSleep);
    expect(inserts.map((p) => p.length / 3)).toEqual([TYPED_LINK_BACKFILL_BATCH_SIZE, 3]);
    expect(result.inserted).toBe(TYPED_LINK_BACKFILL_BATCH_SIZE + 3);
    expect(log.join("\n")).toContain(`inserted ${TYPED_LINK_BACKFILL_BATCH_SIZE + 3} LEGACY opportunity_objective_links`);
    // No ON CONFLICT (unverified against DSQL ASYNC unique indexes) and no CTE.
    expect(query.mock.calls.every(([sql]) => !/ON CONFLICT|\bWITH\b/i.test(sql as string))).toBe(true);
  });

  it("retries a conflicting INSERT, and gives up (leaving the migration unfinished) when conflicts never clear", async () => {
    let failures = 1;
    const pending = [candidate(1)];
    const flaky = fakeClient((sql, params) => {
      const quiet = quietQuarantine(sql);
      if (quiet) return quiet;
      if (isCandidateQuery(sql)) return { rows: pending.splice(0, params[0] as number) };
      if (failures-- > 0) return conflict();
      return { rowCount: 1 };
    });
    await expect(backfillOpportunityObjectiveLinks(flaky.client, "s", [], noSleep)).resolves.toMatchObject({ inserted: 1 });

    const stuck = fakeClient((sql) => quietQuarantine(sql) ?? (isCandidateQuery(sql) ? { rows: [candidate(1)] } : conflict()));
    await expect(backfillOpportunityObjectiveLinks(stuck.client, "s", [], noSleep)).rejects.toThrow(/OC000/);
  });

  it("reports quarantined orphans by id, never links them, and never touches opportunities", async () => {
    const { client, query } = fakeClient((sql) => {
      const ok = preconditionsOk(sql);
      if (ok) return ok;
      if (isCrossWorkspaceQuery(sql)) return { rows: [{ opportunity_id: "x1" }, { opportunity_id: "x2" }] };
      if (isDanglingQuery(sql)) return { rows: [{ opportunity_id: "d1" }] };
      return { rows: [] };
    });
    const log: string[] = [];
    const result = await backfillOpportunityObjectiveLinks(client, "s", log, noSleep);
    expect(result.quarantined).toEqual({ crossWorkspace: ["x1", "x2"], dangling: ["d1"] });
    expect(log.join("\n")).toMatch(/quarantined 2 cross-workspace[^\n]*x1, x2/);
    expect(log.join("\n")).toMatch(/quarantined 1 dangling[^\n]*d1/);
    const select = query.mock.calls.map(([sql]) => sql as string).find(isCandidateQuery)!;
    expect(select).toContain("obj.workspace_id = o.workspace_id");
    // The only write besides the link INSERT/DELETE is nothing: opportunities are never updated or deleted.
    expect(query.mock.calls.every(([sql]) => !/\bUPDATE\b|DELETE FROM "s"\."opportunities"/i.test(sql as string))).toBe(true);
  });

  it("prunes stale LEGACY links before inserting, only ever by origin = 'LEGACY', in batches within the 500 cap", async () => {
    const stale = Array.from({ length: TYPED_LINK_BACKFILL_BATCH_SIZE + 2 }, (_, i) => ({ id: `l${i}` }));
    const order: string[] = [];
    const deletes: string[][] = [];
    const { client, query } = fakeClient((sql, params) => {
      const ok = preconditionsOk(sql);
      if (ok) return ok;
      if (isPruneSelect(sql)) { order.push("select-stale"); return { rows: stale.splice(0, params[0] as number) }; }
      if (isPruneDelete(sql)) {
        order.push("delete");
        expect(sql).toContain("origin = 'LEGACY'");
        deletes.push(params[0] as string[]);
        return { rowCount: (params[0] as string[]).length };
      }
      if (isCandidateQuery(sql)) { order.push("candidates"); return { rows: [] }; }
      return { rows: [] };
    });
    const log: string[] = [];
    const result = await backfillOpportunityObjectiveLinks(client, "s", log, noSleep);
    expect(result.pruned).toBe(TYPED_LINK_BACKFILL_BATCH_SIZE + 2);
    expect(deletes.map((ids) => ids.length)).toEqual([TYPED_LINK_BACKFILL_BATCH_SIZE, 2]);
    expect(order.indexOf("candidates")).toBeGreaterThan(order.lastIndexOf("delete"));
    expect(log.join("\n")).toContain(`pruned ${TYPED_LINK_BACKFILL_BATCH_SIZE + 2} stale LEGACY opportunity_objective_links rows`);
    const select = query.mock.calls.map(([sql]) => sql as string).find(isPruneSelect)!;
    // Stale = endpoint gone, pointer cleared/changed (kr joined on the link's objective), or workspace drift.
    expect(select).toContain("kr.objective_id = l.objective_id");
    expect(select).toMatch(/o\.id IS NULL OR kr\.id IS NULL OR obj\.id IS NULL/);
    expect(select).toContain("l.workspace_id IS DISTINCT FROM o.workspace_id");
    expect(select).toContain("l.workspace_id IS DISTINCT FROM obj.workspace_id");
  });

  it("retries a conflicting prune DELETE, and throws rather than loop when a guarded DELETE removes nothing", async () => {
    let failures = 1;
    const once = [{ id: "l1" }];
    const flaky = fakeClient((sql, params) => {
      const ok = preconditionsOk(sql);
      if (ok) return ok;
      if (isPruneSelect(sql)) return { rows: once.splice(0, params[0] as number) };
      if (isPruneDelete(sql)) return failures-- > 0 ? conflict() : { rowCount: 1 };
      return { rows: [] };
    });
    await expect(backfillOpportunityObjectiveLinks(flaky.client, "s", [], noSleep)).resolves.toMatchObject({ pruned: 1 });

    const stuck = fakeClient((sql) => preconditionsOk(sql) ?? (isPruneSelect(sql) ? { rows: [{ id: "l1" }] } : isPruneDelete(sql) ? { rowCount: 0 } : { rows: [] }));
    await expect(backfillOpportunityObjectiveLinks(stuck.client, "s", [], noSleep)).rejects.toThrow(/prune made no progress/);
  });

  it("checks preconditions first and inserts nothing when they fail", async () => {
    const { client, query } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "0" }] } : { rows: [] }));
    await expect(backfillOpportunityObjectiveLinks(client, "s", [], noSleep)).rejects.toThrow(/not applied/);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO/.test(sql as string))).toBe(false);
  });
});

describe("assertTypedLinkTables postconditions", () => {
  const COLUMNS: Record<string, string[]> = {
    opportunity_objective_links: ["id", "workspace_id", "opportunity_id", "objective_id", "origin", "source", "created_by_id", "created_at"],
    solution_key_result_links: ["id", "workspace_id", "solution_id", "key_result_id", "source", "created_by_id", "created_at"],
  };
  const healthy = (sql: string, params: unknown[]): Reply => {
    if (sql.includes("information_schema.columns")) {
      return { rows: COLUMNS[params[1] as string].map((column_name) => ({ column_name, is_nullable: column_name === "created_by_id" ? "YES" : "NO" })) };
    }
    if (sql.includes("pg_index")) return { rows: [{ indisvalid: true, indisunique: /_pair$/.test(params[1] as string) }] };
    return { rows: [{ n: "0" }] };
  };

  it("passes when tables, indexes and all integrity counts are clean", async () => {
    const { client } = fakeClient(healthy);
    await expect(assertTypedLinkTables(client, "s")).resolves.toBeUndefined();
  });

  it("fails when a table is missing or workspace_id is nullable", async () => {
    const missing = fakeClient((sql, p) => (sql.includes("information_schema.columns") ? { rows: [] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(missing.client, "s")).rejects.toThrow(/table postcondition failed: opportunity_objective_links/);
    const nullable = fakeClient((sql, p) => {
      const base = healthy(sql, p) as { rows: { column_name: string; is_nullable: string }[] };
      if (!sql.includes("information_schema.columns")) return base;
      return { rows: base.rows.map((r) => (r.column_name === "workspace_id" ? { ...r, is_nullable: "YES" } : r)) };
    });
    await expect(assertTypedLinkTables(nullable.client, "s")).rejects.toThrow(/workspace_id must be NOT NULL/);
  });

  it("fails when an index is missing, invalid, or a pair index is not unique", async () => {
    const missing = fakeClient((sql, p) => (sql.includes("pg_index") ? { rows: [] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(missing.client, "s")).rejects.toThrow(/index postcondition failed: idx_opportunity_objective_links_pair/);
    const invalid = fakeClient((sql, p) => (sql.includes("pg_index") ? { rows: [{ indisvalid: false, indisunique: true }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(invalid.client, "s")).rejects.toThrow(/missing or invalid/);
    const notUnique = fakeClient((sql, p) => (sql.includes("pg_index") ? { rows: [{ indisvalid: true, indisunique: false }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(notUnique.client, "s")).rejects.toThrow(/must be unique/);
  });

  const cases: Array<[string, (sql: string) => boolean, RegExp]> = [
    ["legacy rows without a link", isCandidateQuery, /2 legacy opportunity rows lack a link/],
    ["a pointer to an objective with a NULL workspace_id", (sql) => sql.startsWith("SELECT count") && /obj\.workspace_id IS NULL/.test(sql), /2 legacy pointers reference an objective with a NULL workspace_id/],
    ["a pointer that falls in no class (partition not exhaustive)", (sql) => sql.includes('FROM "s"."opportunities" AS o WHERE o.linked_key_result_id IS NOT NULL') && !sql.includes("JOIN"), /2 legacy pointers but only 0 fall in a known class/],
    ["a LEGACY link whose workspace differs from an endpoint's", (sql) => sql.includes("IS DISTINCT FROM") && sql.includes("l.origin = 'LEGACY'"), /2 LEGACY opportunity_objective_links rows have a workspace_id that differs/],
    ["a LEGACY link with a missing endpoint", (sql) => /o\.id IS NULL OR obj\.id IS NULL/.test(sql) && sql.includes("l.origin = 'LEGACY'"), /2 LEGACY opportunity_objective_links rows point at a missing endpoint/],
    ["duplicates", (sql) => sql.includes("HAVING count(*) > 1") && sql.includes("opportunity_objective_links"), /2 duplicate opportunity_objective_links pairs/],
    ["an origin outside DIRECT/LEGACY", (sql) => sql.includes("origin NOT IN"), /2 opportunity_objective_links rows have an origin other than DIRECT or LEGACY/],
  ];
  it.each(cases)("fails closed on %s", async (_name, matches, message) => {
    const { client } = fakeClient((sql, p) => (matches(sql) ? { rows: [{ n: "2" }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(client, "s")).rejects.toThrow(message);
  });
});

describe("getTypedLinkStatus (GET /api/admin/migrate)", () => {
  const bothTables = { rows: [{ table_name: "opportunity_objective_links" }, { table_name: "solution_key_result_links" }] };

  it("returns a null linkIntegrity while the tables do not exist, with the orphan preflight still readable", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema.tables")) return { rows: [] };
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      return { rows: [{ n: "4" }] };
    });
    const status = await getTypedLinkStatus(client, "s");
    expect(status.linkIntegrity).toBeNull();
    expect(status.preflight).toMatchObject({ tablesPresent: false, legacyDangling: 4, legacyCrossWorkspace: 4, legacyObjectiveWorkspaceNull: 4 });
  });

  it("reports cross-workspace as null (not zero) when objectives.workspace_id does not exist yet", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema")) return { rows: [] };
      return { rows: [{ n: "1" }] };
    });
    const { preflight } = await getTypedLinkStatus(client, "s");
    expect(preflight.legacyCrossWorkspace).toBeNull();
    expect(preflight.legacyObjectiveWorkspaceNull).toBeNull();
  });

  it("reports each anomaly class as a count once the tables exist", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema.tables")) return bothTables;
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      let n = "0";
      if (isCandidateQuery(sql)) n = "5";
      else if (/obj\.workspace_id IS NULL/.test(sql)) n = "8";
      else if (isCrossWorkspaceQuery(sql) || /obj\.workspace_id <> o\.workspace_id/.test(sql)) n = "6";
      else if (/kr\.id IS NULL OR obj\.id IS NULL/.test(sql) && !sql.includes("solution_key_result_links")) n = "7";
      else if (sql.includes("IS DISTINCT FROM") && sql.includes("l.origin = 'LEGACY'")) n = "2";
      else if (/o\.id IS NULL OR obj\.id IS NULL/.test(sql) && sql.includes("l.origin = 'LEGACY'")) n = "3";
      else if (sql.includes("IS DISTINCT FROM") && sql.includes("l.origin = 'DIRECT'")) n = "11";
      else if (/o\.id IS NULL OR obj\.id IS NULL/.test(sql) && sql.includes("l.origin = 'DIRECT'")) n = "12";
      else if (sql.includes("HAVING count(*) > 1") && sql.includes("opportunity_objective_links")) n = "4";
      return { rows: [{ n }] };
    });
    const { linkIntegrity } = await getTypedLinkStatus(client, "s");
    expect(linkIntegrity).toMatchObject({
      legacyWithoutLink: 5,
      // LEGACY only: these are the fail-closed postconditions.
      workspaceMismatch: 2,
      danglingEndpoint: 3,
      // User-made links (DIRECT here; the solution table adds its own, zero in this fake): reported, never failed on.
      directDangling: 12,
      directWorkspaceMismatch: 11,
      duplicates: 4,
      legacyCrossWorkspace: 6,
      legacyDangling: 7,
      legacyObjectiveWorkspaceNull: 8,
    });
  });

  it("sums the solution/key-result table into the same totals", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema.tables")) return bothTables;
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      return { rows: [{ n: sql.includes("solution_key_result_links") && sql.includes("HAVING count(*) > 1") ? "9" : "0" }] };
    });
    expect((await getTypedLinkStatus(client, "s")).linkIntegrity?.duplicates).toBe(9);
  });

  it("only ever runs read-only SELECT queries", async () => {
    const { client, query } = fakeClient((sql) => {
      if (sql.includes("information_schema.tables")) return bothTables;
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      return { rows: [{ n: "0" }] };
    });
    await getTypedLinkStatus(client, "s");
    expect(query.mock.calls.length).toBeGreaterThan(3);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/i.test(sql as string))).toBe(true);
  });
});

describe("072 residual pass: the same function, with DIRECT links reported rather than failed on", () => {
  const COLUMNS: Record<string, string[]> = {
    opportunity_objective_links: ["id", "workspace_id", "opportunity_id", "objective_id", "origin", "source", "created_by_id", "created_at"],
    solution_key_result_links: ["id", "workspace_id", "solution_id", "key_result_id", "source", "created_by_id", "created_at"],
  };
  const healthy = (sql: string, params: unknown[]): Reply => {
    if (sql.includes("information_schema.columns")) {
      return { rows: COLUMNS[params[1] as string].map((column_name) => ({ column_name, is_nullable: column_name === "created_by_id" ? "YES" : "NO" })) };
    }
    if (sql.includes("pg_index")) return { rows: [{ indisvalid: true, indisunique: /_pair$/.test(params[1] as string) }] };
    return { rows: [{ n: "0" }] };
  };
  const isDirectEndpointQuery = (sql: string) =>
    (sql.includes("l.origin = 'DIRECT'") && sql.includes("opportunity_objective_links")) ||
    (sql.includes("solution_key_result_links") && (sql.includes("IS DISTINCT FROM") || /sol\.id IS NULL OR kr\.id IS NULL/.test(sql)));

  it("is registered as its own name and shares the 071 hook file and digest", () => {
    expect(TYPED_LINK_RESIDUAL_MIGRATION).toBe("072_typed_links_residual_backfill");
    expect(REVIEWED_MIGRATION_CODE_SHA256[TYPED_LINK_RESIDUAL_MIGRATION]).toEqual(REVIEWED_MIGRATION_CODE_SHA256[TYPED_LINK_TABLES_MIGRATION]);
  });

  describe("preconditions", () => {
    const withReceipts = (applied: string[]) => (sql: string, params: unknown[]): Reply => {
      if (sql.includes("_prisma_migrations")) return { rows: [{ n: applied.includes(params[0] as string) ? "1" : "0" }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      return { rows: [{ n: "0" }] };
    };
    it("requires 068 and 071, naming 072 in the failure", async () => {
      const no068 = fakeClient(withReceipts(["071_typed_link_tables"]));
      await expect(assertTypedLinkPreconditions(no068.client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).rejects.toThrow(/^072_typed_links_residual_backfill: precondition failed: 068_workspace_id_on_solution_objective is not applied/);
      const no071 = fakeClient(withReceipts(["068_workspace_id_on_solution_objective"]));
      await expect(assertTypedLinkPreconditions(no071.client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).rejects.toThrow(/^072_typed_links_residual_backfill: precondition failed: 071_typed_link_tables is not applied/);
      const both = fakeClient(withReceipts(["068_workspace_id_on_solution_objective", "071_typed_link_tables"]));
      await expect(assertTypedLinkPreconditions(both.client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).resolves.toBeUndefined();
    });
    it("071 itself still does not require a 071 receipt", async () => {
      const only068 = fakeClient(withReceipts(["068_workspace_id_on_solution_objective"]));
      await expect(assertTypedLinkPreconditions(only068.client, "s")).resolves.toBeUndefined();
    });
  });

  it("does NOT fail on DIRECT links with a missing endpoint or a workspace mismatch, nor on solution links", async () => {
    const { client } = fakeClient((sql, p) => (isDirectEndpointQuery(sql) ? { rows: [{ n: "7" }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).resolves.toBeUndefined();
    await expect(assertTypedLinkTables(client, "s")).resolves.toBeUndefined();
  });

  it("still fails closed on LEGACY rows, with the 072 name in the message", async () => {
    const mismatch = fakeClient((sql, p) => (sql.includes("IS DISTINCT FROM") && sql.includes("l.origin = 'LEGACY'") ? { rows: [{ n: "2" }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(mismatch.client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).rejects.toThrow(/^072_typed_links_residual_backfill: agreement postcondition failed: 2 LEGACY opportunity_objective_links/);
    const unlinked = fakeClient((sql, p) => (isCandidateQuery(sql) ? { rows: [{ n: "1" }] } : healthy(sql, p)));
    await expect(assertTypedLinkTables(unlinked.client, "s", TYPED_LINK_RESIDUAL_MIGRATION)).rejects.toThrow(/^072_typed_links_residual_backfill: backfill postcondition failed/);
  });

  it("the DIRECT checks only ever read, and never mention a DELETE of a DIRECT row anywhere in the hook", async () => {
    const source = readFileSync(path.join(process.cwd(), "lib/migrations/typed-link-tables.ts"), "utf8");
    // The only DELETE the hook issues is the LEGACY prune, guarded twice.
    const deletes = source.match(/DELETE FROM[^`]*/g) ?? [];
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("origin = 'LEGACY'");
  });

  it("the backfill reports the DIRECT counts in its log and leaves the DIRECT rows alone", async () => {
    const preconditionsOk = (sql: string): Reply => {
      if (sql.includes("_prisma_migrations")) return { rows: [{ n: "1" }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ column_name: "workspace_id" }] };
      if (/"objectives"\s+WHERE workspace_id IS NULL/.test(sql)) return { rows: [{ n: "0" }] };
      return undefined;
    };
    const { client, query } = fakeClient((sql) => {
      const ok = preconditionsOk(sql);
      if (ok) return ok;
      if (isDirectEndpointQuery(sql)) return { rows: [{ n: "4" }] };
      return { rows: [] };
    });
    const log: string[] = [];
    await backfillOpportunityObjectiveLinks(client, "s", log, noSleep, TYPED_LINK_RESIDUAL_MIGRATION);
    // 4 from the opportunity DIRECT dangling query + 4 from the solution dangling query.
    expect(log.join("\n")).toMatch(/reported 8 DIRECT\/solution links with a missing endpoint and 8 with a workspace mismatch/);
    expect(query.mock.calls.some(([sql]) => /DELETE FROM/.test(sql as string))).toBe(false);
  });

  it("getDirectLinkReport sums the opportunity DIRECT links and the solution links", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("l.origin = 'DIRECT'") && sql.includes("IS DISTINCT FROM")) return { rows: [{ n: "1" }] };
      if (sql.includes("l.origin = 'DIRECT'")) return { rows: [{ n: "2" }] };
      if (sql.includes("solution_key_result_links") && sql.includes("IS DISTINCT FROM")) return { rows: [{ n: "10" }] };
      if (sql.includes("solution_key_result_links") && /sol\.id IS NULL/.test(sql)) return { rows: [{ n: "20" }] };
      return { rows: [{ n: "0" }] };
    });
    expect(await getDirectLinkReport(client, "s")).toEqual({ directWorkspaceMismatch: 11, directDangling: 22 });
  });

  it("the DIRECT report queries never select LEGACY rows (a LEGACY row is pruned or failed on, not reported)", async () => {
    const { client, query } = fakeClient(() => ({ rows: [{ n: "0" }] }));
    await getDirectLinkReport(client, "s");
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls.some((sql) => sql.includes("'LEGACY'"))).toBe(false);
    expect(sqls.filter((sql) => sql.includes("opportunity_objective_links")).every((sql) => sql.includes("l.origin = 'DIRECT'"))).toBe(true);
  });
});

describe("managed manifest pins the hook code", () => {
  const HOOK = "lib/migrations/typed-link-tables.ts";
  it.each([TYPED_LINK_TABLES_MIGRATION, TYPED_LINK_RESIDUAL_MIGRATION])("accepts the reviewed hook as on disk and rejects a changed one (%s)", (name) => {
    expect(() => assertReviewedMigrationCode(name)).not.toThrow();
    const real = readFileSync(path.join(process.cwd(), HOOK));
    expect(createHash("sha256").update(real).digest("hex")).toBe(REVIEWED_MIGRATION_CODE_SHA256[name][HOOK]);
    const tampered = Buffer.from(real.toString("utf8") + "\n// changed\n");
    expect(() => assertReviewedMigrationCode(name, () => tampered)).toThrow(new RegExp(`code digest changed: ${name}`));
  });
});
