/**
 * lib/task-links-read.ts over seeded fake data: the nine association kinds are entity_links TASK_REFERENCES rows (stored spelling
 * REVIEW_REQUEST for DECISION), the residual kinds (COMMENT, AGENT_CONVERSATION) are task_links rows. Pins workspace scoping on both
 * endpoints, (createdAt, id) ordering, dangling targets, the legacy DECISION spelling and the merge of the two stores.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

import { getLinkedTargetIds, getTaskIdsLinkedTo, getTaskLinks, getTasksLinkedTo } from "@/lib/task-links-read";
import type { AppTransactionClient } from "@/lib/db";

const db = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state as unknown as Record<string, Row[]>;
let clock = 0;
const at = () => new Date(10_000 + ++clock);

/** One link in the store its kind lives in: a reference in entity_links, a residual kind (COMMENT, AGENT_CONVERSATION) in task_links. */
function link(taskId: string, linkedType: string, linkedId: string, opts: { createdAt?: Date; id?: string } = {}) {
  const createdAt = opts.createdAt ?? at();
  const id = opts.id ?? `l-${++clock}`;
  if (linkedType === "COMMENT" || linkedType === "AGENT_CONVERSATION") {
    state().taskLinks.push({ id, taskId, linkedType, linkedId, source: "UI", createdById: null, createdAt });
    return;
  }
  const task = state().tasks.find((t) => t.id === taskId);
  state().entityLinks.push({
    id, workspaceId: (task?.workspaceId as string) ?? WS_A.id, linkType: "TASK_REFERENCES", fromType: "TASK", fromId: taskId,
    toType: linkedType === "DECISION" ? "REVIEW_REQUEST" : linkedType, toId: linkedId, origin: "DIRECT", source: "UI", createdById: null, createdAt, updatedAt: createdAt,
  });
}

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});

const ROADMAP = (ids: string[], workspaceIds: string[] = [WS_A.id]) => ({ workspaceIds, linkedType: "ROADMAP_ITEM" as const, linkedIds: ids });

describe("getTasksLinkedTo (roadmap delivery rollup)", () => {
  it("returns the linked tasks with workspace scoping", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    link("task-a2", "ROADMAP_ITEM", "ri-a");
    link("task-a3", "ROADMAP_ITEM", "ri-a2");
    link("task-b", "ROADMAP_ITEM", "ri-b"); // workspace B
    const rows = await getTasksLinkedTo(db(), ROADMAP(["ri-a", "ri-a2", "ri-b"]));
    expect(rows.map((r) => [r.linkedId, r.task.id, r.task.status])).toEqual([["ri-a", "task-a", "TODO"], ["ri-a", "task-a2", "DONE"], ["ri-a2", "task-a3", "IN_PROGRESS"]]);
  });

  it("returns exactly {linkedId, task:{id,title,status}}", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    expect(await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).toEqual([{ linkedId: "ri-a", task: { id: "task-a", title: "A task", status: "TODO" } }]);
  });

  it("COMMENT links and other target types are never returned", async () => {
    link("task-a", "COMMENT", "ri-a");
    link("task-a2", "DOC", "ri-a");
    expect(await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).toEqual([]);
  });

  it("multi-workspace scope (cross-workspace roadmap view) reads each workspace", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    link("task-b", "ROADMAP_ITEM", "ri-b");
    const rows = await getTasksLinkedTo(db(), ROADMAP(["ri-a", "ri-b"], [WS_A.id, WS_B.id]));
    expect(rows.map((r) => r.task.id).sort()).toEqual(["task-a", "task-b"]);
  });

  it("an empty id list short-circuits", async () => {
    expect(await getTasksLinkedTo(db(), ROADMAP([]))).toEqual([]);
  });

  it("orders by (created_at, id): ties break on id", async () => {
    const tie = new Date(5_000);
    link("task-a3", "ROADMAP_ITEM", "ri-a", { createdAt: tie, id: "tl-z" });
    link("task-a", "ROADMAP_ITEM", "ri-a", { createdAt: tie, id: "tl-y" });
    link("task-a2", "ROADMAP_ITEM", "ri-a", { createdAt: new Date(4_000), id: "tl-x" });
    expect((await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).map((r) => r.task.id)).toEqual(["task-a2", "task-a", "task-a3"]);
  });

  it("a dangling target is absent", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-gone");
    expect(await getTasksLinkedTo(db(), ROADMAP(["ri-gone"]))).toEqual([]);
  });

  it("a link from a task in another workspace is not visible through this workspace", async () => {
    link("task-b", "ROADMAP_ITEM", "ri-a");
    expect(await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).toEqual([]);
  });
});

