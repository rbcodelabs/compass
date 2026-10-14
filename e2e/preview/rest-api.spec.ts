import { randomUUID } from "node:crypto";
import { test, expect, fixture } from "./fixtures";

const json = { "content-type": "application/json" };

test.describe("isolated REST API contract", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("serves OpenAPI and returns bearer JSON instead of a browser redirect", async ({ request }) => {
    const spec = await request.get("/api/v1/openapi.json");
    expect(spec.status()).toBe(200);
    expect((await spec.json()).openapi).toBe("3.1.0");
    const unauthenticated = await request.get("/api/v1/me", { maxRedirects: 0 });
    expect(unauthenticated.status()).toBe(401);
    expect(unauthenticated.headers()["content-type"]).toContain("application/problem+json");
  });

  test("API key supports create, update, pagination, tenant denial and a typed link action", async ({ request }) => {
    const f = fixture();
    const headers = { ...json, authorization: `Bearer ${f.apiKey}` };
    const title = `REST preview ${randomUUID().slice(0, 8)}`;
    const first = await request.post(`/api/v1/workspaces/${f.workspaceId}/opportunities`, { headers, data: { title } });
    expect(first.status()).toBe(201);
    const opportunity = await first.json();
    expect((await request.post(`/api/v1/workspaces/${f.workspaceId}/opportunities`, { headers, data: { title: `${title} second` } })).status()).toBe(201);
    const updated = await request.patch(`/api/v1/workspaces/${f.workspaceId}/opportunities/${opportunity.id}`, { headers, data: { title: `${title} updated` } });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).title).toBe(`${title} updated`);
    const page = await request.get(`/api/v1/workspaces/${f.workspaceId}/opportunities?limit=1`, { headers });
    expect(page.status()).toBe(200);
    expect((await page.json()).nextCursor).toEqual(expect.any(String));
    expect((await request.get(`/api/v1/workspaces/${f.isolatedWorkspaceId}/opportunities/${opportunity.id}`, { headers })).status()).toBe(404);
    const taskResponse = await request.post(`/api/v1/workspaces/${f.workspaceId}/tasks`, { headers, data: { title: `${title} task` } });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();
    expect((await request.post(`/api/v1/workspaces/${f.workspaceId}/tasks/${task.id}/links`, { headers, data: { linkedType: "OPPORTUNITY", linkedId: opportunity.id } })).status()).toBe(201);
  });

  test("OAuth read token reads but cannot mutate", async ({ request }) => {
    const f = fixture();
    const headers = { ...json, authorization: `Bearer ${f.oauthReadToken}` };
    expect((await request.get(`/api/v1/workspaces/${f.workspaceId}`, { headers })).status()).toBe(200);
    const denied = await request.post(`/api/v1/workspaces/${f.workspaceId}/opportunities`, { headers, data: { title: "must not write" } });
    expect(denied.status()).toBe(403);
    expect(denied.headers()["www-authenticate"]).toContain("insufficient_scope");
  });
});
