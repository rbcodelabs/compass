/**
 * TaskLink (9 target types; DECISION is stored as REVIEW_REQUEST). entity_links (TASK_REFERENCES) is the only store of the nine
 * association kinds; lib/task-link-writes.ts is the single writer of them AND of the residual kinds that were never associations
 * (COMMENT, AGENT_CONVERSATION), which stay in task_links. Reads and the generic tools ignore the type.
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
  createTaskLink, createTaskLinks, deleteTaskLink, deleteTaskLinkByPair, drainTaskLinksTo, findTaskLink, getTaskLinkById, taskLinkedTypeOf, taskReferenceTargetType,
} from "@/lib/task-link-writes";
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { TASK_REFERENCE_TARGET_TYPES, getLinkType, isLinkTypeEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";

const KEY = "TASK_REFERENCES";
const prisma = () => fake.current!.client as unknown as AppPrismaClient;
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const referenceRows = () => fake.current!.state.entityLinks.filter((row) => row.linkType === KEY);
const residualRows = () => fake.current!.state.taskLinks;

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
  // task_links now holds only the residual kinds (COMMENT, AGENT_CONVERSATION) plus, in one test, a stray row of a reference kind.
  state.taskLinks = [];
  const taskLink = {
    ...table(state.taskLinks),
    findUnique: async ({ where }: { where: { id: string } }) => state.taskLinks.find((row) => row.id === where.id) ?? null,
    create: async ({ data }: { data: Row }) => {
      if (state.taskLinks.some((row) => row.taskId === data.taskId && row.linkedType === data.linkedType && row.linkedId === data.linkedId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const row = { id: `tl-${++n}`, source: "UI", createdById: null, createdAt: new Date(), ...data };
      state.taskLinks.push(row);
      return { ...row };
    },
    deleteMany: async ({ where }: { where?: Row }) => {
      const doomed = state.taskLinks.filter((row) => match(row, where));
      for (const row of doomed) state.taskLinks.splice(state.taskLinks.indexOf(row), 1);
      return { count: doomed.length };
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

  it("maps spellings both ways: DECISION <-> REVIEW_REQUEST, COMMENT and AGENT_CONVERSATION are residual", () => {
    expect(taskReferenceTargetType("DECISION")).toBe("REVIEW_REQUEST");
    expect(taskReferenceTargetType("DOC")).toBe("DOC");
    expect(taskReferenceTargetType("COMMENT")).toBeNull();
    expect(taskReferenceTargetType("AGENT_CONVERSATION")).toBeNull();
    expect(taskReferenceTargetType("REVIEW_REQUEST")).toBeNull();
    expect(taskLinkedTypeOf("REVIEW_REQUEST")).toBe("DECISION");
    expect(taskLinkedTypeOf("DOC")).toBe("DOC");
  });
});

describe("createTaskLink", () => {
  it.each(Object.keys(TARGET_OF))("%s: one entity_links row with the stored type, none in task_links, the caller's spelling returned", async (linkedType) => {
    const linkedId = TARGET_OF[linkedType];
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType, linkedId, workspaceId: WS_A.id });
    expect(residualRows()).toHaveLength(0);
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

  it("a COMMENT link (the Doc comment a task was made from) is a residual row in task_links only", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1", workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
    expect(residualRows()).toHaveLength(1);
    expect(link).toMatchObject({ id: residualRows()[0].id, linkedType: "COMMENT", linkedId: "cmt-1" });
    // A repeat is idempotent for the residual kinds too.
    const again = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1", workspaceId: WS_A.id });
    expect(again.id).toBe(link.id);
    expect(residualRows()).toHaveLength(1);
  });
});

describe("createTaskLinks (inside the caller's transaction, e.g. a task create)", () => {
  it("writes both stores in input order", async () => {
    const links = await createTaskLinks(tx(), {
      workspaceId: WS_A.id,
      taskId: "task-a",
      links: [{ linkedType: "COMMENT", linkedId: "cmt-1" }, { linkedType: "DECISION", linkedId: "rr-a", source: "UI" }, { linkedType: "DOC", linkedId: "doc-a" }],
    });
    expect(links.map((link) => link.linkedType)).toEqual(["COMMENT", "DECISION", "DOC"]);
    expect(referenceRows().map((row) => row.toType).sort()).toEqual(["DOC", "REVIEW_REQUEST"]);
    expect(residualRows().map((row) => row.linkedId)).toEqual(["cmt-1"]);
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

  it("finds a residual link by pair", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-1", workspaceId: WS_A.id });
    expect(await findTaskLink(prisma(), { taskId: "task-a", linkedType: "AGENT_CONVERSATION", linkedId: "conv-1", workspaceId: WS_A.id })).toMatchObject({ id: link.id });
  });

  it("resolves a link id of either store, and null for a gone one", async () => {
    const uuid = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    fake.current!.state.entityLinks.push({ id: uuid, workspaceId: WS_A.id, linkType: KEY, fromType: "TASK", fromId: "task-a", toType: "REVIEW_REQUEST", toId: "rr-a", origin: "DIRECT", source: "UI", createdById: null, createdAt: new Date(1) });
    expect(await getTaskLinkById(prisma(), uuid)).toEqual({ id: uuid, taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a" });
    const residual = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1", workspaceId: WS_A.id });
    expect(await getTaskLinkById(prisma(), residual.id)).toMatchObject({ id: residual.id, taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1" });
    expect(await getTaskLinkById(prisma(), "6f9619ff-8b86-4011-b42d-00c04fc964aa")).toBeNull();
  });
});

describe("deleteTaskLink", () => {
  it("removes a reference link", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DECISION", linkedId: "rr-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
  });

  it("a stale pre-cleanup task_links row of a reference kind (the id an open page still holds) goes with its pair", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    fake.current!.state.taskLinks.push({ id: "stale-legacy-id", taskId: "task-a", linkedType: "DOC", linkedId: "doc-a" });
    // The stale id is not an entity_links id; the pair it names is what gets removed.
    await deleteTaskLink(prisma(), { link: { id: "stale-legacy-id", taskId: "task-a", linkedType: "DOC", linkedId: "doc-a" }, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
    expect(residualRows()).toHaveLength(0);
    expect(link.id).not.toBe("stale-legacy-id");
  });

  it("a target deleted since still unlinks (only the task is verified)", async () => {
    const link = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    (fake.current!.client as unknown as { doc: { findMany: unknown } }).doc.findMany = async () => [];
    await deleteTaskLink(prisma(), { link, workspaceId: WS_A.id });
    expect(referenceRows()).toHaveLength(0);
  });

  it("removes a residual link by id and leaves the others", async () => {
    const comment = await createTaskLink(prisma(), { taskId: "task-a", linkedType: "COMMENT", linkedId: "cmt-1", workspaceId: WS_A.id });
    await createTaskLink(prisma(), { taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", workspaceId: WS_A.id });
    await deleteTaskLink(prisma(), { link: comment, workspaceId: WS_A.id });
    expect(residualRows()).toHaveLength(0);
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
    // COMMENT / unknown kinds are residual: nothing in entity_links to drain.
    expect(await drainTaskLinksTo(tx(), { linkedType: "COMMENT", linkedIds: ["x"] })).toBe(0);
  });
});
