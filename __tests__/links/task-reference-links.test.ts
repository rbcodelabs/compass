/**
 * TaskLink (9 association targets; DECISION is stored as REVIEW_REQUEST, plus the two origins). entity_links is the only store:
 * TASK_REFERENCES for the nine associations and TASK_CREATED_FROM for COMMENT and AGENT_CONVERSATION (moved by migration 115);
 * lib/task-link-writes.ts is the single writer of both. The legacy task_links table is gone from the schema.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | { client: unknown; state: Record<string, Row[]> } }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

import {
  createTaskLink, createTaskLinks, deleteLinksOfTasks, deleteOriginLinksTo, deleteTaskLink, deleteTaskLinkByPair, drainTaskLinksTo, findTaskLink, getTaskLinkById, taskLinkedTypeOf,
  taskOriginTargetType, taskReferenceTargetType,
} from "@/lib/task-link-writes";
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { TASK_ORIGIN_TARGET_TYPES, TASK_REFERENCE_TARGET_TYPES, getLinkType, isLinkTypeEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";

const KEY = "TASK_REFERENCES";
const prisma = () => fake.current!.client as unknown as AppPrismaClient;
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const referenceRows = () => fake.current!.state.entityLinks.filter((row) => row.linkType === KEY);
const ORIGIN_KEY = "TASK_CREATED_FROM";
const originRows = () => fake.current!.state.entityLinks.filter((row) => row.linkType === ORIGIN_KEY);

/** The tenant fake has no tasks, task links or the other task targets: a tiny in-memory delegate for each, enough for resolveEndpoints and the writers. */
function addTaskTables(base: ReturnType<typeof createTenantFakePrisma>) {
  const match = (row: Row, where: Row = {}): boolean =>
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
  Object.assign(base.client, {
    task: table(state.tasks),
    roadmapItem: table(targets.roadmapItem),
    // The fake's own doc delegate only has findUnique; endpoint resolution needs findMany.
    doc: { ...(base.client as unknown as { doc: object }).doc, ...table(targets.doc) },
    feedbackItem: { ...(base.client as unknown as { feedbackItem: object }).feedbackItem, ...table(targets.feedbackItem) },
    reviewRequest: table(targets.reviewRequest),
  });
  state.targets = Object.entries(targets).flatMap(([, rows]) => rows);
  return base as unknown as { client: unknown; state: Record<string, Row[]> };
}

/** One target per spelling callers use, all in workspace A (KEY_RESULT through its objective). */
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

