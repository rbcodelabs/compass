/**
 * The registry contract (ADR section 4): iterates EVERY registered link type, so a new entry that is missing a label,
 * an authorize rule, a resolvable endpoint, a tenant-isolation guarantee, a delete path, a gate, restricted-context
 * denial or a parity entry fails here instead of in production. The "only lib/links/ names the model" check lives in
 * entity-links-guard.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ tools: {} as Record<string, unknown> }));
const resolved = vi.hoisted(() => ({ calls: [] as { type: string; workspaceId: string; id: string }[] }));

vi.mock("@/lib/db", () => ({ default: () => ({}) }));
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: "u1" }) }));
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: unknown) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool: (name, meta) => { registered.tools[name] = meta }, registerResource: () => {} });
    return vi.fn();
  },
}));
// Endpoints exist only in workspace "ws-A" under ids "<type>-A"; anything else is missing, exactly as a workspace-filtered read behaves.
vi.mock("@/lib/links/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/endpoints")>();
  return {
    ...actual,
    resolveEndpoints: async (_tx: unknown, type: string, workspaceId: string, ids: string[]) => {
      const out = new Map();
      for (const id of ids) {
        resolved.calls.push({ type, workspaceId, id });
        if (workspaceId === "ws-A" && id === `${type}-A`) out.set(id, { type, id, workspaceId, title: id });
      }
      return out;
    },
  };
});

await import("@/app/api/mcp/route");

import { ENTITY_TYPE_VOCABULARY, normalizeEntityType, toWorkspaceEntityType, type LinkableEntityType } from "@/lib/entity-types";
import { LINK_TYPES, LINK_TYPE_KEYS, getLinkType, toTypesOf, validateLinkTypeDef, type LinkTypeDef } from "@/lib/links/registry";
import { linkEntities } from "@/lib/links/service";
import { AGENT_TOOL_POLICY, RESEARCH_TOOL_ALLOWLIST, TOOL_GATES, TOOL_SCOPES } from "@/lib/mcp-tool-gates";
import { MCP_REST_PARITY_MANIFEST } from "@/lib/rest/parity-manifest";
import { REST_ROUTES } from "@/lib/rest/registry";
import { assertInterviewToolInput } from "@/lib/pm-agent-processing";
import { assertResearchSynthesisToolInput, RESEARCH_SYNTHESIS_TOOLS } from "@/lib/research-handoff-scope";
import type { AppTransactionClient } from "@/lib/db";

const defs: LinkTypeDef[] = Object.values(LINK_TYPES);
const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf-8");
const GENERIC_TOOLS = ["link_entities", "unlink_entities", "list_links"] as const;

describe("registry shape", () => {
  it("registers at least one type and keys are unique, append-only UPPER_SNAKE names", () => {
    expect(defs.length).toBeGreaterThan(0);
    expect(new Set(LINK_TYPE_KEYS).size).toBe(LINK_TYPE_KEYS.length);
    expect(LINK_TYPE_KEYS).toContain("EXPERIMENT_INFORMED_BY_STUDY");
  });

  it.each(defs.map((def) => [def.key, def] as const))("%s: passes the structural checks", (_key, def) => {
    expect(validateLinkTypeDef(def)).toEqual([]);
    expect(getLinkType(def.key)).toBe(def);
    expect(def.restrictedContexts).toBe("deny");
  });

  it("validateLinkTypeDef catches a bad entry (canary)", () => {
    const bad = { ...defs[0], key: "lowercase", labels: { forward: "", inverse: "x" }, restrictedContexts: "allow" as const };
    expect(validateLinkTypeDef(bad).length).toBe(3);
  });

  it.each(defs.map((def) => [def.key, def] as const))("%s: has an authorize rule per operation (write the from end, unlink checks only from)", (_key, def) => {
    expect(def.authorize("link")).toEqual({ from: "write", to: "read" });
    expect(def.authorize("unlink")).toEqual({ from: "write", to: "none" });
    expect(def.authorize("list")).toEqual({ from: "read", to: "read" });
  });

  it.each(defs.map((def) => [def.key, def] as const))("%s: summaries use distinct field names per endpoint type", (_key, def) => {
    const fields = [def.summaries.onFrom?.field, def.summaries.onTo?.field].filter(Boolean);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("endpoints are resolvable and tenant-scoped", () => {
  it.each(ENTITY_TYPE_VOCABULARY.map((type) => [type] as const))("%s: resolveEndpoints reads through exactly one delegate and filters by the workspace", async (type) => {
    // The real resolver (not the mocked one above), against a recording transaction.
    const real = await vi.importActual<typeof import("@/lib/links/endpoints")>("@/lib/links/endpoints");
    const wheres: unknown[] = [];
    const delegate = { findMany: vi.fn(async (args: { where: unknown }) => { wheres.push(args.where); return [] }) };
    const tx = new Proxy({}, { get: () => delegate }) as unknown as AppTransactionClient;
    await real.resolveEndpoints(tx, type, "ws-needle", ["id-1"]);
    expect(wheres.length).toBeGreaterThan(0);
    expect(JSON.stringify(wheres[0])).toContain("ws-needle");
  });

  it.each(defs.flatMap((def) => [def.from, ...toTypesOf(def)].map((type) => [def.key, type] as const)))("%s: endpoint type %s has an access-control mapping for the MCP gate", (_key, type) => {
    expect(toWorkspaceEntityType(type)).not.toBeNull();
  });

  it.each(defs.flatMap((def) => (["from", "to"] as const).filter((side) => def.cardinality[side] === "one").map((side) => [def.key, side === "from" ? [def.from] : toTypesOf(def)] as const)))(
    "%s: a to-one side is on entity types whose row can be touched",
    async (_key, types) => {
      const real = await vi.importActual<typeof import("@/lib/links/endpoints")>("@/lib/links/endpoints");
      const delegate = { updateMany: vi.fn(async () => ({ count: 1 })) };
      const tx = new Proxy({}, { get: () => delegate }) as unknown as AppTransactionClient;
      for (const type of types) expect(await real.touchEndpoint(tx, type as LinkableEntityType, "ws", "id")).toBe(true);
    },
  );

  it("touchEndpoint reports false for the types without an updatedAt column", async () => {
    const real = await vi.importActual<typeof import("@/lib/links/endpoints")>("@/lib/links/endpoints");
    for (const type of ["REVIEW_REQUEST", "METRIC", "RESEARCH_TURN"] as const) expect(await real.touchEndpoint({} as AppTransactionClient, type, "ws", "id")).toBe(false);
  });
});

describe("tenant isolation for every from/to pair", () => {
  const pairs = defs.flatMap((def) => toTypesOf(def).map((to) => ({ key: def.key, from: def.from, to })));
  const ctx = { source: "MCP" as const };

  it.each(pairs.map((pair) => [`${pair.key}: ${pair.from} -> ${pair.to}`, pair] as const))("%s: only same-workspace endpoints link", async (_label, pair) => {
    const create = vi.fn();
    const guarded = { entityLink: { findFirst: vi.fn(), create, count: vi.fn() } } as unknown as AppTransactionClient;
    const base = { linkType: pair.key, toType: pair.to, ctx };
    // from in A, to in A, but the caller declares workspace B
    await expect(linkEntities(guarded, { ...base, fromId: `${pair.from}-A`, toId: `${pair.to}-A`, expectedWorkspaceId: "ws-B" })).rejects.toThrow(/not found/);
    // declared workspace A, but the to end is not A's
    await expect(linkEntities(guarded, { ...base, fromId: `${pair.from}-A`, toId: `${pair.to}-B`, expectedWorkspaceId: "ws-A" })).rejects.toThrow(/not found/);
    // declared workspace A, but the from end is not A's
    await expect(linkEntities(guarded, { ...base, fromId: `${pair.from}-B`, toId: `${pair.to}-A`, expectedWorkspaceId: "ws-A" })).rejects.toThrow(/not found/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("delete paths and the workspace cascade cover every type", () => {
  const sources = {
    cascade: read("lib/delete-workspace-cascade.ts"),
    research: read("lib/research-workspace-cleanup.ts"),
  };
  const all = Object.values(sources).join("\n");

  it("the workspace cascade removes every link stamped with the workspace, first", () => {
    expect(sources.cascade).toMatch(/deleteWorkspaceLinks as deleteWorkspaceEntityLinks/);
    expect(sources.cascade.indexOf("deleteWorkspaceEntityLinks(prisma, workspaceId)")).toBeGreaterThan(-1);
    expect(sources.cascade.indexOf("deleteWorkspaceEntityLinks(prisma, workspaceId)")).toBeLessThan(sources.cascade.indexOf("deleteWorkspaceResearchData(prisma, workspaceId)"));
  });

  it.each(defs.flatMap((def) => [
    ...(def.lifecycle.onFromDeleted === "delete" ? [[def.key, def.from] as const] : []),
    ...(def.lifecycle.onToDeleted === "delete" ? toTypesOf(def).map((type) => [def.key, type] as const) : []),
  ]))("%s: deleting a %s removes its links (deleteLinksForEntity is called in a delete path)", (_key, type) => {
    expect(all).toContain(`deleteLinksForEntity(prisma, "${type}"`);
  });

  it("studies' links go before the studies themselves", () => {
    expect(sources.research.indexOf('deleteLinksForEntity(prisma, "RESEARCH_STUDY"')).toBeLessThan(sources.research.indexOf("researchStudy.deleteMany"));
  });

  it("experiments' links go before the experiments themselves", () => {
    expect(sources.cascade.indexOf('deleteLinksForEntity(prisma, "EXPERIMENT"')).toBeLessThan(sources.cascade.indexOf("experiment.deleteMany"));
  });
});

describe("tools: gates, scopes, parity and restricted contexts", () => {
  it.each(GENERIC_TOOLS.map((tool) => [tool] as const))("%s is registered, gated, scoped, agent-classified and has a REST parity entry", (tool) => {
    expect(tool in registered.tools).toBe(true);
    expect(tool in TOOL_GATES).toBe(true);
    expect(TOOL_SCOPES[tool]).toBe(tool === "list_links" ? "mcp:read" : "mcp:write");
    expect(AGENT_TOOL_POLICY[tool]).toBe(tool === "list_links" ? "READ" : "WRITE");
    const parity = MCP_REST_PARITY_MANIFEST[tool as keyof typeof MCP_REST_PARITY_MANIFEST];
    expect(parity.kind).toBe("direct");
    const operationId = (parity as { operationId: string }).operationId;
    expect(REST_ROUTES.some((route) => route.operationId === operationId)).toBe(true);
  });

  it("every compat tool and REST operation named by a type exists", () => {
    for (const def of defs) {
      for (const tool of def.compat?.mcpTools ?? []) expect(tool in registered.tools, `${def.key}: ${tool}`).toBe(true);
      for (const op of def.compat?.restOps ?? []) expect(REST_ROUTES.some((route) => route.operationId === op), `${def.key}: ${op}`).toBe(true);
    }
  });

  it.each(["link_entities", "unlink_entities"])("%s is denied to participant (research), PM-interview and research-synthesis contexts", (tool) => {
    expect(RESEARCH_TOOL_ALLOWLIST.has(tool)).toBe(false);
    expect(RESEARCH_SYNTHESIS_TOOLS.has(tool)).toBe(false);
    expect(() => assertResearchSynthesisToolInput({ status: "RUNNING", kind: "RESEARCH_SYNTHESIS", studyId: "s" }, tool, { studyId: "s" })).toThrow(/outside this research synthesis/);
    expect(() => assertInterviewToolInput("EXPERIMENT", "e", tool, { workspaceId: "w", fromId: "e" })).toThrow(/outside this interview/);
  });

  it("the REST list route accepts the generic parameters and still the legacy ones", () => {
    const route = REST_ROUTES.find((r) => r.operationId === "listEntityLinks")!;
    const id = "11111111-1111-4111-8111-111111111111";
    expect(route.querySchema!.safeParse({ opportunityId: id }).success).toBe(true);
    expect(route.querySchema!.safeParse({ entityType: "EXPERIMENT", entityId: id, linkType: "EXPERIMENT_INFORMED_BY_STUDY" }).success).toBe(true);
    expect(route.querySchema!.safeParse({ entityType: "EXPERIMENT" }).success).toBe(false);
    expect(route.querySchema!.safeParse({ opportunityId: id, entityType: "EXPERIMENT", entityId: id }).success).toBe(false);
    expect(route.querySchema!.safeParse({}).success).toBe(false);
  });

  it("normalizeEntityType is what the gate uses for list_links entityType", () => {
    expect(normalizeEntityType("EXPERIMENT")).toBe("EXPERIMENT");
  });
});
