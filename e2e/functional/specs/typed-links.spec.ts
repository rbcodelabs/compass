import { test, expect } from "../fixtures/index";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Typed links between Opportunities, Objectives, Key Results and Solutions (ADR Phase 2), end to end over the
 * real MCP endpoint, route, gates and database: the new link tools, the legacy `link_opportunity_to_kr` dual
 * write, the additive reads, tenant isolation for a user who is a member of TWO workspaces, and explicit link
 * cleanup when a parent is deleted. Cleanup of the synthetic fixture is by id; nothing of the shared fixture
 * workspace is touched.
 */
type ToolResult = {
  isError?: boolean;
  structuredContent?: { ok: boolean; data: Record<string, unknown>; message: string };
};
type Link = { kind: string; objectiveId?: string; opportunityId?: string; keyResultId?: string; solutionId?: string; origin?: string };

test.describe.serial("typed links", () => {
  test.setTimeout(240_000);
  const url = new URL(process.env.DATABASE_URL!);
  const orgId = randomUUID();
  const [wsA, wsB, wsC] = [randomUUID(), randomUUID(), randomUUID()];
  const token = `cmp_${randomBytes(16).toString("hex")}`;
  const keyId = randomUUID();
  const [cycleA, cycleB] = [randomUUID(), randomUUID()];
  const [objA1, objA2, objB] = [randomUUID(), randomUUID(), randomUUID()];
  const [krA1, krA2, krB] = [randomUUID(), randomUUID(), randomUUID()];
  const [oppA1, oppA2, oppLegacyOnly, oppB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let pool: pg.Pool;
  let userId: string;

  async function tool(client: APIRequestContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await client.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
    });
    expect(response.status()).toBe(200);
    const body = await response.text();
    const payload = body.startsWith("event:") || body.startsWith("data:")
      ? JSON.parse(body.split("\n").find((line) => line.startsWith("data:"))!.slice(5))
      : JSON.parse(body);
    expect(payload.error).toBeUndefined();
    return payload.result;
  }
  const succeeded = (result: ToolResult) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.ok, JSON.stringify(result)).toBe(true);
    return result.structuredContent!.data;
  };
  const denied = (result: ToolResult) => expect(result.isError === true || result.structuredContent?.ok === false, JSON.stringify(result)).toBe(true);
  const links = async (request: APIRequestContext, workspaceId: string, filter: Record<string, string>) =>
    (succeeded(await tool(request, "list_links", { workspaceId, ...filter })).items as Link[]);
  const opportunity = async (request: APIRequestContext, opportunityId: string) => succeeded(await tool(request, "get_opportunity", { opportunityId }));

  test.beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
      throw new Error("Typed link tests require the dedicated local compass_e2e database");
    }
    pool = new pg.Pool({ connectionString: url.toString() });
    userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email='dev@localhost.dev'")).rows[0].id;
    await pool.query("INSERT INTO compass_dev.organizations (id,slug,name) VALUES ($1,$2,'Synthetic typed-links organization')", [orgId, `typed-links-${orgId}`]);
    await pool.query("INSERT INTO compass_dev.organization_members (organization_id,user_id,role) VALUES ($1,$2,'MEMBER')", [orgId, userId]);
    for (const [index, id] of [wsA, wsB, wsC].entries()) {
      await pool.query("INSERT INTO compass_dev.workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,$3)", [id, orgId, `typed-links-${index}-${id.slice(0, 8)}`]);
    }
    // The user is a member of A and B (the cross-linking hazard), and of nothing in C.
    for (const id of [wsA, wsB]) {
      await pool.query("INSERT INTO compass_dev.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'ADMIN')", [id, userId]);
    }
    await pool.query("INSERT INTO compass_dev.api_keys (id,user_id,name,key_hash,key_prefix,purpose) VALUES ($1,$2,'Synthetic typed-links key',$3,$4,'USER')", [keyId, userId, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)]);
    await pool.query("INSERT INTO compass_dev.okr_cycles (id,workspace_id,title,start_date,end_date) VALUES ($1,$2,'A cycle','2026-01-01','2026-03-31'), ($3,$4,'B cycle','2026-01-01','2026-03-31')", [cycleA, wsA, cycleB, wsB]);
    await pool.query(
      "INSERT INTO compass_dev.objectives (id,workspace_id,cycle_id,title) VALUES ($1,$2,$3,'Objective A1'), ($4,$2,$3,'Objective A2'), ($5,$6,$7,'Objective B')",
      [objA1, wsA, cycleA, objA2, objB, wsB, cycleB],
    );
    await pool.query("INSERT INTO compass_dev.key_results (id,objective_id,title,target) VALUES ($1,$2,'KR A1',1), ($3,$4,'KR A2',1), ($5,$6,'KR B',1)", [krA1, objA1, krA2, objA2, krB, objB]);
    // oppLegacyOnly is a raw row exactly as the code before typed links wrote it: a legacy pointer and no link row.
    await pool.query(
      "INSERT INTO compass_dev.opportunities (id,workspace_id,title,linked_key_result_id) VALUES ($1,$2,'Opportunity A1',NULL), ($3,$2,'Opportunity A2',NULL), ($4,$2,'Legacy-only opportunity',$5), ($6,$7,'Opportunity B',NULL)",
      [oppA1, wsA, oppA2, oppLegacyOnly, krA1, oppB, wsB],
    );
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      // Synthetic rows only, by id. Link rows go first: no foreign keys reach them.
      const workspaces = [wsA, wsB, wsC];
      await pool.query("DELETE FROM compass_dev.opportunity_objective_links WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.solution_key_result_links WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.solutions WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.opportunities WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.key_results WHERE objective_id=ANY($1::uuid[])", [[objA1, objA2, objB]]);
      await pool.query("DELETE FROM compass_dev.objectives WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.okr_cycles WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.api_keys WHERE id=$1", [keyId]);
      await pool.query("DELETE FROM compass_dev.workspace_members WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.workspaces WHERE id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.organization_members WHERE organization_id=$1", [orgId]);
      await pool.query("DELETE FROM compass_dev.organizations WHERE id=$1", [orgId]);
    } finally {
      await pool.end();
    }
  });

  test("a legacy-only seeded row still reads correctly: the key result from the column, no link inferred", async ({ request }) => {
    const data = await opportunity(request, oppLegacyOnly);
    expect(data.linkedKeyResult).toMatchObject({ id: krA1, title: "KR A1" });
    expect(data.linkedObjectives).toEqual([]);
    const listed = (succeeded(await tool(request, "list_opportunities", { workspaceId: wsA })).items as Array<Record<string, unknown>>).find((o) => o.id === oppLegacyOnly)!;
    expect(listed.linkedKeyResult).toMatchObject({ title: "KR A1", objective: "Objective A1" });
    expect(listed.linkedObjectives).toEqual([]);
    expect(await links(request, wsA, { opportunityId: oppLegacyOnly })).toEqual([]);
  });

  test("link_opportunity_to_objective links, shows in get_opportunity and list_opportunities, and is idempotent", async ({ request }) => {
    expect(succeeded(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: oppA1, objectiveId: objA1 }))).toMatchObject({ created: true, link: { origin: "DIRECT", source: "MCP", workspaceId: wsA } });
    expect(succeeded(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: oppA1, objectiveId: objA1 }))).toMatchObject({ created: false });

    const data = await opportunity(request, oppA1);
    expect(data.linkedObjectives).toEqual([{ id: objA1, title: "Objective A1" }]);
    expect(data.linkedKeyResult).toBeNull();
    const listed = (succeeded(await tool(request, "list_opportunities", { workspaceId: wsA })).items as Array<Record<string, unknown>>).find((o) => o.id === oppA1)!;
    expect(listed.linkedObjectives).toEqual([{ id: objA1, title: "Objective A1" }]);
    expect(await links(request, wsA, { opportunityId: oppA1 })).toEqual([expect.objectContaining({ kind: "opportunity_objective", objectiveId: objA1, origin: "DIRECT" })]);
    expect(await links(request, wsA, { objectiveId: objA1 })).toEqual([expect.objectContaining({ opportunityId: oppA1 })]);
  });

  test("the legacy tool creates a LEGACY link, follows a change, and a clear removes it", async ({ request }) => {
    succeeded(await tool(request, "link_opportunity_to_kr", { opportunityId: oppA2, keyResultId: krA2 }));
    let data = await opportunity(request, oppA2);
    expect(data.linkedKeyResult).toMatchObject({ id: krA2 });
    expect(data.linkedObjectives).toEqual([{ id: objA2, title: "Objective A2" }]);
    expect(await links(request, wsA, { opportunityId: oppA2 })).toEqual([expect.objectContaining({ objectiveId: objA2, origin: "LEGACY" })]);

    succeeded(await tool(request, "link_opportunity_to_kr", { opportunityId: oppA2, keyResultId: krA1 }));
    expect((await opportunity(request, oppA2)).linkedObjectives).toEqual([{ id: objA1, title: "Objective A1" }]);

    succeeded(await tool(request, "link_opportunity_to_kr", { opportunityId: oppA2, keyResultId: null }));
    data = await opportunity(request, oppA2);
    expect(data.linkedKeyResult).toBeNull();
    expect(data.linkedObjectives).toEqual([]);
    expect(await links(request, wsA, { opportunityId: oppA2 })).toEqual([]);
  });

  test("create_opportunity with a keyResultId writes the column and the link; a DIRECT link added over a LEGACY pair survives a clear", async ({ request }) => {
    const created = succeeded(await tool(request, "create_opportunity", { workspaceId: wsA, title: "Created with a key result", keyResultId: krA2 }));
    const id = String(created.id);
    expect(created.linkedKeyResultId).toBe(krA2);
    expect((await opportunity(request, id)).linkedObjectives).toEqual([{ id: objA2, title: "Objective A2" }]);
    expect(await links(request, wsA, { opportunityId: id })).toEqual([expect.objectContaining({ origin: "LEGACY" })]);

    succeeded(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: id, objectiveId: objA2 }));
    expect(await links(request, wsA, { opportunityId: id })).toEqual([expect.objectContaining({ origin: "DIRECT" })]);
    succeeded(await tool(request, "link_opportunity_to_kr", { opportunityId: id, keyResultId: null }));
    expect(await links(request, wsA, { opportunityId: id })).toEqual([expect.objectContaining({ objectiveId: objA2, origin: "DIRECT" })]);

    // Unlinking drops it for good once no key result implies it; repeating reports nothing removed.
    expect(succeeded(await tool(request, "unlink_opportunity_from_objective", { workspaceId: wsA, opportunityId: id, objectiveId: objA2 }))).toMatchObject({ removed: 1 });
    expect(succeeded(await tool(request, "unlink_opportunity_from_objective", { workspaceId: wsA, opportunityId: id, objectiveId: objA2 }))).toMatchObject({ removed: 0 });
  });

  test("a cross-workspace link is rejected everywhere, even for a member of both workspaces, and writes nothing", async ({ request }) => {
    denied(await tool(request, "link_opportunity_to_kr", { opportunityId: oppA1, keyResultId: krB }));
    denied(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: oppA1, objectiveId: objB }));
    denied(await tool(request, "link_opportunity_to_objective", { workspaceId: wsB, opportunityId: oppA1, objectiveId: objB }));
    denied(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: oppB, objectiveId: objA1 }));
    denied(await tool(request, "create_opportunity", { workspaceId: wsA, title: "Must not exist", keyResultId: krB }));
    // A workspace the user does not belong to.
    denied(await tool(request, "link_opportunity_to_objective", { workspaceId: wsC, opportunityId: oppA1, objectiveId: objA1 }));
    denied(await tool(request, "list_links", { workspaceId: wsC, opportunityId: oppA1 }));

    expect((await opportunity(request, oppA1)).linkedKeyResult).toBeNull();
    expect(await links(request, wsA, { opportunityId: oppA1 })).toHaveLength(1);
    expect(await links(request, wsB, { opportunityId: oppB })).toEqual([]);
    const titles = (succeeded(await tool(request, "list_opportunities", { workspaceId: wsA })).items as Array<{ title: string }>).map((o) => o.title);
    expect(titles).not.toContain("Must not exist");
  });

  test("solution to key result links: link, list, additive list_solutions field, unlink, tenant checks", async ({ request }) => {
    const solution = succeeded(await tool(request, "add_solution", { opportunityId: oppA1, title: "Solution under A1" }));
    const solutionId = String(solution.id);
    expect(succeeded(await tool(request, "link_solution_to_key_result", { workspaceId: wsA, solutionId, keyResultId: krA2 }))).toMatchObject({ created: true });
    expect(succeeded(await tool(request, "link_solution_to_key_result", { workspaceId: wsA, solutionId, keyResultId: krA2 }))).toMatchObject({ created: false });
    denied(await tool(request, "link_solution_to_key_result", { workspaceId: wsA, solutionId, keyResultId: krB }));

    expect(await links(request, wsA, { solutionId })).toEqual([expect.objectContaining({ kind: "solution_key_result", keyResultId: krA2 })]);
    expect(await links(request, wsA, { keyResultId: krA2 })).toEqual([expect.objectContaining({ solutionId })]);
    const listed = (succeeded(await tool(request, "list_solutions", { workspaceId: wsA })).items as Array<Record<string, unknown>>).find((s) => s.id === solutionId)!;
    expect(listed.linkedKeyResults).toEqual([{ id: krA2, title: "KR A2", objectiveId: objA2 }]);
    // The solution keeps its single home opportunity.
    expect(listed.opportunityId).toBe(oppA1);

    expect(succeeded(await tool(request, "unlink_solution_from_key_result", { workspaceId: wsA, solutionId, keyResultId: krA2 }))).toMatchObject({ removed: 1 });
    expect(succeeded(await tool(request, "unlink_solution_from_key_result", { workspaceId: wsA, solutionId, keyResultId: krA2 }))).toMatchObject({ removed: 0 });
    // Re-link: this one is removed by deleting the key result below.
    succeeded(await tool(request, "link_solution_to_key_result", { workspaceId: wsA, solutionId, keyResultId: krA2 }));
  });

  test("deleting a key result or an objective removes the links that named it", async ({ request }) => {
    succeeded(await tool(request, "link_opportunity_to_kr", { opportunityId: oppA2, keyResultId: krA2 }));
    succeeded(await tool(request, "link_opportunity_to_objective", { workspaceId: wsA, opportunityId: oppA1, objectiveId: objA2 }));
    const byOrigin = (a: (string | undefined)[], b: (string | undefined)[]) => String(a[1]).localeCompare(String(b[1]));
    expect((await links(request, wsA, { objectiveId: objA2 })).map((l) => [l.opportunityId, l.origin]).sort(byOrigin)).toEqual([[oppA1, "DIRECT"], [oppA2, "LEGACY"]]);
    expect((await links(request, wsA, { keyResultId: krA2 })).length).toBe(1);

    // Deleting the key result clears the legacy pointer, the LEGACY link it implied, and the solution link; the DIRECT link stays.
    succeeded(await tool(request, "delete_key_result", { keyResultId: krA2 }));
    expect((await opportunity(request, oppA2)).linkedKeyResult).toBeNull();
    expect((await links(request, wsA, { objectiveId: objA2 })).map((l) => [l.opportunityId, l.origin])).toEqual([[oppA1, "DIRECT"]]);
    // list_links on a deleted key result is a clean not-found, not a stale link.
    denied(await tool(request, "list_links", { workspaceId: wsA, keyResultId: krA2 }));

    // Deleting the (now childless) objective removes the DIRECT link too.
    succeeded(await tool(request, "delete_objective", { objectiveId: objA2 }));
    expect((await opportunity(request, oppA1)).linkedObjectives).toEqual([{ id: objA1, title: "Objective A1" }]);
    denied(await tool(request, "list_links", { workspaceId: wsA, objectiveId: objA2 }));
    const left = await pool.query("SELECT count(*)::int AS n FROM compass_dev.opportunity_objective_links WHERE objective_id=$1", [objA2]);
    expect(left.rows[0].n).toBe(0);
  });
});
