import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  OCC_MAX_ATTEMPTS,
  WORKSPACE_ID_BACKFILL_BATCH_SIZE,
  assertWorkspaceIdOnSolutionObjective,
  backfillWorkspaceIdOnSolutionObjective,
  getWorkspaceIdBackfillStatus,
  isOccConflict,
  withOccRetry,
} from "@/lib/migrations/workspace-id-on-solution-objective";
import { REVIEWED_MIGRATION_CODE_SHA256, assertReviewedMigrationCode } from "@/lib/preview-automation/managed-manifest";

const conflict = () => Object.assign(new Error("change conflicts with another transaction, please retry: (OC000)"), { code: "40001" });
const noSleep = async () => {};

describe("withOccRetry", () => {
  it("recognises DSQL optimistic-concurrency conflicts by SQLSTATE or message, and nothing else", () => {
    expect(isOccConflict(conflict())).toBe(true);
    expect(isOccConflict(Object.assign(new Error("x"), { code: "40001" }))).toBe(true);
    expect(isOccConflict(new Error("OC001 conflict"))).toBe(true);
    expect(isOccConflict(Object.assign(new Error("boom"), { code: "23505" }))).toBe(false);
    expect(isOccConflict(null)).toBe(false);
  });

  it("retries a 40001 with exponential backoff and then succeeds", async () => {
    const work = vi.fn().mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValue("ok");
    const sleeps: number[] = [];
    await expect(withOccRetry(work, async (ms) => { sleeps.push(ms); })).resolves.toBe("ok");
    expect(work).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] - 1); // backoff grows (jitter < base)
  });

  it("is bounded: a conflict that never clears is thrown after OCC_MAX_ATTEMPTS", async () => {
    const work = vi.fn().mockRejectedValue(conflict());
    await expect(withOccRetry(work, noSleep)).rejects.toThrow(/OC000/);
    expect(work).toHaveBeenCalledTimes(OCC_MAX_ATTEMPTS);
  });

  it("does not retry anything that is not a conflict", async () => {
    const work = vi.fn().mockRejectedValue(Object.assign(new Error("syntax error"), { code: "42601" }));
    await expect(withOccRetry(work, noSleep)).rejects.toThrow("syntax error");
    expect(work).toHaveBeenCalledTimes(1);
  });
});

function fakeClient(handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number } | Error) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const result = handler(sql, params);
    if (result instanceof Error) throw result;
    return { rows: [], rowCount: 0, ...result };
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe("backfillWorkspaceIdOnSolutionObjective", () => {
  it("groups each batch by workspace, updates only NULL rows, and retries a conflicting UPDATE", async () => {
    const pending: Record<string, Array<{ id: string; workspace_id: string }>> = {
      solutions: [{ id: "s1", workspace_id: "wa" }, { id: "s2", workspace_id: "wb" }, { id: "s3", workspace_id: "wa" }],
      objectives: [],
    };
    let failedOnce = false;
    const updates: Array<[string, string[]]> = [];
    const { client, query } = fakeClient((sql, params) => {
      if (sql.startsWith("SELECT")) {
        const table = /FROM "s"\."(\w+)"/.exec(sql)![1];
        const rows = pending[table].splice(0, WORKSPACE_ID_BACKFILL_BATCH_SIZE);
        return { rows };
      }
      if (!failedOnce) { failedOnce = true; return conflict(); }
      expect(sql).toContain("workspace_id IS NULL");
      updates.push([params[0] as string, params[1] as string[]]);
      return { rowCount: (params[1] as string[]).length };
    });
    const log: string[] = [];
    await backfillWorkspaceIdOnSolutionObjective(client, "s", log, noSleep);
    expect(updates).toEqual([["wa", ["s1", "s3"]], ["wb", ["s2"]]]);
    expect(log).toEqual(["  ✓ backfilled 3 solutions.workspace_id rows", "  ✓ backfilled 0 objectives.workspace_id rows"]);
    expect(query.mock.calls.every(([sql]) => !/\bWITH\b|UPDATE[^$]*\bFROM\b/i.test(sql as string))).toBe(true); // no CTE / UPDATE ... FROM
  });

  it("gives up (leaving the migration unfinished) when conflicts never clear", async () => {
    const { client } = fakeClient((sql) => (sql.startsWith("SELECT") ? { rows: [{ id: "s1", workspace_id: "wa" }] } : conflict()));
    await expect(backfillWorkspaceIdOnSolutionObjective(client, "s", [], noSleep)).rejects.toThrow(/OC000/);
  });
});

