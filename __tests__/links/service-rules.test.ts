/**
 * Service rules that the single registered type does not exercise: to-one cardinality, symmetric ordering, attrs
 * validation, duplicatePolicy "error" and multi-target `toType`. The registry is wrapped so test-only definitions
 * sit next to the real ones; nothing here registers a type for production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

const extra = vi.hoisted(() => ({ defs: {} as Record<string, unknown> }));
vi.mock("@/lib/links/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/registry")>();
  const lookup = (key: string) => (extra.defs[key] as ReturnType<typeof actual.getLinkType>) ?? actual.getLinkType(key);
  return {
    ...actual,
    getLinkType: lookup,
    requireLinkType: (key: string) => {
      const def = lookup(key);
      if (!def) throw new Error(`test: unknown ${key}`);
      return def;
    },
  };
});

import { defaultAuthorize, type LinkTypeDef } from "@/lib/links/registry";
import { linkEntities } from "@/lib/links/service";
import type { AppTransactionClient } from "@/lib/db";

const base = { direction: "directed", cardinality: { from: "many", to: "many" }, labels: { forward: "f", inverse: "i" }, duplicatePolicy: "idempotent", authorize: defaultAuthorize, lifecycle: { onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" }, summaries: {}, restrictedContexts: "deny" } as const;
const ctx = { source: "MCP" as const };
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state;
const run = (linkType: string, input: Partial<Parameters<typeof linkEntities>[1]> = {}) =>
  linkEntities(tx(), { linkType, fromId: "exp-a", toId: "study-a", expectedWorkspaceId: WS_A.id, ctx, ...input });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  extra.defs = {
    TEST_ONE_STUDY_PER_EXPERIMENT: { ...base, key: "TEST_ONE_STUDY_PER_EXPERIMENT", from: "EXPERIMENT", to: "RESEARCH_STUDY", cardinality: { from: "one", to: "many" } },
    TEST_ONE_EXPERIMENT_PER_STUDY: { ...base, key: "TEST_ONE_EXPERIMENT_PER_STUDY", from: "EXPERIMENT", to: "RESEARCH_STUDY", cardinality: { from: "many", to: "one" } },
    TEST_SYMMETRIC: { ...base, key: "TEST_SYMMETRIC", from: "EXPERIMENT", to: "EXPERIMENT", direction: "symmetric" },
    TEST_DUPLICATE_ERROR: { ...base, key: "TEST_DUPLICATE_ERROR", from: "EXPERIMENT", to: "RESEARCH_STUDY", duplicatePolicy: "error" },
    TEST_ATTRS: { ...base, key: "TEST_ATTRS", from: "EXPERIMENT", to: "RESEARCH_STUDY", attrs: z.object({ note: z.string().max(10) }).strict() },
    TEST_MULTI_TARGET: { ...base, key: "TEST_MULTI_TARGET", from: "EXPERIMENT", to: ["RESEARCH_STUDY", "EXPERIMENT"] },
    TEST_ORIGINS: { ...base, key: "TEST_ORIGINS", from: "EXPERIMENT", to: "RESEARCH_STUDY", origins: ["LEGACY"] },
  } satisfies Record<string, Partial<LinkTypeDef> & { key: string }>;
});

describe("to-one cardinality (enforced in the service, not the database)", () => {
  it("allows the first link, refuses a second for the same from entity, and touches the entity row", async () => {
    const touchedBefore = state().experiments.find((row) => row.id === "exp-a")!.updatedAt as Date;
    expect((await run("TEST_ONE_STUDY_PER_EXPERIMENT")).created).toBe(true);
    expect((state().experiments.find((row) => row.id === "exp-a")!.updatedAt as Date).getTime()).toBeGreaterThan(touchedBefore.getTime());
    await expect(run("TEST_ONE_STUDY_PER_EXPERIMENT", { toId: "study-a-usability" })).rejects.toThrow(/already has a TEST_ONE_STUDY_PER_EXPERIMENT link; unlink it first/);
    expect(state().entityLinks).toHaveLength(1);
    // Another experiment is unaffected, and repeating the SAME pair stays an idempotent no-op rather than a cardinality error.
    expect((await run("TEST_ONE_STUDY_PER_EXPERIMENT", { fromId: "exp-a2" })).created).toBe(true);
    expect((await run("TEST_ONE_STUDY_PER_EXPERIMENT")).created).toBe(false);
  });

  it("enforces the to side the same way", async () => {
    await run("TEST_ONE_EXPERIMENT_PER_STUDY");
    await expect(run("TEST_ONE_EXPERIMENT_PER_STUDY", { fromId: "exp-a2" })).rejects.toThrow(/already has a TEST_ONE_EXPERIMENT_PER_STUDY link/);
  });
});

describe("symmetric types", () => {
  it("store one row with endpoints ordered by (type, id), so A-B and B-A are the same link", async () => {
    const first = await run("TEST_SYMMETRIC", { fromId: "exp-a2", toId: "exp-a", toType: "EXPERIMENT" });
    expect(first.created).toBe(true);
    expect(state().entityLinks[0]).toMatchObject({ fromId: "exp-a", toId: "exp-a2" });
    const reverse = await run("TEST_SYMMETRIC", { fromId: "exp-a", toId: "exp-a2", toType: "EXPERIMENT" });
    expect(reverse.created).toBe(false);
    expect(state().entityLinks).toHaveLength(1);
  });

  it("refuses to link an entity to itself", async () => {
    await expect(run("TEST_SYMMETRIC", { fromId: "exp-a", toId: "exp-a", toType: "EXPERIMENT" })).rejects.toThrow(/itself/);
  });
});

describe("duplicatePolicy, attrs, origins and multi-target types", () => {
  it('duplicatePolicy "error" reports the repeat as a failure', async () => {
    await run("TEST_DUPLICATE_ERROR");
    await expect(run("TEST_DUPLICATE_ERROR")).rejects.toThrow(/Already linked/);
  });

  it("validates attrs with the registry schema and stores them as JSON text", async () => {
    await expect(run("TEST_ATTRS", { attrs: { note: "this is far too long" } })).rejects.toThrow(/Invalid attrs/);
    await expect(run("TEST_ATTRS", { attrs: { other: 1 } })).rejects.toThrow(/Invalid attrs/);
    await run("TEST_ATTRS", { attrs: { note: "ok" } });
    expect(state().entityLinks[0].attrs).toBe('{"note":"ok"}');
  });

  it("requires toType for a multi-target type and rejects one outside the allowed list", async () => {
    await expect(run("TEST_MULTI_TARGET")).rejects.toThrow(/toType is required/);
    await expect(run("TEST_MULTI_TARGET", { toType: "TASK" })).rejects.toThrow(/links to RESEARCH_STUDY, EXPERIMENT, not TASK/);
    expect((await run("TEST_MULTI_TARGET", { toType: "EXPERIMENT", toId: "exp-a2" })).created).toBe(true);
    expect(state().entityLinks[0]).toMatchObject({ toType: "EXPERIMENT", toId: "exp-a2" });
  });

  it("refuses an origin the type does not allow", async () => {
    await expect(run("TEST_ORIGINS", { origin: "DIRECT" })).rejects.toThrow(/does not allow origin DIRECT/);
    expect((await run("TEST_ORIGINS", { origin: "LEGACY" })).link.origin).toBe("LEGACY");
  });
});
