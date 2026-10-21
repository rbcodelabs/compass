/**
 * Phase 6: ArtifactLink (Artifact -> Solution, Artifact -> Decision). artifact_links stays the source of truth; lib/artifacts.ts writes it and
 * mirrors every link and unlink into entity_links in the same transaction while COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR is on. Removal never depends on
 * the flag, and reads and the generic tools ignore both types. A Decision link is live supporting material (ADR-0010) and TRACKED_DECISION-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { linkArtifactToDecision, linkArtifactToSolution, unlinkArtifactFromDecision, unlinkArtifactFromSolution } from "@/lib/artifacts";
import { deleteLinksForEntity, linkEntities, listLinks } from "@/lib/links/service";
import { getLinkType, isArtifactLinkMirrorEnabled, isLinkTypeEnabled, linkTypesForEntity } from "@/lib/links/registry";
import type { AppTransactionClient } from "@/lib/db";

const SOLUTION = "ARTIFACT_ATTACHED_TO_SOLUTION";
const DECISION = "ARTIFACT_SUPPORTS_DECISION";
const state = () => fake.current!.state;
const mirrored = (type?: string) => state().entityLinks.filter((row) => (type ? row.linkType === type : row.linkType === SOLUTION || row.linkType === DECISION));
const solutionInput = (artifactId = "art-a", solutionId = "sol-a") => ({ artifactId, solutionId, workspaceId: WS_A.id, createdById: "user-alice", source: "MCP" as const });
const decisionInput = (artifactId = "art-a", requestId = "rr-a") => ({ artifactId, requestId, workspaceId: WS_A.id, createdById: "user-alice", source: "UI" as const });
const legacyRows = () => state().artifactLinks;

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});
afterEach(() => vi.unstubAllEnvs());

describe("flag", () => {
  it("is on outside production unless set to 0, and off in production unless set to 1", () => {
    expect(isArtifactLinkMirrorEnabled()).toBe(true);
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    expect(isArtifactLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "");
    expect(isArtifactLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "true");
    expect(isArtifactLinkMirrorEnabled()).toBe(false);
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "1");
    expect(isArtifactLinkMirrorEnabled()).toBe(true);
  });
});

describe("Artifact -> Solution", () => {
  it("writes the legacy row first and a mirror row with the same workspace, actor and source", async () => {
    expect(await linkArtifactToSolution(solutionInput())).toMatchObject({ created: true, linkedType: "SOLUTION", linkedId: "sol-a" });
    expect(legacyRows()).toHaveLength(1);
    expect(mirrored()).toHaveLength(1);
    expect(mirrored()[0]).toMatchObject({ linkType: SOLUTION, workspaceId: WS_A.id, fromType: "ARTIFACT", fromId: "art-a", toType: "SOLUTION", toId: "sol-a", origin: "DIRECT", source: "MCP", createdById: "user-alice" });
    expect(state().writes.findIndex((w) => w.startsWith("artifactLink.create"))).toBeLessThan(state().writes.findIndex((w) => w.startsWith("entityLink.create")));
  });

  it("is idempotent: a repeat reports created:false and writes nothing new", async () => {
    await linkArtifactToSolution(solutionInput());
    const writes = state().writes.length;
    expect(await linkArtifactToSolution(solutionInput())).toMatchObject({ created: false });
    expect(state().writes.length).toBe(writes);
    expect(legacyRows()).toHaveLength(1);
    expect(mirrored()).toHaveLength(1);
  });

  it("a replay of a legacy link that was never mirrored (flag was off) heals the mirror", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    await linkArtifactToSolution(solutionInput());
    expect(mirrored()).toHaveLength(0);
    vi.unstubAllEnvs();
    expect(await linkArtifactToSolution(solutionInput())).toMatchObject({ created: false });
    expect(mirrored()).toHaveLength(1);
  });

  it("flag off: only the legacy row is written", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    expect((await linkArtifactToSolution(solutionInput())).created).toBe(true);
    expect(legacyRows()).toHaveLength(1);
    expect(mirrored()).toHaveLength(0);
  });

  it("refuses a Solution or Artifact from another workspace and writes neither row", async () => {
    await expect(linkArtifactToSolution(solutionInput("art-a", "sol-b"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    await expect(linkArtifactToSolution(solutionInput("art-b", "sol-a"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    await expect(linkArtifactToSolution(solutionInput("art-a", "sol-null"))).rejects.toThrow("Artifact and Solution must exist in the same workspace");
    expect(legacyRows()).toHaveLength(0);
    expect(mirrored()).toHaveLength(0);
  });

  it("an archived Artifact can still be attached to a Solution, exactly as in the legacy writer", async () => {
    expect((await linkArtifactToSolution(solutionInput("art-a-archived"))).created).toBe(true);
    expect(mirrored()).toHaveLength(1);
  });

  it("unlink removes the legacy and the mirror row; an unknown pair is removed:false", async () => {
    await linkArtifactToSolution(solutionInput());
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: true });
    expect(legacyRows()).toHaveLength(0);
    expect(mirrored()).toHaveLength(0);
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: false });
  });

  it("unlink removes the mirror row whatever the flag says, and a stale mirror row whose legacy row is gone", async () => {
    await linkArtifactToSolution(solutionInput());
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: true });
    expect(mirrored()).toHaveLength(0);
    // A stale mirror row (the legacy row went while the flag was off) is also swept by the next unlink.
    vi.unstubAllEnvs();
    await linkArtifactToSolution(solutionInput());
    legacyRows().splice(0, 1);
    expect(await unlinkArtifactFromSolution(solutionInput())).toEqual({ removed: false });
    expect(mirrored()).toHaveLength(0);
  });

  it("an unlink in another workspace removes nothing", async () => {
    await linkArtifactToSolution(solutionInput());
    await expect(unlinkArtifactFromSolution({ ...solutionInput("art-b") })).rejects.toThrow("Artifact not found");
    expect(legacyRows()).toHaveLength(1);
    expect(mirrored()).toHaveLength(1);
  });
});

describe("Artifact -> Decision (TRACKED_DECISION only, live supporting material)", () => {
  it("mirrors a link to the request itself (never a revision) with source and actor", async () => {
    expect(await linkArtifactToDecision(decisionInput())).toMatchObject({ created: true, linkedType: "REVIEW_REQUEST", linkedId: "rr-a" });
    expect(mirrored(DECISION)).toHaveLength(1);
    expect(mirrored(DECISION)[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "ARTIFACT", fromId: "art-a", toType: "REVIEW_REQUEST", toId: "rr-a", origin: "DIRECT", source: "UI", createdById: "user-alice" });
    expect(JSON.stringify(mirrored(DECISION))).not.toContain("rev-a");
  });

  it("refuses a non-TRACKED_DECISION request, a foreign request and a foreign Artifact; no row is written", async () => {
    await expect(linkArtifactToDecision(decisionInput("art-a", "rr-a-system"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    await expect(linkArtifactToDecision(decisionInput("art-a", "rr-b"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    await expect(linkArtifactToDecision(decisionInput("art-b", "rr-a"))).rejects.toThrow("Artifact and Decision must exist in the same workspace");
    expect(legacyRows()).toHaveLength(0);
    expect(mirrored()).toHaveLength(0);
  });

  it("the registry itself refuses a non-TRACKED_DECISION request even from the mirror hook", async () => {
    const tx = fake.current!.client as unknown as AppTransactionClient;
    await expect(
      linkEntities(tx, { linkType: DECISION, fromId: "art-a", toId: "rr-a-system", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" }, viaLegacyWriter: true }),
    ).rejects.toThrow("Review request not found in this workspace.");
    expect(mirrored()).toHaveLength(0);
  });

  it("an archived Artifact takes no NEW link, but an existing link replays and heals its mirror", async () => {
    await expect(linkArtifactToDecision(decisionInput("art-a-archived"))).rejects.toThrow(/archived/i);
    expect(legacyRows()).toHaveLength(0);
    expect(mirrored()).toHaveLength(0);
    legacyRows().push({ id: "artifactLink-seed", workspaceId: WS_A.id, artifactId: "art-a-archived", linkedType: "REVIEW_REQUEST", linkedId: "rr-a", createdById: null, source: "UI", createdAt: new Date(1) });
    expect(await linkArtifactToDecision(decisionInput("art-a-archived"))).toMatchObject({ created: false });
    expect(mirrored(DECISION)).toHaveLength(1);
  });

  it("unlink works for an archived Artifact and removes the mirror row regardless of the flag", async () => {
    await linkArtifactToDecision(decisionInput());
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    expect(await unlinkArtifactFromDecision(decisionInput())).toEqual({ removed: true });
    expect(legacyRows()).toHaveLength(0);
    expect(mirrored()).toHaveLength(0);
    expect(await unlinkArtifactFromDecision(decisionInput())).toEqual({ removed: false });
  });

  it("one Artifact can support a Solution and a Decision at once; the two types do not interfere", async () => {
    await linkArtifactToSolution(solutionInput());
    await linkArtifactToDecision(decisionInput());
    expect(mirrored(SOLUTION)).toHaveLength(1);
    expect(mirrored(DECISION)).toHaveLength(1);
    await unlinkArtifactFromDecision(decisionInput());
    expect(mirrored(SOLUTION)).toHaveLength(1);
    expect(mirrored(DECISION)).toHaveLength(0);
  });
});

describe("the mirror is invisible to reads and the generic tools", () => {
  it("the generic link service refuses both types (only the legacy writer may write them)", async () => {
    const tx = fake.current!.client as unknown as AppTransactionClient;
    await expect(linkEntities(tx, { linkType: SOLUTION, fromId: "art-a", toId: "sol-a", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/link_artifact_to_solution/);
    await expect(linkEntities(tx, { linkType: DECISION, fromId: "art-a", toId: "rr-a", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } })).rejects.toThrow(/link_artifact_to_decision/);
  });

  it("reads and summaries ignore them: no applicable type on Artifact, Solution or Review request, and list_links is empty", async () => {
    await linkArtifactToSolution(solutionInput());
    await linkArtifactToDecision(decisionInput());
    for (const type of ["ARTIFACT", "SOLUTION", "REVIEW_REQUEST"] as const) {
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toEqual(expect.arrayContaining([SOLUTION]));
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toEqual(expect.arrayContaining([DECISION]));
    }
    const tx = fake.current!.client as unknown as AppTransactionClient;
    expect(await listLinks(tx, { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a", limit: 50 })).toEqual({ items: [], nextCursor: null });
    expect(await listLinks(tx, { workspaceId: WS_A.id, entityType: "ARTIFACT", entityId: "art-a", linkType: SOLUTION, limit: 50 })).toEqual({ items: [], nextCursor: null });
  });

  it("registers both types as legacy mirrors of lib/artifacts.ts with the 096 backfill and the existing tools as compat", () => {
    for (const key of [SOLUTION, DECISION]) {
      const def = getLinkType(key)!;
      expect(def.legacy).toEqual({ legacyModule: "lib/artifacts.ts", backfillMigration: "096_entity_links_backfill_artifact", mode: "mirror", readFamily: "ARTIFACT" });
      expect(isLinkTypeEnabled(def)).toBe(true);
      expect(def.cardinality).toEqual({ from: "many", to: "many" });
    }
  });
});

describe("delete sweeps", () => {
  it("deleting an Artifact, a Solution or a Review request removes the mirror rows at that end, whatever the flag says", async () => {
    vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
    const tx = fake.current!.client as unknown as AppTransactionClient;
    for (const [type, id] of [["ARTIFACT", "art-a"], ["SOLUTION", "sol-a"], ["REVIEW_REQUEST", "rr-a"]] as const) {
      vi.unstubAllEnvs();
      await linkArtifactToSolution(solutionInput());
      await linkArtifactToDecision(decisionInput());
      expect(mirrored()).toHaveLength(2);
      vi.stubEnv("COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR", "0");
      await deleteLinksForEntity(tx, type, [id]);
      expect(mirrored().filter((row) => row.fromId === id || row.toId === id)).toHaveLength(0);
      // Only the rows at that endpoint go: an Artifact sweep takes both, a Solution or Review request sweep takes its own type.
      expect(mirrored()).toHaveLength(type === "ARTIFACT" ? 0 : 1);
      legacyRows().splice(0);
      state().entityLinks.splice(0);
    }
  });
});
