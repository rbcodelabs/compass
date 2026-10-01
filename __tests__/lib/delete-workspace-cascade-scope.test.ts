/**
 * Scope of the Solution / Objective teardown in the shared workspace cascade.
 *
 * Teardown must be complete (it also releases rows whose workspaceId is still
 * NULL, reaching them through their parent) but must never reach a row whose own
 * workspaceId names a DIFFERENT workspace. So the parent-chain arm is only ever
 * `{ workspaceId: null, <parent> in [...] }`, never a bare parent match.
 */
import { describe, expect, it, vi } from "vitest";
import { CASCADE_CHUNK_SIZE, chunked, deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }));

type Call = { model: string; op: string; args: unknown };

function recordingPrisma(results: Record<string, unknown[]> = {}) {
  const calls: Call[] = [];
  const model = (name: string) =>
    new Proxy({}, {
      get: (_t, op: string) => async (args: unknown) => {
        calls.push({ model: name, op, args });
        const canned = results[`${name}.${op}`];
        if (canned) return canned.length > 1 ? canned.shift() : canned[0];
        if (op.startsWith("findMany")) return [];
        if (op === "count") return 0;
        if (op.endsWith("Many")) return { count: 0 };
        return null;
      },
    });
  const client: unknown = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(client);
      if (prop === "$queryRaw" || prop === "$executeRaw") return async () => [];
      return model(prop);
    },
  });
  return { client: client as Parameters<typeof deleteWorkspaceCascade>[0], calls };
}

const WS = "ws-1";

/**
 * Behavior, not query shape: the tenant fake honours where clauses (OR, in, null equality), so this shows WHICH rows
 * the cascade actually removes. Models the fake does not hold are recording no-ops.
 */
