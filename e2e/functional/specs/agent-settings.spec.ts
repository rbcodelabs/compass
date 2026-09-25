import { test, expect } from "../fixtures/index";
import pg from "pg";
import { randomUUID } from "node:crypto";
import path from "node:path";

test("register an account agent, grant workspace access, generate and revoke its key", async ({ page, request, base }) => {
  test.setTimeout(120_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Agent settings test requires local compass_e2e");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const name = `Engineering assistant ${randomUUID().slice(0, 8)}`;
  try {
    await page.goto("/settings/agents");
    await page.getByLabel("New agent name").fill(name);
    await page.getByRole("button", { name: "Create agent", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    let card = page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByLabel("Key name", { exact: true }).fill("Test integration");
    await card.getByRole("button", { name: "Generate agent key" }).click();
    await expect(card.locator("code")).toContainText("cmp_");
    const rawKey = (await card.locator("code").textContent())!;
    const identityResponse = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${rawKey}`, accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "get_current_identity", arguments: {} } },
    });
    expect(identityResponse.status()).toBe(200);
    const body = await identityResponse.text();
    const payload = body.startsWith("event:") || body.startsWith("data:") ? JSON.parse(body.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) : JSON.parse(body);
    expect(payload.error).toBeUndefined();
    expect(payload.result.isError).not.toBe(true);
    expect(payload.result.structuredContent.ok).toBe(true);
    expect(payload.result.structuredContent.data.purpose).toBe("AGENT");
    expect(payload.result.structuredContent.data.agent.name).toBe(name);
    await card.getByRole("button", { name: "Hide key" }).click();
    await page.reload();
    await expect(card.locator("code")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Revoke Test integration" })).toBeVisible();
    await page.goto(`${base}/settings`);
    await page.getByRole("combobox", { name: "Workspace agent" }).click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await page.getByRole("combobox", { name: "Agent access" }).click();
    await page.getByRole("option", { name: "Read and write" }).click();
    await page.getByRole("button", { name: "Save agent access" }).click();
    await expect(page.getByRole("button", { name: `Revoke access to ${name}` })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: `Revoke access to ${name}` })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    if (process.env.COMPASS_CAPTURE_AGENT_DOCS === "1") {
      for (const viewport of [{ width: 1280, height: 800, name: "desktop" }, { width: 390, height: 844, name: "mobile" }]) {
        await page.setViewportSize(viewport);
        await page.goto("/settings/agents");
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await page.screenshot({ path: path.resolve(`public/screenshots/docs/agents-${viewport.name}.png`), fullPage: true });
        await page.goto(`${base}/settings`);
        await expect(page.getByRole("heading", { name: "Workspace agents", exact: true })).toBeVisible();
        await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.resolve(`public/screenshots/docs/workspace-agents-${viewport.name}.png`), fullPage: false });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: `Revoke access to ${name}` }).click();
    // The row disappears only once the revoke server action returns its
    // revalidated page. In the dev-mode server that round trip has been
    // observed at 5.1s (trace: POST wait 5112ms), just past the 5s default.
    await expect(page.getByRole("button", { name: `Revoke access to ${name}` })).toHaveCount(0, { timeout: 15_000 });
    await page.goto("/settings/agents");
    card = page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "Revoke Test integration" }).click();
    await expect(card.getByRole("button", { name: "Revoke Test integration" })).toHaveCount(0);
    await card.getByRole("button", { name: "Suspend", exact: true }).click();
    await expect(card.getByRole("button", { name: "Reactivate", exact: true })).toBeVisible();
  } finally {
    const ids = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows.map((r) => r.id);
    if (ids.length) {
      await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.api_keys WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agents WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.end();
  }
});