describe("registry entry", () => {
  const def = getLinkType(KEY)!;

  it("is one type whose target varies: the nine task-link targets, DECISION spelled REVIEW_REQUEST, no COMMENT, no SQUAD", () => {
    expect([...TASK_REFERENCE_TARGET_TYPES].sort()).toEqual(
      ["DOC", "EXPERIMENT", "FEEDBACK_ITEM", "KEY_RESULT", "OBJECTIVE", "OPPORTUNITY", "REVIEW_REQUEST", "ROADMAP_ITEM", "SOLUTION"],
    );
    expect(def.from).toBe("TASK");
    expect(def.dedicatedWriter).toMatchObject({ module: "lib/task-link-writes.ts" });
    expect(def.duplicatePolicy).toBe("error");
    expect(def.origins).toEqual(["DIRECT"]);
  });

  it("is invisible to the generic reads and refused by the generic tools (link_task is the writer)", async () => {
    expect(linkTypesForEntity("TASK").map((entry) => entry.def.key)).not.toContain(KEY);
    expect(isLinkTypeEnabled(def)).toBe(true);
    await expect(linkEntities(tx(), { linkType: KEY, fromId: "task-a", toId: "doc-a", toType: "DOC", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/written through link_task/);
    expect(referenceRows()).toHaveLength(0);
    const listed = await listLinks(tx(), { workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", limit: 10 });
    expect(listed.items).toEqual([]);
  });

  it("maps spellings both ways: DECISION <-> REVIEW_REQUEST; COMMENT and AGENT_CONVERSATION are origins, not associations", () => {
    expect(taskReferenceTargetType("DECISION")).toBe("REVIEW_REQUEST");
    expect(taskReferenceTargetType("DOC")).toBe("DOC");
    expect(taskReferenceTargetType("COMMENT")).toBeNull();
    expect(taskReferenceTargetType("AGENT_CONVERSATION")).toBeNull();
    expect(taskReferenceTargetType("REVIEW_REQUEST")).toBeNull();
    expect(taskLinkedTypeOf("REVIEW_REQUEST")).toBe("DECISION");
    expect(taskLinkedTypeOf("DOC")).toBe("DOC");
  });
});

describe("TASK_CREATED_FROM registry entry (COMMENT and AGENT_CONVERSATION)", () => {
  const def = getLinkType(ORIGIN_KEY)!;

  it("is a task -> comment | conversation type, internal and dedicated-writer, named after the migration that moved the rows", () => {
    expect(def.from).toBe("TASK");
    expect([...TASK_ORIGIN_TARGET_TYPES]).toEqual(["COMMENT", "AGENT_CONVERSATION"]);
    expect(def.internal).toBe(true);
    expect(def.dedicatedWriter).toEqual({ module: "lib/task-link-writes.ts", backfillMigration: "115_entity_links_task_link_move" });
    expect(def.duplicatePolicy).toBe("idempotent");
    expect(def.origins).toEqual(["DIRECT", "MIGRATION"]);
  });

  it("is invisible to the generic reads and refused by the generic tools", async () => {
    expect(linkTypesForEntity("TASK").map((entry) => entry.def.key)).not.toContain(ORIGIN_KEY);
    await expect(linkEntities(tx(), { linkType: ORIGIN_KEY, fromId: "task-a", toId: "cmt-a", toType: "COMMENT", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/managed by its owning feature/);
    await expect(linkEntities(tx(), { linkType: ORIGIN_KEY, fromId: "task-a", toId: "cmt-a", toType: "COMMENT", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" }, viaDedicatedWriter: true })).rejects.toThrow(/managed by its owning feature/);
    expect(originRows()).toHaveLength(0);
  });

  it("maps the origin kinds, and only them", () => {
    expect(taskOriginTargetType("COMMENT")).toBe("COMMENT");
    expect(taskOriginTargetType("AGENT_CONVERSATION")).toBe("AGENT_CONVERSATION");
    expect(taskOriginTargetType("DOC")).toBeNull();
    expect(taskOriginTargetType("DECISION")).toBeNull();
  });
});

describe("createTaskLink", () => {
  it.each(Object.keys(TARGET_OF))("%s: one entity_links row with the stored type, the caller's spelling returned", async (linkedType) => {
    const linkedId = TARGET_OF[linkedType];
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(1);
    expect(referenceRows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "TASK", fromId: "task-a", toType: STORED_TYPE[linkedType] ?? linkedType, toId: linkedId, origin: "DIRECT", source: "UI" });
    expect(link).toMatchObject({ id: referenceRows()[0].id, taskId: "task-a", linkedType, linkedId });
    // The DECISION alias never reaches a stored row.
    expect(referenceRows().some((row) => row.toType === "DECISION")).toBe(false);
  });

  it("copies the source and actor onto the row", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id, source: "MCP", createdById: "user-alice" });
    expect(referenceRows()[0]).toMatchObject({ source: "MCP", createdById: "user-alice" });
  });

  it("is idempotent: a repeat returns the existing link and keeps one row", async () => {
    const first = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    const again = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    expect(again.id).toBe(first.id);
    expect(referenceRows()).toHaveLength(1);
  });

  it("a target in another workspace is refused and nothing is written", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-b", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(referenceRows()).toHaveLength(0);
  });

  it("a task in another workspace is refused", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-b", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(referenceRows()).toHaveLength(0);
  });

  it.each([["COMMENT", "cmt-a"], ["AGENT_CONVERSATION", "conv-a"]])("a %s link is one TASK_CREATED_FROM row in entity_links", async (linkedType, linkedId) => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id, source: "AGENT", createdById: null });
    expect(referenceRows()).toHaveLength(0);
    expect(originRows()).toHaveLength(1);
    expect(originRows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "TASK", fromId: "task-a", toType: linkedType, toId: linkedId, origin: "DIRECT", source: "AGENT" });
    expect(link).toMatchObject({ id: originRows()[0].id, taskId: "task-a", linkedType, linkedId });
    // A repeat is idempotent.
    const again = await createTaskLink(prisma(), { taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id });
    expect(again.id).toBe(link.id);
    expect(originRows()).toHaveLength(1);
  });

  it("an origin target in another workspace, or a missing one, is refused and nothing is written", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-b", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    await expect(createTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-b", workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(originRows()).toHaveLength(0);
  });

  it("an unknown link kind is refused instead of being stored somewhere", async () => {
    await expect(createTaskLink(prisma(), { taskId: "task-a", linkedType: "SQUAD", linkedId: "x", workspaceId: WS_A.id })).rejects.toThrow(/Unsupported task link type/);
  });

});