describe("deleteWorkspaceCascade against a where-honouring fake", () => {
  function composite() {
    const fake = createTenantFakePrisma();
    const noop = recordingPrisma();
    const client: unknown = new Proxy({}, {
      get: (_t, prop: string) => {
        const real = (fake.client as unknown as Record<string, unknown>)[prop];
        const fallback = (noop.client as unknown as Record<string, unknown>)[prop];
        if (prop === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(client);
        return new Proxy({}, {
          get: (_m, op: string) => {
            const fn = real && (real as Record<string, unknown>)[op];
            return typeof fn === "function" ? fn : (fallback as Record<string, unknown>)[op];
          },
        });
      },
    });
    return { fake, client: client as Parameters<typeof deleteWorkspaceCascade>[0] };
  }

  it("removes this workspace's solutions and objectives, including un-backfilled ones, and never another workspace's", async () => {
    const { fake, client } = composite();
    const { solutions, objectives, keyResults, okrCycles } = fake.state;
    // Drifted rows: their own workspaceId names B although their parent is in A. They must survive A's teardown.
    solutions.push({ id: "sol-drift", workspaceId: "ws-b", opportunityId: "opp-a", title: "drifted" });
    objectives.push({ id: "obj-drift", workspaceId: "ws-b", cycleId: "cycle-a", title: "drifted" });
    keyResults.push({ id: "kr-drift", objectiveId: "obj-drift", title: "kr of drifted" });

    await deleteWorkspaceCascade(client, WS_A.id, { skipBlobCleanup: true });

    expect(solutions.map((s) => s.id).sort()).toEqual(["sol-b", "sol-drift"]);
    expect(objectives.map((o) => o.id).sort()).toEqual(["obj-b", "obj-drift"]);
    expect(keyResults.map((k) => k.id).sort()).toEqual(["kr-b", "kr-drift"]);
    // Workspace A's own cycle goes; B's does not.
    expect(okrCycles.map((c) => c.id)).toEqual(["cycle-b"]);
  });

  it("deletes workspace A's typed links (including a drifted link row on A's endpoints) and leaves B's links alone", async () => {
    const { fake, client } = composite();
    const { opportunityObjectiveLinks: oLinks, solutionKeyResultLinks: sLinks } = fake.state;
    const row = (extra: Record<string, unknown>) => ({ id: `l${oLinks.length + sLinks.length}`, createdAt: new Date(1), ...extra });
    oLinks.push(row({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" }));
    // Drifted: the row says B, but its opportunity is A's, so deleting A's opportunity must take it too.
    oLinks.push(row({ workspaceId: "ws-b", opportunityId: "opp-a", objectiveId: "obj-b", origin: "LEGACY" }));
    oLinks.push(row({ workspaceId: "ws-b", opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT" }));
    sLinks.push(row({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" }));
    sLinks.push(row({ workspaceId: "ws-b", solutionId: "sol-b", keyResultId: "kr-b" }));

    await deleteWorkspaceCascade(client, WS_A.id, { skipBlobCleanup: true });

    expect(oLinks.map((l) => [l.opportunityId, l.objectiveId])).toEqual([["opp-b", "obj-b"]]);
    expect(sLinks.map((l) => l.solutionId)).toEqual(["sol-b"]);
  });

  it("a cascade for workspace B leaves A's links alone", async () => {
    const { fake, client } = composite();
    const { opportunityObjectiveLinks: oLinks, solutionKeyResultLinks: sLinks } = fake.state;
    oLinks.push({ id: "la", createdAt: new Date(1), workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a", origin: "DIRECT" });
    oLinks.push({ id: "lb", createdAt: new Date(1), workspaceId: "ws-b", opportunityId: "opp-b", objectiveId: "obj-b", origin: "DIRECT" });
    sLinks.push({ id: "sa", createdAt: new Date(1), workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" });
    await deleteWorkspaceCascade(client, "ws-b", { skipBlobCleanup: true });
    expect(oLinks.map((l) => l.id)).toEqual(["la"]);
    expect(sLinks.map((l) => l.id)).toEqual(["sa"]);
  });

  it("a cascade for workspace B touches nothing of A's", async () => {
    const { fake, client } = composite();
    await deleteWorkspaceCascade(client, "ws-b", { skipBlobCleanup: true });
    expect(fake.state.solutions.map((s) => s.id).sort()).toEqual(["sol-a", "sol-null"]);
    expect(fake.state.objectives.map((o) => o.id).sort()).toEqual(["obj-a", "obj-null"]);
  });
});

describe("deleteWorkspaceCascade row limits (DSQL: ~3,000 modified rows per transaction)", () => {
  it("chunked() splits a list into bounded pieces without losing or repeating an id", () => {
    const ids = Array.from({ length: CASCADE_CHUNK_SIZE * 2 + 3 }, (_, i) => `id-${i}`);
    const pieces = chunked(ids);
    expect(pieces.map((p) => p.length)).toEqual([CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE, 3]);
    expect(pieces.flat()).toEqual(ids);
    expect(chunked([])).toEqual([]);
  });

  it("no statement over solutions, objectives, key results, check-ins, assumptions or scores carries more than one chunk of ids", async () => {
    const make = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
    const N = CASCADE_CHUNK_SIZE * 2 + 203; // 1,203
    const { client, calls } = recordingPrisma({
      "oKRCycle.findMany": [[{ id: "cycle-1" }]],
      "opportunity.findMany": [make("opp", N)],
      "solution.findMany": [make("sol", N)],
      "objective.findMany": [make("obj", N)],
      "keyResult.findMany": [make("kr", N)],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });

    const idLists = (model: string, op: string, key: (where: Record<string, { in?: string[] }>) => string[] | undefined) =>
      calls.filter((c) => c.model === model && c.op === op).map((c) => key((c.args as { where: Record<string, { in?: string[] }> }).where)).filter((l): l is string[] => Array.isArray(l));
    const checks: Array<[string, string, (w: Record<string, { in?: string[] }>) => string[] | undefined, number]> = [
      ["objective", "updateMany", (w) => w.id?.in, N],
      ["solution", "deleteMany", (w) => w.id?.in, N],
      ["solutionScore", "deleteMany", (w) => w.solutionId?.in, N],
      ["assumption", "deleteMany", (w) => w.solutionId?.in, N],
      ["solutionComment", "deleteMany", (w) => w.solutionId?.in, N],
      ["opportunityScore", "deleteMany", (w) => w.opportunityId?.in, N],
      ["objective", "deleteMany", (w) => w.id?.in, N],
      ["checkIn", "deleteMany", (w) => w.keyResultId?.in, N * 3], // every objective chunk returns the same 1,203 key results
      ["keyResult", "deleteMany", (w) => w.id?.in, N * 3],
    ];
    for (const [model, op, key, total] of checks) {
      const lists = idLists(model, op, key);
      expect(lists.length, `${model}.${op} statements`).toBeGreaterThanOrEqual(Math.ceil(N / CASCADE_CHUNK_SIZE));
      for (const list of lists) expect(list.length, `${model}.${op}`).toBeLessThanOrEqual(CASCADE_CHUNK_SIZE);
      expect(lists.flat().length, `${model}.${op} ids covered`).toBe(total);
    }
    // Every solution and objective id is covered exactly once.
    expect(new Set(idLists("solution", "deleteMany", (w) => w.id?.in).flat()).size).toBe(N);
    expect(new Set(idLists("objective", "deleteMany", (w) => w.id?.in).flat()).size).toBe(N);
  });
});

describe("deleteWorkspaceCascade typed links: order and row limits", () => {
  it("deletes the workspace's links BEFORE any opportunity, solution or objective delete", async () => {
    const { client, calls } = recordingPrisma({
      "opportunityObjectiveLink.findMany": [[{ id: "l1" }], []],
      "opportunityObjectiveLink.deleteMany": [{ count: 1 }],
      "solutionKeyResultLink.findMany": [[{ id: "s1" }], []],
      "solutionKeyResultLink.deleteMany": [{ count: 1 }],
      "oKRCycle.findMany": [[{ id: "cycle-1" }]],
      "opportunity.findMany": [[{ id: "opp-1" }]],
      "solution.findMany": [[{ id: "sol-1" }]],
      "objective.findMany": [[{ id: "obj-1" }]],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const first = (model: string, op: string) => calls.findIndex((c) => c.model === model && c.op === op);
    const linkSweep = Math.max(first("opportunityObjectiveLink", "deleteMany"), first("solutionKeyResultLink", "deleteMany"));
    expect(first("opportunityObjectiveLink", "deleteMany")).toBeGreaterThan(-1);
    expect(first("solutionKeyResultLink", "deleteMany")).toBeGreaterThan(-1);
    for (const [model, op] of [["opportunity", "deleteMany"], ["solution", "deleteMany"], ["objective", "deleteMany"]] as const) {
      expect(linkSweep, `${model}.${op}`).toBeLessThan(first(model, op));
    }
    // The workspace sweep is the single indexed workspaceId read, deleting by id in chunks.
    const find = calls.find((c) => c.model === "opportunityObjectiveLink" && c.op === "findMany")!;
    expect(find.args).toMatchObject({ where: { workspaceId: WS }, take: CASCADE_CHUNK_SIZE });
  });

  it("no link statement carries more than one chunk of ids, and a large workspace is swept to the end", async () => {
    const N = CASCADE_CHUNK_SIZE * 2 + 17;
    const rows = Array.from({ length: N }, (_, i) => ({ id: `l${i}` }));
    const pages = [rows.slice(0, CASCADE_CHUNK_SIZE), rows.slice(CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE * 2), rows.slice(CASCADE_CHUNK_SIZE * 2), []];
    const { client, calls } = recordingPrisma({
      "opportunityObjectiveLink.findMany": pages,
      "opportunityObjectiveLink.deleteMany": [{ count: CASCADE_CHUNK_SIZE }, { count: CASCADE_CHUNK_SIZE }, { count: 17 }, { count: 0 }],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const deletes = calls.filter((c) => c.model === "opportunityObjectiveLink" && c.op === "deleteMany").map((c) => (c.args as { where: { id?: { in: string[] } } }).where.id?.in).filter(Boolean) as string[][];
    expect(deletes.map((d) => d.length)).toEqual([CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE, 17]);
    expect(deletes.flat()).toEqual(rows.map((r) => r.id));
  });
});

describe("deleteWorkspaceCascade Solution / Objective scope", () => {
  it("selects objectives by their own workspaceId, or by cycle only while that is NULL", async () => {
    const { client, calls } = recordingPrisma({ "oKRCycle.findMany": [[{ id: "cycle-1" }]], "objective.findMany": [[{ id: "obj-1" }]] });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const expected = { OR: [{ workspaceId: WS }, { workspaceId: null, cycleId: { in: ["cycle-1"] } }] };
    expect(calls.find((c) => c.model === "objective" && c.op === "findMany")!.args).toMatchObject({ where: expected });
    // The parentKeyResult release is then driven by the ids that scope selected, in chunks.
    expect(calls.find((c) => c.model === "objective" && c.op === "updateMany")!.args).toMatchObject({ where: { id: { in: ["obj-1"] } } });
  });

  it("selects solutions by their own workspaceId, or by opportunity only while that is NULL", async () => {
    const { client, calls } = recordingPrisma({ "opportunity.findMany": [[{ id: "opp-1" }]] });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const find = calls.find((c) => c.model === "solution" && c.op === "findMany")!;
    expect(find.args).toMatchObject({ where: { OR: [{ workspaceId: WS }, { workspaceId: null, opportunityId: { in: ["opp-1"] } }] } });
    // No bare parent-chain arm that could match a row owned by another workspace.
    expect(JSON.stringify(find.args)).not.toContain('{"opportunityId":{"in"');
  });

  it("deletes the solutions, assumptions and comments it found, and the objectives, key results and check-ins it found", async () => {
    const { client, calls } = recordingPrisma({
      "solution.findMany": [[{ id: "sol-1" }]],
      "objective.findMany": [[{ id: "obj-1" }]],
      "keyResult.findMany": [[{ id: "kr-1" }]],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const has = (model: string, op: string, where: unknown) => calls.some((c) => c.model === model && c.op === op && JSON.stringify((c.args as { where: unknown }).where) === JSON.stringify(where));
    expect(has("assumption", "deleteMany", { solutionId: { in: ["sol-1"] } })).toBe(true);
    expect(has("solution", "deleteMany", { id: { in: ["sol-1"] } })).toBe(true);
    expect(has("checkIn", "deleteMany", { keyResultId: { in: ["kr-1"] } })).toBe(true);
    expect(has("objective", "deleteMany", { id: { in: ["obj-1"] } })).toBe(true);
  });
});
