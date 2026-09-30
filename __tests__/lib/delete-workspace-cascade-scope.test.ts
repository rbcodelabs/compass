/**
 * Scope of the Solution / Objective teardown in the shared workspace cascade.
 *
 * Teardown must be complete (it also releases rows whose workspaceId is still
 * NULL, reaching them through their parent) but must never reach a row whose own
 * workspaceId names a DIFFERENT workspace. So the parent-chain arm is only ever
 * `{ workspaceId: null, <parent> in [...] }`, never a bare parent match.
 */
import { describe, expect, it, vi } from "vitest";
import { deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade";

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

describe("deleteWorkspaceCascade Solution / Objective scope", () => {
  it("selects objectives by their own workspaceId, or by cycle only while that is NULL", async () => {
    const { client, calls } = recordingPrisma({ "oKRCycle.findMany": [[{ id: "cycle-1" }]] });
    await deleteWorkspaceCascade(client, WS, { skipBlobCleanup: true });
    const expected = { OR: [{ workspaceId: WS }, { workspaceId: null, cycleId: { in: ["cycle-1"] } }] };
    expect(calls.find((c) => c.model === "objective" && c.op === "updateMany")!.args).toMatchObject({ where: expected });
    expect(calls.find((c) => c.model === "objective" && c.op === "findMany")!.args).toMatchObject({ where: expected });
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
