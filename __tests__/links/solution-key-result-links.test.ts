/**
 * Solution <-> Key Result (SOLUTION_TARGETS_KEY_RESULT). entity_links is the only store: lib/typed-links.ts is the dedicated writer
 * and the generic link tools refuse the type.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

import { deleteLinksFor, drainLinksFor, linkSolutionToKeyResult, runTypedLinkTransaction, unlinkSolutionFromKeyResult } from "@/lib/typed-links";
import { linkEntities, unlinkEntities } from "@/lib/links/service";
import { linkTypesForEntity, isLinkTypeEnabled, getLinkType } from "@/lib/links/registry";
import type { AppTransactionClient } from "@/lib/db";

const KEY = "SOLUTION_TARGETS_KEY_RESULT";
const ctx = { source: "MCP" as const, createdById: "user-alice" };
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state;
const link = (solutionId = "sol-a", keyResultId = "kr-a", expectedWorkspaceId: string = WS_A.id) =>
  linkSolutionToKeyResult(tx(), { solutionId, keyResultId, expectedWorkspaceId, ctx });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});

describe("link and unlink", () => {
  it("stores the workspace, actor and source of its writer", async () => {
    const result = await link();
    expect(result.created).toBe(true);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().entityLinks[0]).toMatchObject({
      workspaceId: WS_A.id, linkType: KEY, fromType: "SOLUTION", fromId: "sol-a", toType: "KEY_RESULT", toId: "kr-a", source: "MCP", createdById: "user-alice",
    });
  });

  it("is idempotent: a repeat link adds nothing", async () => {
    await link();
    expect((await link()).created).toBe(false);
    expect(state().entityLinks).toHaveLength(1);
  });

  it("removes the row on unlink, and unlinking a missing link is a clean no-op", async () => {
    await link();
    expect((await unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id })).removed).toBe(1);
    expect(state().entityLinks).toHaveLength(0);
    expect((await unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id })).removed).toBe(0);
  });

  it("propagates a write failure to the caller, so the shared transaction rolls back (the fake does not model rollback)", async () => {
    const failing = vi.spyOn(fake.current!.client.entityLink, "create").mockRejectedValueOnce(new Error("boom"));
    await expect(link()).rejects.toThrow("boom");
    failing.mockRestore();
  });
});

describe("tenant isolation", () => {
  it("a cross-workspace pair is refused before anything is written", async () => {
    await expect(link("sol-a", "kr-b")).rejects.toThrow();
    await expect(link("sol-b", "kr-a")).rejects.toThrow();
    await expect(link("sol-a", "kr-a", WS_B.id)).rejects.toThrow();
    expect(state().entityLinks).toHaveLength(0);
  });

  it("unlinking in the wrong workspace removes nothing", async () => {
    await link();
    await expect(unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_B.id })).rejects.toThrow();
    expect(state().entityLinks).toHaveLength(1);
  });
});

describe("one writer: the generic surface cannot write this type", () => {
  it("linkEntities and unlinkEntities refuse it and point at the existing tool", async () => {
    await expect(linkEntities(tx(), { linkType: KEY, fromId: "sol-a", toId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_solution_to_key_result/);
    await expect(unlinkEntities(tx(), { linkType: KEY, fromId: "sol-a", toId: "kr-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through/);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("is not offered for either endpoint of the generic link tools", () => {
    expect(linkTypesForEntity("SOLUTION").map((entry) => entry.def.key)).not.toContain(KEY);
    expect(linkTypesForEntity("KEY_RESULT").map((entry) => entry.def.key)).not.toContain(KEY);
  });

  it("the registry entry names its dedicated writer and its compat tools", () => {
    const def = getLinkType(KEY)!;
    expect(def.dedicatedWriter?.module).toBe("lib/typed-links.ts");
    expect(def.compat?.mcpTools).toEqual(["link_solution_to_key_result", "unlink_solution_from_key_result"]);
    expect(isLinkTypeEnabled(def)).toBe(true);
  });
});

describe("delete and cascade", () => {
  const seedTwo = async () => {
    await link("sol-a", "kr-a");
    state().keyResults.push({ id: "kr-a2", objectiveId: "obj-a", title: "A2", target: 1, current: 0, sortOrder: 1 });
    await link("sol-a", "kr-a2");
  };

  it("deleteLinksFor sweeps the rows of a deleted solution", async () => {
    await seedTwo();
    expect(await deleteLinksFor(tx(), "solution", ["sol-a"])).toBe(2);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("drainLinksFor sweeps the rows of a deleted key result and leaves other links alone", async () => {
    await seedTwo();
    expect(await drainLinksFor(tx(), "keyResult", ["kr-a"])).toBe(1);
    expect(state().entityLinks.map((row) => row.toId)).toEqual(["kr-a2"]);
  });

  it("a race through runTypedLinkTransaction still ends with one row", async () => {
    await Promise.all([
      runTypedLinkTransaction(fake.current!.client as never, (t) => linkSolutionToKeyResult(t, { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })),
      runTypedLinkTransaction(fake.current!.client as never, (t) => linkSolutionToKeyResult(t, { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })),
    ]);
    expect(state().entityLinks).toHaveLength(1);
  });
});
