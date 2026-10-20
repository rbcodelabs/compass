/**
 * Phase 7: TaskLink (9 target types; DECISION is stored as REVIEW_REQUEST). task_links stays the source of truth;
 * lib/task-link-writes.ts mirrors every write into entity_links (TASK_REFERENCES) in the same transaction while
 * COMPASS_ENTITY_LINKS_TASK_MIRROR is on. Reads and the generic tools ignore the type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | { client: unknown; state: Record<string, Row[]> } }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { createTaskLink, deleteTaskLink, drainMirroredTaskLinksTo, mirrorTaskLinks, upsertTaskLink } from "@/lib/task-link-writes";
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { TASK_REFERENCE_TARGET_TYPES, getLinkType, isLinkTypeEnabled, isTaskLinkMirrorEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";

const KEY = "TASK_REFERENCES";
const prisma = () => fake.current!.client as unknown as AppPrismaClient;
const mirrorRows = () => fake.current!.state.entityLinks.filter((row) => row.linkType === KEY);
const legacyRows = () => fake.current!.state.taskLinks;

/** The tenant fake has no tasks, task links or the other task targets: a tiny in-memory delegate for each, enough for resolveEndpoints and the writers. */
function addTaskTables(base: ReturnType<typeof createTenantFakePrisma>) {
  const match = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, cond]) => {
      if (cond !== null && typeof cond === "object" && "in" in (cond as Row)) return ((cond as { in: unknown[] }).in).includes(row[key]);
      return row[key] === cond;
    });
  let n = 0;
  const table = (rows: Row[]) => ({
    findMany: async ({ where, select }: { where?: Row; select?: Row } = {}) => rows.filter((row) => match(row, where)).map((row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : { ...row })),
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((row) => match(row, where)) ?? null,
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((row) => match(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
  });
  const state = base.state as unknown as Record<string, Row[]>;
  state.tasks = [
    { id: "task-a", workspaceId: WS_A.id, title: "A task" },
    { id: "task-a2", workspaceId: WS_A.id, title: "A task 2" },
    { id: "task-b", workspaceId: WS_B.id, title: "B task" },
  ];
  const targets: Record<string, Row[]> = {
    roadmapItem: [{ id: "road-a", workspaceId: WS_A.id, title: "A roadmap" }, { id: "road-b", workspaceId: WS_B.id, title: "B roadmap" }],
    doc: [{ id: "doc-a", workspaceId: WS_A.id, title: "A doc" }, { id: "doc-b", workspaceId: WS_B.id, title: "B doc" }],
    feedbackItem: [{ id: "fb-a", workspaceId: WS_A.id, title: "A feedback" }],
    reviewRequest: [{ id: "rr-a", workspaceId: WS_A.id, currentRevision: { title: "A decision" } }],
  };
  state.taskLinks = [];
  const taskLink = {
    findFirst: async ({ where }: { where?: Row } = {}) => state.taskLinks.find((row) => match(row, where)) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (state.taskLinks.some((row) => row.taskId === data.taskId && row.linkedType === data.linkedType && row.linkedId === data.linkedId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const row = { id: `tl-${++n}`, source: "UI", createdById: null, createdAt: new Date(), ...data };
      state.taskLinks.push(row);
      return { ...row };
    },
    upsert: async ({ where, create }: { where: { taskId_linkedType_linkedId: Row }; create: Row }) => {
      const key = where.taskId_linkedType_linkedId;
      const existing = state.taskLinks.find((row) => row.taskId === key.taskId && row.linkedType === key.linkedType && row.linkedId === key.linkedId);
      if (existing) return { ...existing };
      const row = { id: `tl-${++n}`, source: "UI", createdById: null, createdAt: new Date(), ...create };
      state.taskLinks.push(row);
      return { ...row };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = state.taskLinks.findIndex((row) => row.id === where.id);
      if (index < 0) throw new Error("Record to delete does not exist.");
      return state.taskLinks.splice(index, 1)[0];
    },
  };
  Object.assign(base.client, {
    task: table(state.tasks),
    taskLink,
    roadmapItem: table(targets.roadmapItem),
    // The fake's own doc delegate only has findUnique; endpoint resolution needs findMany.
    doc: { ...(base.client as unknown as { doc: object }).doc, ...table(targets.doc) },
    feedbackItem: { ...(base.client as unknown as { feedbackItem: object }).feedbackItem, ...table(targets.feedbackItem) },
    reviewRequest: table(targets.reviewRequest),
  });
  state.targets = Object.entries(targets).flatMap(([, rows]) => rows);
  return base as unknown as { client: unknown; state: Record<string, Row[]> };
}

/** One target per legacy linked_type, all in workspace A (KEY_RESULT through its objective), keyed by the legacy spelling. */
const TARGET_OF: Record<string, string> = {
  OPPORTUNITY: "opp-a",
  SOLUTION: "sol-a",
  ROADMAP_ITEM: "road-a",
  OBJECTIVE: "obj-a",
  KEY_RESULT: "kr-a",
  DOC: "doc-a",
  EXPERIMENT: "exp-a",
  FEEDBACK_ITEM: "fb-a",
  DECISION: "rr-a",
};
const STORED_TYPE: Record<string, string> = { DECISION: "REVIEW_REQUEST" };

beforeEach(() => {
  fake.current = addTaskTables(createTenantFakePrisma());
});
afterEach(() => vi.unstubAllEnvs());

describe("flag", () => {
  it("is on outside production unless set to 0, and off in production unless set to 1", () => {
    expect(isTaskLinkMirrorEnabled()).toBe(true);
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "0");
    expect(isTaskLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "");
    expect(isTaskLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "true");
    expect(isTaskLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "1");
    expect(isTaskLinkMirrorEnabled()).toBe(true);
  });
});

describe("registry entry", () => {
  const def = getLinkType(KEY)!;

  it("is one type whose target varies: the nine task-link targets, DECISION spelled REVIEW_REQUEST, no COMMENT, no SQUAD", () => {
    expect([...TASK_REFERENCE_TARGET_TYPES].sort()).toEqual(
      ["DOC", "EXPERIMENT", "FEEDBACK_ITEM", "KEY_RESULT", "OBJECTIVE", "OPPORTUNITY", "REVIEW_REQUEST", "ROADMAP_ITEM", "SOLUTION"],
    );
    expect(def.from).toBe("TASK");
    expect(def.legacy).toEqual({ legacyModule: "lib/task-link-writes.ts", backfillMigration: "097_entity_links_backfill_task", mode: "mirror" });
    expect(def.duplicatePolicy).toBe("error");
    expect(def.origins).toEqual(["DIRECT"]);
  });

  it("is invisible to reads and refused by the generic tools (the legacy table is the truth)", async () => {
    expect(linkTypesForEntity("TASK").map((entry) => entry.def.key)).not.toContain(KEY);
    expect(isLinkTypeEnabled(def)).toBe(true);
    await expect(linkEntities(prisma() as unknown as AppTransactionClient, { linkType: KEY, fromId: "task-a", toId: "doc-a", toType: "DOC", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/written through link_task/);
    expect(mirrorRows()).toHaveLength(0);
    const listed = await listLinks(prisma() as unknown as AppTransactionClient, { workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", limit: 10 });
    expect(listed.items).toEqual([]);
  });
});

describe("createTaskLink", () => {
  it.each(Object.keys(TARGET_OF))("%s: the legacy row is written first and mirrored in the same transaction with the stored type", async (linkedType) => {
    const linkedId = TARGET_OF[linkedType];
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id });
    expect(legacyRows()).toHaveLength(1);
    expect(legacyRows()[0]).toMatchObject({ taskId: "task-a", linkedType, linkedId });
    expect(mirrorRows()).toHaveLength(1);
    expect(mirrorRows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "TASK", fromId: "task-a", toType: STORED_TYPE[linkedType] ?? linkedType, toId: linkedId, origin: "DIRECT", source: "UI" });
    expect(link.id).toBe(legacyRows()[0].id);
    // The DECISION alias never reaches a stored row.
    expect(mirrorRows().some((row) => row.toType === "DECISION")).toBe(false);
  });

  it("copies the legacy row's source and actor into the mirror row", async () => {
    const tx = prisma() as unknown as AppTransactionClient;
    await mirrorTaskLinks(tx, { workspaceId: WS_A.id, links: [{ taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", source: "MCP", createdById: "user-alice" }] });
    expect(mirrorRows()[0]).toMatchObject({ source: "MCP", createdById: "user-alice" });
  });

  it("does not mirror a COMMENT link (the Doc comment a task was made from stays legacy-only), nor an unknown type", async () => {
    await mirrorTaskLinks(prisma() as unknown as AppTransactionClient, { workspaceId: WS_A.id, links: [{ taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1" }, { taskId: "task-a", linkedType: "SQUAD", linkedId: "x" }] });
    expect(mirrorRows()).toHaveLength(0);
  });

  it("mirrors only the nine legacy spellings: the stored spelling REVIEW_REQUEST, lowercase and unknown types are not mirrored", async () => {
    await mirrorTaskLinks(prisma() as unknown as AppTransactionClient, {
      workspaceId: WS_A.id,
      links: [
        { taskId: "task-a", linkedType: "REVIEW_REQUEST", linkedId: "rr-a" },
        { taskId: "task-a", linkedType: "doc", linkedId: "doc-a" },
        { taskId: "task-a", linkedType: "TASK", linkedId: "task-a2" },
      ],
    });
    expect(mirrorRows()).toHaveLength(0);
  });

  it("a target in another workspace is refused and nothing is mirrored (the legacy transaction is the caller's to roll back)", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-b", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(mirrorRows()).toHaveLength(0);
  });

  it("a task in another workspace is refused", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-b", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(mirrorRows()).toHaveLength(0);
  });

  it("flag off: only the legacy row is written", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "0");
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    expect(legacyRows()).toHaveLength(1);
    expect(mirrorRows()).toHaveLength(0);
  });

  it("fails closed in production unless the flag is exactly 1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    expect(mirrorRows()).toHaveLength(0);
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "1");
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "SOLUTION", linkedId: "sol-a", workspaceId: WS_A.id });
    expect(mirrorRows().map((row) => row.toId)).toEqual(["sol-a"]);
  });
});

describe("upsertTaskLink (the idempotent legacy writer)", () => {
  const upsert = (linkedType = "DOC", linkedId = "doc-a") =>
    upsertTaskLink(prisma(), {
      taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id,
      upsert: (tx) => (tx as unknown as { taskLink: { upsert: (args: unknown) => Promise<never> } }).taskLink.upsert({ where: { taskId_linkedType_linkedId: { taskId: "task-a", linkedType, linkedId } }, create: { taskId: "task-a", linkedType, linkedId }, update: {} }),
    });

  it("a repeat reconciles silently even though the registry type reports duplicates as errors for the generic tools", async () => {
    await upsert();
    await upsert();
    expect(legacyRows()).toHaveLength(1);
    expect(mirrorRows()).toHaveLength(1);
  });

  it("repairs a missing mirror row for a legacy row that predates the mirror", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "0");
    await upsert();
    expect(mirrorRows()).toHaveLength(0);
    vi.unstubAllEnvs();
    await upsert();
    expect(mirrorRows()).toHaveLength(1);
  });
});

