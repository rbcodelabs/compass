/**
 * ARTIFACT_ATTACHED_TO_EXPERIMENT: a NATIVE entity_links type (no legacy table, no mirror, no read flag). lib/artifacts.ts wraps the
 * generic service for the tools; the UI drives the same type through changeEntityLink. Covers link / replay / unlink, tenant refusal, the
 * archived-artifact rule, delete sweeps, the batch reader PR B (the experiments gallery) depends on, summaries and the picker view.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma>, user: "user-alice" as string | null }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({ auth: async () => (fake.user ? { user: { id: fake.user } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

import {
  getArtifactExperimentIds,
  getExperimentArtifactIds,
  getExperimentsArtifactIds,
  linkArtifactToExperiment,
  unlinkArtifactFromExperiment,
} from "@/lib/artifacts";
import { deleteLinksForEntity, linkEntities, listLinks } from "@/lib/links/service";
import { getLinkType, isLinkTypeEnabled, linkTypesForEntity } from "@/lib/links/registry";
import { getLinkedEntitiesView, loadLinkSummaries } from "@/lib/links/read-models";
import { changeEntityLink, readEntityLinks } from "@/app/[orgSlug]/[workspaceSlug]/links/actions";
import type { AppTransactionClient } from "@/lib/db";

const KEY = "ARTIFACT_ATTACHED_TO_EXPERIMENT";
const state = () => fake.current!.state;
const tx = () => fake.current!.client as unknown as AppTransactionClient;
const rows = () => state().entityLinks.filter((row) => row.linkType === KEY);
const input = (artifactId = "art-a", experimentId = "exp-a") => ({ artifactId, experimentId, workspaceId: WS_A.id, createdById: "user-alice", source: "MCP" as const });
let clock = 0;
/** Seeds a link row directly, for states the service refuses to create (archived artifact) or to speed up bulk fixtures. */
const seed = (artifactId: string, experimentId: string, workspaceId: string = WS_A.id) =>
  state().entityLinks.push({ id: `seed-${++clock}`, workspaceId, linkType: KEY, fromType: "ARTIFACT", fromId: artifactId, toType: "EXPERIMENT", toId: experimentId, origin: "DIRECT", source: "UI", createdAt: new Date(1000 + clock), updatedAt: new Date(1000 + clock) });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  fake.user = "user-alice";
  clock = 0;
});

describe("registry entry", () => {
  it("is a native, always-enabled type visible to reads on both endpoints, with a UI and compat tools", () => {
    const def = getLinkType(KEY)!;
    expect(def).toMatchObject({ from: "ARTIFACT", to: "EXPERIMENT", duplicatePolicy: "idempotent", restrictedContexts: "deny", cardinality: { from: "many", to: "many" } });
    expect(def.legacy).toBeUndefined();
    expect(def.internal).toBeUndefined();
    expect(def.lifecycle).toEqual({ onFromDeleted: "delete", onToDeleted: "delete", onArchive: "keep" });
    expect(isLinkTypeEnabled(def)).toBe(true);
    expect(typeof def.candidates).toBe("function");
    expect(linkTypesForEntity("ARTIFACT").map((entry) => entry.def.key)).toContain(KEY);
    expect(linkTypesForEntity("EXPERIMENT").map((entry) => entry.def.key)).toContain(KEY);
  });
});

