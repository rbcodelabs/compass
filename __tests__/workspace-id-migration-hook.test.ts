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
  repairWorkspaceIdResidual,
  withOccRetry,
} from "@/lib/migrations/workspace-id-on-solution-objective";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective";
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
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).rejects.toThrow(/3 solutions rows still have NULL workspace_id \(2 reference a missing opportunities row, 0 have no opportunity_id at all/);
    expect(query.mock.calls.some(([sql]) => /NOT EXISTS/i.test(sql as string))).toBe(false);
  });

  it("names the migration it is running as, so a 069 failure says 069 (not 068)", async () => {
    const nulls = (sql: string) => (sql.includes("LEFT JOIN") ? { rows: [{ total: "1", with_parent: "0" }] } : healthy(sql));
    const { client } = fakeClient(nulls);
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s", "069_workspace_id_residual_backfill")).rejects.toThrow(/^069_workspace_id_residual_backfill: backfill postcondition failed/);
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s")).rejects.toThrow(/^068_workspace_id_on_solution_objective: backfill postcondition failed/);
    const missingColumn = fakeClient((sql) => (sql.includes("information_schema.columns") ? { rows: [] } : healthy(sql)));
    await expect(assertWorkspaceIdOnSolutionObjective(missingColumn.client, "s", "069_workspace_id_residual_backfill")).rejects.toThrow(/^069_workspace_id_residual_backfill: column postcondition failed/);
  });

  it("reports a row with neither a workspace_id nor a parent key (e.g. a cycle-less Objective) separately, and still fails closed", async () => {
    // Phase 1 makes objectives.cycle_id optional. A cycle-less Objective that somehow has no workspace_id has nothing to derive one from.
    const { client } = fakeClient((sql) => {
      if (sql.includes("LEFT JOIN") && sql.includes('"objectives"')) return { rows: [{ total: "2", with_parent: "0" }] };
      if (sql.includes("child.cycle_id IS NULL")) return { rows: [{ n: "2" }] };
      return healthy(sql);
    });
    await expect(assertWorkspaceIdOnSolutionObjective(client, "s", "069_workspace_id_residual_backfill")).rejects.toThrow(
      /2 objectives rows still have NULL workspace_id \(0 reference a missing okr_cycles row, 2 have no cycle_id at all and nothing to derive a workspace from/,
    );
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

describe("069 is explicit-only and the residual repair is repeatable", () => {
  it("an untargeted POST never runs 069; a targeted POST does", () => {
    const pending = [{ name: "070_x" }, { name: "069_workspace_id_residual_backfill" }, { name: "071_y" }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["070_x", "071_y"]);
    expect(selectMigrationsToRun(pending, "069_workspace_id_residual_backfill").map((m) => m.name)).toEqual(["069_workspace_id_residual_backfill"]);
    expect(selectMigrationsToRun(pending, "070_x").map((m) => m.name)).toEqual(["070_x"]);
  });

  it("a fresh-schema caller (the scoped preview worker) opts in and gets everything, 069 last; production callers do not", () => {
    const pending = [{ name: "068_workspace_id_on_solution_objective" }, { name: "069_workspace_id_residual_backfill" }];
    expect(selectMigrationsToRun(pending, undefined, true).map((m) => m.name)).toEqual(["068_workspace_id_on_solution_objective", "069_workspace_id_residual_backfill"]);
    expect(selectMigrationsToRun(pending, undefined, false).map((m) => m.name)).toEqual(["068_workspace_id_on_solution_objective"]);
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["068_workspace_id_on_solution_objective"]);
  });

  it("reports what an untargeted run skipped, and nothing when targeted or opted in", () => {
    const pending = [{ name: "070_x" }, { name: "069_workspace_id_residual_backfill" }];
    expect(skippedExplicitOnly(pending)).toEqual(["069_workspace_id_residual_backfill"]);
    expect(skippedExplicitOnly(pending, "070_x")).toEqual([]);
    expect(skippedExplicitOnly(pending, undefined, true)).toEqual([]);
    expect(skippedExplicitOnly([{ name: "070_x" }])).toEqual([]);
  });

  it("the scoped preview worker opts in (source check), and no production-style caller does", () => {
    const worker = readFileSync(path.join(process.cwd(), "scripts/preview-automation/migrate.ts"), "utf8");
    expect(worker).toMatch(/applyMigrations\(pool, schema, undefined, \{[^}]*includeExplicitOnly: true/);
    for (const file of ["app/api/admin/migrate/route.ts", "lib/preview-automation/managed-migrations.ts"]) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toContain("includeExplicitOnly");
    }
  });

  it("the vercel-managed request path is handled before the strict body parser, so its own body contract is untouched", () => {
    const route = readFileSync(path.join(process.cwd(), "app/api/admin/migrate/route.ts"), "utf8");
    const post = route.slice(route.indexOf("export async function POST"));
    expect(post.indexOf('return managedRequest(req, true)')).toBeGreaterThan(-1);
    expect(post.indexOf("managedRequest(req, true)")).toBeLessThan(post.indexOf("parseMigratePostBody("));
  });

  it("the managed (vercel-managed) path still advances only by an explicit script", async () => {
    const managed = readFileSync(path.join(process.cwd(), "lib/preview-automation/managed-migrations.ts"), "utf8");
    expect(managed).toMatch(/applyMigrations\(pool, context\.schema, script, \{ preProvisionedSchema: true, managedPilot: true \}\)/);
    // applyMigrations itself refuses a managed invocation with no target.
    const runner = readFileSync(path.join(process.cwd(), "lib/migrations/runner.ts"), "utf8");
    expect(runner).toMatch(/options\.managedPilot && \(.*!targetScript\)\) throw new Error\("Invalid managed migration invocation"\)/);
  });

  function poolWith(handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
    const { client, query } = fakeClient(handler);
    const release = vi.fn();
    return { pool: { connect: async () => ({ ...(client as object), query, release }) } as never, query, release };
  }
  const columnsPresent = (sql: string) => (sql.includes("information_schema.columns") && sql.includes("ANY") ? { rows: [{ table_name: "solutions" }, { table_name: "objectives" }] } : null);

  it("refuses before touching data when 068 has not been applied", async () => {
    const { pool, release } = poolWith(() => ({ rows: [] }));
    await expect(repairWorkspaceIdResidual(pool, "s", noSleep)).rejects.toBeInstanceOf(WorkspaceIdBackfillRefusal);
    await expect(repairWorkspaceIdResidual(pool, "s", noSleep)).rejects.toThrow(/apply 068/);
    expect(release).toHaveBeenCalled();
  });

  it("backfills NULL rows, runs the postconditions, and returns before/after counts; repeatable", async () => {
    let remaining = 2;
    const { pool, query } = poolWith((sql) => {
      const present = columnsPresent(sql);
      if (present) return present;
      if (sql.startsWith("SELECT child.id")) {
        if (!sql.includes('"solutions"') || remaining === 0) return { rows: [] };
        const rows = Array.from({ length: remaining }, (_, i) => ({ id: `s${i}`, workspace_id: "wa" }));
        remaining = 0;
        return { rows };
      }
      if (sql.startsWith("UPDATE")) return { rowCount: 2 };
      if (sql.includes("is_nullable")) return { rows: [{ is_nullable: "YES" }] };
      if (sql.includes("pg_index")) return { rows: [{ indisvalid: true }] };
      if (sql.includes("LEFT JOIN") && sql.includes("count(parent.id)")) return { rows: [{ total: "0", with_parent: "0" }] };
      return { rows: [{ n: "0", count: "0" }] };
    });
    const first = await repairWorkspaceIdResidual(pool, "s", noSleep);
    expect(first.log).toContain("  ✓ backfilled 2 solutions.workspace_id rows");
    expect(first.after.nullWorkspaceId).toEqual({ solutions: 0, objectives: 0 });
    const second = await repairWorkspaceIdResidual(pool, "s", noSleep);
    expect(second.log).toContain("  ✓ backfilled 0 solutions.workspace_id rows");
    expect(query.mock.calls.some(([sql]) => /CREATE|ALTER|INSERT INTO "s"\._prisma_migrations/i.test(sql as string))).toBe(false); // no DDL, no receipt
  });

  it("fails closed on an orphan and attaches the before-counts and log for the operator", async () => {
    const { pool } = poolWith((sql) => {
      const present = columnsPresent(sql);
      if (present) return present;
      if (sql.startsWith("SELECT child.id")) return { rows: [] };
      if (sql.includes("is_nullable")) return { rows: [{ is_nullable: "YES" }] };
      if (sql.includes("pg_index")) return { rows: [{ indisvalid: true }] };
      if (sql.includes("LEFT JOIN") && sql.includes("count(parent.id)")) return { rows: [{ total: "1", with_parent: "0" }] };
      return { rows: [{ n: "0", count: "0" }] };
    });
    await expect(repairWorkspaceIdResidual(pool, "s", noSleep)).rejects.toBeInstanceOf(WorkspaceIdBackfillRefusal);
    await expect(repairWorkspaceIdResidual(pool, "s", noSleep)).rejects.toMatchObject({
      message: expect.stringContaining("backfill-workspace-id: backfill postcondition failed"),
      before: { columnsPresent: true },
      log: expect.any(Array),
    });
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
