/**
 * Cross-tenant matrix for the OKR and squad server actions.
 *
 * These actions used to take an objective / key result / cycle / squad id from
 * the client and act on it with no membership check, so any signed-in user could
 * mutate another workspace's rows. They now resolve the row through
 * requireProductEntity (real helper, not mocked) which folds workspace
 * membership into the lookup. Objective carries its own workspaceId (migration 068),
 * Key Result scopes through its Objective, and a NULL workspaceId is denied even
 * though the parent chain (cycle) still points at the caller's workspace.
 *
 * The fake honours those `where` clauses, so a missing filter shows up as a
 * foreign row being read or written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const W_A = "ws-a";
const W_B = "ws-b";
const ALICE = "user-alice"; // member of A only

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof makeDb> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

function makeDb() {
  const workspaces: Row[] = [
    { id: W_A, slug: "alpha", org: "acme", members: [ALICE] },
    { id: W_B, slug: "beta", org: "globex", members: ["user-bob"] },
  ];
  const tables: Record<string, Row[]> = {
    workspace: workspaces,
    okrCycle: [{ id: "cycle-a", workspaceId: W_A }, { id: "cycle-b", workspaceId: W_B }],
    objective: [
      { id: "obj-a", workspaceId: W_A, cycleId: "cycle-a", squadId: "00000000-0000-4000-8000-00000000000a", status: "ON_TRACK", sortOrder: 0 },
      { id: "obj-b", workspaceId: W_B, cycleId: "cycle-b", squadId: "00000000-0000-4000-8000-00000000000b", status: "ON_TRACK", sortOrder: 0 },
      { id: "obj-null", workspaceId: null, cycleId: "cycle-a", squadId: null, status: "ON_TRACK", sortOrder: 0 },
    ],
    keyResult: [
      { id: "kr-a", objectiveId: "obj-a", current: 0, sortOrder: 0 },
      { id: "kr-b", objectiveId: "obj-b", current: 0, sortOrder: 0 },
      { id: "kr-null", objectiveId: "obj-null", current: 0, sortOrder: 0 },
    ],
    squad: [{ id: "00000000-0000-4000-8000-00000000000a", workspaceId: W_A, name: "A" }, { id: "00000000-0000-4000-8000-00000000000b", workspaceId: W_B, name: "B" }],
    opportunity: [
      { id: "opp-b", workspaceId: W_B, squadId: "00000000-0000-4000-8000-00000000000b", linkedKeyResultId: null },
      { id: "opp-a", workspaceId: W_A, squadId: null, linkedKeyResultId: "kr-a" },
    ],
    opportunityObjectiveLink: [
      { id: "l-a-legacy", workspaceId: W_A, opportunityId: "opp-a", objectiveId: "obj-a", origin: "LEGACY" },
      { id: "l-a-direct", workspaceId: W_A, opportunityId: "opp-a", objectiveId: "obj-a2", origin: "DIRECT" },
      { id: "l-b", workspaceId: W_B, opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT" },
    ],
    solutionKeyResultLink: [
      { id: "s-a", workspaceId: W_A, solutionId: "sol-a", keyResultId: "kr-a" },
      { id: "s-b", workspaceId: W_B, solutionId: "sol-b", keyResultId: "kr-b" },
    ],
    experiment: [],
    roadmapItem: [{ id: "rm-a", workspaceId: W_A, squadId: null }, { id: "rm-b", workspaceId: W_B, squadId: "00000000-0000-4000-8000-00000000000b" }],
    task: [{ id: "task-a", workspaceId: W_A, squadId: "00000000-0000-4000-8000-00000000000a" }, { id: "task-b", workspaceId: W_B, squadId: "00000000-0000-4000-8000-00000000000b" }],
    checkIn: [],
  };
  const relations: Record<string, Record<string, [string, string]>> = {
    okrCycle: { workspace: ["workspace", "workspaceId"] },
    objective: { cycle: ["okrCycle", "cycleId"], workspace: ["workspace", "workspaceId"] },
    keyResult: { objective: ["objective", "objectiveId"] },
    squad: { workspace: ["workspace", "workspaceId"] },
    opportunity: { workspace: ["workspace", "workspaceId"] },
    roadmapItem: { workspace: ["workspace", "workspaceId"] },
    task: { workspace: ["workspace", "workspaceId"] },
  };
  const writes: string[] = [];
  const matches = (model: string, row: Row, where: Row = {}): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") {
        if (!(cond as Row[]).some((c) => matches(model, row, c))) return false;
        continue;
      }
      if (model === "workspace" && key === "members") {
        if (!(row.members as string[]).includes((cond as { some: { userId: string } }).some.userId)) return false;
        continue;
      }
      if (model === "workspace" && key === "organization") {
        if ((cond as { slug: string }).slug !== row.org) return false;
        continue;
      }
      if (cond !== null && typeof cond === "object" && !relations[model]?.[key] && !(model === "workspace" && (key === "members" || key === "organization"))) {
        const op = cond as { in?: unknown[]; not?: unknown };
        if (op.in) { if (!op.in.includes(row[key])) return false; continue; }
        if ("not" in op) { if (row[key] === op.not) return false; continue; }
      }
      const rel = relations[model]?.[key];
      if (rel) {
        const parent = tables[rel[0]].find((r) => r.id === row[rel[1]]);
        if (!parent || !matches(rel[0], parent, cond as Row)) return false;
        continue;
      }
      if (!(key in row)) throw new Error(`fake: unsupported where key ${model}.${key}`);
      if (row[key] !== cond) return false;
    }
    return true;
  };
  const delegate = (model: string) => ({
    findFirst: async ({ where }: { where: Row }) => {
      const row = tables[model].find((r) => matches(model, r, where));
      if (!row) return null;
      // Emulate the `select` shapes the helper asks for.
      const out: Row = { ...row };
      const rel = relations[model];
      if (model === "keyResult") out.objective = tables.objective.find((o) => o.id === row.objectiveId);
      void rel;
      return out;
    },
    count: async ({ where }: { where: Row }) => tables[model].filter((r) => matches(model, r, where)).length,
    findMany: async ({ where }: { where: Row }) => tables[model].filter((r) => matches(model, r, where)).map((r) => ({ ...r })),
    deleteMany: async ({ where }: { where: Row }) => {
      const doomed = tables[model].filter((r) => matches(model, r, where));
      for (const r of doomed) { writes.push(`${model}.deleteMany:${r.id}`); tables[model].splice(tables[model].indexOf(r), 1); }
      return { count: doomed.length };
    },
    create: async ({ data }: { data: Row }) => { const row = { id: `${model}-new`, ...data }; tables[model].push(row); writes.push(`${model}.create`); return row; },
    update: async ({ where, data }: { where: Row; data: Row }) => { const row = tables[model].find((r) => matches(model, r, where)); if (!row) throw new Error("not found"); Object.assign(row, data); writes.push(`${model}.update:${row.id}`); return row; },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => { const rows = tables[model].filter((r) => matches(model, r, where)); rows.forEach((r) => { Object.assign(r, data); writes.push(`${model}.updateMany:${r.id}`); }); return { count: rows.length }; },
    delete: async ({ where }: { where: Row }) => { const i = tables[model].findIndex((r) => matches(model, r, where)); if (i < 0) throw new Error("not found"); writes.push(`${model}.delete:${tables[model][i].id}`); tables[model].splice(i, 1); return {}; },
  });
  const client: Record<string, unknown> = {
    workspace: { findFirst: async ({ where }: { where: Row }) => (workspaces.find((w) => matches("workspace", w, where)) as Row | undefined) ?? null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  for (const m of Object.keys(tables)) if (m !== "workspace") client[m === "okrCycle" ? "oKRCycle" : m] = delegate(m);
  return { client, tables, writes };
}

vi.mock("@/lib/db", () => ({ default: () => db.current!.client }));
vi.mock("@/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/analytics/activity", () => ({ getHumanActivityPrisma: () => db.current!.client }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: vi.fn() }));

import * as okr from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import * as settings from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { requireProductEntity } from "@/lib/product-action-auth";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const DENIED = "Entity not found or access denied";

beforeEach(() => {
  db.current = makeDb();
  session.userId = ALICE;
});

describe("requireProductEntity for OKR kinds", () => {
  it("resolves the caller's own rows to their workspace", async () => {
    await expect(requireProductEntity("okrCycle", "cycle-a")).resolves.toMatchObject({ workspaceId: W_A });
    await expect(requireProductEntity("objective", "obj-a")).resolves.toMatchObject({ workspaceId: W_A });
    await expect(requireProductEntity("keyResult", "kr-a")).resolves.toMatchObject({ workspaceId: W_A });
    await expect(requireProductEntity("squad", "00000000-0000-4000-8000-00000000000a")).resolves.toMatchObject({ workspaceId: W_A });
  });

  it.each([["okrCycle", "cycle-b"], ["objective", "obj-b"], ["keyResult", "kr-b"], ["squad", "00000000-0000-4000-8000-00000000000b"]] as const)(
    "denies %s %s in another workspace", async (kind, id) => {
      await expect(requireProductEntity(kind, id)).rejects.toThrow(DENIED);
    });

  it("rejects an expected workspace that does not match the row's (exact mismatch, row itself is reachable)", async () => {
    // Positive control: without the expectation the same row resolves.
    await expect(requireProductEntity("objective", "obj-a")).resolves.toMatchObject({ workspaceId: W_A });
    await expect(requireProductEntity("objective", "obj-a", W_B)).rejects.toThrow(DENIED);
    await expect(requireProductEntity("task", "task-a")).resolves.toMatchObject({ workspaceId: W_A });
    await expect(requireProductEntity("task", "task-a", W_B)).rejects.toThrow(DENIED);
    await expect(requireProductEntity("keyResult", "kr-a", W_B)).rejects.toThrow(DENIED);
  });

  it.each([["objective", "obj-null"], ["keyResult", "kr-null"]] as const)(
    "denies %s %s: a NULL workspaceId fails closed although its cycle belongs to the caller", async (kind, id) => {
      await expect(requireProductEntity(kind, id)).rejects.toThrow(DENIED);
    });

  it.each([["task", "task-a", "task-b"], ["roadmapItem", "rm-a", "rm-b"], ["squad", "00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"]] as const)(
    "the %s kind resolves the caller's row and denies another workspace's", async (kind, own, foreign) => {
      await expect(requireProductEntity(kind, own)).resolves.toMatchObject({ workspaceId: W_A });
      await expect(requireProductEntity(kind, foreign)).rejects.toThrow(DENIED);
    });

  it("rejects an unauthenticated caller", async () => {
    session.userId = null;
    await expect(requireProductEntity("objective", "obj-a")).rejects.toThrow("Unauthorized");
  });
});

describe("OKR server actions", () => {
  const denied: Array<[string, () => Promise<unknown>]> = [
    ["addKeyResult(unbackfilled objective)", () => okr.addKeyResult("obj-null", "acme", "alpha", form({ title: "KR", target: "5" }))],
    ["logCheckIn(key result under an unbackfilled objective)", () => okr.logCheckIn("kr-null", "acme", "alpha", form({ value: "3" }))],
    ["updateObjectiveStatus(unbackfilled)", () => okr.updateObjectiveStatus("obj-null", "AT_RISK", "acme", "alpha")],
    ["deleteObjective(unbackfilled)", () => okr.deleteObjective("obj-null", "/p")],
    ["createCycle(foreign workspace)", () => okr.createCycle(W_B, "globex", "beta", form({ title: "Q", startDate: "2026-01-01", endDate: "2026-03-31" }))],
    ["createObjective(foreign cycle)", () => okr.createObjective("cycle-b", "globex", "beta", form({ title: "X" }))],
    ["createObjective(own cycle, foreign squad)", () => okr.createObjective("cycle-a", "acme", "alpha", form({ title: "X", squadId: "00000000-0000-4000-8000-00000000000b" }))],
    ["addKeyResult(foreign objective)", () => okr.addKeyResult("obj-b", "globex", "beta", form({ title: "KR", target: "5" }))],
    ["logCheckIn(foreign key result)", () => okr.logCheckIn("kr-b", "globex", "beta", form({ value: "3" }))],
    ["updateObjectiveStatus(foreign)", () => okr.updateObjectiveStatus("obj-b", "AT_RISK", "globex", "beta")],
    ["deleteObjective(foreign)", () => okr.deleteObjective("obj-b", "/p")],
    ["deleteKeyResult(foreign)", () => okr.deleteKeyResult("kr-b", "/p")],
    ["reorderObjective(foreign)", () => okr.reorderObjective("obj-b", 9, "/p")],
    ["reorderKeyResult(foreign)", () => okr.reorderKeyResult("kr-b", 9, "/p")],
  ];

  it.each(denied)("%s is refused and writes nothing", async (_name, run) => {
    await expect(run()).rejects.toThrow(/access denied|not found|Squad not found/);
    expect(db.current!.writes).toEqual([]);
  });

  it("an unauthenticated caller cannot create an objective", async () => {
    session.userId = null;
    await expect(okr.createObjective("cycle-a", "acme", "alpha", form({ title: "X" }))).rejects.toThrow("Unauthorized");
    expect(db.current!.writes).toEqual([]);
  });

  it("deleteKeyResult removes the LEGACY link and the solution links to that key result, keeps DIRECT links, and never touches workspace B's", async () => {
    await okr.deleteKeyResult("kr-a", "/p");
    const ids = (name: string) => db.current!.tables[name].map((r) => r.id);
    expect(ids("opportunityObjectiveLink")).toEqual(["l-a-direct", "l-b"]);
    expect(ids("solutionKeyResultLink")).toEqual(["s-b"]);
    expect(ids("keyResult")).not.toContain("kr-a");
  });

  it("deleteObjective removes every opportunity link to it (both origins) and only those", async () => {
    db.current!.tables.opportunityObjectiveLink.push({ id: "l-a-direct-obj-a", workspaceId: W_A, opportunityId: "opp-a2", objectiveId: "obj-a", origin: "DIRECT" });
    await okr.deleteObjective("obj-a", "/p");
    expect(db.current!.tables.opportunityObjectiveLink.map((r) => r.id)).toEqual(["l-a-direct", "l-b"]);
  });

  it("the caller's own rows still work (positive control)", async () => {
    await okr.createObjective("cycle-a", "acme", "alpha", form({ title: "Mine", squadId: "00000000-0000-4000-8000-00000000000a" }));
    await okr.addKeyResult("obj-a", "acme", "alpha", form({ title: "KR", target: "5" }));
    await okr.updateObjectiveStatus("obj-a", "AT_RISK", "acme", "alpha");
    await okr.reorderObjective("obj-a", 4, "/p");
    await okr.reorderKeyResult("kr-a", 4, "/p");
    await okr.deleteKeyResult("kr-a", "/p");
    await okr.deleteObjective("obj-a", "/p");
    expect(db.current!.tables.objective.map((o) => o.id)).not.toContain("obj-a");
  });
});

describe("squad server actions", () => {
  it("deleteSquad refuses another workspace's squad and nulls nothing", async () => {
    await expect(settings.deleteSquad("acme", "alpha", "00000000-0000-4000-8000-00000000000b")).rejects.toThrow("Squad not found in this workspace");
    expect(db.current!.writes).toEqual([]);
    expect(db.current!.tables.objective.find((o) => o.id === "obj-b")!.squadId).toBe("00000000-0000-4000-8000-00000000000b");
  });

  it("deleteSquad on the caller's own squad only clears rows in the caller's workspace", async () => {
    // Foreign rows that (incorrectly) point at the caller's squad must survive.
    db.current!.tables.objective.find((o) => o.id === "obj-b")!.squadId = "00000000-0000-4000-8000-00000000000a";
    db.current!.tables.task.find((t) => t.id === "task-b")!.squadId = "00000000-0000-4000-8000-00000000000a";
    await settings.deleteSquad("acme", "alpha", "00000000-0000-4000-8000-00000000000a");
    expect(db.current!.tables.objective.find((o) => o.id === "obj-a")!.squadId).toBeNull();
    // Task.squadId is cleared too (the fifth table with a squad_id column), scoped to the workspace.
    expect(db.current!.tables.task.find((t) => t.id === "task-a")!.squadId).toBeNull();
    expect(db.current!.tables.objective.find((o) => o.id === "obj-b")!.squadId).toBe("00000000-0000-4000-8000-00000000000a");
    expect(db.current!.tables.task.find((t) => t.id === "task-b")!.squadId).toBe("00000000-0000-4000-8000-00000000000a");
  });

  it("updateSquad refuses another workspace's squad", async () => {
    await expect(settings.updateSquad("acme", "alpha", "00000000-0000-4000-8000-00000000000b", { name: "Pwned" })).rejects.toThrow("Squad not found in this workspace");
    expect(db.current!.tables.squad.find((s) => s.id === "00000000-0000-4000-8000-00000000000b")!.name).toBe("B");
  });

  it.each([
    ["objective", "obj-b"],
    ["opportunity", "opp-b"],
    ["roadmapItem", "rm-b"],
  ] as const)("assignSquad(%s %s) refuses another workspace's object", async (type, id) => {
    await expect(settings.assignSquad(type, id, null, "/p")).rejects.toThrow(DENIED);
    expect(db.current!.writes).toEqual([]);
  });

  it("assignSquad refuses a squad from another workspace for the caller's own object", async () => {
    await expect(settings.assignSquad("objective", "obj-a", "00000000-0000-4000-8000-00000000000b", "/p")).rejects.toThrow("Squad not found in this workspace");
    expect(db.current!.tables.objective.find((o) => o.id === "obj-a")!.squadId).toBe("00000000-0000-4000-8000-00000000000a");
  });
});
