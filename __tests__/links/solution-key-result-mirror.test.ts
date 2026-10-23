/**
 * Phase 4: Solution <-> Key Result mirror (backfilled by 098). solution_key_result_links stays the source of truth;
 * lib/typed-links.ts mirrors each link/unlink into entity_links (SOLUTION_TARGETS_KEY_RESULT) in the same
 * transaction while COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR is on. Reads and the generic tools ignore the type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

import { deleteLinksFor, drainLinksFor, linkSolutionToKeyResult, runTypedLinkTransaction, unlinkSolutionFromKeyResult } from "@/lib/typed-links";
import { linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { linkTypesForEntity, isLinkTypeEnabled, getLinkType, isSolutionKeyResultMirrorEnabled } from "@/lib/links/registry";
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
afterEach(() => vi.unstubAllEnvs());

describe("flag", () => {
  it("is on outside production unless set to 0, and off in production unless set to 1", () => {
    expect(isSolutionKeyResultMirrorEnabled()).toBe(true);
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "0");
    expect(isSolutionKeyResultMirrorEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "");
    expect(isSolutionKeyResultMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "1");
    expect(isSolutionKeyResultMirrorEnabled()).toBe(true);
  });
});

describe("mirror on legacy write", () => {
  it("writes the legacy row first and a mirror row with the same workspace, actor and source", async () => {
    const result = await link();
    expect(result.created).toBe(true);
    expect(state().solutionKeyResultLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().entityLinks[0]).toMatchObject({
      workspaceId: WS_A.id, linkType: KEY, fromType: "SOLUTION", fromId: "sol-a", toType: "KEY_RESULT", toId: "kr-a", source: "MCP", createdById: "user-alice",
    });
  });

  it("is idempotent: a repeat link adds nothing to either table", async () => {
    await link();
    expect((await link()).created).toBe(false);
    expect(state().solutionKeyResultLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(1);
  });

  it("writes no mirror row when the flag is off, and the legacy result is unchanged", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "0");
    expect((await link()).created).toBe(true);
    expect(state().solutionKeyResultLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("removes the mirror row on unlink, even when the flag has since been turned off", async () => {
    await link();
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "0");
    expect((await unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id })).removed).toBe(1);
    expect(state().solutionKeyResultLinks).toHaveLength(0);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("a legacy link made before the flag has no mirror row, and unlinking it is still a clean no-op on the mirror", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "0");
    await link();
    vi.unstubAllEnvs();
    expect((await unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id })).removed).toBe(1);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("propagates a mirror failure to the caller, so the shared transaction rolls back (the fake does not model rollback)", async () => {
    const failing = vi.spyOn(fake.current!.client.entityLink, "create").mockRejectedValueOnce(new Error("boom"));
    await expect(link()).rejects.toThrow("boom");
    failing.mockRestore();
  });

  it("listLinks with the mirrored type named explicitly returns an empty page, flag on or off", async () => {
    await link();
    for (const flag of ["1", "0"]) {
      vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", flag);
      for (const [entityType, entityId] of [["SOLUTION", "sol-a"], ["KEY_RESULT", "kr-a"]]) {
        expect(await listLinks(tx(), { workspaceId: WS_A.id, entityType, entityId, linkType: KEY, limit: 10 })).toEqual({ items: [], nextCursor: null });
      }
    }
  });
});

describe("tenant isolation", () => {
  it("a cross-workspace pair is refused before either table is written", async () => {
    await expect(link("sol-a", "kr-b")).rejects.toThrow();
    await expect(link("sol-b", "kr-a")).rejects.toThrow();
    await expect(link("sol-a", "kr-a", WS_B.id)).rejects.toThrow();
    expect(state().solutionKeyResultLinks).toHaveLength(0);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("unlinking in the wrong workspace removes neither table's row", async () => {
    await link();
    await expect(unlinkSolutionFromKeyResult(tx(), { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_B.id })).rejects.toThrow();
    expect(state().solutionKeyResultLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(1);
  });
});

describe("one writer: the generic surface cannot write or read this type", () => {
  it("linkEntities and unlinkEntities refuse it and point at the existing tool", async () => {
    await expect(linkEntities(tx(), { linkType: KEY, fromId: "sol-a", toId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })).rejects.toThrow(/written through link_solution_to_key_result/);
    await expect(unlinkEntities(tx(), { linkType: KEY, fromId: "sol-a", toId: "kr-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/written through/);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("reads hide it: it is not offered for either endpoint and listLinks returns nothing for the mirror", async () => {
    await link();
    expect(linkTypesForEntity("SOLUTION").map((entry) => entry.def.key)).not.toContain(KEY);
    expect(linkTypesForEntity("KEY_RESULT").map((entry) => entry.def.key)).not.toContain(KEY);
    expect((await listLinks(tx(), { workspaceId: WS_A.id, entityType: "SOLUTION", entityId: "sol-a", limit: 10 })).items).toEqual([]);
  });

  it("the registry entry is legacy-mirrored, names its explicit-only 098 backfill and its compat tools", () => {
    const def = getLinkType(KEY)!;
    expect(def.legacy).toEqual({ legacyModule: "lib/typed-links.ts", backfillMigration: "098_entity_links_backfill_solution_key_result", mode: "mirror", readFamily: "SOLUTION_KR" });
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

  it("deleteLinksFor sweeps legacy and mirror rows for a deleted solution, even with the flag off", async () => {
    await seedTwo();
    vi.stubEnv("COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR", "0");
    expect(await deleteLinksFor(tx(), "solution", ["sol-a"])).toBe(4);
    expect(state().solutionKeyResultLinks).toHaveLength(0);
    expect(state().entityLinks).toHaveLength(0);
  });

  it("drainLinksFor sweeps both tables for a deleted key result and leaves other links alone", async () => {
    await seedTwo();
    expect(await drainLinksFor(tx(), "keyResult", ["kr-a"])).toBe(2);
    expect(state().solutionKeyResultLinks.map((row) => row.keyResultId)).toEqual(["kr-a2"]);
    expect(state().entityLinks.map((row) => row.toId)).toEqual(["kr-a2"]);
  });

  it("a race through runTypedLinkTransaction still ends with one row in each table", async () => {
    await Promise.all([
      runTypedLinkTransaction(fake.current!.client as never, (t) => linkSolutionToKeyResult(t, { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })),
      runTypedLinkTransaction(fake.current!.client as never, (t) => linkSolutionToKeyResult(t, { solutionId: "sol-a", keyResultId: "kr-a", expectedWorkspaceId: WS_A.id, ctx })),
    ]);
    expect(state().solutionKeyResultLinks).toHaveLength(1);
    expect(state().entityLinks).toHaveLength(1);
  });
});
