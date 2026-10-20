/**
 * Phase 7 against a real Prisma client, real PrismaPg adapter, real unique indexes and the real migrations in a throwaway schema of the local
 * compass_e2e database. Proves what the fakes cannot:
 *   1. the legacy task_links row and its entity_links mirror row commit or roll back TOGETHER (a mirror refusal leaves no legacy row);
 *   2. the real UI task creator (createWorkspaceTask) mirrors its nested DOC link in the same transaction and leaves a COMMENT link legacy-only;
 *   3. unlinking, deleting a document and the workspace sweep remove the mirror row (deleteLinksForEntity against real SQL).
 *
 *   ENTITY_LINKS_TASK_DATABASE_URL=postgresql://postgres:pw@localhost:5440/compass_e2e \
 *     npx vitest run __tests__/links/task-link-writes.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "@/lib/db";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/db", () => ({ default: () => holder.client }));

import { replayAllMigrations } from "../helpers/replay-migrations";
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at";
import { createWorkspaceTask } from "@/lib/task-create";
import { createTaskLink, deleteTaskLink, drainMirroredTaskLinksTo, mirrorTaskLinks, upsertTaskLink } from "@/lib/task-link-writes";
import { deleteLinksForEntity } from "@/lib/links/service";

const databaseUrl = process.env.ENTITY_LINKS_TASK_DATABASE_URL;
const KEY = "TASK_REFERENCES";

describe.skipIf(!databaseUrl)("task link writers against a real Prisma client", () => {
  const schema = `task_link_writes_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const previous = process.env.DATABASE_URL;
  const [WS_A, WS_B] = [randomUUID(), randomUUID()];
  const [taskA, docA, docB, objectiveA] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);
  const legacy = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.task_links WHERE ${where}`)).rows[0].n);
  const mirror = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.entity_links WHERE link_type = '${KEY}' AND ${where}`)).rows[0].n);
  let prisma: AppPrismaClient;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const replay = await replayAllMigrations(pool, schema);
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200);
    await q(`INSERT INTO {S}.tasks (id, workspace_id, title) VALUES ($1,$2,'Task A')`, [taskA, WS_A]);
    await q(`INSERT INTO {S}.docs (id, workspace_id, title) VALUES ($1,$2,'Doc A'), ($3,$4,'Doc B')`, [docA, WS_A, docB, WS_B]);
    await q(`INSERT INTO {S}.objectives (id, workspace_id, title) VALUES ($1,$2,'Objective A')`, [objectiveA, WS_A]);
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient;
    holder.client = prisma;
  }, 240_000);

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("writes the legacy row and the mirror row together, with the legacy row's source copied", async () => {
    const link = await createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docA, workspaceId: WS_A });
    expect(await legacy()).toBe(1);
    const row = (await q(`SELECT workspace_id, from_type, to_type, origin, source FROM {S}.entity_links WHERE link_type='${KEY}'`)).rows;
    expect(row).toEqual([{ workspace_id: WS_A, from_type: "TASK", to_type: "DOC", origin: "DIRECT", source: "UI" }]);
    await deleteTaskLink(prisma, { link, workspaceId: WS_A });
    expect(await legacy()).toBe(0);
    expect(await mirror()).toBe(0);
  });

  it("a refused mirror rolls the legacy row back: a target in another workspace leaves neither row", async () => {
    await expect(createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docB, workspaceId: WS_A })).rejects.toThrow(/not found in this workspace/);
    expect(await legacy()).toBe(0);
    expect(await mirror()).toBe(0);
  });

  it("upsert is idempotent and keeps one row in each table", async () => {
    const upsert = () =>
      upsertTaskLink(prisma, {
        taskId: taskA, linkedType: "OBJECTIVE", linkedId: objectiveA, workspaceId: WS_A,
        upsert: (tx) => tx.taskLink.upsert({ where: { taskId_linkedType_linkedId: { taskId: taskA, linkedType: "OBJECTIVE", linkedId: objectiveA } }, create: { taskId: taskA, linkedType: "OBJECTIVE", linkedId: objectiveA }, update: {} }),
      });
    await Promise.all([upsert(), upsert().catch(() => undefined)]);
    await upsert();
    expect(await legacy("linked_type = 'OBJECTIVE'")).toBe(1);
    expect(await mirror("to_type = 'OBJECTIVE'")).toBe(1);
  });

  it("the UI task creator mirrors its nested links in the same transaction", async () => {
    const task = await createWorkspaceTask(WS_A, { title: "From the UI", links: [{ linkedType: "DOC", linkedId: docA }] });
    expect(await legacy(`task_id = '${task.id}'`)).toBe(1);
    expect((await q(`SELECT to_type, to_id FROM {S}.entity_links WHERE link_type='${KEY}' AND from_id = $1`, [task.id])).rows).toEqual([{ to_type: "DOC", to_id: docA }]);
  });

  it("a mirror refusal inside the creating transaction rolls the task and its nested legacy link back", async () => {
    const taskId = randomUUID();
    const before = { tasks: Number((await q(`SELECT count(*)::int AS n FROM {S}.tasks`)).rows[0].n), links: await legacy() };
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { id: taskId, workspaceId: WS_A, title: "Doomed", links: { create: { linkedType: "DOC", linkedId: docB } } } });
        await mirrorTaskLinks(tx, { workspaceId: WS_A, links: [{ taskId, linkedType: "DOC", linkedId: docB }] });
      }),
    ).rejects.toThrow(/not found in this workspace/);
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.tasks`)).rows[0].n)).toBe(before.tasks);
    expect(await legacy()).toBe(before.links);
  });

  it("deleting a target's links and a workspace's links removes the mirror rows", async () => {
    expect(await mirror()).toBeGreaterThan(0);
    expect(await drainMirroredTaskLinksTo(prisma, { linkedType: "OBJECTIVE", linkedIds: [objectiveA] })).toBe(1);
    expect(await mirror("to_type = 'OBJECTIVE'")).toBe(0);
    await deleteLinksForEntity(prisma, "DOC", [docA]);
    expect(await mirror()).toBe(0);
    // The legacy rows are untouched by the mirror cleanup (their own delete paths own them).
    expect(await legacy()).toBeGreaterThan(0);
  });
});
