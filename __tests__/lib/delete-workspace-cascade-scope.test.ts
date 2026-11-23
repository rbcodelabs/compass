/**
 * Scope of the Solution / Objective teardown in the shared workspace cascade.
 *
 * Teardown must be complete (it also releases rows whose workspaceId is still
 * NULL, reaching them through their parent) but must never reach a row whose own
 * workspaceId names a DIFFERENT workspace. So the parent-chain arm is only ever
 * `{ workspaceId: null, <parent> in [...] }`, never a bare parent match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASCADE_CHUNK_SIZE, chunked, deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { createReleaseBudget } from "@/lib/feedback-attachment-ownership";

const storeDelete = vi.fn<(urls: string[]) => Promise<void>>();
vi.mock("@/lib/storage/public-store", () => ({
  getPublicFileStore: () => ({ delete: storeDelete, put: vi.fn(), fetch: vi.fn() }),
}));

vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({}) }));
// The registry-driven final sweep walks every content model with real paging; this where-honouring fake neither holds those models nor
// honours take/cursor. The sweep is exercised (and its tenant scoping proven) against real Postgres in
// workspace-export-coverage.integration.test.ts, so these tests stay about the hand-written steps above it.
vi.mock("@/lib/workspace-export/sweep", () => ({ sweepWorkspaceOwnedRows: async () => ({}) }));

type Call = { model: string; op: string; args: unknown };

function recordingPrisma(results: Record<string, unknown[]> = {}, opts: { queryRaw?: unknown[]; txFails?: boolean } = {}) {
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
      if (prop === "$transaction") {
        return async (fn: (tx: unknown) => unknown) => {
          const out = await fn(client);
          // The failure is raised after the callback ran, i.e. the commit itself failed.
          if (opts.txFails) throw new Error("commit failed");
          return out;
        };
      }
      if (prop === "$queryRaw") return async () => opts.queryRaw ?? [];
      if (prop === "$executeRaw") return async () => [];
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
    const links = fake.state.entityLinks;
    const row = (extra: Record<string, unknown>) => ({ id: `l${links.length}`, createdAt: new Date(1), source: "UI", ...extra });
    links.push(row({ workspaceId: WS_A.id, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT" }));
    // Drifted: the row says B, but its opportunity is A's, so deleting A's opportunity must take it too.
    links.push(row({ workspaceId: "ws-b", linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-b", origin: "LEGACY" }));
    links.push(row({ workspaceId: "ws-b", linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-b", toType: "OBJECTIVE", toId: "obj-b", origin: "DIRECT" }));
    links.push(row({ workspaceId: WS_A.id, linkType: "SOLUTION_TARGETS_KEY_RESULT", fromType: "SOLUTION", fromId: "sol-a", toType: "KEY_RESULT", toId: "kr-a", origin: "DIRECT" }));
    links.push(row({ workspaceId: "ws-b", linkType: "SOLUTION_TARGETS_KEY_RESULT", fromType: "SOLUTION", fromId: "sol-b", toType: "KEY_RESULT", toId: "kr-b", origin: "DIRECT" }));

    await deleteWorkspaceCascade(client, WS_A.id, { skipBlobCleanup: true });

    expect(links.map((l) => [l.fromId, l.toId])).toEqual([["opp-b", "obj-b"], ["sol-b", "kr-b"]]);
  });

  it("a cascade for workspace B leaves A's links alone", async () => {
    const { fake, client } = composite();
    const links = fake.state.entityLinks;
    links.push({ id: "la", createdAt: new Date(1), workspaceId: WS_A.id, linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-a", toType: "OBJECTIVE", toId: "obj-a", origin: "DIRECT" });
    links.push({ id: "lb", createdAt: new Date(1), workspaceId: "ws-b", linkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", fromId: "opp-b", toType: "OBJECTIVE", toId: "obj-b", origin: "DIRECT" });
    links.push({ id: "sa", createdAt: new Date(1), workspaceId: WS_A.id, linkType: "SOLUTION_TARGETS_KEY_RESULT", fromType: "SOLUTION", fromId: "sol-a", toType: "KEY_RESULT", toId: "kr-a", origin: "DIRECT" });
    await deleteWorkspaceCascade(client, "ws-b", { skipBlobCleanup: true });
    expect(links.map((l) => l.id)).toEqual(["la", "sa"]);
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
      "entityLink.findMany": [[{ id: "l1" }], []],
      "entityLink.deleteMany": [{ count: 1 }],
      "oKRCycle.findMany": [[{ id: "cycle-1" }]],
      "opportunity.findMany": [[{ id: "opp-1" }]],
      "solution.findMany": [[{ id: "sol-1" }]],
      "objective.findMany": [[{ id: "obj-1" }]],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const first = (model: string, op: string) => calls.findIndex((c) => c.model === model && c.op === op);
    const linkSweep = first("entityLink", "deleteMany");
    expect(linkSweep).toBeGreaterThan(-1);
    for (const [model, op] of [["opportunity", "deleteMany"], ["solution", "deleteMany"], ["objective", "deleteMany"]] as const) {
      expect(linkSweep, `${model}.${op}`).toBeLessThan(first(model, op));
    }
    // The workspace sweep is the single indexed workspaceId read, deleting by id in chunks.
    const find = calls.find((c) => c.model === "entityLink" && c.op === "findMany")!;
    expect(find.args).toMatchObject({ where: { workspaceId: WS }, take: CASCADE_CHUNK_SIZE });
  });

  it("no link statement carries more than one chunk of ids, and a large workspace is swept to the end", async () => {
    const N = CASCADE_CHUNK_SIZE * 2 + 17;
    const rows = Array.from({ length: N }, (_, i) => ({ id: `l${i}` }));
    const pages = [rows.slice(0, CASCADE_CHUNK_SIZE), rows.slice(CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE * 2), rows.slice(CASCADE_CHUNK_SIZE * 2), []];
    const { client, calls } = recordingPrisma({
      "entityLink.findMany": pages,
      "entityLink.deleteMany": [{ count: CASCADE_CHUNK_SIZE }, { count: CASCADE_CHUNK_SIZE }, { count: 17 }, { count: 0 }],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const deletes = calls.filter((c) => c.model === "entityLink" && c.op === "deleteMany").map((c) => (c.args as { where: { id?: { in: string[] } } }).where.id?.in).filter(Boolean) as string[][];
    expect(deletes.slice(0, 3).map((d) => d.length)).toEqual([CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE, 17]);
    expect(deletes.flat().slice(0, N)).toEqual(rows.map((r) => r.id));
  });
});

describe("deleteWorkspaceCascade generic entity links", () => {
  const first = (calls: Call[], model: string, op: string) => calls.findIndex((c) => c.model === model && c.op === op);

  it("sweeps the workspace's entity_links first, then each experiment's and study's links BEFORE the rows themselves", async () => {
    const { client, calls } = recordingPrisma({
      "entityLink.findMany": [[{ id: "w1" }], [], [{ id: "x1" }], [], [{ id: "s1" }], []],
      "entityLink.deleteMany": [{ count: 1 }, { count: 1 }, { count: 1 }],
      "experiment.findMany": [[{ id: "exp-1" }]],
      "researchStudy.findMany": [[{ id: "study-1" }]],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });

    const links = calls.filter((c) => c.model === "entityLink");
    // 1. the stamped-workspace sweep is the first thing the cascade does to entity_links, and before any parent delete
    expect(links[0].args).toMatchObject({ where: { workspaceId: WS }, take: CASCADE_CHUNK_SIZE });
    expect(first(calls, "entityLink", "deleteMany")).toBeLessThan(first(calls, "researchStudy", "deleteMany"));
    expect(first(calls, "entityLink", "deleteMany")).toBeLessThan(first(calls, "experiment", "deleteMany"));
    // 2. endpoint-keyed sweeps name the type and both directions, and run before the study / experiment delete
    const sweepIndexes = (type: string) =>
      calls.flatMap((c, i) => (c.model === "entityLink" && c.op === "findMany" && JSON.stringify(c.args).includes(`"fromType":"${type}"`) ? [i] : []));
    for (const [type, parent] of [["RESEARCH_STUDY", "researchStudy"], ["EXPERIMENT", "experiment"]] as const) {
      const indexes = sweepIndexes(type);
      expect(indexes.length, type).toBeGreaterThan(0);
      expect(calls[indexes[0]].args).toMatchObject({ where: { OR: [{ fromType: type, fromId: { in: [`${type === "EXPERIMENT" ? "exp" : "study"}-1`] } }, { toType: type, toId: { in: [`${type === "EXPERIMENT" ? "exp" : "study"}-1`] } }] } });
      expect(Math.max(...indexes), type).toBeLessThan(first(calls, parent, "deleteMany"));
    }
  });

  it("leaves another workspace's entity links alone (behavioural, where-honouring fake)", async () => {
    const fake = createTenantFakePrisma();
    fake.state.entityLinks.push(
      { id: "a", workspaceId: WS_A.id, linkType: "T", fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-a", createdAt: new Date(1) },
      { id: "b", workspaceId: "ws-b", linkType: "T", fromType: "EXPERIMENT", fromId: "exp-b", toType: "RESEARCH_STUDY", toId: "study-b", createdAt: new Date(1) },
    );
    const noop = recordingPrisma();
    const client: unknown = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(client);
        const real = (fake.client as unknown as Record<string, unknown>)[prop];
        const fallback = (noop.client as unknown as Record<string, unknown>)[prop];
        return new Proxy({}, { get: (_m, op: string) => { const fn = real && (real as Record<string, unknown>)[op]; return typeof fn === "function" ? fn : (fallback as Record<string, unknown>)[op]; } });
      },
    });
    await deleteWorkspaceCascade(client as Parameters<typeof deleteWorkspaceCascade>[0], WS_A.id, { skipBlobCleanup: true });
    expect(fake.state.entityLinks.map((row) => row.id)).toEqual(["b"]);
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

  it("still tears down cycle-less Objectives (070) when the workspace has no cycles at all", async () => {
    const { client, calls } = recordingPrisma({
      "oKRCycle.findMany": [[]],
      "objective.findMany": [[{ id: "obj-nocycle" }]],
      "keyResult.findMany": [[{ id: "kr-nocycle" }]],
    });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    // Selected through the Objective's own workspaceId; the cycle list being empty must not skip them.
    expect(calls.find((c) => c.model === "objective" && c.op === "findMany")!.args).toMatchObject({
      where: { OR: [{ workspaceId: WS }, { workspaceId: null, cycleId: { in: [] } }] },
    });
    const has = (model: string, op: string, where: unknown) => calls.some((c) => c.model === model && c.op === op && JSON.stringify((c.args as { where: unknown }).where) === JSON.stringify(where));
    expect(has("checkIn", "deleteMany", { keyResultId: { in: ["kr-nocycle"] } })).toBe(true);
    expect(has("keyResult", "deleteMany", { id: { in: ["kr-nocycle"] } })).toBe(true);
    expect(has("objective", "deleteMany", { id: { in: ["obj-nocycle"] } })).toBe(true);
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

// Attachment BLOBS (design: Products/Compass/Runs/compass-attachment-leak-small-fix-design.md). Step 6 deletes the rows; the files
// behind them used to be left on public URLs forever. Release runs after the final transaction commits, honours skipBlobCleanup,
// and never throws into the teardown.
describe("deleteWorkspaceCascade attachment blob release", () => {
  const WS_UUID = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
  const OTHER_WS_UUID = "cccccccc-2222-4222-8222-dddddddddddd";
  const HOST = "store123.public.blob.vercel-storage.com";
  const OWN = `https://${HOST}/feedback/${WS_UUID}/1700000000000-own.png`;
  const THEIRS = `https://${HOST}/feedback/${OTHER_WS_UUID}/1700000000000-theirs.png`;
  const canned = { "feedbackItem.findMany": [[{ id: "fb-1" }, { id: "fb-2" }]], "feedbackAttachment.findMany": [[{ url: OWN }, { url: THEIRS }]] };

  beforeEach(() => {
    storeDelete.mockReset();
    storeDelete.mockResolvedValue(undefined);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secret");
    vi.stubEnv("COMPASS_ENV", "production");
    vi.stubEnv("FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED", "1");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the attachment URLs before step 6 deletes the rows, then deletes only the workspace's own files", async () => {
    const { client, calls } = recordingPrisma(structuredClone(canned));
    await deleteWorkspaceCascade(client, WS_UUID);
    const read = calls.findIndex((c) => c.model === "feedbackAttachment" && c.op === "findMany");
    const rowsDeleted = calls.findIndex((c) => c.model === "feedbackAttachment" && c.op === "deleteMany");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(rowsDeleted);
    expect(calls[read].args).toMatchObject({ where: { feedbackItemId: { in: ["fb-1", "fb-2"] } }, select: { url: true } });
    expect(storeDelete.mock.calls).toEqual([[[OWN]]]);
  });

  it("deletes no file when the final transaction fails (guard 3; mutation M3: release before the commit)", async () => {
    const { client } = recordingPrisma(structuredClone(canned), { txFails: true });
    await expect(deleteWorkspaceCascade(client, WS_UUID)).rejects.toThrow("commit failed");
    expect(storeDelete).not.toHaveBeenCalled();
  });

  it("skipBlobCleanup (preview automation) never reads or deletes a file (guard 4; mutation M2)", async () => {
    const { client, calls } = recordingPrisma(structuredClone(canned));
    await deleteWorkspaceCascade(client, WS_UUID, { skipBlobCleanup: true });
    expect(storeDelete).not.toHaveBeenCalled();
    expect(calls.some((c) => c.model === "feedbackAttachment" && c.op === "findMany")).toBe(false);
  });

  it("keeps a file another workspace's row still references", async () => {
    const { client } = recordingPrisma(structuredClone(canned), { queryRaw: [{ id: "x", url: OWN }] });
    await deleteWorkspaceCascade(client, WS_UUID);
    expect(storeDelete).not.toHaveBeenCalled();
  });

  it("a release failure is logged, never thrown into the teardown", async () => {
    storeDelete.mockRejectedValue(new Error("provider 500"));
    const { client } = recordingPrisma(structuredClone(canned));
    await expect(deleteWorkspaceCascade(client, WS_UUID)).resolves.toBeUndefined();
  });

  it("with the flag off the whole path runs but nothing is deleted", async () => {
    vi.stubEnv("FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED", "");
    const { client } = recordingPrisma(structuredClone(canned));
    await deleteWorkspaceCascade(client, WS_UUID);
    expect(storeDelete).not.toHaveBeenCalled();
  });

  it("pages the URL read in chunks so no statement carries more than one chunk of ids", async () => {
    const N = CASCADE_CHUNK_SIZE * 2 + 7;
    const items = Array.from({ length: N }, (_, i) => ({ id: `fb-${i}` }));
    const { client, calls } = recordingPrisma({ "feedbackItem.findMany": [items], "feedbackAttachment.findMany": [[]] });
    await deleteWorkspaceCascade(client, WS_UUID);
    const reads = calls.filter((c) => c.model === "feedbackAttachment" && c.op === "findMany").map((c) => (c.args as { where: { feedbackItemId: { in: string[] } } }).where.feedbackItemId.in);
    expect(reads.map((r) => r.length)).toEqual([CASCADE_CHUNK_SIZE, CASCADE_CHUNK_SIZE, 7]);
  });

  it("accepts one shared release budget (account deletion shares one 20 s budget across its workspaces)", async () => {
    const budget = createReleaseBudget(20_000);
    const { client } = recordingPrisma(structuredClone(canned));
    await deleteWorkspaceCascade(client, WS_UUID, { blobBudget: budget });
    expect(storeDelete).toHaveBeenCalledTimes(1);
  });
});