describe("createTaskLinks (inside the caller's transaction, e.g. a task create)", () => {
  it("writes both link types in input order, all in entity_links", async () => {
    const links = await createTaskLinks(tx(), {
      workspaceId: WS_A.id,
      taskId: "task-a",
      links: [{ linkedType: "COMMENT", linkedId: "cmt-a" }, { linkedType: "DECISION", linkedId: "rr-a", source: "UI" }, { linkedType: "DOC", linkedId: "doc-a" }],
    });
    expect(links.map((link) => link.linkedType)).toEqual(["COMMENT", "DECISION", "DOC"]);
    expect(referenceRows().map((row) => row.toType).sort()).toEqual(["DOC", "REVIEW_REQUEST"]);
    expect(originRows().map((row) => row.toId)).toEqual(["cmt-a"]);
  });

  it("a refused target throws so the caller's transaction rolls the task back", async () => {
    await expect(createTaskLinks(tx(), { workspaceId: WS_A.id, taskId: "task-a", links: [{ linkedType: "DOC", linkedId: "doc-b" }] })).rejects.toThrow(/not found in this workspace/);
  });
});

describe("findTaskLink and getTaskLinkById", () => {
  it("finds a reference by pair, in the caller's spelling, scoped to the workspace", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id });
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id })).toMatchObject({ id: link.id, linkedType: "DECISION" });
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "rr-a", workspaceId: WS_A.id })).toBeNull();
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_B.id })).toBeNull();
  });

  it("finds an origin link by pair", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-a", workspaceId: WS_A.id });
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-a", workspaceId: WS_A.id })).toMatchObject({ id: link.id });
    // The task's workspace scopes the lookup.
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-a", workspaceId: WS_B.id })).toBeNull();
  });

  it("resolves a link id of either link type, and null for a gone one", async () => {
    const uuid = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    fake.current!.state.entityLinks.push({ id: uuid, workspaceId: WS_A.id, linkType: KEY, fromType: "TASK", fromId: "task-a", toType: "REVIEW_REQUEST", toId: "rr-a", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(1) });
    expect(await getTaskLinkById(prisma(), uuid)).toEqual({ id: uuid, taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a" });
    const originId = "7f9619ff-8b86-4011-b42d-00c04fc964ff";
    fake.current!.state.entityLinks.push({ id: originId, workspaceId: WS_A.id, linkType: ORIGIN_KEY, fromType: "TASK", fromId: "task-a", toType: "COMMENT", toId: "cmt-a", origin: "MIGRATION", source: "UI", createdById: null, createdAt: new Date(1), updatedAt: new Date(1) });
    expect(await getTaskLinkById(prisma(), originId)).toEqual({ id: originId, taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-a" });
    // An id that is not an entity_links link of either type (a stale legacy task_links id) resolves to nothing.
    expect(await getTaskLinkById(prisma(), "tl-old")).toBeNull();
    expect(await getTaskLinkById(prisma(), "6f9619ff-8b86-4011-b42d-00c04fc964aa")).toBeNull();
  });
});

describe("deleteTaskLink", () => {
  it("removes a reference link", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
  });

  it("a target deleted since still unlinks (only the task is verified)", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    (fake.current!.client as unknown as { doc: { findMany: unknown } }).doc.findMany = async () => [];
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
  });

  it("removes an origin link and leaves the others", async () => {
    const comment = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link: comment, workspaceId: WS_A.id });
    expect(originRows()).toHaveLength(0);
    expect(referenceRows()).toHaveLength(1);
  });

  it("only removes the pair it was asked about and leaves other links of the task", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    const other = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "SOLUTION", linkedId: "sol-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link: other, workspaceId: WS_A.id });
    expect(referenceRows().map((row) => `${row.fromId}>${row.toId}`).sort()).toEqual(["task-a2>doc-a", "task-a>doc-a"]);
  });
});

