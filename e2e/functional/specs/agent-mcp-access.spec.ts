import { test, expect } from "../fixtures/index";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

type ToolResult = {
  isError?: boolean;
  structuredContent?: { ok: boolean; data: Record<string, unknown>; message: string };
};

test("one agent key spans granted organizations while assignments, revocation and read grants remain enforced", async ({ request }) => {
  test.setTimeout(180_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Agent tests require the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: url.toString() });
  const agentId = randomUUID();
  const keyId = randomUUID();
  const orgIds = [randomUUID(), randomUUID()];
  const workspaceIds = [randomUUID(), randomUUID(), randomUUID()];
  const orgSlugs = orgIds.map(id => `agent-test-${id}`);
  const token = `cmp_${randomBytes(16).toString("hex")}`;

  async function tool(client: APIRequestContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await client.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
    });
    expect(response.status()).toBe(200);
    const body = await response.text();
    const payload = body.startsWith("event:") || body.startsWith("data:")
      ? JSON.parse(body.split("\n").find(line => line.startsWith("data:"))!.slice(5))
      : JSON.parse(body);
    expect(payload.error).toBeUndefined();
    return payload.result;
  }
  const succeeded = (result: ToolResult) => {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.ok).toBe(true);
    return result.structuredContent!.data;
  };
  const denied = (result: ToolResult) =>
    expect(result.isError === true || result.structuredContent?.ok === false).toBe(true);

  try {
    const userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email='dev@localhost.dev'")).rows[0].id;
    for (let i = 0; i < orgIds.length; i++) {
      await pool.query("INSERT INTO compass_dev.organizations (id,slug,name) VALUES ($1,$2,'Synthetic agent organization')", [orgIds[i], orgSlugs[i]]);
      await pool.query("INSERT INTO compass_dev.organization_members (organization_id,user_id,role) VALUES ($1,$2,'OWNER')", [orgIds[i], userId]);
    }
    for (let i = 0; i < workspaceIds.length; i++) {
      await pool.query("INSERT INTO compass_dev.workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,$3)", [workspaceIds[i], orgIds[i === 1 ? 1 : 0], `workspace-${i}`]);
      await pool.query("INSERT INTO compass_dev.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'ADMIN')", [workspaceIds[i], userId]);
    }
    await pool.query("INSERT INTO compass_dev.agents (id,owner_user_id,name) VALUES ($1,$2,'Synthetic external agent')", [agentId, userId]);
    await pool.query("INSERT INTO compass_dev.api_keys (id,user_id,agent_id,name,key_hash,key_prefix,purpose) VALUES ($1,$2,$3,'Synthetic key',$4,$5,'AGENT')", [keyId, userId, agentId, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)]);
    for (const workspaceId of workspaceIds.slice(0, 2)) {
      await pool.query("INSERT INTO compass_dev.agent_workspace_grants (agent_id,workspace_id,access,granted_by_user_id) VALUES ($1,$2,'WRITE',$3)", [agentId, workspaceId, userId]);
    }

    const identity = succeeded(await tool(request, "get_current_identity"));
    expect(identity.agent).toMatchObject({ id: agentId });
    const visible = (identity.workspaces as Array<{ id: string }>).map(w => w.id).sort();
    expect(visible).toEqual(workspaceIds.slice(0, 2).sort());
    const assignees = succeeded(await tool(request, "list_task_assignees", { workspaceId: workspaceIds[0], search: "Synthetic external", limit: 10 }));
    expect(assignees.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "AGENT", id: agentId })]));
    const firstTask = succeeded(await tool(request, "create_task", { workspaceId: workspaceIds[0], title: "Assigned external work", assignee: { type: "AGENT", id: agentId } }));
    succeeded(await tool(request, "create_task", { workspaceId: workspaceIds[1], title: "Same key, other organization" }));
    denied(await tool(request, "create_task", { workspaceId: workspaceIds[2], title: "Must not be created" }));
    denied(await tool(request, "create_workspace", { orgSlug: orgSlugs[0], name: "Agent cannot administer", slug: "must-not-exist" }));
    const assigned = succeeded(await tool(request, "list_tasks", { workspaceId: workspaceIds[0], assignedToMe: true }));
    expect(JSON.stringify(assigned)).toContain(String(firstTask.id));
    denied(await tool(request, "list_tasks", { workspaceId: workspaceIds[0], assignedToMe: true, assignee: { type: "USER", id: userId } }));
    denied(await tool(request, "update_task", { taskId: firstTask.id, assignee: null, assigneeUserId: userId }));
    denied(await tool(request, "approve_solution_plan", { commentId: randomUUID() }));
    const listing = succeeded(await tool(request, "list_workspaces", { orgSlug: orgSlugs[0] }));
    expect(JSON.stringify(listing)).not.toContain(workspaceIds[2]);

    succeeded(await tool(request, "update_task", { taskId: firstTask.id, assignee: { type: "USER", id: userId } }));
    let persisted = (await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [firstTask.id])).rows[0];
    expect(persisted).toEqual({ assignee_user_id: userId, assignee_agent_id: null });
    expect(succeeded(await tool(request, "get_current_identity")).agent).toMatchObject({ id: agentId });
    succeeded(await tool(request, "update_task", { taskId: firstTask.id, assigneeUserId: null }));
    expect((await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [firstTask.id])).rows[0]).toEqual({ assignee_user_id: null, assignee_agent_id: null });
    succeeded(await tool(request, "update_task", { taskId: firstTask.id, assignee: { type: "AGENT", id: agentId } }));
    persisted = (await pool.query("SELECT assignee_user_id,assignee_agent_id FROM compass_dev.tasks WHERE id=$1", [firstTask.id])).rows[0];
    expect(persisted).toEqual({ assignee_user_id: null, assignee_agent_id: agentId });

    await pool.query("UPDATE compass_dev.agent_workspace_grants SET access='READ' WHERE agent_id=$1 AND workspace_id=$2", [agentId, workspaceIds[1]]);
    succeeded(await tool(request, "list_tasks", { workspaceId: workspaceIds[1] }));
    denied(await tool(request, "create_task", { workspaceId: workspaceIds[1], title: "Read grant cannot write" }));
    await pool.query("UPDATE compass_dev.agent_workspace_grants SET revoked_at=NOW() WHERE agent_id=$1 AND workspace_id=$2", [agentId, workspaceIds[0]]);
    denied(await tool(request, "get_task", { taskId: firstTask.id }));
    succeeded(await tool(request, "list_tasks", { workspaceId: workspaceIds[1] }));

    const activity = (await pool.query("SELECT status,workspace_id FROM compass_dev.agent_tool_calls WHERE agent_id=$1", [agentId])).rows;
    expect(activity.some(row => row.status === "SUCCEEDED" && row.workspace_id === workspaceIds[0])).toBe(true);
    expect(activity.some(row => row.status === "DENIED")).toBe(true);
    expect((await pool.query("SELECT count(*) FROM compass_dev.tasks WHERE workspace_id=$1", [workspaceIds[2]])).rows[0].count).toBe("0");

    await pool.query("UPDATE compass_dev.agents SET status='SUSPENDED' WHERE id=$1", [agentId]);
    const suspended = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: "suspended", method: "tools/call", params: { name: "get_current_identity", arguments: {} } },
    });
    expect(suspended.status()).toBe(401);
  } finally {
    await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id=$1", [agentId]);
    await pool.query("DELETE FROM compass_dev.api_keys WHERE id=$1", [keyId]);
    await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id=$1", [agentId]);
    await pool.query("DELETE FROM compass_dev.tasks WHERE workspace_id=ANY($1::uuid[])", [workspaceIds]);
    await pool.query("DELETE FROM compass_dev.agents WHERE id=$1", [agentId]);
    await pool.query("DELETE FROM compass_dev.workspace_members WHERE workspace_id=ANY($1::uuid[])", [workspaceIds]);
    await pool.query("DELETE FROM compass_dev.workspaces WHERE id=ANY($1::uuid[])", [workspaceIds]);
    await pool.query("DELETE FROM compass_dev.organization_members WHERE organization_id=ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM compass_dev.organizations WHERE id=ANY($1::uuid[])", [orgIds]);
    await pool.end();
  }
});