describe("link and unlink", () => {
  it("writes one entity_links row stamped with the workspace, actor and source, and touches nothing else", async () => {
    const experiment = { ...state().experiments.find((e) => e.id === "exp-a")! };
    const artifact = { ...state().artifacts.find((a) => a.id === "art-a")! };
    const result = await linkArtifactToExperiment(input());
    expect(result).toMatchObject({ created: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "ARTIFACT", fromId: "art-a", toType: "EXPERIMENT", toId: "exp-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" });
    expect(result.id).toBe(rows()[0].id);
    expect(state().artifactLinks).toHaveLength(0); // never the legacy table
    expect(state().experiments.find((e) => e.id === "exp-a")).toEqual(experiment);
    expect(state().artifacts.find((a) => a.id === "art-a")).toEqual(artifact);
  });

  it("is idempotent: a replay reports created:false, returns the same link and writes nothing", async () => {
    const first = await linkArtifactToExperiment(input());
    const writes = state().writes.length;
    const again = await linkArtifactToExperiment(input());
    expect(again).toEqual({ id: first.id, created: false });
    expect(state().writes.length).toBe(writes);
    expect(rows()).toHaveLength(1);
  });

  it("one artifact can attach to many experiments and one experiment can hold many artifacts", async () => {
    await linkArtifactToExperiment(input("art-a", "exp-a"));
    await linkArtifactToExperiment(input("art-a", "exp-a2"));
    await linkArtifactToExperiment(input("art-a2", "exp-a"));
    expect(rows()).toHaveLength(3);
  });

  it("unlink removes the row, is idempotent, and leaves both records", async () => {
    await linkArtifactToExperiment(input());
    expect(await unlinkArtifactFromExperiment(input())).toEqual({ removed: true });
    expect(rows()).toHaveLength(0);
    expect(await unlinkArtifactFromExperiment(input())).toEqual({ removed: false });
    expect(state().artifacts.some((a) => a.id === "art-a")).toBe(true);
    expect(state().experiments.some((e) => e.id === "exp-a")).toBe(true);
  });

  it("the generic link service accepts the type too (it is not legacy-mirrored)", async () => {
    const result = await linkEntities(tx(), { linkType: KEY, fromId: "art-a", toId: "exp-a", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } });
    expect(result.created).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("refuses a foreign artifact or a foreign experiment as not found and writes nothing", async () => {
    await expect(linkArtifactToExperiment(input("art-b", "exp-a"))).rejects.toThrow("Artifact not found in this workspace.");
    await expect(linkArtifactToExperiment(input("art-a", "exp-b"))).rejects.toThrow("Experiment not found in this workspace.");
    await expect(linkArtifactToExperiment({ ...input("art-b", "exp-b"), workspaceId: WS_A.id })).rejects.toThrow(/not found in this workspace/);
    expect(rows()).toHaveLength(0);
  });

  it("an unlink aimed at another workspace's artifact removes nothing", async () => {
    seed("art-b", "exp-b", WS_B.id);
    await expect(unlinkArtifactFromExperiment(input("art-b", "exp-b"))).rejects.toThrow("Artifact not found in this workspace.");
    expect(rows()).toHaveLength(1);
  });

  it("reads never return a link whose far end is in another workspace, or a row stamped with another workspace", async () => {
    seed("art-a", "exp-b"); // drifted: stamped A, far end lives in B
    seed("art-b", "exp-a"); // drifted: far end lives in B
    seed("art-a", "exp-a", WS_B.id); // stamped with the other workspace
    expect(await getArtifactExperimentIds(tx(), WS_A.id, "art-a")).toEqual([]);
    expect(await getExperimentArtifactIds(tx(), WS_A.id, "exp-a")).toEqual([]);
    expect((await getExperimentsArtifactIds(tx(), WS_A.id, ["exp-a", "exp-b"])).size).toBe(0);
  });
});

describe("archived artifact rule", () => {
  it("an archived artifact takes no NEW link", async () => {
    await expect(linkArtifactToExperiment(input("art-a-archived", "exp-a"))).rejects.toThrow(/archived/i);
    expect(rows()).toHaveLength(0);
  });

  it("an existing link of an archived artifact replays as a no-op success and can still be removed", async () => {
    seed("art-a-archived", "exp-a");
    expect(await linkArtifactToExperiment(input("art-a-archived", "exp-a"))).toMatchObject({ created: false });
    expect(rows()).toHaveLength(1);
    expect(await getExperimentArtifactIds(tx(), WS_A.id, "exp-a")).toEqual(["art-a-archived"]);
    expect(await unlinkArtifactFromExperiment(input("art-a-archived", "exp-a"))).toEqual({ removed: true });
    expect(rows()).toHaveLength(0);
  });
});

describe("delete sweeps", () => {
  it("deleting the artifact's links leaves the experiment and the experiment's other artifacts", async () => {
    seed("art-a", "exp-a");
    seed("art-a2", "exp-a");
    expect(await deleteLinksForEntity(tx(), "ARTIFACT", ["art-a"])).toBe(1);
    expect(await getExperimentArtifactIds(tx(), WS_A.id, "exp-a")).toEqual(["art-a2"]);
    expect(state().experiments.some((e) => e.id === "exp-a")).toBe(true);
  });

  it("deleting the experiment's links leaves the artifact and its other experiments", async () => {
    seed("art-a", "exp-a");
    seed("art-a", "exp-a2");
    expect(await deleteLinksForEntity(tx(), "EXPERIMENT", ["exp-a"])).toBe(1);
    expect(await getArtifactExperimentIds(tx(), WS_A.id, "art-a")).toEqual(["exp-a2"]);
    expect(state().artifacts.some((a) => a.id === "art-a")).toBe(true);
  });

  it("deleteArtifact sweeps the artifact's experiment links before the artifact goes", async () => {
    const { deleteArtifact } = await import("@/lib/artifacts");
    seed("art-a", "exp-a");
    seed("art-a2", "exp-a");
    // The shared fake models no revisions or blob-cleanup queue; an empty one is enough because this artifact has no revisions.
    Object.assign(fake.current!.client, {
      artifactRevision: { deleteMany: async () => ({ count: 0 }), findMany: async () => [], findFirst: async () => null },
      artifactBlobCleanup: { upsert: async () => ({}), findMany: async () => [], update: async () => ({}), delete: async () => ({}) },
    });
    const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn().mockResolvedValue(undefined) };
    await deleteArtifact({ artifactId: "art-a", workspaceId: WS_A.id }, storage as never);
    expect(state().artifacts.some((a) => a.id === "art-a")).toBe(false);
    expect(rows().map((row) => row.fromId)).toEqual(["art-a2"]);
    const writes = state().writes;
    expect(writes.findIndex((w) => w.startsWith("entityLink.deleteMany"))).toBeLessThan(writes.findIndex((w) => w.startsWith("artifact.delete")));
  });
});