describe("deleteTaskLinkByPair", () => {
  it("reports whether a link existed", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id });
    expect(await deleteTaskLinkByPair(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id })).toBe(true);
    expect(referenceRows()).toHaveLength(0);
    expect(await deleteTaskLinkByPair(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id })).toBe(false);
  });
});

describe("unlinkEntities for a reference row from outside the task writer", () => {
  it("is refused", async () => {
    await expect(unlinkEntities(tx(), { linkType: KEY, fromId: "task-a", toId: "doc-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through link_task/);
  });
});

describe("drainTaskLinksTo (objective and key result deletes)", () => {
  it("removes only the task-reference rows that end at the deleted target", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "OBJECTIVE", linkedId: "obj-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "OBJECTIVE", linkedId: "obj-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "KEY_RESULT", linkedId: "kr-a", workspaceId: WS_A.id });
    fake.current!.state.entityLinks.push({ id: "other", workspaceId: WS_A.id, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT" });
    expect(await drainTaskLinksTo(tx(), { linkedType: "OBJECTIVE", linkedIds: ["obj-a"] })).toBe(2);
    expect(referenceRows().map((row) => row.toId)).toEqual(["kr-a"]);
    expect(fake.current!.state.entityLinks.some((row) => row.id === "other")).toBe(true);
    // COMMENT is an origin kind, drained by deleteOriginLinksTo, not here.
    expect(await drainTaskLinksTo(tx(), { linkedType: "COMMENT", linkedIds: ["x"] })).toBe(0);
  });
});

describe("deleteOriginLinksTo (a deleted comment)", () => {
  it("removes the TASK_CREATED_FROM rows that end at the deleted comments, and nothing else", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "COMMENT", linkedId: "cmt-a2", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    expect(await deleteOriginLinksTo(tx(), { linkedType: "COMMENT", linkedIds: ["cmt-a"] })).toBe(1);
    expect(originRows().map((row) => row.toId).sort()).toEqual(["cmt-a2", "conv-a"]);
    expect(referenceRows()).toHaveLength(1);
    // Association kinds and an empty list are not its business.
    expect(await deleteOriginLinksTo(tx(), { linkedType: "DOC", linkedIds: ["doc-a"] })).toBe(0);
    expect(await deleteOriginLinksTo(tx(), { linkedType: "COMMENT", linkedIds: [] })).toBe(0);
    expect(referenceRows()).toHaveLength(1);
  });
});

describe("deleteLinksOfTasks (workspace teardown)", () => {
  it("removes every link of the tasks in both link types", async () => {
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-a", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a2", linkedType: "COMMENT", linkedId: "cmt-a", workspaceId: WS_A.id });
    await deleteLinksOfTasks(tx(), ["task-a"]);
    expect(referenceRows()).toHaveLength(0);
    expect(originRows().map((row) => row.fromId)).toEqual(["task-a2"]);
  });
});
