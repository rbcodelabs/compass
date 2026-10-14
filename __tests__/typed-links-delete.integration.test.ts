/**
 * The UI and MCP key result / objective deletes against a REAL Prisma client (relationMode = "prisma" Restrict emulation) and a real
 * Postgres schema, in a throwaway schema of the local compass_e2e database:
 *
 *   TYPED_LINK_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/typed-links-delete.integration.test.ts
 *
 * Answers, with evidence: does deleting a key result that has check-ins (or supporting objectives) really throw? (yes, below) And
 * therefore: the parent is deleted FIRST and its links drained AFTER, so a refused delete keeps every link.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/db", () => ({ default: () => holder.client }));
vi.mock("@/lib/product-action-auth", () => ({
  requireProductWorkspace: vi.fn().mockResolvedValue("ws"),
  requireProductEntity: vi.fn().mockResolvedValue({ workspaceId: "ws", opportunityId: null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }));
vi.mock("@/lib/okr-hierarchy", () => ({ getEligibleParentKeyResults: vi.fn(), setObjectiveParentKeyResult: vi.fn() }));

import { applyMigrations } from "@/lib/migrations/runner";
import { deleteKeyResult as deleteKeyResultAction, deleteObjective as deleteObjectiveAction } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { deleteKeyResult as deleteKeyResultTool, deleteObjective as deleteObjectiveTool } from "@/lib/okr-tool-handlers";

const databaseUrl = process.env.TYPED_LINK_TEST_DATABASE_URL ?? process.env.WORKSPACE_ID_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("key result and objective deletes against a real Prisma client", () => {
  const schema = `tldel_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const previous = process.env.DATABASE_URL;
  const WS = randomUUID();
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);
  const one = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n);
  const statements: { query: string; params: string }[] = [];
  let prisma: PrismaClient;

  // Per-test rows, rebuilt by beforeEach so every test starts from the same graph.
  let cycle: string, obj: string, supporting: string, kr: string, oppPointing: string, oppDirectOnly: string, sol: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // Every table the Restrict / SetNull emulation of these deletes reads exists: the early simple migrations, then 068 and 071.
    const names = readdirSync(path.join(process.cwd(), "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name < "039" || name === "064_solution_scoring" || name === "068_workspace_id_on_solution_objective" || name === "071_typed_link_tables")
      .sort();
    for (const name of names) {
      const applied = await applyMigrations(pool, schema, name);
      expect(applied.status, `${name}: ${JSON.stringify(await applied.json())}`).toBe(200);
    }
    const { PrismaClient: Client } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const client = new Client({ adapter: new PrismaPg(pool, { schema }), log: [{ emit: "event", level: "query" }] });
    (client as unknown as { $on(event: "query", cb: (e: { query: string; params: string }) => void): void }).$on("query", (e) => statements.push({ query: e.query, params: e.params }));
    prisma = client;
    holder.client = client;
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  beforeEach(async () => {
    for (const table of ["opportunity_objective_links", "solution_key_result_links", "check_ins", "solutions", "opportunities", "key_results", "objectives", "okr_cycles"]) {
      await q(`DELETE FROM {S}.${table}`);
    }
    [cycle, obj, supporting, kr, oppPointing, oppDirectOnly, sol] = Array.from({ length: 7 }, () => randomUUID());
    await q(`INSERT INTO {S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1,$2,'c','2026-01-01','2026-03-31')`, [cycle, WS]);
    await q(`INSERT INTO {S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1,$2,$3,'obj'), ($4,$2,$3,'supporting')`, [obj, WS, cycle, supporting]);
    await q(`INSERT INTO {S}.key_results (id, objective_id, title, target) VALUES ($1,$2,'kr',1)`, [kr, obj]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title, linked_key_result_id) VALUES ($1,$2,'points at kr',$3), ($4,$2,'direct only',NULL)`, [oppPointing, WS, kr, oppDirectOnly]);
    await q(`INSERT INTO {S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1,$2,$3,'sol')`, [sol, WS, oppPointing]);
    // The links the dual-write would have made: a LEGACY one for the pointer, a DIRECT one the user made, a solution link.
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'LEGACY'), ($1,$4,$3,'DIRECT')`, [WS, oppPointing, obj, oppDirectOnly]);
    await q(`INSERT INTO {S}.solution_key_result_links (workspace_id, solution_id, key_result_id) VALUES ($1,$2,$3)`, [WS, sol, kr]);
    statements.length = 0;
  });

  const counts = async () => ({
    legacy: await one(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links WHERE origin = 'LEGACY'`),
    direct: await one(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links WHERE origin = 'DIRECT'`),
    solution: await one(`SELECT count(*)::int AS n FROM {S}.solution_key_result_links`),
  });
  const krExists = async () => (await one(`SELECT count(*)::int AS n FROM {S}.key_results WHERE id = $1`, [kr])) === 1;

  it("EVIDENCE: under relationMode=prisma a key result with check-ins, or with a supporting objective, cannot be deleted", async () => {
    await q(`INSERT INTO {S}.check_ins (id, key_result_id, value) VALUES (gen_random_uuid(), $1, 1)`, [kr]);
    await expect(prisma.keyResult.delete({ where: { id: kr } })).rejects.toThrow();
    expect(await krExists()).toBe(true);
    await q(`DELETE FROM {S}.check_ins`);

    await q(`UPDATE {S}.objectives SET parent_key_result_id = $1 WHERE id = $2`, [kr, supporting]);
    await expect(prisma.keyResult.delete({ where: { id: kr } })).rejects.toThrow();
    expect(await krExists()).toBe(true);
  });

  it("UI deleteKeyResult REFUSED by check-ins throws and every link survives", async () => {
    await q(`INSERT INTO {S}.check_ins (id, key_result_id, value) VALUES (gen_random_uuid(), $1, 1)`, [kr]);
    await expect(deleteKeyResultAction(kr, "/p")).rejects.toThrow();
    expect(await krExists()).toBe(true);
    expect(await counts()).toEqual({ legacy: 1, direct: 1, solution: 1 });
  });

  it("UI deleteKeyResult REFUSED by a supporting objective throws and every link survives", async () => {
    await q(`UPDATE {S}.objectives SET parent_key_result_id = $1 WHERE id = $2`, [kr, supporting]);
    await expect(deleteKeyResultAction(kr, "/p")).rejects.toThrow();
    expect(await krExists()).toBe(true);
    expect(await counts()).toEqual({ legacy: 1, direct: 1, solution: 1 });
  });

  it("UI deleteKeyResult that goes through: the key result and the pointer go, then the LEGACY and solution links; the DIRECT link stays", async () => {
    await deleteKeyResultAction(kr, "/p");
    expect(await krExists()).toBe(false);
    expect(await one(`SELECT count(*)::int AS n FROM {S}.opportunities WHERE id = $1 AND linked_key_result_id IS NULL`, [oppPointing])).toBe(1);
    expect(await counts()).toEqual({ legacy: 0, direct: 1, solution: 0 });
  });

  it("MCP deleteKeyResult (which clears check-ins and supporting objectives itself) removes the key result, then the LEGACY and solution links", async () => {
    await q(`INSERT INTO {S}.check_ins (id, key_result_id, value) VALUES (gen_random_uuid(), $1, 1)`, [kr]);
    const result = await deleteKeyResultTool({ keyResultId: kr });
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.data).toMatchObject({ deleted: true, removedOpportunityLinks: 1, removedSolutionLinks: 1 });
    expect(await krExists()).toBe(false);
    expect(await counts()).toEqual({ legacy: 0, direct: 1, solution: 0 });
  });

  it("an objective that still has key results is refused (UI and MCP) and keeps its links; once childless its links go, in passes of at most 500 links", async () => {
    await expect(deleteObjectiveAction(obj, "/p")).rejects.toThrow();
    const refused = await deleteObjectiveTool({ objectiveId: obj });
    expect(refused.structuredContent.ok).toBe(false);
    expect(await counts()).toEqual({ legacy: 1, direct: 1, solution: 1 });

    await deleteKeyResultAction(kr, "/p");
    await q(
      `INSERT INTO {S}.opportunities (id, workspace_id, title) SELECT gen_random_uuid(), $1, 'bulk ' || g FROM generate_series(1, 1203) g`,
      [WS],
    );
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) SELECT $1, o.id, $2, 'LEGACY' FROM {S}.opportunities o WHERE o.title LIKE 'bulk %'`, [WS, obj]);
    expect(await one(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links WHERE objective_id = $1`, [obj])).toBe(1204);

    statements.length = 0;
    await deleteObjectiveAction(obj, "/p");
    expect(await one(`SELECT count(*)::int AS n FROM {S}.objectives WHERE id = $1`, [obj])).toBe(0);
    expect(await one(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links WHERE objective_id = $1`, [obj])).toBe(0);
    const linkDeletes = statements.filter((s) => /DELETE FROM/.test(s.query) && /opportunity_objective_links/.test(s.query));
    expect(linkDeletes.length).toBeGreaterThanOrEqual(3);
    for (const statement of linkDeletes) {
      // Prisma repeats the id list in the DELETE (the original filter AND the ids it just selected), so the DISTINCT bound values are the ids per statement.
      expect(new Set(JSON.parse(statement.params) as unknown[]).size, statement.query.slice(0, 120)).toBeLessThanOrEqual(500);
    }
  });

  it("if the post-delete drain fails (link table unavailable) the key result is still gone and the user sees success, not an error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await q(`ALTER TABLE {S}.solution_key_result_links RENAME TO solution_key_result_links_hidden`);
    try {
      await expect(deleteKeyResultAction(kr, "/p")).resolves.toBeUndefined();
      expect(await krExists()).toBe(false);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "typed_links.cleanup_failed", surface: "ui.deleteKeyResult.solution" })]),
      );
    } finally {
      await q(`ALTER TABLE {S}.solution_key_result_links_hidden RENAME TO solution_key_result_links`);
      log.mockRestore();
    }
    // The leftover is a link to a deleted key result: hidden from reads (endpoint join) and reported by linkIntegrity.directDangling.
    expect((await counts()).solution).toBe(1);
  });
});
