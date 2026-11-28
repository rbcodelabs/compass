import { test, expect } from "../fixtures/index";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Roadmap item display IDs (RM-n) over the real MCP endpoint, route, gates and database: list_roadmap_items carries
 * displayId, get_roadmap_item reads full detail (with linked Tasks) by UUID or by RM-n + workspaceId, update_roadmap_item
 * accepts RM-n, and the same RM-n in a second workspace is a different row that cannot be reached through the first.
 * A user who is a member of TWO workspaces is the hazard under test. Synthetic fixtures are removed by id.
 */
type ToolResult = { isError?: boolean; structuredContent?: { ok: boolean; data: Record<string, unknown>; message: string }; content?: Array<{ text: string }> };
type Item = { id: string; displayId: string | null; title: string };

test.describe.serial("roadmap display IDs over MCP", () => {
  test.setTimeout(180_000);
  const url = new URL(process.env.DATABASE_URL!);
  const orgId = randomUUID();
  const [wsA, wsB, wsC] = [randomUUID(), randomUUID(), randomUUID()];
  const token = `cmp_${randomBytes(16).toString("hex")}`;
  const keyId = randomUUID();
  let pool: pg.Pool;
  let userId: string;
  let itemA: string;
  let itemB: string;

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
    // A refused reference or gate may surface as a JSON-RPC error or as an isError result; callers use `denied`.
    return payload.error ? { isError: true, content: [{ text: String(payload.error.message) }] } : payload.result;
  }
  const succeeded = (result: ToolResult) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.ok, JSON.stringify(result)).toBe(true);
    return result.structuredContent!.data;
  };
  const refused = (result: ToolResult) => expect(result.isError === true || result.structuredContent?.ok === false, JSON.stringify(result)).toBe(true);
  const listed = async (request: APIRequestContext, workspaceId: string, extra: Record<string, unknown> = {}) =>
    succeeded(await tool(request, "list_roadmap_items", { workspaceId, ...extra })).items as Item[];

  test.beforeAll(async () => {
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
      throw new Error("Roadmap display ID tests require the dedicated local compass_e2e database");
    }
    pool = new pg.Pool({ connectionString: url.toString() });
    userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email='dev@localhost.dev'")).rows[0].id;
    await pool.query("INSERT INTO compass_dev.organizations (id,slug,name) VALUES ($1,$2,'Synthetic roadmap display ID organization')", [orgId, `rm-display-${orgId}`]);
    await pool.query("INSERT INTO compass_dev.organization_members (organization_id,user_id,role) VALUES ($1,$2,'MEMBER')", [orgId, userId]);
    for (const [index, id] of [wsA, wsB, wsC].entries()) {
      await pool.query("INSERT INTO compass_dev.workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,$3)", [id, orgId, `rm-display-${index}-${id.slice(0, 8)}`]);
    }
    // Member of A and B, of nothing in C.
    for (const id of [wsA, wsB]) await pool.query("INSERT INTO compass_dev.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'ADMIN')", [id, userId]);
    await pool.query("INSERT INTO compass_dev.api_keys (id,user_id,name,key_hash,key_prefix,purpose) VALUES ($1,$2,'Synthetic roadmap display ID key',$3,$4,'USER')", [keyId, userId, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)]);
  });

  test.afterAll(async () => {
    if (!pool) return;
    try {
      const workspaces = [wsA, wsB, wsC];
      await pool.query("DELETE FROM compass_dev.entity_links WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.tasks WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.roadmap_items WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.api_keys WHERE id=$1", [keyId]);
      await pool.query("DELETE FROM compass_dev.workspace_members WHERE workspace_id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.workspaces WHERE id=ANY($1::uuid[])", [workspaces]);
      await pool.query("DELETE FROM compass_dev.organization_members WHERE organization_id=$1", [orgId]);
      await pool.query("DELETE FROM compass_dev.organizations WHERE id=$1", [orgId]);
    } finally {
      await pool.end();
    }
  });

  test("list_roadmap_items shows displayId in structured, full text and compact output; each workspace numbers from RM-1", async ({ request }) => {
    itemA = succeeded(await tool(request, "add_to_roadmap", { workspaceId: wsA, title: "Item in A", horizon: "NOW" })).id as string;
    itemB = succeeded(await tool(request, "add_to_roadmap", { workspaceId: wsB, title: "Item in B", horizon: "NOW" })).id as string;
    const [a] = await listed(request, wsA);
    const [b] = await listed(request, wsB);
    expect(a).toMatchObject({ id: itemA, displayId: "RM-1" });
    expect(b).toMatchObject({ id: itemB, displayId: "RM-1" });
    const compact = await tool(request, "list_roadmap_items", { workspaceId: wsA, compact: true });
    expect((succeeded(compact).items as Item[])[0].displayId).toBe("RM-1");
    expect(compact.content?.[0].text).toContain("RM-1");
    const full = await tool(request, "list_roadmap_items", { workspaceId: wsA });
    expect(full.content?.[0].text).toContain("Display ID: RM-1");
  });

  test("get_roadmap_item returns the same detail by UUID and by RM-n + workspaceId, including linked tasks", async ({ request }) => {
    const task = succeeded(await tool(request, "create_task", { workspaceId: wsA, title: "Delivery task" })).id as string;
    succeeded(await tool(request, "link_task", { taskId: task, linkedType: "ROADMAP_ITEM", linkedId: itemA }));
    const byUuid = succeeded(await tool(request, "get_roadmap_item", { roadmapItemId: itemA }));
    const byDisplay = succeeded(await tool(request, "get_roadmap_item", { roadmapItemId: "rm-1", workspaceId: wsA }));
    expect(byDisplay).toEqual(byUuid);
    expect(byUuid).toMatchObject({ id: itemA, displayId: "RM-1", title: "Item in A", horizon: "NOW", tasks: [{ id: task, displayId: expect.stringMatching(/^TASK-\d+$/), title: "Delivery task" }] });
    // A display ID with no workspace, and a missing item, are refused.
    refused(await tool(request, "get_roadmap_item", { roadmapItemId: "RM-1" }));
    refused(await tool(request, "get_roadmap_item", { roadmapItemId: "RM-99", workspaceId: wsA }));
  });

  test("RM-1 means the item of the workspace named, never the other workspace's", async ({ request }) => {
    expect(succeeded(await tool(request, "get_roadmap_item", { roadmapItemId: "RM-1", workspaceId: wsB })).title).toBe("Item in B");
    // A UUID of A's item paired with B (member of both) is not found, and the caller is not in C at all.
    refused(await tool(request, "get_roadmap_item", { roadmapItemId: itemA, workspaceId: wsB }));
    refused(await tool(request, "get_roadmap_item", { roadmapItemId: "RM-1", workspaceId: wsC }));
    // A TASK-n where a roadmap item is expected names its real type.
    const wrong = await tool(request, "get_roadmap_item", { roadmapItemId: "TASK-1", workspaceId: wsA });
    refused(wrong);
    expect(JSON.stringify(wrong)).toContain("is a Task");
  });

  test("update_roadmap_item and set_launch_tier accept RM-n; a foreign workspace writes nothing", async ({ request }) => {
    succeeded(await tool(request, "update_roadmap_item", { itemId: "RM-1", workspaceId: wsA, title: "Renamed in A" }));
    expect((await pool.query("SELECT title FROM compass_dev.roadmap_items WHERE id=$1", [itemA])).rows[0].title).toBe("Renamed in A");
    expect((await pool.query("SELECT title FROM compass_dev.roadmap_items WHERE id=$1", [itemB])).rows[0].title).toBe("Item in B");
    // UUID still works.
    succeeded(await tool(request, "update_roadmap_item", { itemId: itemA, title: "Renamed by UUID" }));
    // A workspace the caller is not in, and a display ID with no workspace.
    refused(await tool(request, "update_roadmap_item", { itemId: "RM-1", workspaceId: wsC, title: "Must not land" }));
    refused(await tool(request, "update_roadmap_item", { itemId: "RM-1", title: "Must not land" }));
    refused(await tool(request, "set_launch_tier", { itemId: "RM-1", workspaceId: wsC, tier: "TIER_1" }));
    const titles = (await pool.query("SELECT title FROM compass_dev.roadmap_items WHERE workspace_id=ANY($1::uuid[]) ORDER BY title", [[wsA, wsB, wsC]])).rows.map((r) => r.title);
    expect(titles).toEqual(["Item in B", "Renamed by UUID"]);
  });
});