describe("assertWorkspaceIdOnSolutionObjective", () => {
  const healthy = (sql: string) => {
    if (sql.includes("information_schema.columns")) return { rows: [{ is_nullable: "YES" }] };
    if (sql.includes("pg_index")) return { rows: [{ indisvalid: true }] };
    if (sql.includes("LEFT JOIN")) return { rows: [{ total: "0", with_parent: "0" }] };
    return { rows: [{ count: "0" }] };
  };

  it("passes when columns, indexes, NULL and agreement checks are clean", async () => {
    const { client } = fakeClient(healthy);
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).resolves.toBeUndefined();
  });

  it("counts orphans with a LEFT JOIN (no correlated NOT EXISTS) and names them in the error", async () => {
    const { client, query } = fakeClient((sql) => (sql.includes("LEFT JOIN") ? { rows: [{ total: "3", with_parent: "1" }] } : healthy(sql)));
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).rejects.toThrow(/3 solutions rows still have NULL workspace_id \(2 have no opportunities parent\)/);
    expect(query.mock.calls.some(([sql]) => /NOT EXISTS/i.test(sql as string))).toBe(false);
  });

  it("fails on parent/child drift", async () => {
    const { client } = fakeClient((sql) => (sql.includes("<>") ? { rows: [{ count: "2" }] } : healthy(sql)));
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).rejects.toThrow(/agreement postcondition failed: 2 solutions rows disagree/);
  });

  it("fails when an index is missing or invalid", async () => {
    const { client } = fakeClient((sql) => (sql.includes("pg_index") ? { rows: [] } : healthy(sql)));
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).rejects.toThrow(/index postcondition failed: idx_solutions_workspace_id/);
  });
});

describe("getWorkspaceIdBackfillStatus (GET /api/admin/migrate preflight)", () => {
  it("reports orphan counts before the columns exist and no NULL/drift numbers", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [] };
      return { rows: [{ n: sql.includes('"solutions"') ? "4" : "1" }] };
    });
    await expect(getWorkspaceIdBackfillStatus(client, "s")).resolves.toEqual({
      columnsPresent: false,
      orphans: { solutions: 4, objectives: 1 },
      nullWorkspaceId: null,
      parentDrift: null,
    });
  });

  it("reports orphan, NULL and drift counts once the columns exist", async () => {
    const { client } = fakeClient((sql) => {
      if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "solutions" }, { table_name: "objectives" }] };
      const table = sql.includes('"solutions"') ? "solutions" : "objectives";
      const n = sql.includes("parent.id IS NULL") ? 1 : sql.includes("IS NOT NULL AND") ? 2 : 3;
      return { rows: [{ n: String(table === "solutions" ? n : n + 10) }] };
    });
    await expect(getWorkspaceIdBackfillStatus(client, "s")).resolves.toEqual({
      columnsPresent: true,
      orphans: { solutions: 1, objectives: 11 },
      nullWorkspaceId: { solutions: 3, objectives: 13 },
      parentDrift: { solutions: 2, objectives: 12 },
    });
  });
});

describe("managed manifest pins the backfill hook code, not only the SQL", () => {
  const NAME = "068_workspace_id_on_solution_objective";
  const HOOK = "lib/migrations/workspace-id-on-solution-objective.ts";

  it("accepts the reviewed hook file as it is on disk", () => {
    expect(() => assertReviewedMigrationCode(NAME)).not.toThrow();
    const real = readFileSync(path.join(process.cwd(), HOOK));
    expect(createHash("sha256").update(real).digest("hex")).toBe(REVIEWED_MIGRATION_CODE_SHA256[NAME][HOOK]);
  });

  it("rejects a hook whose contents were changed after review", () => {
    const tampered = Buffer.from(readFileSync(path.join(process.cwd(), HOOK), "utf8") + "\n// changed\n");
    expect(() => assertReviewedMigrationCode(NAME, () => tampered)).toThrow(/code digest changed: 068_workspace_id_on_solution_objective/);
  });

  it("does nothing for migrations that have no reviewed code", () => {
    expect(() => assertReviewedMigrationCode("001_init", () => { throw new Error("must not read"); })).not.toThrow();
  });
});
