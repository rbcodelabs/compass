/**
 * Runs the REGISTERED migration 073 through the real runner (`applyMigrations`)
 * against a throwaway schema in the local compass_e2e database. Never touches
 * Aurora or any shared environment, and never deletes rows outside its own schema.
 *
 * The schema is built with `prisma db push` from the CURRENT schema.prisma, which now
 * declares the thinking_model columns (the code PR). The test then DROPS those two
 * columns to recreate the state production is in before 073 is applied, and proves
 * two things: 073 is a pure additive no-op for existing rows, and the current Prisma
 * client reads and writes the columns once 073 has added them.
 *
 *   THINKING_MODEL_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/workspace-thinking-model-migration.integration.test.ts --maxWorkers=2
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";

const MIGRATION = "073_workspace_thinking_model";
const databaseUrl = process.env.THINKING_MODEL_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("073 workspace thinking_model columns (registered migration)", () => {
  // Prefix must not contain the column name: the index/constraint probes below regex on it.
  const schema = `tmcols_${randomUUID().replaceAll("-", "")}`;
  const previous = process.env.DATABASE_URL;
  let pool: Pool;
  let prisma: ReturnType<typeof makeClient>;
  let created = false;
  let orgId: string;
  let beforeRows: Record<string, unknown>[] = [];

  const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql.replaceAll("{S}", `"${schema}"`), params);
  const makeClient = (p: Pool) => new PrismaClient({ adapter: new PrismaPg(p, { schema }) }).$extends(injectUpdatedAtExtension);

  async function apply() {
    const response = await applyMigrations(pool, schema, MIGRATION);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function status() {
    const response = await getMigrationStatus(pool, schema);
    return (await response.json()) as Record<string, unknown>;
  }
  const receipts = async () =>
    Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRATION])).rows[0].n);
  const columns = async () =>
    (
      await q(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'workspaces' AND column_name LIKE 'thinking_model%'
          ORDER BY column_name`,
        [schema],
      )
    ).rows;
  const workspaceRows = async () =>
    (await q(`SELECT to_jsonb(w) AS j FROM {S}.workspaces w ORDER BY w.slug`)).rows.map((r) => r.j as Record<string, unknown>);
  const withoutNewColumns = (row: Record<string, unknown>) => {
    return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("thinking_model")));
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Requires an isolated local compass_e2e URL without a schema override");
    }
    process.env.DATABASE_URL = databaseUrl;
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    url.searchParams.set("schema", schema);
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 90_000 });
    } catch {
      throw new Error("Could not prepare the owned local thinking-model schema");
    }
    prisma = makeClient(pool);

    // Pre-073 state: existing workspaces written by today's client.
    const org = await prisma.organization.create({ data: { slug: "tm-org", name: "Thinking Model Org" } });
    orgId = org.id;
    await prisma.workspace.create({ data: { organizationId: orgId, slug: "tm-a", name: "Workspace A", description: "first", nowLimit: 3, roadmapPublic: true } });
    await prisma.workspace.create({ data: { organizationId: orgId, slug: "tm-b", name: "Workspace B", brandingPrimaryHex: "#112233" } });
    // db push built the columns from the current schema.prisma; production has none until 073, so remove them.
    await q(`ALTER TABLE {S}.workspaces DROP COLUMN thinking_model, DROP COLUMN thinking_model_labels`);
    beforeRows = await workspaceRows();
  });

  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("before: columns are absent and 073 is pending in the status/preflight", async () => {
    expect(beforeRows).toHaveLength(2);
    expect(await columns()).toEqual([]);
    const before = await status();
    expect(before.manifest).toContain(MIGRATION);
    expect(before.pending).toContain(MIGRATION);
    expect(before.appliedMigrations).not.toContain(MIGRATION);
  });

  it("applies 073 through the real runner and records exactly one receipt", async () => {
    const { status: code, body } = await apply();
    expect(body, JSON.stringify(body)).not.toHaveProperty("error");
    expect(code).toBe(200);
    expect(await receipts()).toBe(1);
  });

  it("adds thinking_model VARCHAR(40) and thinking_model_labels TEXT, both nullable with no default", async () => {
    expect(await columns()).toEqual([
      { column_name: "thinking_model", data_type: "character varying", character_maximum_length: 40, is_nullable: "YES", column_default: null },
      { column_name: "thinking_model_labels", data_type: "text", character_maximum_length: null, is_nullable: "YES", column_default: null },
    ]);
    // No index and no constraint was created on either column.
    const indexed = await q(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'workspaces' AND indexdef ~ 'thinking_model'`,
      [schema],
    );
    expect(indexed.rows).toEqual([]);
    const constrained = await q(
      `SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'workspaces' AND pg_get_constraintdef(c.oid) ~ 'thinking_model'`,
      [schema],
    );
    expect(constrained.rows).toEqual([]);
  });

  it("leaves existing rows untouched: new columns are NULL and every other column is byte-identical", async () => {
    const after = await workspaceRows();
    expect(after).toHaveLength(beforeRows.length);
    for (const [index, row] of after.entries()) {
      expect(row.thinking_model).toBeNull();
      expect(row.thinking_model_labels).toBeNull();
      expect(withoutNewColumns(row)).toEqual(beforeRows[index]);
    }
  });

  it("status/preflight after: 073 is applied and no longer pending, response shape unchanged", async () => {
    const afterStatus = await status();
    expect(afterStatus.appliedMigrations).toContain(MIGRATION);
    expect(afterStatus.pending).not.toContain(MIGRATION);
    expect(afterStatus.unresolvedMigrations).not.toContain(MIGRATION);
    // 073 adds no status field: no hook, no preflight section.
    expect(Object.keys(afterStatus).filter((key) => /thinking/i.test(key))).toEqual([]);
  });

  it("is idempotent: a second run applies nothing and keeps one receipt and the same columns", async () => {
    const columnsBefore = await columns();
    const again = await apply();
    expect(again.status).toBe(200);
    expect(String(again.body.message)).toContain("Nothing to apply");
    expect(await receipts()).toBe(1);
    expect(await columns()).toEqual(columnsBefore);
  });

  it("re-executing the raw DDL (receipt lost) is also a no-op thanks to IF NOT EXISTS", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    const rerun = await apply();
    expect(rerun.body, JSON.stringify(rerun.body)).not.toHaveProperty("error");
    expect(rerun.status).toBe(200);
    expect(await receipts()).toBe(1);
    expect(await columns()).toHaveLength(2);
    expect((await workspaceRows()).map(withoutNewColumns)).toEqual(beforeRows);
  });

  it("the current Prisma client (with thinkingModel fields) does Workspace CRUD against the schema once 073 added the columns", async () => {
    const created = await prisma.workspace.create({ data: { organizationId: orgId, slug: "tm-c", name: "Workspace C" } });
    expect(created.thinkingModel).toBeNull();
    expect(created.thinkingModelLabels).toBeNull();
    expect(created.slug).toBe("tm-c");

    const found = await prisma.workspace.findFirst({ where: { slug: "tm-a", organizationId: orgId }, include: { organization: true } });
    expect(found?.description).toBe("first");
    expect(found?.nowLimit).toBe(3);
    expect(found?.organization.slug).toBe("tm-org");

    const updated = await prisma.workspace.update({ where: { id: created.id }, data: { name: "Workspace C renamed", launchWorkflowEnabled: true } });
    expect(updated.name).toBe("Workspace C renamed");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const listed = await prisma.workspace.findMany({ where: { organizationId: orgId }, select: { id: true, slug: true, name: true }, orderBy: { slug: "asc" } });
    expect(listed.map((w) => w.slug)).toEqual(["tm-a", "tm-b", "tm-c"]);

    // New rows written by old code leave the new columns NULL.
    const raw = await q(`SELECT thinking_model, thinking_model_labels FROM {S}.workspaces WHERE id = $1`, [created.id]);
    expect(raw.rows[0]).toEqual({ thinking_model: null, thinking_model_labels: null });

    await prisma.workspace.delete({ where: { id: created.id } });
    expect(await prisma.workspace.count({ where: { organizationId: orgId } })).toBe(2);
  });

  it("the new columns accept values within their declared shape (for the later code PR) without disturbing other columns", async () => {
    const [a] = await workspaceRows();
    await q(`UPDATE {S}.workspaces SET thinking_model = 'ost', thinking_model_labels = '{"x":"y"}' WHERE slug = 'tm-a'`);
    await expect(q(`UPDATE {S}.workspaces SET thinking_model = $1 WHERE slug = 'tm-a'`, ["x".repeat(41)])).rejects.toThrow(/too long/);
    const [after] = await workspaceRows();
    expect(withoutNewColumns(after)).toEqual(withoutNewColumns(a));
    // Old client still reads the row fine with non-NULL new columns.
    const read = await prisma.workspace.findFirst({ where: { slug: "tm-a", organizationId: orgId } });
    expect(read?.name).toBe("Workspace A");
    await q(`UPDATE {S}.workspaces SET thinking_model = NULL, thinking_model_labels = NULL WHERE slug = 'tm-a'`);
  });
});
