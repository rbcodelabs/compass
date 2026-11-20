import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";

const context = vi.hoisted(() => ({ prisma: null as PrismaClient | null, userId: "" }));
vi.mock("@/lib/db", () => ({ default: () => context.prisma }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: context.userId } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { reorderKeyResult, reorderObjective } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

describe.skipIf(!integrationDatabaseUrl)("OKR reorder against PostgreSQL", () => {
  const schema = `okr_reorder_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  let prisma: PrismaClient;
  let workspaceId: string;
  const orderBy = [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

  beforeAll(async () => {
    const url = new URL(integrationDatabaseUrl!);
    pool = new Pool({ connectionString: integrationDatabaseUrl });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("schema", schema);
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], {
      stdio: "pipe", timeout: 180_000,
    });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as PrismaClient;
    context.prisma = prisma;
    const organization = await prisma.organization.create({ data: { slug: "okr-reorder", name: "Reorder fixtures" } });
    workspaceId = (await prisma.workspace.create({ data: { organizationId: organization.id, slug: "test", name: "Test" } })).id;
    context.userId = (await prisma.user.create({ data: { email: "reorder@example.test", name: "Reorder tester" } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId: context.userId, role: "ADMIN" } });
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    try {
      await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool?.end();
    }
  });

  it("persists moves in both directions without changing key results of another objective", async () => {
    const parent = await prisma.objective.create({ data: { workspaceId, title: "Parent" } });
    const other = await prisma.objective.create({ data: { workspaceId, title: "Other" } });
    const create = (objectiveId: string, title: string, sortOrder: number) =>
      prisma.keyResult.create({ data: { objectiveId, title, sortOrder, target: 10 } });
    const a = await create(parent.id, "First", 0);
    const b = await create(parent.id, "Second", 1);
    const c = await create(parent.id, "Third", 2);
    const unrelated = await create(other.id, "Unrelated", 4);
    const ranks = async () => (await prisma.keyResult.findMany({ where: { objectiveId: parent.id }, orderBy: [...orderBy] }))
      .map(({ id, sortOrder }) => [id, sortOrder]);

    await reorderKeyResult(c.id, 0, "/okrs");
    expect(await ranks()).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]]);
    await reorderKeyResult(c.id, 2, "/okrs");
    expect(await ranks()).toEqual([[a.id, 0], [b.id, 1], [c.id, 2]]);
    expect(await prisma.keyResult.findUnique({ where: { id: unrelated.id } })).toMatchObject({ sortOrder: 4 });
  });

  it("moves an objective using the visible anchor and preserves the full cycle order", async () => {
    const cycle = await prisma.oKRCycle.create({ data: {
      workspaceId, title: "Reorder period", startDate: new Date("2026-01-01"), endDate: new Date("2026-03-31"),
    } });
    const create = (title: string, sortOrder: number, cycleId: string | null = cycle.id) =>
      prisma.objective.create({ data: { workspaceId, title, sortOrder, cycleId } });
    const a = await create("First visible", 0);
    const b = await create("Hidden by name", 1);
    const c = await create("Second visible", 2);
    const unrelated = await create("Another cycle", 5, null);

    await reorderObjective(a.id, { anchorId: c.id, position: "after" }, "/okrs");
    const ranks = (await prisma.objective.findMany({ where: { workspaceId, cycleId: cycle.id }, orderBy: [...orderBy] }))
      .map(({ id, sortOrder }) => [id, sortOrder]);
    expect(ranks).toEqual([[b.id, 0], [c.id, 1], [a.id, 2]]);
    await expect(reorderObjective(a.id, { anchorId: unrelated.id, position: "after" }, "/okrs")).rejects.toThrow("Not found");
    expect(await prisma.objective.findUnique({ where: { id: unrelated.id } })).toMatchObject({ sortOrder: 5 });
  });
});
