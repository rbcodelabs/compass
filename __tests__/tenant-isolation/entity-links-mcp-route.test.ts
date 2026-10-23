/**
 * Behaviour and tenant isolation of link_entities, unlink_entities and the generic mode of list_links, driven through
 * the real `register()` wrapper (gate first, handler second) against the tenant fake Prisma. Pins what the gate matrix
 * cannot: the rows the handlers WRITE carry the `from` row's workspace, a denied call writes nothing, the response keeps
 * the `ID: <uuid>` line, and the legacy list_links contract is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setModules } from "../helpers/modules"
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { runWithMcpActor } from "@/lib/mcp-authz";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));

type ToolResult = { content: Array<{ text: string }>; structuredContent: { ok: boolean; data: Record<string, unknown> } };
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>;
const registeredTools: Record<string, ToolCallback> = {};
const toolMeta: Record<string, { inputSchema: unknown }> = {};
vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown, cb: ToolCallback) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta, cb) { registeredTools[name] = cb; toolMeta[name] = meta as { inputSchema: unknown }; }, registerResource() {} });
    return () => new Response("ok");
  },
}));
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _workspaceId: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));

await import("@/app/api/mcp/route");

const TYPE = "EXPERIMENT_INFORMED_BY_STUDY";
const alice = { userId: USERS.alice, purpose: "USER" as const };
const bob = { userId: USERS.bob, purpose: "USER" as const };
const service = { userId: null, purpose: "SERVICE" as const };
const call = (name: string, args: Record<string, unknown>, actor: { userId: string | null; purpose: "USER" | "SERVICE" } = alice) => {
  const handler = registeredTools[name];
  if (!handler) throw new Error(`Tool "${name}" was not registered`);
  return runWithMcpActor(actor, () => handler(args));
};
const state = () => fake.current!.state;
const link = { workspaceId: WS_A.id, linkType: TYPE, fromId: "exp-a", toId: "study-a" };

beforeEach(() => {
  fake.current = createTenantFakePrisma();
});
afterEach(() => vi.unstubAllEnvs());

describe("link_entities", () => {
  it("creates the link stamped with the experiment's workspace, idempotently, and ends the text with an ID line", async () => {
    const first = await call("link_entities", link);
    expect(first.structuredContent.ok).toBe(true);
    expect(first.structuredContent.data).toMatchObject({ created: true, link: { linkType: TYPE, fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-a", workspaceId: WS_A.id, origin: "DIRECT", source: "MCP" } });
    const id = (first.structuredContent.data.link as { id: string }).id;
    expect(first.content[0].text.split("\n").at(-1)).toBe(`ID: ${id}`);
    expect(first.content[0].text).toMatch(/Linked EXPERIMENT "A experiment" and RESEARCH_STUDY "A interviews"/);

    const again = await call("link_entities", link);
    expect(again.structuredContent.data).toMatchObject({ created: false });
    expect(again.content[0].text).toMatch(/already linked/);
    expect(again.content[0].text.split("\n").at(-1)).toBe(`ID: ${id}`);
    expect(state().entityLinks).toHaveLength(1);
    expect(state().entityLinks[0]).toMatchObject({ workspaceId: WS_A.id, createdById: USERS.alice });
  });

  it.each([
    ["a foreign study", { toId: "study-b" }, /access denied/],
    ["a foreign experiment", { fromId: "exp-b" }, /access denied/],
    ["a study that does not exist", { toId: "study-missing" }, /access denied/],
  ])("denies %s and writes nothing", async (_label, ids, message) => {
    await expect(call("link_entities", { ...link, ...ids })).rejects.toThrow(message);
    expect(state().writes).toEqual([]);
    expect(state().entityLinks).toEqual([]);
  });

  it("a member of BOTH workspaces still cannot join A's experiment to B's study", async () => {
    fake.current!.addMember(WS_B.id, USERS.alice);
    await expect(call("link_entities", { ...link, toId: "study-b" })).rejects.toThrow(/does not belong to workspace/);
    await expect(call("link_entities", { ...link, workspaceId: WS_B.id, toId: "study-b" })).rejects.toThrow(/does not belong to workspace/);
    expect(state().writes).toEqual([]);
  });

  it("denies a non-member and a forged workspaceId", async () => {
    await expect(call("link_entities", link, bob)).rejects.toThrow(/access denied/);
    await expect(call("link_entities", { ...link, workspaceId: WS_B.id }, bob)).rejects.toThrow();
    expect(state().writes).toEqual([]);
  });

  it("even the service key (which skips the gate) cannot cross-link: both ends are re-verified in the transaction", async () => {
    const cross = await call("link_entities", { ...link, toId: "study-b" }, service);
    expect(cross.structuredContent.ok).toBe(false);
    expect(cross.content[0].text).toMatch(/not found in this workspace/);
    const forged = await call("link_entities", { ...link, workspaceId: WS_B.id }, service);
    expect(forged.structuredContent.ok).toBe(false);
    expect(state().entityLinks).toEqual([]);
  });

  it("reports eligibility failures as failed results with a user-safe message and writes nothing", async () => {
    const pm = await call("link_entities", { ...link, toId: "study-a-pm" });
    expect(pm.structuredContent.ok).toBe(false);
    expect(pm.content[0].text).toBe("Research study not found.");
    const archived = await call("link_entities", { ...link, toId: "study-a-archived" });
    expect(archived.content[0].text).toMatch(/Archived research studies cannot be linked/);
    const external = await call("link_entities", { ...link, toId: "study-a-external" });
    expect(external.content[0].text).toMatch(/Only customer interview and usability test/);
    expect(state().entityLinks).toEqual([]);
  });

  it("refuses when the research feature flag is off, and an unknown link type is a failed result (after the gate rejects it)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    setModules({ research_capture: false });
    const off = await call("link_entities", link);
    expect(off.structuredContent.ok).toBe(false);
    expect(off.content[0].text).toMatch(/not enabled/);
    await expect(call("link_entities", { ...link, linkType: "NOPE" })).rejects.toThrow(/Unknown link type/);
    expect(state().entityLinks).toEqual([]);
  });

  it("changes no experiment or study row", async () => {
    const before = JSON.stringify([state().experiments, state().researchStudies]);
    await call("link_entities", link);
    expect(JSON.stringify([state().experiments, state().researchStudies])).toBe(before);
  });
});

describe("unlink_entities", () => {
  it("removes the link and its ID line, then reports removed:0", async () => {
    const created = await call("link_entities", link);
    const id = (created.structuredContent.data.link as { id: string }).id;
    const removed = await call("unlink_entities", link);
    expect(removed.structuredContent.data).toMatchObject({ removed: 1, linkType: TYPE, fromId: "exp-a", toId: "study-a" });
    expect(removed.content[0].text.split("\n").at(-1)).toBe(`ID: ${id}`);
    const none = await call("unlink_entities", link);
    expect(none.structuredContent.data).toMatchObject({ removed: 0 });
    expect(none.content[0].text).toBe("No such link; nothing to remove.");
    expect(state().entityLinks).toEqual([]);
  });

  it("removes a link whose study has since been deleted (the gate and the service verify only the from end)", async () => {
    await call("link_entities", link);
    state().researchStudies.splice(0, state().researchStudies.length);
    expect((await call("unlink_entities", link)).structuredContent.data).toMatchObject({ removed: 1 });
  });

  it("leaves workspace B's link for the same ids untouched, and denies a foreign experiment", async () => {
    state().entityLinks.push({ id: "b-link", workspaceId: WS_B.id, linkType: TYPE, fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-a", createdAt: new Date(5) });
    expect((await call("unlink_entities", link)).structuredContent.data).toMatchObject({ removed: 0 });
    expect(state().entityLinks).toHaveLength(1);
    await expect(call("unlink_entities", { ...link, fromId: "exp-b" })).rejects.toThrow(/access denied/);
  });
});

describe("list_links, generic mode", () => {
  it("lists from either end with the label read from that end", async () => {
    await call("link_entities", link);
    const fromExperiment = await call("list_links", { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", limit: 50 });
    expect(fromExperiment.structuredContent.data).toMatchObject({ count: 1, nextCursor: null, items: [{ kind: "entity_link", side: "from", label: "Informed by", linkType: TYPE }] });
    const fromStudy = await call("list_links", { workspaceId: WS_A.id, entityType: "RESEARCH_STUDY", entityId: "study-a", linkType: TYPE, limit: 50 });
    expect(fromStudy.structuredContent.data).toMatchObject({ count: 1, items: [{ side: "to", label: "Informs", from: { id: "exp-a", title: "A experiment" } }] });
    expect(fromStudy.content[0].text).toMatch(/link ID: /);
  });

  it("denies a foreign entity and a non-member, and says 'No links found.' for none", async () => {
    await expect(call("list_links", { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-b", limit: 50 })).rejects.toThrow(/access denied/);
    await expect(call("list_links", { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", limit: 50 }, bob)).rejects.toThrow(/access denied/);
    const none = await call("list_links", { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a2", limit: 50 });
    expect(none.content[0].text).toBe("No links found.");
  });

  it("never returns a link stamped for A whose other end is in B", async () => {
    state().entityLinks.push({ id: "drift", workspaceId: WS_A.id, linkType: TYPE, fromType: "EXPERIMENT", fromId: "exp-a", toType: "RESEARCH_STUDY", toId: "study-b", createdAt: new Date(5) });
    const result = await call("list_links", { workspaceId: WS_A.id, entityType: "EXPERIMENT", entityId: "exp-a", limit: 50 });
    expect(result.structuredContent.data).toMatchObject({ count: 0, items: [] });
  });

  it("keeps the legacy contract: the four ids still list the typed links, and mixing modes is refused", async () => {
    const legacy = await call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a", limit: 50 });
    expect(legacy.structuredContent.ok).toBe(true);
    expect(legacy.content[0].text).toBe("No links found.");
    const mixed = await call("list_links", { workspaceId: WS_A.id, opportunityId: "opp-a", entityType: "EXPERIMENT", entityId: "exp-a", limit: 50 });
    expect(mixed.structuredContent.ok).toBe(false);
  });

  it("validates its input: exactly one legacy id, or entityType with entityId", () => {
    const schema = toolMeta.list_links.inputSchema as { safeParse: (value: unknown) => { success: boolean } };
    const id = "11111111-1111-4111-8111-111111111111";
    const base = { workspaceId: id };
    expect(schema.safeParse({ ...base, opportunityId: id }).success).toBe(true);
    expect(schema.safeParse({ ...base, entityType: "EXPERIMENT", entityId: id }).success).toBe(true);
    expect(schema.safeParse({ ...base, entityType: "EXPERIMENT", entityId: id, linkType: TYPE }).success).toBe(true);
    expect(schema.safeParse({ ...base }).success).toBe(false);
    expect(schema.safeParse({ ...base, entityType: "EXPERIMENT" }).success).toBe(false);
    expect(schema.safeParse({ ...base, linkType: TYPE }).success).toBe(false);
    expect(schema.safeParse({ ...base, opportunityId: id, entityType: "EXPERIMENT", entityId: id }).success).toBe(false);
    expect(schema.safeParse({ ...base, entityType: "NOPE", entityId: id }).success).toBe(false);
  });
});
