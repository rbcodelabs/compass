/**
 * lib/links/service.ts against the where-honouring tenant fake: tenant isolation, eligibility, idempotency,
 * race retry, read filtering and batched deletes for EXPERIMENT_INFORMED_BY_STUDY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { LINK_WRITE_CHUNK, deleteLinksForEntity, deleteWorkspaceLinks, linkEntities, listLinks, unlinkEntities } from "@/lib/links/service";
import { runTypedLinkTransaction, TypedLinkError } from "@/lib/typed-links";
import type { AppTransactionClient } from "@/lib/db";

const TYPE = "EXPERIMENT_INFORMED_BY_STUDY";
const ctx = { source: "MCP" as const, createdById: "user-alice" };
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const state = () => fake.current!.state;
const link = (overrides: Partial<Parameters<typeof linkEntities>[1]> = {}) =>
  linkEntities(tx(), { linkType: TYPE, fromId: "exp-a", toId: "study-a", expectedWorkspaceId: WS_A.id, ctx, ...overrides });
const seedLink = (row: Record<string, unknown>) =>
  state().entityLinks.push({
    id: `seed-${state().entityLinks.length}`, workspaceId: WS_A.id, linkType: TYPE, fromType: "EXPERIMENT", toType: "RESEARCH_STUDY",
    origin: "DIRECT", source: "MCP", createdById: null, attrs: null, createdAt: new Date(10 + state().entityLinks.length), updatedAt: new Date(), ...row,
  });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});
afterEach(() => vi.unstubAllEnvs());

describe("linkEntities", () => {
  it("stores the link with the from row's workspace, the actor and the caller's source, and touches nothing else", async () => {
    const before = JSON.stringify([state().experiments, state().researchStudies]);
    const result = await link();
    expect(result.created).toBe(true);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().entityLinks[0]).toMatchObject({
      workspaceId: WS_A.id, linkType: TYPE, fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-a",
      origin: "DIRECT", source: "MCP", createdById: "user-alice", attrs: null,
    });
    expect(state().entityLinks[0].updatedAt).toBeInstanceOf(Date);
    // Linking changes no experiment status/assumption and no study protocol or credential: neither table was written.
    expect(JSON.stringify([state().experiments, state().researchStudies])).toBe(before);
    expect(state().writes.filter((w) => !w.startsWith("entityLink."))).toEqual([]);
  });

  it("is idempotent: a repeat reports created:false and writes nothing", async () => {
    await link();
    const writes = state().writes.length;
    const again = await link();
    expect(again.created).toBe(false);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().writes).toHaveLength(writes);
  });

  it("repairs a drifted workspaceId on the existing pair to the verified one", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a", workspaceId: WS_B.id });
    const result = await link();
    expect(result.created).toBe(false);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().entityLinks[0].workspaceId).toBe(WS_A.id);
  });

  it.each([
    ["a study in another workspace", { toId: "study-b" }],
    ["an experiment in another workspace", { fromId: "exp-b" }],
    ["a study that does not exist", { toId: "11111111-1111-4111-8111-111111111111" }],
  ])("denies %s and writes nothing", async (_label, ids) => {
    await expect(link(ids)).rejects.toBeInstanceOf(TypedLinkError);
    await expect(link(ids)).rejects.toThrow(/not found in this workspace|not found/i);
    expect(state().writes).toEqual([]);
    expect(state().entityLinks).toEqual([]);
  });

  it("a forged expectedWorkspaceId cannot join workspace A's rows (the precondition is checked on both ends)", async () => {
    await expect(link({ expectedWorkspaceId: WS_B.id })).rejects.toThrow(/not found/);
    await expect(link({ fromId: "exp-b", toId: "study-a", expectedWorkspaceId: WS_B.id })).rejects.toThrow(/not found/);
    expect(state().writes).toEqual([]);
  });

  it("fails closed on an endpoint whose workspace is NULL", async () => {
    state().experiments.push({ id: "exp-null", workspaceId: null, title: "orphan", status: "DESIGNING", updatedAt: new Date(1) });
    state().researchStudies.push({ id: "study-null", workspaceId: null, name: "orphan", studyType: "CUSTOMER_INTERVIEW", status: "ACTIVE", updatedAt: new Date(1) });
    await expect(link({ fromId: "exp-null" })).rejects.toThrow(/not found/);
    await expect(link({ toId: "study-null" })).rejects.toThrow(/not found/);
    expect(state().entityLinks).toEqual([]);
  });

  it("accepts customer-interview and usability-test studies", async () => {
    expect((await link({ toId: "study-a" })).created).toBe(true);
    expect((await link({ toId: "study-a-usability" })).created).toBe(true);
    expect(state().entityLinks).toHaveLength(2);
  });

  it("many-to-many: one experiment, several studies, and one study, several experiments", async () => {
    await link({ fromId: "exp-a", toId: "study-a" });
    await link({ fromId: "exp-a", toId: "study-a-usability" });
    await link({ fromId: "exp-a2", toId: "study-a" });
    expect(state().entityLinks).toHaveLength(3);
  });

  it("treats a PM_INTERVIEW study as not found, refuses an EXTERNAL study, and refuses an archived study", async () => {
    await expect(link({ toId: "study-a-pm" })).rejects.toThrow(/Research study not found/);
    await expect(link({ toId: "study-a-external" })).rejects.toThrow(/Only customer interview and usability test/);
    await expect(link({ toId: "study-a-archived" })).rejects.toThrow(/Archived research studies cannot be linked/);
    expect(state().entityLinks).toEqual([]);
  });

  it("refuses mutations when the research feature flag is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "");
    await expect(link()).rejects.toThrow(/cannot be used: it is not enabled/);
    await expect(unlinkEntities(tx(), { linkType: TYPE, fromId: "exp-a", toId: "study-a", expectedWorkspaceId: WS_A.id })).rejects.toThrow(/not enabled/);
    expect(state().writes).toEqual([]);
  });

  it("rejects unknown link types, attrs on a type without a schema, and a mismatched toType", async () => {
    await expect(link({ linkType: "NOPE" })).rejects.toThrow(/Invalid link type "NOPE"/);
    await expect(link({ attrs: { note: "x" } })).rejects.toThrow(/does not take attrs/);
    await expect(link({ toType: "TASK" })).rejects.toThrow(/links to RESEARCH_STUDY, not TASK/);
    expect(state().entityLinks).toEqual([]);
  });

  it("a lost pair race is retried and the loser becomes an idempotent no-op", async () => {
    const client = fake.current!.client;
    const delegate = client.entityLink as { findFirst: (args: unknown) => Promise<unknown> };
    const realFindFirst = delegate.findFirst;
    let calls = 0;
    // The first attempt reads "no link" (the race), then the unique pair index rejects its insert because a concurrent winner
    // committed the same pair; the retry reads the winner.
    delegate.findFirst = async (args: unknown) => {
      calls += 1;
      if (calls === 1) {
        seedLink({ id: "winner", fromId: "exp-a", toId: "study-a" });
        return null;
      }
      return realFindFirst(args);
    };
    const result = await runTypedLinkTransaction(client as never, (t) => linkEntities(t, { linkType: TYPE, fromId: "exp-a", toId: "study-a", expectedWorkspaceId: WS_A.id, ctx }));
    expect(result.created).toBe(false);
    expect(state().entityLinks).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("unlinkEntities", () => {
  const unlink = (overrides: Partial<Parameters<typeof unlinkEntities>[1]> = {}) =>
    unlinkEntities(tx(), { linkType: TYPE, fromId: "exp-a", toId: "study-a", expectedWorkspaceId: WS_A.id, ...overrides });

  it("removes the link, then reports removed:0 (idempotent)", async () => {
    await link();
    const first = await unlink();
    expect(first.removed).toBe(1);
    expect(first.removedIds).toHaveLength(1);
    expect((await unlink()).removed).toBe(0);
    expect(state().entityLinks).toEqual([]);
  });

  it("only verifies the from endpoint: a link whose study is gone stays removable", async () => {
    await link();
    state().researchStudies.splice(0, state().researchStudies.length);
    expect((await unlink()).removed).toBe(1);
  });

  it("a link to an archived study stays removable", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a-archived" });
    expect((await unlink({ toId: "study-a-archived" })).removed).toBe(1);
  });

  it("never touches another workspace's row for the same ids", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a", workspaceId: WS_B.id });
    expect((await unlink()).removed).toBe(0);
    expect(state().entityLinks).toHaveLength(1);
  });

  it("denies a from endpoint in another workspace", async () => {
    await expect(unlink({ fromId: "exp-b", toId: "study-b" })).rejects.toThrow(/not found/);
  });
});

describe("listLinks", () => {
  const list = (overrides: Partial<Parameters<typeof listLinks>[1]> = {}) =>
    listLinks(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", limit: 50, ...overrides });

  it("lists both directions with the label read from the queried end", async () => {
    await link({ fromId: "exp-a", toId: "study-a" });
    await link({ fromId: "exp-a2", toId: "study-a" });
    const fromExperiment = await list();
    expect(fromExperiment.items).toHaveLength(1);
    expect(fromExperiment.items[0]).toMatchObject({
      kind: "entity_link", linkType: TYPE, side: "from", label: "Informed by",
      from: { type: "EXPERIMENT", id: "exp-a", title: "A experiment" }, to: { type: "RESEARCH_STUDY", id: "study-a", title: "A interviews" },
    });
    const fromStudy = await list({ entityType: "RESEARCH_STUDY", entityId: "study-a" });
    expect(fromStudy.items.map((item) => [item.side, item.label, item.from.id])).toEqual([["to", "Informs", "exp-a"], ["to", "Informs", "exp-a2"]]);
  });

  it("drops a dangling endpoint and a link stamped for a workspace whose endpoint is elsewhere", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a" });
    seedLink({ fromId: "exp-a", toId: "11111111-1111-4111-8111-111111111111" }); // study deleted: dangling
    seedLink({ fromId: "exp-a", toId: "study-b" }); // stamped A but the study lives in B (drift)
    const { items } = await list();
    expect(items.map((item) => item.to.id)).toEqual(["study-a"]);
  });

  it("does not list another workspace's links even when the ids are shared", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a", workspaceId: WS_B.id });
    expect((await list()).items).toEqual([]);
  });

  it("keeps an archived study's link visible", async () => {
    seedLink({ fromId: "exp-a", toId: "study-a-archived" });
    expect((await list()).items.map((item) => item.to.id)).toEqual(["study-a-archived"]);
  });

  it("denies an entity in another workspace and an unknown entity type", async () => {
    await expect(list({ entityId: "exp-b" })).rejects.toThrow(/not found/);
    await expect(list({ entityType: "NOPE" })).rejects.toThrow(/Unknown entity type/);
  });

  it("rejects a linkType that does not touch the entity, and hides the type when its flag is off", async () => {
    await expect(list({ entityType: "TASK", entityId: "task-1", linkType: TYPE })).rejects.toThrow();
    seedLink({ fromId: "exp-a", toId: "study-a" });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_RESEARCH_CAPTURE_ENABLED", "");
    expect((await list()).items).toEqual([]);
    expect((await list({ linkType: TYPE })).items).toEqual([]);
  });

  it("pages with a keyset cursor, oldest first, without repeating or skipping", async () => {
    for (const study of ["study-a", "study-a-usability", "study-a-archived"]) seedLink({ fromId: "exp-a", toId: study });
    const first = await list({ limit: 2 });
    expect(first.items.map((item) => item.to.id)).toEqual(["study-a", "study-a-usability"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.to.id)).toEqual(["study-a-archived"]);
    expect(second.nextCursor).toBeNull();
    await expect(list({ cursor: "garbage" })).rejects.toThrow(/Invalid cursor/);
  });
});

describe("deletes", () => {
  it("deleteLinksForEntity removes links in BOTH directions, in batches of at most 500 links, and is idempotent", async () => {
    const total = LINK_WRITE_CHUNK * 2 + 150;
    for (let i = 0; i < total; i += 1) seedLink({ id: `bulk-${i}`, fromId: `exp-${i}`, toId: "study-a" });
    // The queried study as the FROM side of a (synthetic) reverse-direction row, and an unrelated link that must survive.
    seedLink({ id: "reverse", fromType: "RESEARCH_STUDY", fromId: "study-a", toType: "EXPERIMENT", toId: "exp-a" });
    seedLink({ id: "keep", fromId: "exp-a", toId: "study-a-usability" });

    const deleteMany = vi.spyOn(fake.current!.client.entityLink, "deleteMany");
    const removed = await deleteLinksForEntity(tx(), "RESEARCH_STUDY", ["study-a"]);
    expect(removed).toBe(total + 1);
    expect(state().entityLinks.map((row) => row.id)).toEqual(["keep"]);
    const sizes = deleteMany.mock.calls.map(([args]) => ((args.where as { id: { in: string[] } }).id.in).length);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LINK_WRITE_CHUNK);
    expect(await deleteLinksForEntity(tx(), "RESEARCH_STUDY", ["study-a"])).toBe(0);
  });

  it("deleteLinksForEntity matches on the entity TYPE too, so a shared id of another type is untouched", async () => {
    seedLink({ id: "as-experiment", fromId: "shared", toId: "study-a" });
    expect(await deleteLinksForEntity(tx(), "RESEARCH_STUDY", ["shared"])).toBe(0);
    expect(await deleteLinksForEntity(tx(), "EXPERIMENT", ["shared"])).toBe(1);
  });

  it("deleteWorkspaceLinks removes only that workspace's rows", async () => {
    seedLink({ id: "a1" });
    seedLink({ id: "a2", fromId: "exp-a2" });
    seedLink({ id: "b1", workspaceId: WS_B.id, fromId: "exp-b", toId: "study-b" });
    expect(await deleteWorkspaceLinks(tx(), WS_A.id)).toBe(2);
    expect(state().entityLinks.map((row) => row.id)).toEqual(["b1"]);
  });
});