describe("readers", () => {
  it("return ids in creation order, from either end", async () => {
    seed("art-a2", "exp-a");
    seed("art-a", "exp-a");
    seed("art-a", "exp-a2");
    expect(await getExperimentArtifactIds(tx(), WS_A.id, "exp-a")).toEqual(["art-a2", "art-a"]);
    expect(await getArtifactExperimentIds(tx(), WS_A.id, "art-a")).toEqual(["exp-a", "exp-a2"]);
    expect(await getExperimentArtifactIds(tx(), WS_A.id, "exp-b")).toEqual([]);
  });
});

describe("getExperimentsArtifactIds (the batch PR B depends on)", () => {
  it("returns a map from experiment id to its artifact ids, only for experiments that have artifacts", async () => {
    seed("art-a", "exp-a");
    seed("art-a2", "exp-a");
    seed("art-a", "exp-a2");
    const map = await getExperimentsArtifactIds(tx(), WS_A.id, ["exp-a", "exp-a2", "exp-none"]);
    expect([...map.keys()].sort()).toEqual(["exp-a", "exp-a2"]);
    expect(map.get("exp-a")).toEqual(["art-a", "art-a2"]);
    expect(map.get("exp-a2")).toEqual(["art-a"]);
    expect(map.has("exp-none")).toBe(false);
  });

  it("de-duplicates repeated experiment ids and repeated link rows", async () => {
    seed("art-a", "exp-a");
    seed("art-a", "exp-a"); // a duplicate row must not show twice
    const map = await getExperimentsArtifactIds(tx(), WS_A.id, ["exp-a", "exp-a", "exp-a"]);
    expect(map.get("exp-a")).toEqual(["art-a"]);
  });

  it("is workspace-scoped: another workspace's experiments and links never appear", async () => {
    seed("art-b", "exp-b", WS_B.id);
    seed("art-a", "exp-a");
    const fromA = await getExperimentsArtifactIds(tx(), WS_A.id, ["exp-a", "exp-b"]);
    expect([...fromA.keys()]).toEqual(["exp-a"]);
    const fromB = await getExperimentsArtifactIds(tx(), WS_B.id, ["exp-a", "exp-b"]);
    expect([...fromB.entries()]).toEqual([["exp-b", ["art-b"]]]);
  });

  it("drops a link whose artifact no longer exists instead of returning a dangling id", async () => {
    seed("art-gone", "exp-a");
    seed("art-a", "exp-a");
    expect((await getExperimentsArtifactIds(tx(), WS_A.id, ["exp-a"])).get("exp-a")).toEqual(["art-a"]);
  });

  it("returns an empty map without querying for an empty input", async () => {
    const spy = vi.spyOn(fake.current!.client.entityLink, "findMany");
    expect((await getExperimentsArtifactIds(tx(), WS_A.id, [])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("chunks large id lists at 500 per query and still finds links in every chunk", async () => {
    const ids = Array.from({ length: 1201 }, (_, index) => `exp-bulk-${index}`);
    ids.splice(0, 1, "exp-a");
    ids.splice(700, 1, "exp-a2");
    ids.splice(1200, 1, "exp-bulk-last");
    state().experiments.push({ id: "exp-bulk-last", workspaceId: WS_A.id, title: "Last", status: "DESIGNING", updatedAt: new Date(1), assumptionId: null, createdAt: new Date(1) });
    seed("art-a", "exp-a");
    seed("art-a2", "exp-a2");
    seed("art-a", "exp-bulk-last");
    const spy = vi.spyOn(fake.current!.client.entityLink, "findMany");
    const map = await getExperimentsArtifactIds(tx(), WS_A.id, ids);
    // 1201 unique ids -> 3 link queries (500 + 500 + 201).
    const chunkSizes = spy.mock.calls.map((call) => ((call[0] as { where: { toId: { in: string[] } } }).where.toId.in).length);
    expect(chunkSizes).toEqual([500, 500, 201]);
    expect([...map.keys()].sort()).toEqual(["exp-a", "exp-a2", "exp-bulk-last"]);
  });
});

describe("summaries and the picker view", () => {
  it("an experiment gets linkedArtifacts and an artifact gets linkedExperiments, selecting only id, title and status; archived artifacts stay visible", async () => {
    seed("art-a", "exp-a");
    seed("art-a-archived", "exp-a");
    seed("art-b", "exp-a", WS_B.id);
    const onExperiment = await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a" });
    expect(onExperiment.linkedArtifacts.map((row) => row.id)).toEqual(["art-a-archived", "art-a"]); // by title: "A archived artifact" < "A artifact"
    expect(Object.keys(onExperiment.linkedArtifacts[0]).sort()).toEqual(["id", "status", "title"]);
    const onArtifact = await loadLinkSummaries(tx(), { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a" });
    expect(onArtifact).toEqual({ linkedExperiments: [{ id: "exp-a", title: "A experiment", status: "DESIGNING" }] });
  });

  it("from the artifact: lists linked experiments, offers unlinked ones in the workspace, and an archived artifact cannot take a new link", async () => {
    seed("art-a", "exp-a");
    const view = await getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a", linkType: KEY });
    expect(view).toMatchObject({ side: "from", label: "Attached to", otherType: "EXPERIMENT", canLink: true });
    expect(view!.linked.map((i) => i.id)).toEqual(["exp-a"]);
    expect(view!.candidates.map((i) => i.id)).toEqual(["exp-a2"]);
    seed("art-a-archived", "exp-a");
    const archived = await getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a-archived", linkType: KEY });
    expect(archived).toMatchObject({ canLink: false, candidates: [] });
    expect(archived!.linked.map((i) => i.id)).toEqual(["exp-a"]);
  });

  it("from the experiment: offers only ACTIVE, unlinked artifacts of the workspace", async () => {
    seed("art-a", "exp-a");
    const view = await getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", linkType: KEY });
    expect(view).toMatchObject({ side: "to", label: "Artifacts", otherType: "ARTIFACT", otherNoun: "artifact", canLink: true });
    expect(view!.candidates.map((i) => i.id)).toEqual(["art-a2"]);
  });

  it("is invisible for an entity in another workspace", async () => {
    expect(await getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-b", linkType: KEY })).toBeNull();
    expect(await getLinkedEntitiesView(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-b", linkType: KEY })).toBeNull();
  });

  it("list_links sees the type from either end", async () => {
    seed("art-a", "exp-a");
    const fromArtifact = await listLinks(tx(), { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a", linkType: KEY, limit: 50 });
    const fromExperiment = await listLinks(tx(), { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", linkType: KEY, limit: 50 });
    expect(fromArtifact.items).toHaveLength(1);
    expect(fromExperiment.items).toHaveLength(1);
  });
});

describe("UI actions (changeEntityLink, the section's only writer)", () => {
  const A = "00000000-0000-4000-8000-00000000a0a1";
  const E = "00000000-0000-4000-8000-00000000e0e1";
  beforeEach(() => {
    state().artifacts.push({ id: A, workspaceId: WS_A.id, title: "UI artifact", status: "ACTIVE", updatedAt: new Date(1) });
    state().experiments.push({ id: E, workspaceId: WS_A.id, title: "UI experiment", status: "RUNNING", updatedAt: new Date(1), assumptionId: null, createdAt: new Date(1) });
  });

  it("links and unlinks from the artifact side and the experiment side with the same orientation", async () => {
    const fromArtifact = { linkType: KEY, entityType: "ARTIFACT", entityId: A, otherId: E };
    expect(await changeEntityLink("acme", "alpha", { ...fromArtifact, operation: "link" })).toEqual({ ok: true, changed: true });
    expect(await changeEntityLink("acme", "alpha", { ...fromArtifact, operation: "link" })).toEqual({ ok: true, changed: false });
    expect(rows()[0]).toMatchObject({ fromId: A, toId: E, source: "UI", createdById: "user-alice" });
    const read = await readEntityLinks("acme", "alpha", { linkType: KEY, entityType: "EXPERIMENT", entityId: E });
    expect(read.ok && read.view?.linked.map((i) => i.id)).toEqual([A]);
    const fromExperiment = { linkType: KEY, entityType: "EXPERIMENT", entityId: E, otherId: A };
    expect(await changeEntityLink("acme", "alpha", { ...fromExperiment, operation: "unlink" })).toEqual({ ok: true, changed: true });
    expect(await changeEntityLink("acme", "alpha", { ...fromExperiment, operation: "link" })).toEqual({ ok: true, changed: true });
    expect(rows()).toHaveLength(1);
  });

  it("refuses an archived artifact with a user-safe message, and a non-member without writing", async () => {
    const archived = await changeEntityLink("acme", "alpha", { linkType: KEY, entityType: "ARTIFACT", entityId: "00000000-0000-4000-8000-00000000a0a2", otherId: E, operation: "link" });
    expect(archived.ok).toBe(false);
    state().artifacts.push({ id: "00000000-0000-4000-8000-00000000a0a3", workspaceId: WS_A.id, title: "Old", status: "ARCHIVED", updatedAt: new Date(1) });
    const refused = await changeEntityLink("acme", "alpha", { linkType: KEY, entityType: "ARTIFACT", entityId: "00000000-0000-4000-8000-00000000a0a3", otherId: E, operation: "link" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Archived/) });
    fake.user = "user-eve";
    expect((await changeEntityLink("acme", "alpha", { linkType: KEY, entityType: "ARTIFACT", entityId: A, otherId: E, operation: "link" })).ok).toBe(false);
    expect(rows()).toHaveLength(0);
  });
});
