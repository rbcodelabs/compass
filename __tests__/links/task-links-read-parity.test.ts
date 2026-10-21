/**
 * Read-flip parity (PR C, TASK family): lib/task-links-read.ts with COMPASS_ENTITY_LINKS_TASK_READ off / shadow / on over the SAME seeded
 * fake data (task_links AND entity_links TASK_REFERENCES hold the same links, like the dual-writing writers). Workspace scoping, ordering,
 * dangling targets and the fallback to legacy when the entity_links read throws are pinned; by-design differences are asserted explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

type Row = Record<string, unknown>;
const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

import { getReadCompareCounters, resetReadCompareCounters } from "@/lib/links/read-compare";
import { LINK_READ_FLAG_NAMES } from "@/lib/links/read-mode";
import { getLinkedTargetIds, getTasksLinkedTo } from "@/lib/task-links-read";
import type { AppTransactionClient } from "@/lib/db";

const db = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state as unknown as Record<string, Row[]>;
let clock = 0;
const at = () => new Date(10_000 + ++clock);

async function inEachMode<T>(read: () => Promise<T>): Promise<{ off: T; shadow: T; on: T }> {
  const out = {} as { off: T; shadow: T; on: T };
  for (const mode of ["off", "shadow", "on"] as const) {
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, mode);
    out[mode] = await read();
  }
  vi.unstubAllEnvs();
  return out;
}

/** One link written to task_links AND mirrored into entity_links (stored spelling REVIEW_REQUEST for DECISION), as the writers do. */
function link(taskId: string, linkedType: string, linkedId: string, opts: { createdAt?: Date; id?: string; mirrored?: boolean } = {}) {
  const createdAt = opts.createdAt ?? at();
  const task = state().tasks.find((t) => t.id === taskId);
  const id = opts.id ?? `tl-${state().taskLinks.length + 1}`;
  state().taskLinks.push({ id, taskId, linkedType, linkedId, source: "UI", createdById: null, createdAt });
  if (opts.mirrored === false || linkedType === "COMMENT") return;
  state().entityLinks.push({
    id: `el-${id}`, workspaceId: (task?.workspaceId as string) ?? WS_A.id, linkType: "TASK_REFERENCES", fromType: "TASK", fromId: taskId,
    toType: linkedType === "DECISION" ? "REVIEW_REQUEST" : linkedType, toId: linkedId, origin: "DIRECT", source: "UI", createdById: null, createdAt, updatedAt: createdAt,
  });
}

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  resetReadCompareCounters();
});
afterEach(() => vi.unstubAllEnvs());

const ROADMAP = (ids: string[], workspaceIds: string[] = [WS_A.id]) => ({ workspaceIds, linkedType: "ROADMAP_ITEM" as const, linkedIds: ids });

