/**
 * Real Prisma client, real PrismaPg adapter, real unique pair index, real migrations (001_init, 034_research_capture,
 * 091_entity_links) in a throwaway schema of the local compass_e2e database. Proves what the fakes cannot, for the generic
 * entity_links table:
 *   1. a lost race on idx_entity_links_pair surfaces as an error isLinkUniqueRace recognises with the repo's actual client
 *      setup, so concurrent identical link calls all succeed and exactly one reports created: true;
 *   2. link / unlink / list through the MCP tool handlers work end to end against the real schema, and tenant isolation holds;
 *   3. deleting an entity's links, and a workspace's, runs as committed statements of at most 500 links each;
 *   4. the workspace-filtered endpoint reads and the explicit updatedAt behave against real SQL.
 *
 *   TYPED_LINK_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/links/entity-links.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "@/lib/db";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/db", () => ({ default: () => holder.client }));

import { applyMigrations } from "@/lib/migrations/runner";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";
import { runWithMcpActor } from "@/lib/mcp-authz";
import { linkEntitiesTool, listLinksTool, unlinkEntitiesTool } from "@/lib/link-tool-handlers";
import { LINK_WRITE_CHUNK, deleteLinksForEntity, deleteWorkspaceLinks, linkEntities } from "@/lib/links/service";
import { isLinkUniqueRace, runTypedLinkTransaction } from "@/lib/typed-links";

const databaseUrl = process.env.TYPED_LINK_TEST_DATABASE_URL ?? process.env.WORKSPACE_ID_TEST_DATABASE_URL;
const TYPE = "EXPERIMENT_INFORMED_BY_STUDY";

describe.skipIf(!databaseUrl)("entity_links against a real Prisma client and unique index", () => {
  const schema = `elinks_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const previous = process.env.DATABASE_URL;
  const [WS_A, WS_B] = [randomUUID(), randomUUID()];
  const [expA, expA2, expB, studyA, studyArchived, studyPm, studyB] = Array.from({ length: 7 }, () => randomUUID());
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);
  const count = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.entity_links WHERE ${where}`)).rows[0].n);
  const alice = { userId: randomUUID(), purpose: "USER" as const };
  let prisma: AppPrismaClient;
  const statements: { query: string; params: string }[] = [];
  const asAlice = <T>(work: () => Promise<T>) => runWithMcpActor(alice, work);

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const name of ["001_init", "034_research_capture", "091_entity_links"]) {
      const applied = await applyMigrations(pool, schema, name);
      expect(applied.status, `${name}: ${JSON.stringify(await applied.json())}`).toBe(200);
    }
    const experiment = (id: string, ws: string, title: string) =>
      q(`INSERT INTO {S}.experiments (id, workspace_id, title, hypothesis, method, kill_condition) VALUES ($1,$2,$3,'h','m','k')`, [id, ws, title]);
    await experiment(expA, WS_A, "Experiment A");
    await experiment(expA2, WS_A, "Experiment A2");
    await experiment(expB, WS_B, "Experiment B");
    const study = (id: string, ws: string, name: string, type: string, status: string) =>
      q(`INSERT INTO {S}.research_studies (id, workspace_id, name, goal, study_type, guide, status) VALUES ($1,$2,$3,'g',$4,'[]',$5)`, [id, ws, name, type, status]);
    await study(studyA, WS_A, "Interviews A", "CUSTOMER_INTERVIEW", "ACTIVE");
    await study(studyArchived, WS_A, "Archived A", "CUSTOMER_INTERVIEW", "ARCHIVED");
    await study(studyPm, WS_A, "PM interview", "PM_INTERVIEW", "ACTIVE");
    await study(studyB, WS_B, "Interviews B", "CUSTOMER_INTERVIEW", "ACTIVE");

    // The repo's own client setup (lib/db.ts): PrismaClient on a PrismaPg adapter bound to the schema, plus the updatedAt extension.
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const base = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), log: [{ emit: "event", level: "query" }] });
    (base as unknown as { $on(event: "query", cb: (e: { query: string; params: string }) => void): void }).$on("query", (e) => statements.push({ query: e.query, params: e.params }));
    prisma = base.$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient;
    holder.client = prisma;
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

  it("a duplicate insert on the pair index raises an error that isLinkUniqueRace recognises", async () => {
    const data = { workspaceId: WS_A, linkType: TYPE, fromType: "EXPERIMENT", fromId: expA, toType: "RESEARCH_STUDY", toId: studyA };
    await prisma.entityLink.create({ data });
    const error = await prisma.entityLink.create({ data }).then(() => null, (e: unknown) => e);
    expect(error, "second create must fail on the unique index").not.toBeNull();
    expect(isLinkUniqueRace(error), JSON.stringify({ code: (error as { code?: string }).code, meta: (error as { meta?: unknown }).meta, message: (error as Error).message })).toBe(true);
    await prisma.entityLink.deleteMany({});
  });

  it("is not fooled by an unrelated unique violation", () => {
    expect(isLinkUniqueRace(Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002", meta: { modelName: "User" } }))).toBe(false);
  });

  it("concurrent identical link calls all succeed: exactly one creates, the rest are idempotent no-ops", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        runTypedLinkTransaction(prisma, (tx) => linkEntities(tx, { linkType: TYPE, fromId: expA, toId: studyA, expectedWorkspaceId: WS_A, ctx: { source: "MCP", createdById: null } })),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(7);
    expect(await count()).toBe(1);
    const row = (await q(`SELECT workspace_id, link_type, from_type, to_type, origin, source, updated_at FROM {S}.entity_links`)).rows[0];
    expect(row).toMatchObject({ workspace_id: WS_A, link_type: TYPE, from_type: "EXPERIMENT", to_type: "RESEARCH_STUDY", origin: "DIRECT", source: "MCP" });
    expect(row.updated_at).toBeInstanceOf(Date);
    await prisma.entityLink.deleteMany({});
  });

  it("link, list and unlink through the MCP tool handlers, with tenant isolation, against the real schema", async () => {
    const linked = await asAlice(() => linkEntitiesTool({ workspaceId: WS_A, linkType: TYPE, fromId: expA, toId: studyA }));
    expect(linked.structuredContent).toMatchObject({ ok: true, data: { created: true } });
    expect(linked.content[0].text.split("\n").at(-1)).toMatch(/^ID: [0-9a-f-]{36}$/);

    // Cross-workspace, PM-interview and archived-study attempts are refused and write nothing.
    for (const [fromId, toId, message] of [
      [expA, studyB, /not found in this workspace/],
      [expB, studyA, /not found in this workspace/],
      [expA, studyPm, /Research study not found/],
      [expA2, studyArchived, /Archived research studies cannot be linked/],
    ] as const) {
      const refused = await asAlice(() => linkEntitiesTool({ workspaceId: WS_A, linkType: TYPE, fromId, toId }));
      expect(refused.structuredContent.ok).toBe(false);
      expect(refused.content[0].text).toMatch(message);
    }
    expect(await count()).toBe(1);

    const fromExperiment = await asAlice(() => listLinksTool({ workspaceId: WS_A, entityType: "EXPERIMENT", entityId: expA, limit: 50 }));
    expect(fromExperiment.structuredContent.data).toMatchObject({ count: 1, items: [{ side: "from", label: "Informed by", to: { id: studyA, title: "Interviews A" } }] });
    const fromStudy = await asAlice(() => listLinksTool({ workspaceId: WS_A, entityType: "RESEARCH_STUDY", entityId: studyA, limit: 50 }));
    expect(fromStudy.structuredContent.data).toMatchObject({ count: 1, items: [{ side: "to", label: "Informs", from: { id: expA } }] });
    // The other workspace sees nothing, and cannot list A's experiment at all.
    const foreign = await asAlice(() => listLinksTool({ workspaceId: WS_B, entityType: "EXPERIMENT", entityId: expA, limit: 50 }));
    expect(foreign.structuredContent.ok).toBe(false);

    // An archived study keeps its link visible and removable.
    await q(`UPDATE {S}.research_studies SET status = 'ARCHIVED' WHERE id = $1`, [studyA]);
    expect((await asAlice(() => listLinksTool({ workspaceId: WS_A, entityType: "EXPERIMENT", entityId: expA, limit: 50 }))).structuredContent.data).toMatchObject({ count: 1 });
    // A study deleted out from under a link: the dangling row is not listed, but unlinking still works (only the from end is verified).
    await q(`DELETE FROM {S}.research_studies WHERE id = $1`, [studyA]);
    expect((await asAlice(() => listLinksTool({ workspaceId: WS_A, entityType: "EXPERIMENT", entityId: expA, limit: 50 }))).structuredContent.data).toMatchObject({ count: 0 });
    const removed = await asAlice(() => unlinkEntitiesTool({ workspaceId: WS_A, linkType: TYPE, fromId: expA, toId: studyA }));
    expect(removed.structuredContent.data).toMatchObject({ removed: 1 });
    expect((await asAlice(() => unlinkEntitiesTool({ workspaceId: WS_A, linkType: TYPE, fromId: expA, toId: studyA }))).structuredContent.data).toMatchObject({ removed: 0 });
    expect(await count()).toBe(0);
    await q(`INSERT INTO {S}.research_studies (id, workspace_id, name, goal, study_type, guide, status) VALUES ($1,$2,'Interviews A','g','CUSTOMER_INTERVIEW','[]','ACTIVE')`, [studyA, WS_A]);
  });

  it("deleteLinksForEntity removes a study's links (both directions) in committed statements of at most 500 links", async () => {
    const total = LINK_WRITE_CHUNK * 2 + 150;
    await q(`INSERT INTO {S}.experiments (id, workspace_id, title, hypothesis, method, kill_condition) SELECT gen_random_uuid(), $1, 'bulk ' || g, 'h', 'm', 'k' FROM generate_series(1, $2::int) g`, [WS_A, total]);
    await q(
      `INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id)
       SELECT $1, $2, 'EXPERIMENT', e.id, 'RESEARCH_STUDY', $3 FROM {S}.experiments e WHERE e.title LIKE 'bulk %'`,
      [WS_A, TYPE, studyA],
    );
    // One row naming the study as the FROM end (reverse direction), and one unrelated link that must survive.
    await q(`INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id) VALUES ($1,'TEST_REVERSE','RESEARCH_STUDY',$2,'EXPERIMENT',$3)`, [WS_A, studyA, expA]);
    await q(`INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id) VALUES ($1,$2,'EXPERIMENT',$3,'RESEARCH_STUDY',$4)`, [WS_A, TYPE, expA2, studyArchived]);
    const before = await count();
    expect(before).toBe(total + 2);

    statements.length = 0;
    const removed = await deleteLinksForEntity(prisma, "RESEARCH_STUDY", [studyA]);
    expect(removed).toBe(total + 1);
    expect(await count()).toBe(1);
    const deletes = statements.filter((s) => /DELETE FROM/.test(s.query) && /entity_links/.test(s.query));
    expect(deletes.length).toBeGreaterThanOrEqual(Math.ceil((total + 1) / LINK_WRITE_CHUNK));
    for (const statement of deletes) {
      // Prisma repeats the id list in the DELETE, so the DISTINCT bound values are the ids per statement.
      expect(new Set(JSON.parse(statement.params) as unknown[]).size, statement.query.slice(0, 120)).toBeLessThanOrEqual(LINK_WRITE_CHUNK);
    }
    expect(await deleteLinksForEntity(prisma, "RESEARCH_STUDY", [studyA])).toBe(0);
  });

  it("deleteWorkspaceLinks removes only that workspace's rows, in passes of at most 500", async () => {
    await q(`INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id) VALUES ($1,$2,'EXPERIMENT',$3,'RESEARCH_STUDY',$4)`, [WS_B, TYPE, expB, studyB]);
    await q(
      `INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id)
       SELECT $1, 'TEST_BULK', 'EXPERIMENT', gen_random_uuid(), 'RESEARCH_STUDY', gen_random_uuid() FROM generate_series(1, $2::int)`,
      [WS_A, LINK_WRITE_CHUNK + 40],
    );
    statements.length = 0;
    const removed = await deleteWorkspaceLinks(prisma, WS_A);
    expect(removed).toBe(LINK_WRITE_CHUNK + 40 + 1);
    expect(await count(`workspace_id = '${WS_B}'`)).toBe(1);
    expect(await count(`workspace_id = '${WS_A}'`)).toBe(0);
    const deletes = statements.filter((s) => /DELETE FROM/.test(s.query) && /entity_links/.test(s.query));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    for (const statement of deletes) expect(new Set(JSON.parse(statement.params) as unknown[]).size).toBeLessThanOrEqual(LINK_WRITE_CHUNK);
  });
});
