/**
 * Real Prisma client, real adapter, real unique index, throwaway schema in the local compass_e2e database. Proves two things the
 * fakes cannot:
 *   1. a lost race on the unique pair index surfaces as an error isLinkUniqueRace recognises with the repo's actual client setup
 *      (PrismaClient + PrismaPg adapter + the updatedAt extension), so concurrent identical link calls all succeed and exactly one
 *      reports created: true (an idempotent no-op for the loser, not a raw error);
 *   2. draining a parent with more than one chunk of links runs as several committed statements of at most 500 links.
 *
 *   TYPED_LINK_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/typed-links-race.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppPrismaClient } from "@/lib/db";
import { applyMigrations } from "@/lib/migrations/runner";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";
import {
  LINK_WRITE_CHUNK,
  drainLinksFor,
  isLinkUniqueRace,
  linkOpportunityToObjective,
  linkSolutionToKeyResult,
  runTypedLinkTransaction,
} from "@/lib/typed-links";

const databaseUrl = process.env.TYPED_LINK_TEST_DATABASE_URL ?? process.env.WORKSPACE_ID_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("typed links against a real Prisma client and unique index", () => {
  const schema = `tlrace_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const previous = process.env.DATABASE_URL;
  const WS = randomUUID();
  const [cycle, objective, keyResult, opportunity, solution] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);
  const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM {S}.${table}`)).rows[0].n);
  let prisma: AppPrismaClient;
  const statements: { query: string; params: string }[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const name of ["001_init", "068_workspace_id_on_solution_objective", "071_typed_link_tables"]) {
      const applied = await applyMigrations(pool, schema, name);
      expect(applied.status, `${name}: ${JSON.stringify(await applied.json())}`).toBe(200);
    }
    await q(`INSERT INTO {S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1,$2,'c','2026-01-01','2026-03-31')`, [cycle, WS]);
    await q(`INSERT INTO {S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1,$2,$3,'o')`, [objective, WS, cycle]);
    await q(`INSERT INTO {S}.key_results (id, objective_id, title, target) VALUES ($1,$2,'k',1)`, [keyResult, objective]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title) VALUES ($1,$2,'opp')`, [opportunity, WS]);
    await q(`INSERT INTO {S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1,$2,$3,'sol')`, [solution, WS, opportunity]);

    // The repo's own client setup (lib/db.ts): PrismaClient on a PrismaPg adapter bound to the schema, plus the updatedAt extension.
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const base = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), log: [{ emit: "event", level: "query" }] });
    (base as unknown as { $on(event: "query", cb: (e: { query: string; params: string }) => void): void }).$on("query", (e) => statements.push({ query: e.query, params: e.params }));
    prisma = base.$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient;
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

  it("a duplicate insert on the pair index raises an error that isLinkUniqueRace recognises (both link models)", async () => {
    const data = { workspaceId: WS, opportunityId: opportunity, objectiveId: objective, origin: "DIRECT" };
    await prisma.opportunityObjectiveLink.create({ data });
    const error = await prisma.opportunityObjectiveLink.create({ data }).then(() => null, (e: unknown) => e);
    expect(error, "second create must fail on the unique index").not.toBeNull();
    expect(isLinkUniqueRace(error), JSON.stringify({ code: (error as { code?: string }).code, meta: (error as { meta?: unknown }).meta, message: (error as Error).message })).toBe(true);
    await prisma.opportunityObjectiveLink.deleteMany({});

    const solutionData = { workspaceId: WS, solutionId: solution, keyResultId: keyResult };
    await prisma.solutionKeyResultLink.create({ data: solutionData });
    const solutionError = await prisma.solutionKeyResultLink.create({ data: solutionData }).then(() => null, (e: unknown) => e);
    expect(isLinkUniqueRace(solutionError), (solutionError as Error)?.message).toBe(true);
    await prisma.solutionKeyResultLink.deleteMany({});
  });

  it("is not fooled by an unrelated unique violation or other errors", () => {
    expect(isLinkUniqueRace(Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002", meta: { modelName: "User" } }))).toBe(false);
    expect(isLinkUniqueRace(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(false);
    expect(isLinkUniqueRace(null)).toBe(false);
  });

  it("concurrent identical link calls all succeed: exactly one creates, the rest are idempotent no-ops (opportunity and objective)", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        runTypedLinkTransaction(prisma, (tx) => linkOpportunityToObjective(tx, { opportunityId: opportunity, objectiveId: objective, ctx: { source: "MCP", createdById: null } })),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(7);
    expect(await count("opportunity_objective_links")).toBe(1);
  });

  it("concurrent identical link calls all succeed (solution and key result)", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        runTypedLinkTransaction(prisma, (tx) => linkSolutionToKeyResult(tx, { solutionId: solution, keyResultId: keyResult, ctx: { source: "MCP", createdById: null } })),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await count("solution_key_result_links")).toBe(1);
  });

  it("drainLinksFor deletes a parent's links in committed statements of at most 500 links", async () => {
    const total = LINK_WRITE_CHUNK * 2 + 150;
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title) SELECT gen_random_uuid(), $1, 'bulk ' || g FROM generate_series(1, $2::int) g`, [WS, total]);
    await q(
      `INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin)
       SELECT $1, o.id, $2, 'DIRECT' FROM {S}.opportunities o WHERE o.title LIKE 'bulk %'`,
      [WS, objective],
    );
    // The earlier concurrent test left one link on this objective as well.
    const before = await count("opportunity_objective_links");
    expect(before).toBe(total + 1);

    statements.length = 0;
    const removed = await drainLinksFor(prisma, "objective", [objective]);
    expect(removed).toBe(before);
    expect(await count("opportunity_objective_links")).toBe(0);
    const deletes = statements.filter((s) => /DELETE FROM/.test(s.query) && /opportunity_objective_links/.test(s.query));
    // 1,151 links need at least three passes, and no DELETE can name more than one chunk of ids (the highest bind parameter is the id count).
    expect(deletes.length).toBeGreaterThanOrEqual(Math.ceil(before / LINK_WRITE_CHUNK));
    for (const statement of deletes) {
      // Prisma repeats the id list in the DELETE (the original filter AND the ids it just selected), so the DISTINCT bound values are the ids per statement.
      expect(new Set(JSON.parse(statement.params) as unknown[]).size, statement.query.slice(0, 120)).toBeLessThanOrEqual(500);
    }
    // Idempotent: a second drain finds nothing.
    expect(await drainLinksFor(prisma, "objective", [objective])).toBe(0);
  });
});