describe("getTasksLinkedTo (roadmap delivery rollup)", () => {
  it("same rows in off / shadow / on, with workspace scoping", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    link("task-a2", "ROADMAP_ITEM", "ri-a");
    link("task-a3", "ROADMAP_ITEM", "ri-a2");
    link("task-b", "ROADMAP_ITEM", "ri-b"); // workspace B
    const { off, shadow, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-a", "ri-a2", "ri-b"])));
    expect(off.map((r) => [r.linkedId, r.task.id, r.task.status])).toEqual([["ri-a", "task-a", "TODO"], ["ri-a", "task-a2", "DONE"], ["ri-a2", "task-a3", "IN_PROGRESS"]]);
    expect(shadow).toEqual(off);
    expect(on).toEqual(off);
    expect(getReadCompareCounters().TASK.mismatches).toBe(0);
    expect(getReadCompareCounters().TASK.compares).toBe(1); // shadow only
  });

  it("returns exactly {linkedId, task:{id,title,status}} (no extra legacy fields leak)", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    const { off, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-a"])));
    expect(off).toEqual([{ linkedId: "ri-a", task: { id: "task-a", title: "A task", status: "TODO" } }]);
    expect(on).toEqual(off);
  });

  it("COMMENT links and other target types are never returned", async () => {
    link("task-a", "COMMENT", "ri-a");
    link("task-a2", "DOC", "ri-a");
    const { off, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-a"])));
    expect(off).toEqual([]);
    expect(on).toEqual([]);
  });

  it("multi-workspace scope (cross-workspace roadmap view) matches legacy", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    link("task-b", "ROADMAP_ITEM", "ri-b");
    const { off, shadow, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-a", "ri-b"], [WS_A.id, WS_B.id])));
    expect(off.map((r) => r.task.id).sort()).toEqual(["task-a", "task-b"]);
    expect(shadow).toEqual(off);
    expect([...on].sort((x, y) => x.task.id.localeCompare(y.task.id))).toEqual([...off].sort((x, y) => x.task.id.localeCompare(y.task.id)));
    expect(getReadCompareCounters().TASK.mismatches).toBe(0);
  });

  it("empty id list short-circuits in every mode", async () => {
    const { off, shadow, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP([])));
    expect([off, shadow, on]).toEqual([[], [], []]);
  });

  it("on orders by (created_at, id): ties break on id", async () => {
    const tie = new Date(5_000);
    link("task-a3", "ROADMAP_ITEM", "ri-a", { createdAt: tie, id: "tl-z" });
    link("task-a", "ROADMAP_ITEM", "ri-a", { createdAt: tie, id: "tl-y" });
    link("task-a2", "ROADMAP_ITEM", "ri-a", { createdAt: new Date(4_000), id: "tl-x" });
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, "on");
    expect((await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).map((r) => r.task.id)).toEqual(["task-a2", "task-a", "task-a3"]);
  });
});

describe("getTasksLinkedTo / getLinkedTargetIds for DECISION targets", () => {
  it("DECISION is read as REVIEW_REQUEST; same tasks in every mode", async () => {
    link("task-a", "DECISION", "rr-a");
    link("task-a2", "DECISION", "rr-a");
    const input = { workspaceIds: [WS_A.id], linkedType: "DECISION" as const, linkedIds: ["rr-a"], unscopedLegacy: true };
    const { off, shadow, on } = await inEachMode(() => getTasksLinkedTo(db(), input));
    expect(off.map((r) => r.task.id)).toEqual(["task-a", "task-a2"]);
    expect(shadow).toEqual(off);
    expect(on).toEqual(off);
    expect(getReadCompareCounters().TASK.mismatches).toBe(0);
  });

  it("getLinkedTargetIds: the set of decisions with follow-up work, same in every mode", async () => {
    link("task-a", "DECISION", "rr-a");
    const input = { workspaceIds: [WS_A.id], linkedType: "DECISION" as const, linkedIds: ["rr-a", "rr-a-system"], unscopedLegacy: true };
    const { off, shadow, on } = await inEachMode(() => getLinkedTargetIds(db(), input));
    expect([...off]).toEqual(["rr-a"]);
    expect([...shadow]).toEqual(["rr-a"]);
    expect([...on]).toEqual(["rr-a"]);
  });

  it("another workspace's decision is not visible through this workspace in on mode", async () => {
    link("task-b", "DECISION", "rr-b");
    const input = { workspaceIds: [WS_A.id], linkedType: "DECISION" as const, linkedIds: ["rr-b"], unscopedLegacy: true };
    const { on } = await inEachMode(() => getTasksLinkedTo(db(), input));
    expect(on).toEqual([]);
  });
});