describe("DECISION targets (stored as REVIEW_REQUEST)", () => {
  it("getTasksLinkedTo reads a DECISION as REVIEW_REQUEST", async () => {
    link("task-a", "DECISION", "rr-a");
    link("task-a2", "DECISION", "rr-a");
    const input = { workspaceIds: [WS_A.id], linkedType: "DECISION" as const, linkedIds: ["rr-a"] };
    expect((await getTasksLinkedTo(db(), input)).map((r) => r.task.id)).toEqual(["task-a", "task-a2"]);
  });

  it("getLinkedTargetIds: the set of decisions with follow-up work", async () => {
    link("task-a", "DECISION", "rr-a");
    const ids = await getLinkedTargetIds(db(), { workspaceIds: [WS_A.id], linkedType: "DECISION", linkedIds: ["rr-a", "rr-a-system"] });
    expect([...ids]).toEqual(["rr-a"]);
  });

  it("another workspace's decision is not visible through this workspace", async () => {
    link("task-b", "DECISION", "rr-b");
    expect(await getTasksLinkedTo(db(), { workspaceIds: [WS_A.id], linkedType: "DECISION", linkedIds: ["rr-b"] })).toEqual([]);
  });
});

describe("getTaskLinks", () => {
  it("merges references (legacy DECISION spelling) and residual COMMENT rows, ordered by (createdAt, id), with an entry for every task", async () => {
    const tie = new Date(5_000);
    link("task-a", "DOC", "doc-a", { createdAt: tie, id: "id-b" });
    link("task-a", "COMMENT", "cmt-1", { createdAt: tie, id: "id-a" });
    link("task-a", "DECISION", "rr-a", { createdAt: new Date(4_000), id: "id-z" });
    const map = await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_A.id }, { id: "task-a2", workspaceId: WS_A.id }]);
    expect(map.get("task-a")!.map((l) => [l.id, l.linkedType, l.linkedId])).toEqual([["id-z", "DECISION", "rr-a"], ["id-a", "COMMENT", "cmt-1"], ["id-b", "DOC", "doc-a"]]);
    expect(map.get("task-a2")).toEqual([]);
  });

  it("a reference link's id is its entity_links id and carries source and creation time", async () => {
    link("task-a", "DOC", "doc-a", { id: "el-1", createdAt: new Date(7_000) });
    const [only] = (await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_A.id }])).get("task-a")!;
    expect(only).toMatchObject({ id: "el-1", taskId: "task-a", linkedType: "DOC", linkedId: "doc-a", source: "UI", createdById: null, createdAt: new Date(7_000) });
  });

  it("hides a reference whose target is dangling or whose task is read under another workspace", async () => {
    link("task-a", "DOC", "doc-gone");
    link("task-a", "DOC", "doc-a");
    const map = await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_A.id }]);
    expect(map.get("task-a")!.map((l) => l.linkedId)).toEqual(["doc-a"]);
    const foreign = await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_B.id }]);
    expect(foreign.get("task-a")).toEqual([]);
  });

  it("no tasks, no reads", async () => {
    expect((await getTaskLinks(db(), [])).size).toBe(0);
  });
});

describe("getTaskIdsLinkedTo", () => {
  it("returns the tasks of a reference target, scoped to the workspace", async () => {
    link("task-a", "SOLUTION", "sol-a");
    link("task-a2", "SOLUTION", "sol-a");
    link("task-b", "SOLUTION", "sol-a");
    expect((await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "SOLUTION", linkedId: "sol-a" })).sort()).toEqual(["task-a", "task-a2"]);
  });

  it("serves a residual kind from task_links, scoped to the task's workspace", async () => {
    link("task-a", "COMMENT", "cmt-1");
    link("task-b", "COMMENT", "cmt-1");
    expect(await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "COMMENT", linkedId: "cmt-1" })).toEqual(["task-a"]);
  });
});
