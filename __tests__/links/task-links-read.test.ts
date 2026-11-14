/**
 * lib/task-links-read.ts over seeded fake data: the nine association kinds are entity_links TASK_REFERENCES rows (stored spelling
 * REVIEW_REQUEST for DECISION), the two origins (COMMENT, AGENT_CONVERSATION) are entity_links TASK_CREATED_FROM rows. Pins workspace
 * scoping on both endpoints, (createdAt, id) ordering, dangling targets and the legacy DECISION spelling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

import { getLinkedTargetIds, getOriginTargetIds, getTaskIdsLinkedTo, getTaskLinks, getTasksLinkedTo, getTasksLinkedToOrigin } from "@/lib/task-links-read";
import type { AppTransactionClient } from "@/lib/db";

const db = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state as unknown as Record<string, Row[]>;
let clock = 0;
const at = () => new Date(10_000 + ++clock);

const ORIGINS = ["COMMENT", "AGENT_CONVERSATION"];

/** One link as it is stored now: a reference in entity_links TASK_REFERENCES, an origin (COMMENT, AGENT_CONVERSATION) in TASK_CREATED_FROM. */
function link(taskId: string, linkedType: string, linkedId: string, opts: { createdAt?: Date; id?: string } = {}) {
  const createdAt = opts.createdAt ?? at();
  const id = opts.id ?? `l-${++clock}`;
  const task = state().tasks.find((t) => t.id === taskId);
  state().entityLinks.push({
    id, workspaceId: (task?.workspaceId as string) ?? WS_A.id, linkType: ORIGINS.includes(linkedType) ? "TASK_CREATED_FROM" : "TASK_REFERENCES", fromType: "TASK", fromId: taskId,
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
  it("merges references (legacy DECISION spelling) and COMMENT origins, ordered by (createdAt, id), with an entry for every task", async () => {
    const tie = new Date(5_000);
    link("task-a", "DOC", "doc-a", { createdAt: tie, id: "id-b" });
    link("task-a", "COMMENT", "cmt-a", { createdAt: tie, id: "id-a" });
    link("task-a", "DECISION", "rr-a", { createdAt: new Date(4_000), id: "id-z" });
    const map = await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_A.id }, { id: "task-a2", workspaceId: WS_A.id }]);
    expect(map.get("task-a")!.map((l) => [l.id, l.linkedType, l.linkedId])).toEqual([["id-z", "DECISION", "rr-a"], ["id-a", "COMMENT", "cmt-a"], ["id-b", "DOC", "doc-a"]]);
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

  it("serves an origin kind from entity_links, scoped to the task's workspace", async () => {
    link("task-a", "COMMENT", "cmt-a");
    link("task-b", "COMMENT", "cmt-a");
    expect(await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "COMMENT", linkedId: "cmt-a" })).toEqual(["task-a"]);
  });

  it("serves a conversation origin, and hides a link to a conversation of another workspace", async () => {
    link("task-a", "AGENT_CONVERSATION", "conv-a");
    link("task-a2", "AGENT_CONVERSATION", "conv-b");
    expect(await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "AGENT_CONVERSATION", linkedId: "conv-a" })).toEqual(["task-a"]);
    expect(await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "AGENT_CONVERSATION", linkedId: "conv-b" })).toEqual([]);
  });

  it("hides an origin link whose comment is gone", async () => {
    link("task-a", "COMMENT", "cmt-gone");
    expect(await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "COMMENT", linkedId: "cmt-gone" })).toEqual([]);
  });
});

describe("origin links (TASK_CREATED_FROM)", () => {
  it("getTaskLinks shows COMMENT and AGENT_CONVERSATION links in creation order", async () => {
    link("task-a", "COMMENT", "cmt-a", { id: "el-old", createdAt: new Date(1_000) });
    link("task-a", "AGENT_CONVERSATION", "conv-a", { id: "el-conv", createdAt: new Date(2_000) });
    link("task-a", "COMMENT", "cmt-a2", { id: "el-new", createdAt: new Date(3_000) });
    const map = await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_A.id }]);
    expect(map.get("task-a")!.map((l) => [l.id, l.linkedType, l.linkedId])).toEqual([["el-old", "COMMENT", "cmt-a"], ["el-conv", "AGENT_CONVERSATION", "conv-a"], ["el-new", "COMMENT", "cmt-a2"]]);
  });

  it("does not show an origin link of a task read under another workspace", async () => {
    link("task-a", "COMMENT", "cmt-a");
    expect((await getTaskLinks(db(), [{ id: "task-a", workspaceId: WS_B.id }])).get("task-a")).toEqual([]);
  });

  it("getTaskIdsLinkedTo finds each linked task once", async () => {
    link("task-a", "COMMENT", "cmt-a");
    link("task-a2", "COMMENT", "cmt-a");
    link("task-b", "COMMENT", "cmt-a");
    expect((await getTaskIdsLinkedTo(db(), { workspaceId: WS_A.id, linkedType: "COMMENT", linkedId: "cmt-a" })).sort()).toEqual(["task-a", "task-a2"]);
  });

  it("getOriginTargetIds and getTasksLinkedToOrigin read the origin links", async () => {
    link("task-a", "COMMENT", "cmt-a", { createdAt: new Date(1_000) });
    link("task-a", "COMMENT", "cmt-a2", { createdAt: new Date(2_000) });
    link("task-a", "AGENT_CONVERSATION", "conv-a", { createdAt: new Date(3_000) });
    expect(await getOriginTargetIds(db(), { taskId: "task-a", linkedType: "COMMENT" })).toEqual(["cmt-a", "cmt-a2"]);
    expect(await getOriginTargetIds(db(), { taskId: "task-a", linkedType: "DOC" })).toEqual([]);
    expect(await getTasksLinkedToOrigin(db(), { workspaceId: WS_A.id, linkedType: "COMMENT", linkedIds: ["cmt-a", "cmt-a2"] })).toEqual([{ linkedId: "cmt-a", taskId: "task-a" }, { linkedId: "cmt-a2", taskId: "task-a" }]);
    expect(await getTasksLinkedToOrigin(db(), { workspaceId: WS_A.id, linkedType: "DOC", linkedIds: ["cmt-a"] })).toEqual([]);
  });
});