describe("documented differences: on is stricter than legacy", () => {
  it("a dangling target is returned by off, absent on", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-gone");
    const { off, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-gone"])));
    expect(off.map((r) => r.linkedId)).toEqual(["ri-gone"]);
    expect(on).toEqual([]);
  });

  it("shadow does not count a dangling legacy row as a mismatch (compared in the workspace-filtered view)", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-gone");
    link("task-a", "ROADMAP_ITEM", "ri-a");
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, "shadow");
    await getTasksLinkedTo(db(), ROADMAP(["ri-gone", "ri-a"]));
    expect(getReadCompareCounters().TASK).toMatchObject({ compares: 1, mismatches: 0 });
  });

  it("a decision link from a task in another workspace: legacy (unscoped) shows it, on does not", async () => {
    link("task-b", "DECISION", "rr-a");
    const input = { workspaceIds: [WS_A.id], linkedType: "DECISION" as const, linkedIds: ["rr-a"], unscopedLegacy: true };
    const { off, on } = await inEachMode(() => getTasksLinkedTo(db(), input));
    expect(off.map((r) => r.task.id)).toEqual(["task-b"]);
    expect(on).toEqual([]);
  });

  it("scoped legacy (roadmap) already hides a foreign task, so off and on agree", async () => {
    link("task-b", "ROADMAP_ITEM", "ri-a");
    const { off, on } = await inEachMode(() => getTasksLinkedTo(db(), ROADMAP(["ri-a"])));
    expect(off).toEqual([]);
    expect(on).toEqual([]);
  });
});

describe("shadow and fallback behaviour", () => {
  it("shadow returns legacy and counts a mismatch when entity_links is missing the link", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a", { mirrored: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, "shadow");
    const result = await getTasksLinkedTo(db(), ROADMAP(["ri-a"]));
    expect(result.map((r) => r.task.id)).toEqual(["task-a"]);
    expect(getReadCompareCounters().TASK).toMatchObject({ compares: 1, mismatches: 1, onlyLegacy: 1 });
    warn.mockRestore();
  });

  it("on + entity_links failing: legacy serves the read and the error is counted", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, "on");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fake.current!.client as unknown as { entityLink: { findMany: (...a: unknown[]) => Promise<unknown> } };
    const original = client.entityLink.findMany;
    client.entityLink.findMany = async () => { throw new Error("entity_links unavailable") };
    const result = await getTasksLinkedTo(db(), ROADMAP(["ri-a"]));
    client.entityLink.findMany = original;
    expect(result.map((r) => r.task.id)).toEqual(["task-a"]);
    expect(getReadCompareCounters().TASK.errors).toBe(1);
    warn.mockRestore();
  });

  it("shadow with entity_links failing: legacy result unchanged, error counted", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    vi.stubEnv(LINK_READ_FLAG_NAMES.TASK, "shadow");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fake.current!.client as unknown as { entityLink: { findMany: (...a: unknown[]) => Promise<unknown> } };
    const original = client.entityLink.findMany;
    client.entityLink.findMany = async () => { throw new Error("entity_links unavailable") };
    const result = await getTasksLinkedTo(db(), ROADMAP(["ri-a"]));
    client.entityLink.findMany = original;
    expect(result.map((r) => r.task.id)).toEqual(["task-a"]);
    expect(getReadCompareCounters().TASK.errors).toBe(1);
    warn.mockRestore();
  });

  it("off never touches entity_links", async () => {
    link("task-a", "ROADMAP_ITEM", "ri-a");
    const client = fake.current!.client as unknown as { entityLink: { findMany: (...a: unknown[]) => Promise<unknown> } };
    client.entityLink.findMany = async () => { throw new Error("must not be called") };
    expect((await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).map((r) => r.task.id)).toEqual(["task-a"]);
    expect(getReadCompareCounters().TASK.errors).toBe(0);
  });

  it("the TASK flag does not affect other families' readers", async () => {
    vi.stubEnv(LINK_READ_FLAG_NAMES.ARTIFACT, "on");
    link("task-a", "ROADMAP_ITEM", "ri-a", { mirrored: false });
    expect((await getTasksLinkedTo(db(), ROADMAP(["ri-a"]))).map((r) => r.task.id)).toEqual(["task-a"]); // ARTIFACT=on, TASK off: legacy
  });
});
