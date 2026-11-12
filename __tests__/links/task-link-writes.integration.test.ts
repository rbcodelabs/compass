/**
 * Task links against a real Prisma client, real PrismaPg adapter, real unique indexes and the real migrations in a throwaway schema of the
 * local compass_e2e database. Proves what the fakes cannot:
 *   1. an association link lives only in entity_links (task_links stays empty for it) and a repeat is idempotent under a concurrent race;
 *   2. a refused target rolls the link back, and a refusal inside the creating transaction rolls the task back with it;
 *   3. the real UI task creator (createWorkspaceTask) writes its DOC link and its COMMENT link (TASK_CREATED_FROM) in the same transaction, and
 *      task_links stays empty;
 *   4. a stale pre-cleanup task_links id still unlinks, and unlinking, the objective drain and the workspace sweep remove the rows (real SQL);
 *   5. DEPLOY BEFORE MIGRATION 115: a COMMENT / AGENT_CONVERSATION link that only exists in task_links is still found, read, repeated idempotently and
 *      removable (from both stores), and the migration then copies it without double-showing it.
 *
 *   INTEGRATION_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5440/compass_e2e \
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
import { createTaskLink, createTaskLinks, deleteTaskLink, drainTaskLinksTo, getTaskLinkById } from "@/lib/task-link-writes";
import { getTaskLinks } from "@/lib/task-links-read";
import { deleteLinksForEntity } from "@/lib/links/service";
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { deleteLinksOfTasks, deleteOriginLinksTo, findTaskLink } from "@/lib/task-link-writes";
import { moveTaskLinksToEntityLinks } from "@/lib/migrations/entity-links-task-link-move";

const databaseUrl = integrationDatabaseUrl;
const KEY = "TASK_REFERENCES";

describe.skipIf(!databaseUrl)("task link writers against a real Prisma client", () => {
  const schema = `task_link_writes_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const previous = process.env.DATABASE_URL;
  const [WS_A, WS_B] = [randomUUID(), randomUUID()];
  const [taskA, docA, docB, objectiveA] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [commentA, commentB, convA] = [randomUUID(), randomUUID(), randomUUID()];
  const user = randomUUID();
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);
  const residual = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.task_links WHERE ${where}`)).rows[0].n);
  const references = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.entity_links WHERE link_type = '${KEY}' AND ${where}`)).rows[0].n);
  const origins = async (where = "TRUE") => Number((await q(`SELECT count(*)::int AS n FROM {S}.entity_links WHERE link_type = 'TASK_CREATED_FROM' AND ${where}`)).rows[0].n);
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
    await q(`INSERT INTO {S}.comments (id, workspace_id, target_type, target_id, body, author_name) VALUES ($1,$2,'DOC',$3,'b','a'), ($4,$2,'DOC',$3,'b','a')`, [commentA, WS_A, docA, commentB]);
    await q(`INSERT INTO {S}.agent_conversations (id, workspace_id, user_id, created_at, updated_at) VALUES ($1,$2,$3,now(),now())`, [convA, WS_A, user]);
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

  it("writes one entity_links row and no task_links row, and unlinks it", async () => {
    const link = await createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docA, workspaceId: WS_A });
    expect(await residual()).toBe(0);
    const row = (await q(`SELECT id, workspace_id, from_type, to_type, origin, source FROM {S}.entity_links WHERE link_type='${KEY}'`)).rows;
    expect(row).toEqual([{ id: link.id, workspace_id: WS_A, from_type: "TASK", to_type: "DOC", origin: "DIRECT", source: "UI" }]);
    expect(await getTaskLinkById(prisma, link.id)).toMatchObject({ id: link.id, taskId: taskA, linkedType: "DOC", linkedId: docA });
    await deleteTaskLink(prisma, { link, workspaceId: WS_A });
    expect(await references()).toBe(0);
  });

  it("a refused target leaves nothing behind: a target in another workspace", async () => {
    await expect(createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docB, workspaceId: WS_A })).rejects.toThrow(/not found in this workspace/);
    expect(await references()).toBe(0);
    expect(await residual()).toBe(0);
  });

  it("is idempotent under a concurrent race and keeps one row", async () => {
    const create = () => createTaskLink(prisma, { taskId: taskA, linkedType: "OBJECTIVE", linkedId: objectiveA, workspaceId: WS_A });
    await Promise.all([create(), create().catch(() => undefined)]);
    await create();
    expect(await references("to_type = 'OBJECTIVE'")).toBe(1);
    expect(await residual("linked_type = 'OBJECTIVE'")).toBe(0);
  });

  it("the UI task creator writes its links in the same transaction: DOC in TASK_REFERENCES, COMMENT in TASK_CREATED_FROM, nothing in task_links", async () => {
    const task = await createWorkspaceTask(WS_A, { title: "From the UI", links: [{ linkedType: "COMMENT", linkedId: commentA }, { linkedType: "DOC", linkedId: docA }] });
    expect((await q(`SELECT link_type, to_type, to_id FROM {S}.entity_links WHERE from_id = $1 ORDER BY link_type`, [task.id])).rows).toEqual([
      { link_type: "TASK_CREATED_FROM", to_type: "COMMENT", to_id: commentA },
      { link_type: KEY, to_type: "DOC", to_id: docA },
    ]);
    expect(await residual(`task_id = '${task.id}'`)).toBe(0);
    const merged = (await getTaskLinks(prisma, [{ id: task.id, workspaceId: WS_A }])).get(task.id)!;
    expect(merged.map((l) => l.linkedType).sort()).toEqual(["COMMENT", "DOC"]);
    // The target is verified now that the link is a real entity_links row: a missing comment is refused and nothing is left behind.
    await expect(createTaskLink(prisma, { taskId: task.id, linkedType: "COMMENT", linkedId: randomUUID(), workspaceId: WS_A })).rejects.toThrow(/not found in this workspace/);
    expect(await residual()).toBe(0);
    await deleteLinksOfTasks(prisma, [task.id]);
  });

  it("the agent's conversation link is a TASK_CREATED_FROM row, and a deleted comment takes its links with it", async () => {
    const link = await createTaskLink(prisma, { taskId: taskA, linkedType: "AGENT_CONVERSATION", linkedId: convA, workspaceId: WS_A, source: "AGENT" });
    expect((await q(`SELECT link_type, to_type, source FROM {S}.entity_links WHERE id = $1`, [link.id])).rows).toEqual([{ link_type: "TASK_CREATED_FROM", to_type: "AGENT_CONVERSATION", source: "AGENT" }]);
    await createTaskLink(prisma, { taskId: taskA, linkedType: "COMMENT", linkedId: commentB, workspaceId: WS_A });
    await q(`INSERT INTO {S}.task_links (task_id, linked_type, linked_id) VALUES ($1,'COMMENT',$2)`, [taskA, commentB]);
    expect(await deleteOriginLinksTo(prisma, { linkedType: "COMMENT", linkedIds: [commentB] })).toBe(2);
    expect(await findTaskLink(prisma, { taskId: taskA, linkedType: "COMMENT", linkedId: commentB, workspaceId: WS_A })).toBeNull();
    await deleteTaskLink(prisma, { link, workspaceId: WS_A });
    expect(await origins()).toBe(0);
  });

  it("a refusal inside the creating transaction rolls the task and its links back", async () => {
    const taskId = randomUUID();
    const before = Number((await q(`SELECT count(*)::int AS n FROM {S}.tasks`)).rows[0].n);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { id: taskId, workspaceId: WS_A, title: "Doomed" } });
        await createTaskLinks(tx, { workspaceId: WS_A, taskId, links: [{ linkedType: "DOC", linkedId: docB }] });
      }),
    ).rejects.toThrow(/not found in this workspace/);
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.tasks`)).rows[0].n)).toBe(before);
  });

  it("a stale pre-cleanup task_links id still unlinks the pair it names", async () => {
    await createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docA, workspaceId: WS_A });
    const staleId = randomUUID();
    await q(`INSERT INTO {S}.task_links (id, task_id, linked_type, linked_id) VALUES ($1,$2,'DOC',$3) ON CONFLICT DO NOTHING`, [staleId, taskA, docA]);
    const link = await getTaskLinkById(prisma, staleId);
    expect(link).toMatchObject({ taskId: taskA, linkedType: "DOC", linkedId: docA });
    await deleteTaskLink(prisma, { link: link!, workspaceId: WS_A });
    expect(await references(`from_id = '${taskA}' AND to_id = '${docA}'`)).toBe(0);
    expect(await residual(`task_id = '${taskA}' AND linked_id = '${docA}'`)).toBe(0);
  });

  it("the objective drain and the entity sweep remove the rows", async () => {
    await createTaskLink(prisma, { taskId: taskA, linkedType: "OBJECTIVE", linkedId: objectiveA, workspaceId: WS_A });
    await createTaskLink(prisma, { taskId: taskA, linkedType: "DOC", linkedId: docA, workspaceId: WS_A });
    expect(await references()).toBeGreaterThan(0);
    expect(await drainTaskLinksTo(prisma, { linkedType: "OBJECTIVE", linkedIds: [objectiveA] })).toBe(1);
    expect(await references("to_type = 'OBJECTIVE'")).toBe(0);
    await deleteLinksForEntity(prisma, "DOC", [docA]);
    expect(await references()).toBe(0);
  });

  describe("deploy before migration 115", () => {
    const frozen = async (type: string, target: string, source = "UI") =>
      (await q(`INSERT INTO {S}.task_links (task_id, linked_type, linked_id, source, created_at) VALUES ($1,$2,$3,$4,'2024-01-01 00:00:00') RETURNING id`, [taskA, type, target, source])).rows[0].id as string;

    it("shows a link that only exists in task_links, takes a repeat without a second row, and removes it from both stores", async () => {
      const legacyId = await frozen("COMMENT", commentA);
      const shown = (await getTaskLinks(prisma, [{ id: taskA, workspaceId: WS_A }])).get(taskA)!;
      expect(shown.map((l) => [l.id, l.linkedType, l.linkedId])).toEqual([[legacyId, "COMMENT", commentA]]);
      expect(await createTaskLink(prisma, { taskId: taskA, linkedType: "COMMENT", linkedId: commentA, workspaceId: WS_A })).toMatchObject({ id: legacyId });
      expect(await origins("to_type = 'COMMENT'")).toBe(0);
      await deleteTaskLink(prisma, { link: (await getTaskLinkById(prisma, legacyId))!, workspaceId: WS_A });
      expect(await residual(`id = '${legacyId}'`)).toBe(0);
      expect((await getTaskLinks(prisma, [{ id: taskA, workspaceId: WS_A }])).get(taskA)).toEqual([]);
    });

    it("migration 115 then copies it under the same id, and it is shown once", async () => {
      const legacyId = await frozen("AGENT_CONVERSATION", convA, "AGENT");
      const client = await pool.connect();
      try {
        await q(`DELETE FROM {S}.entity_links WHERE link_type = 'TASK_CREATED_FROM' AND to_type = 'AGENT_CONVERSATION'`);
        const moved = await moveTaskLinksToEntityLinks(client, schema, []);
        expect(moved.inserted.AGENT_CONVERSATION).toBe(1);
      } finally {
        client.release();
      }
      expect((await q(`SELECT id, source, origin FROM {S}.entity_links WHERE link_type = 'TASK_CREATED_FROM' AND to_id = $1`, [convA])).rows).toEqual([{ id: legacyId, source: "AGENT", origin: "MIGRATION" }]);
      const shown = (await getTaskLinks(prisma, [{ id: taskA, workspaceId: WS_A }])).get(taskA)!;
      expect(shown.map((l) => [l.id, l.linkedType])).toEqual([[legacyId, "AGENT_CONVERSATION"]]);
      // Unlinking after the move removes the copy AND the frozen twin (task_links is gone later, but the fallback must not resurrect it meanwhile).
      await deleteTaskLink(prisma, { link: (await getTaskLinkById(prisma, legacyId))!, workspaceId: WS_A });
      expect(await origins()).toBe(0);
      expect(await residual()).toBe(0);
    });

    it("the workspace sweep removes the frozen rows too (TaskLink.task is Restrict, so the tasks could not go otherwise)", async () => {
      await createTaskLink(prisma, { taskId: taskA, linkedType: "COMMENT", linkedId: commentA, workspaceId: WS_A });
      await frozen("COMMENT", commentB);
      await deleteLinksOfTasks(prisma, [taskA]);
      expect(await origins()).toBe(0);
      expect(await references()).toBe(0);
      expect(await residual()).toBe(0);
    });
  });
});