describe("deleteTaskLink", () => {
  it("removes the legacy row and its mirror row", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(legacyRows()).toHaveLength(0);
    expect(mirrorRows()).toHaveLength(0);
  });

  it("removal never depends on the flag: a mirror row written while it was on goes when it is off", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "0");
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(legacyRows()).toHaveLength(0);
    expect(mirrorRows()).toHaveLength(0);
  });

  it("a target deleted since still unlinks (only the task is verified)", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    (fake.current!.client as unknown as { doc: { findMany: unknown } }).doc.findMany = async () => [];
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(mirrorRows()).toHaveLength(0);
  });

  it("only removes the pair it was asked about and leaves other links of the task", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    const other = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "SOLUTION", linkedId: "sol-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link: other, workspaceId: WS_A.id });
    expect(mirrorRows().map((row) => `${row.fromId}>${row.toId}`).sort()).toEqual(["task-a2>doc-a", "task-a>doc-a"]);
  });
});

describe("unlinkEntities for a mirror row from outside the legacy writer", () => {
  it("is refused", async () => {
    await expect(unlinkEntities(prisma() as unknown as AppTransactionClient, { linkType: KEY, fromId: "task-a", toId: "doc-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through link_task/);
  });
});

describe("drainMirroredTaskLinksTo (objective and key result deletes)", () => {
  it("removes only the task-reference rows that end at the deleted target, whatever the flag says", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "OBJECTIVE", linkedId: "obj-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "OBJECTIVE", linkedId: "obj-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "KEY_RESULT", linkedId: "kr-a", workspaceId: WS_A.id });
    fake.current!.state.entityLinks.push({ id: "other", workspaceId: WS_A.id, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT" });
    vi.stubEnv("COMPASS_ENTITY_LINKS_TASK_MIRROR", "0");
    expect(await drainMirroredTaskLinksTo(prisma() as unknown as AppTransactionClient, { linkedType: "OBJECTIVE", linkedIds: ["obj-a"] })).toBe(2);
    expect(mirrorRows().map((row) => row.toId)).toEqual(["kr-a"]);
    expect(fake.current!.state.entityLinks.some((row) => row.id === "other")).toBe(true);
    // COMMENT / unknown types have no mirror rows to drain.
    expect(await drainMirroredTaskLinksTo(prisma() as unknown as AppTransactionClient, { linkedType: "COMMENT", linkedIds: ["x"] })).toBe(0);
  });
});
