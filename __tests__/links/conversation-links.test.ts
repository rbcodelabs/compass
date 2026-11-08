/**
 * RM-19: the CONVERSATION_CREATED / CONVERSATION_MENTIONS link types and lib/links/conversation-links.ts, against the where-honouring
 * tenant fake: registry shape, the tool -> target table, idempotent / non-downgrading writes, tenant isolation, the never-throws dispatcher
 * hook, and access filtering on both reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const actor = vi.hoisted(() => ({ purpose: "AGENT_TURN" as string }));
const turn = vi.hoisted(() => ({ current: vi.fn() }));
const access = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, _w: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
  withAtomicRetry: async (prisma: unknown, callback: (tx: unknown) => unknown) => callback(prisma),
  withUpdatesTables: async (prisma: unknown, callback: (tx: unknown, tablesExist: boolean) => unknown) => callback(prisma, false),
}));
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => actor }));
vi.mock("@/lib/agent-turn-conversation", () => ({ currentAgentConversation: (...args: unknown[]) => turn.current(...args) }));
vi.mock("@/lib/agent-conversation-access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent-conversation-access")>();
  return { ...real, resolveConversationAccess: (...args: unknown[]) => access.resolve(...args) };
});

import { accessibleConversationsWhere } from "@/lib/agent-conversation-access";
import {
  deriveConversationTargets,
  linkAgentToolCall,
  listConversationsForObject,
  listObjectsForConversation,
  recordConversationLink,
  removeConversationLink,
} from "@/lib/links/conversation-links";
import { CONVERSATION_CREATED_LINK_TYPE, CONVERSATION_MENTIONS_LINK_TYPE, LINK_TYPES, linkTypesForEntity, validateLinkTypeDef } from "@/lib/links/registry";
import { linkEntities, listLinks } from "@/lib/links/service";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";

const prisma = () => fake.current!.client as unknown as AppPrismaClient;
const state = () => fake.current!.state;
const rows = (linkType?: string) => state().entityLinks.filter((l) => !linkType || l.linkType === linkType);
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const okResult = (data: unknown) => ({ structuredContent: { ok: true, data } });

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  actor.purpose = "AGENT_TURN";
  turn.current.mockReset().mockResolvedValue({ conversationId: "conv-a", workspaceId: WS_A.id });
  access.resolve.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("registry", () => {
  it.each([CONVERSATION_CREATED_LINK_TYPE, CONVERSATION_MENTIONS_LINK_TYPE])("%s: valid, internal, conversation -> opportunity | solution | task", (key) => {
    const def = LINK_TYPES[key];
    expect(validateLinkTypeDef(def)).toEqual([]);
    expect(def.internal).toBe(true);
    expect(def.from).toBe("AGENT_CONVERSATION");
    expect(def.to).toEqual(["OPPORTUNITY", "SOLUTION", "TASK"]);
    expect(def.duplicatePolicy).toBe("idempotent");
    expect(def.origins).toEqual(["DIRECT", "MIGRATION"]);
    expect(key.length).toBeLessThanOrEqual(60);
  });

  it("internal types are invisible to the generic reads and refused by the generic writers", async () => {
    for (const type of ["OPPORTUNITY", "SOLUTION", "TASK", "AGENT_CONVERSATION"] as const) {
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(CONVERSATION_CREATED_LINK_TYPE);
      expect(linkTypesForEntity(type).map((entry) => entry.def.key)).not.toContain(CONVERSATION_MENTIONS_LINK_TYPE);
    }
    const tx = prisma() as unknown as AppTransactionClient;
    await expect(
      linkEntities(tx, { linkType: CONVERSATION_CREATED_LINK_TYPE, fromId: "conv-a", toId: "task-a", toType: "TASK", expectedWorkspaceId: WS_A.id, ctx: { source: "MCP" } }),
    ).rejects.toThrow(/managed by its owning feature/);
    await expect(listLinks(tx, { workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", linkType: CONVERSATION_CREATED_LINK_TYPE, limit: 10 })).rejects.toThrow();
    expect(rows()).toHaveLength(0);
  });
});

describe("deriveConversationTargets (the one tool -> object table)", () => {
  const OPP = UUID(1);
  const SOL = UUID(2);
  const TASK = UUID(3);
  it("creates -> CREATED", () => {
    expect(deriveConversationTargets("create_opportunity", {}, okResult({ id: OPP }))).toEqual([{ entityType: "OPPORTUNITY", entityId: OPP, kind: "CREATED" }]);
    expect(deriveConversationTargets("create_task", {}, okResult({ id: TASK }))).toEqual([{ entityType: "TASK", entityId: TASK, kind: "CREATED" }]);
    expect(deriveConversationTargets("TaskCreate", {}, okResult({ id: TASK }))).toEqual([{ entityType: "TASK", entityId: TASK, kind: "CREATED" }]);
    expect(deriveConversationTargets("add_solution", { opportunityId: OPP }, okResult({ id: SOL }))).toEqual([
      { entityType: "SOLUTION", entityId: SOL, kind: "CREATED" },
      { entityType: "OPPORTUNITY", entityId: OPP, kind: "MENTIONS" },
    ]);
  });
  it("bulk creates: created ids are CREATED, deduped ones only MENTIONS, failed ones nothing", () => {
    const results = [{ ok: true, id: SOL }, { ok: true, id: OPP, deduped: true }, { ok: false, error: "x" }];
    expect(deriveConversationTargets("create_solutions", {}, okResult({ results }))).toEqual([
      { entityType: "SOLUTION", entityId: SOL, kind: "CREATED" },
      { entityType: "SOLUTION", entityId: OPP, kind: "MENTIONS" },
    ]);
  });
  it("reads and updates -> MENTIONS", () => {
    expect(deriveConversationTargets("get_opportunity", { opportunityId: OPP }, okResult({}))).toEqual([{ entityType: "OPPORTUNITY", entityId: OPP, kind: "MENTIONS" }]);
    expect(deriveConversationTargets("update_solution_status", { solutionId: SOL }, okResult({}))).toEqual([{ entityType: "SOLUTION", entityId: SOL, kind: "MENTIONS" }]);
    expect(deriveConversationTargets("move_task_status", { taskId: TASK }, okResult({}))).toEqual([{ entityType: "TASK", entityId: TASK, kind: "MENTIONS" }]);
  });
  it("ignores failed calls, unrelated tools and non-UUID ids", () => {
    expect(deriveConversationTargets("get_opportunity", { opportunityId: OPP }, { structuredContent: { ok: false, data: null } })).toEqual([]);
    expect(deriveConversationTargets("list_opportunities", { opportunityId: OPP }, okResult({}))).toEqual([]);
    expect(deriveConversationTargets("get_task", { taskId: "TASK-5" }, okResult({}))).toEqual([]);
    expect(deriveConversationTargets("create_task", {}, undefined)).toEqual([]);
  });
});

describe("recordConversationLink", () => {
  const input = { conversationId: "conv-a", workspaceId: WS_A.id, entityType: "TASK" as const, entityId: "task-a" };

  it("writes an automatic link (source AGENT, origin DIRECT, workspace of the from row) and is idempotent", async () => {
    expect(await recordConversationLink(prisma(), { ...input, kind: "CREATED" })).toBe("created");
    expect(rows(CONVERSATION_CREATED_LINK_TYPE)).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ workspaceId: WS_A.id, fromType: "AGENT_CONVERSATION", fromId: "conv-a", toType: "TASK", toId: "task-a", origin: "DIRECT", source: "AGENT", createdById: null });
    expect(await recordConversationLink(prisma(), { ...input, kind: "CREATED" })).toBe("unchanged");
    expect(rows()).toHaveLength(1);
  });

  it("never downgrades CREATED to MENTIONS", async () => {
    await recordConversationLink(prisma(), { ...input, kind: "CREATED" });
    expect(await recordConversationLink(prisma(), { ...input, kind: "MENTIONS" })).toBe("unchanged");
    expect(rows().map((l) => l.linkType)).toEqual([CONVERSATION_CREATED_LINK_TYPE]);
  });

  it("a later create replaces an earlier MENTIONS link for the same pair", async () => {
    await recordConversationLink(prisma(), { ...input, kind: "MENTIONS" });
    expect(rows().map((l) => l.linkType)).toEqual([CONVERSATION_MENTIONS_LINK_TYPE]);
    await recordConversationLink(prisma(), { ...input, kind: "CREATED" });
    expect(rows().map((l) => l.linkType)).toEqual([CONVERSATION_CREATED_LINK_TYPE]);
  });

  it.each([["OPPORTUNITY", "opp-a"], ["SOLUTION", "sol-a"], ["TASK", "task-a"]] as const)("links a conversation to a %s", async (entityType, entityId) => {
    expect(await recordConversationLink(prisma(), { conversationId: "conv-a", workspaceId: WS_A.id, entityType, entityId, kind: "MENTIONS" })).toBe("created");
  });

  it("is tenant-safe: a conversation and an object from different workspaces never link", async () => {
    await expect(recordConversationLink(prisma(), { ...input, conversationId: "conv-b", kind: "CREATED" })).rejects.toThrow(/not found/);
    await expect(recordConversationLink(prisma(), { ...input, entityId: "task-b", kind: "CREATED" })).rejects.toThrow(/not found/);
    await expect(recordConversationLink(prisma(), { ...input, workspaceId: WS_B.id, kind: "CREATED" })).rejects.toThrow(/not found/);
    expect(rows()).toHaveLength(0);
  });
});

describe("linkAgentToolCall (the dispatcher hook)", () => {
  const TASK_ID = UUID(9);

  it("does nothing for a person or a standalone agent (not an AGENT_TURN actor)", async () => {
    actor.purpose = "USER";
    await linkAgentToolCall("get_task", { taskId: TASK_ID }, okResult({}));
    expect(turn.current).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("does nothing outside a live run, for a failed call and for an untracked tool", async () => {
    turn.current.mockResolvedValue(null);
    await linkAgentToolCall("get_task", { taskId: "task-a" }, okResult({}));
    await linkAgentToolCall("get_task", { taskId: TASK_ID }, { structuredContent: { ok: false } });
    await linkAgentToolCall("list_tasks", { taskId: TASK_ID }, okResult({}));
    expect(rows()).toHaveLength(0);
  });

  it("links the resolved conversation (never a tool argument) to the created object", async () => {
    state().tasks.push({ id: TASK_ID, workspaceId: WS_A.id, title: "New task", parentTaskId: null, status: "TODO" });
    await linkAgentToolCall("create_task", { conversationId: "conv-b" }, okResult({ id: TASK_ID }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ linkType: CONVERSATION_CREATED_LINK_TYPE, fromId: "conv-a", toId: TASK_ID, source: "AGENT" });
  });

  it("never throws or fails the tool: a resolver crash, a missing endpoint and a write error are all swallowed and logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    turn.current.mockRejectedValueOnce(new Error("db down"));
    await expect(linkAgentToolCall("create_task", {}, okResult({ id: TASK_ID }))).resolves.toBeUndefined();
    // endpoint missing in the workspace
    await expect(linkAgentToolCall("create_task", {}, okResult({ id: TASK_ID }))).resolves.toBeUndefined();
    expect(rows()).toHaveLength(0);
    expect(log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("conversation_link.failed")).length).toBe(2);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("db down");
  });
});

describe("reads apply the conversation access rules", () => {
  beforeEach(async () => {
    await recordConversationLink(prisma(), { conversationId: "conv-a", workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", kind: "CREATED" });
    await recordConversationLink(prisma(), { conversationId: "conv-a2", workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", kind: "MENTIONS" });
  });

  it("an object lists only the conversations the viewer may open, built on accessibleConversationsWhere", async () => {
    const findMany = vi.fn(async () => [{ id: "conv-a", title: "A chat", archivedAt: null }]);
    const db = { ...(prisma() as object), agentConversation: { findMany } } as unknown as AppPrismaClient;
    const items = await listConversationsForObject(db, { workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", userId: "user-alice" });
    expect(items).toEqual([{ linkId: expect.any(String), kind: "CREATED", auto: true, conversationId: "conv-a", title: "A chat", archived: false }]);
    expect((findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toMatchObject(accessibleConversationsWhere(WS_A.id, "user-alice"));
    // conv-a2 is linked but not visible to this viewer: neither its id nor its title appears.
    expect(JSON.stringify(items)).not.toContain("conv-a2");
  });

  it("orders CREATED before MENTIONS, falls back to a generic title and flags archived chats", async () => {
    const findMany = vi.fn(async () => [{ id: "conv-a2", title: null, archivedAt: new Date() }, { id: "conv-a", title: "A chat", archivedAt: null }]);
    const db = { ...(prisma() as object), agentConversation: { findMany } } as unknown as AppPrismaClient;
    const items = await listConversationsForObject(db, { workspaceId: WS_A.id, entityType: "TASK", entityId: "task-a", userId: "user-alice" });
    expect(items.map((i) => [i.conversationId, i.kind, i.title, i.archived])).toEqual([["conv-a", "CREATED", "A chat", false], ["conv-a2", "MENTIONS", "Agent conversation", true]]);
  });

  it("an object outside the workspace lists nothing", async () => {
    expect(await listConversationsForObject(prisma(), { workspaceId: WS_B.id, entityType: "TASK", entityId: "task-a", userId: "user-bob" })).toEqual([]);
  });

  it("a conversation lists its objects with titles only when the viewer may open it (else null, so the route 404s)", async () => {
    access.resolve.mockResolvedValueOnce(null);
    expect(await listObjectsForConversation(prisma(), { conversationId: "conv-a", workspaceId: WS_A.id, userId: "user-eve" })).toBeNull();
    access.resolve.mockResolvedValueOnce({ role: "OWNER", ownerUserId: "user-alice" });
    expect(await listObjectsForConversation(prisma(), { conversationId: "conv-a", workspaceId: WS_A.id, userId: "user-alice" })).toEqual([
      { linkId: expect.any(String), kind: "CREATED", auto: true, entityType: "TASK", entityId: "task-a", title: "A task" },
    ]);
  });

  it("removal needs access to the conversation and removes exactly that link", async () => {
    const linkId = rows(CONVERSATION_CREATED_LINK_TYPE)[0].id as string;
    access.resolve.mockResolvedValueOnce(null);
    expect(await removeConversationLink(prisma(), { linkId, workspaceId: WS_A.id, userId: "user-eve" })).toBe(false);
    expect(rows()).toHaveLength(2);
    access.resolve.mockResolvedValueOnce({ role: "OWNER", ownerUserId: "user-alice" });
    expect(await removeConversationLink(prisma(), { linkId, workspaceId: WS_A.id, userId: "user-alice" })).toBe(true);
    expect(rows().map((l) => l.linkType)).toEqual([CONVERSATION_MENTIONS_LINK_TYPE]);
    // another workspace cannot remove it, and an unknown id is simply false
    expect(await removeConversationLink(prisma(), { linkId: rows()[0].id as string, workspaceId: WS_B.id, userId: "user-bob" })).toBe(false);
    expect(await removeConversationLink(prisma(), { linkId: "nope", workspaceId: WS_A.id, userId: "user-alice" })).toBe(false);
  });
});
