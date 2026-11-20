/** Opt-in real PostgreSQL test. Uses a random schema, never the functional E2E schema. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";
import { getMigrationDatabaseUrl } from "@/lib/db-url";
import type { AppPrismaClient } from "@/lib/db";

const state = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null, user: null as string | null }));
vi.mock("@/lib/db", () => ({ default: () => state.prisma }));
vi.mock("@/auth", () => ({ auth: async () => state.user ? { user: { id: state.user } } : null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
import { updateTask as updateAction } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { updateTask as updateMcp } from "@/lib/task-tool-handlers";

describe.skipIf(!integrationDatabaseUrl)("task date persistence on PostgreSQL", () => {
  const schema = `task_dates_602_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let prisma: AppPrismaClient;
  let created = false;
  let workspace: string;
  let owner: string;
  let outsider: string;
  let task: string;
  const start = new Date("2026-01-01T00:00:00Z");
  const due = new Date("2026-01-30T00:00:00Z");
  const read = () => prisma.task.findUniqueOrThrow({ where: { id: task }, select: { startDate: true, dueDate: true } });
  const reset = () => prisma.task.update({ where: { id: task }, data: { startDate: start, dueDate: due } });

  beforeAll(async () => {
    const url = new URL(integrationDatabaseUrl!);
    pool = new Pool({ connectionString: integrationDatabaseUrl, max: 8 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    url.searchParams.set("schema", schema);
    // Pass the validated local target only in the child environment, not argv.
    // An explicit allowlist excludes higher-priority migration URLs from the caller.
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      DATABASE_URL: url.toString(),
    };
    if (getMigrationDatabaseUrl(childEnv) !== childEnv.DATABASE_URL) {
      throw new Error("Disposable schema target resolution failed");
    }
    try {
      execFileSync("pnpm", ["exec", "prisma", "db", "push"], { env: childEnv, stdio: "pipe", timeout: 120_000 });
    } catch {
      // Do not propagate child command, environment, stdout, or stderr into test artifacts.
      throw new Error("Disposable schema setup failed; child output withheld");
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient;
    state.prisma = prisma;
    const column = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='start_date'", [schema]);
    expect(column.rowCount).toBe(1);
    const org = await prisma.organization.create({ data: { slug: `date-${randomUUID()}`, name: "Date test" } });
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, slug: "dates", name: "Dates" } });
    const other = await prisma.workspace.create({ data: { organizationId: org.id, slug: "other", name: "Other" } });
    workspace = ws.id;
    owner = (await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Owner" } })).id;
    outsider = (await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Outsider" } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId: workspace, userId: owner, role: "MEMBER" } });
    await prisma.workspaceMember.create({ data: { workspaceId: other.id, userId: outsider, role: "MEMBER" } });
    task = (await prisma.task.create({ data: { workspaceId: workspace, title: "Date test", startDate: start, dueDate: due } })).id;
    state.user = owner;
  }, 180_000);

  afterAll(async () => {
    state.prisma = null;
    try {
      await (prisma as unknown as PrismaClient | undefined)?.$disconnect();
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await pool?.end(); }
  });

  it("persists partial updates, null, and offset instants; rejects invalid ranges without writes", async () => {
    await reset();
    await updateAction(task, { startDate: new Date("2026-01-02T01:00:00+02:00") }, "/");
    expect(await read()).toEqual({ startDate: new Date("2026-01-01T23:00:00Z"), dueDate: due });
    await updateAction(task, { dueDate: new Date("2026-01-01T23:00:00Z") }, "/");
    expect(await read()).toEqual({ startDate: new Date("2026-01-01T23:00:00Z"), dueDate: new Date("2026-01-01T23:00:00Z") });
    const before = await read();
    await expect(updateAction(task, { dueDate: new Date("invalid") }, "/")).rejects.toThrow("Invalid dueDate");
    await expect(updateAction(task, { startDate: due }, "/")).rejects.toThrow();
    expect(await read()).toEqual(before);
    await updateAction(task, { dueDate: null }, "/");
    expect(await read()).toEqual({ startDate: before.startDate, dueDate: null });
    await updateAction(task, { startDate: null }, "/");
    expect(await read()).toEqual({ startDate: null, dueDate: null });
  });

  it("rejects unauthenticated and other-tenant action writes", async () => {
    await reset();
    state.user = null;
    await expect(updateAction(task, { startDate: due }, "/")).rejects.toThrow("Unauthorized");
    state.user = outsider;
    await expect(updateAction(task, { startDate: due }, "/")).rejects.toThrow("Not found");
    state.user = owner;
    expect(await read()).toEqual({ startDate: start, dueDate: due });
  });

  for (const surface of ["action", "mcp"] as const) {
    it(`does not persist an inverted range during conflicting ${surface} partial updates`, async () => {
      await reset();
      let reads = 0;
      let guardedWriteAttempts = 0;
      const observed: Array<{ startDate: Date | null; dueDate: Date | null }> = [];
      let release!: () => void;
      const bothRead = new Promise<void>(resolve => { release = resolve; });
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("INCONCLUSIVE: both validation reads did not reach barrier")), 5000); });
      const instrumented = (prisma as unknown as PrismaClient).$extends({ query: { task: {
        async updateMany({ args, query }) {
          if (args.where?.id !== task) return query(args);
          await Promise.race([bothRead, timeout]);
          expect(args.where.workspaceId).toBe(workspace);
          guardedWriteAttempts++;
          return query(args);
        },
        async findUnique({ args, query }) {
          const result = await query(args);
          // Only the two call sites' validation reads select both dates. Capture's
          // later unselected prefetch must not re-enter or satisfy the barrier.
          if (args.where.id === task && args.select?.startDate === true && args.select?.dueDate === true) {
            reads++;
            if (!result || !("startDate" in result) || !("dueDate" in result)) throw new Error("INCONCLUSIVE: validation read shape changed");
            observed.push({ startDate: result.startDate as Date | null, dueDate: result.dueDate as Date | null });
            if (reads === 2) release();
            if (reads > 2) throw new Error("INCONCLUSIVE: unexpected additional validation read");
            await Promise.race([bothRead, timeout]);
          }
          return result;
        },
      } } });
      state.prisma = instrumented as unknown as AppPrismaClient;
      let results: PromiseSettledResult<unknown>[];
      try {
        const calls = surface === "action"
          ? [updateAction(task, { startDate: new Date("2026-01-20T00:00:00Z") }, "/"), updateAction(task, { dueDate: new Date("2026-01-10T00:00:00Z") }, "/")]
          : [updateMcp({ taskId: task, startDate: "2026-01-20T00:00:00Z" }), updateMcp({ taskId: task, dueDate: "2026-01-10T00:00:00Z" })];
        results = await Promise.allSettled(calls);
      } finally { clearTimeout(timer!); state.prisma = prisma; }
      expect(reads, "INCONCLUSIVE: both actual reads must reach barrier").toBe(2);
      expect(observed).toEqual([{ startDate: start, dueDate: due }, { startDate: start, dueDate: due }]);
      const final = await read();
      expect(final.startDate!.getTime(), JSON.stringify({ results, final })).toBeLessThanOrEqual(final.dueDate!.getTime());
      // A pass requires exactly one successful intended write and one specific
      // validation or serialization conflict. Infrastructure errors are failures,
      // never evidence that the integrity invariant was enforced.
      const isDateConflict = (message: string | undefined) =>
        message === "startDate cannot be after dueDate" || message === "Task date range changed; reload and retry";
      const classify = (result: PromiseSettledResult<unknown>) => {
        if (result.status === "rejected") {
          const error = result.reason as { code?: string; message?: string };
          if (error?.code === "P2034" || error?.code === "40001") return "serialization conflict";
          if (isDateConflict(error?.message)) return "conflict";
          return "unexpected";
        }
        if (surface === "action") return "success";
        const output = result.value as { structuredContent?: { ok?: boolean; message?: string } };
        if (output?.structuredContent?.ok === true) return "success";
        if (output?.structuredContent?.ok === false && isDateConflict(output.structuredContent.message)) return "conflict";
        return "unexpected";
      };
      const classifications = results.map(classify);
      expect(classifications.filter(value => value === "success"), JSON.stringify({ results, final })).toHaveLength(1);
      expect(classifications.filter(value => value === "conflict" || value === "serialization conflict"), JSON.stringify({ results, final })).toHaveLength(1);
      const expected = classifications[0] === "success"
        ? { startDate: new Date("2026-01-20T00:00:00Z"), dueDate: due }
        : { startDate: start, dueDate: new Date("2026-01-10T00:00:00Z") };
      expect(final).toEqual(expected);
      expect(guardedWriteAttempts).toBeGreaterThanOrEqual(2);
    }, 15_000);
  }
});
