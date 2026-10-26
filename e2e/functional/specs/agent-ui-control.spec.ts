/**
 * Agent UI control functional spec.
 *
 * Journey: an agent (a real MCP call with a user API key) tries to drive a tab
 * that has not opted in and is refused → the user turns on "Let agent drive" →
 * the agent reads the tab's state, moves it to another screen, is refused an
 * off-workspace destination, and receives a real screenshot → the user presses
 * Stop and the agent is locked out again.
 *
 * The agent side is not simulated: every command goes through POST /api/mcp and
 * the real ui_* tools, so the queue, the SSE stream, the browser executor and
 * the result post-back are all exercised together.
 */
import { test, expect } from "../fixtures/index";
import { E2E_ORG_SLUG, E2E_WORKSPACE_SLUG, E2E_USER_EMAIL } from "../fixtures/seed-e2e";
import type { APIRequestContext } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type McpResult = {
  isError?: boolean;
  content?: { type: string; data?: string; text?: string; mimeType?: string }[];
  structuredContent?: { ok: boolean; message: string; data: Record<string, unknown> | null };
};

test("an agent can read, move and screenshot a tab only while the user lets it drive", async ({ page, request, base }, testInfo) => {
  test.setTimeout(180_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Agent tests require the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: url.toString() });
  const keyId = randomUUID();
  const token = `cmp_${randomBytes(16).toString("hex")}`;
  let userId = "";

  // Attach to the report and, when E2E_SHOT_DIR is set, keep a copy on disk:
  // Playwright discards attachments of passing tests.
  async function keep(name: string, body: Buffer) {
    await testInfo.attach(name, { body, contentType: "image/png" });
    if (process.env.E2E_SHOT_DIR) {
      fs.mkdirSync(process.env.E2E_SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.E2E_SHOT_DIR, `${name}.png`), body);
    }
  }

  async function tool(client: APIRequestContext, name: string, args: Record<string, unknown>): Promise<McpResult> {
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

  try {
    userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email=$1", [E2E_USER_EMAIL])).rows[0].id;
    const workspaceId = (await pool.query(
      `SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id = w.organization_id
       WHERE o.slug=$1 AND w.slug=$2`,
      [E2E_ORG_SLUG, E2E_WORKSPACE_SLUG],
    )).rows[0].id;
    await pool.query(
      "INSERT INTO compass_dev.api_keys (id,user_id,name,key_hash,key_prefix,purpose) VALUES ($1,$2,'UI control e2e key',$3,$4,'USER')",
      [keyId, userId, createHash("sha256").update(token).digest("hex"), token.slice(4, 12)],
    );

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    // ── 1. Not opted in: the agent is refused with instructions ─────────────
    const refused = await tool(request, "ui_get_state", { workspaceId });
    expect(refused.structuredContent?.ok).toBe(false);
    expect(refused.structuredContent?.message).toMatch(/Let agent drive/);

    // ── 2. The user opts in ─────────────────────────────────────────────────
    const driveButton = page.getByRole("button", { name: "Let agent drive" });
    await expect(driveButton).toBeVisible();
    await keep("1-before-opt-in", await page.screenshot());
    await driveButton.click();
    const banner = page.getByRole("status").filter({ hasText: "An agent can move this tab" });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Stop" })).toBeVisible();
    await keep("2-banner-while-driving", await page.screenshot());

    // The SSE reader needs a moment to attach; the first call retries until it does.
    await expect.poll(async () => (await tool(request, "ui_get_state", { workspaceId })).structuredContent?.ok, { timeout: 30_000 }).toBe(true);

    // ── 3. Read where the user is ───────────────────────────────────────────
    const state = (await tool(request, "ui_get_state", { workspaceId })).structuredContent!.data!;
    expect(String(state.path)).toContain(`${base}/okrs`);
    expect(Array.isArray(state.headings)).toBe(true);

    // ── 4. Move the user to another screen ──────────────────────────────────
    const moved = await tool(request, "ui_navigate", { workspaceId, path: `${base}/roadmap` });
    expect(moved.structuredContent?.ok).toBe(true);
    await page.waitForURL(`**${base}/roadmap`);
    await expect(banner).toBeVisible();

    // ── 5. Off-workspace and off-origin destinations are refused ────────────
    for (const path of ["/api/admin/migrate", "https://evil.example/x", `${base}/../other-ws/okrs`]) {
      const blocked = await tool(request, "ui_navigate", { workspaceId, path });
      expect(blocked.structuredContent?.ok, path).toBe(false);
    }
    await expect(page).toHaveURL(new RegExp(`${base}/roadmap$`));

    // ── 6. A real screenshot of what the user sees ──────────────────────────
    const shot = await tool(request, "ui_screenshot", { workspaceId });
    expect(shot.structuredContent?.ok).toBe(true);
    const image = shot.content?.find(block => block.type === "image");
    expect(image?.mimeType).toBe("image/png");
    const png = Buffer.from(image!.data!, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(5_000);
    await keep("3-agent-screenshot-of-roadmap", png);
    await keep("4-roadmap-as-playwright-sees-it", await page.screenshot());

    // ── 7. Stop: the banner goes and the agent is locked out again ──────────
    await banner.getByRole("button", { name: "Stop" }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByRole("button", { name: "Let agent drive" })).toBeVisible();
    const afterStop = await tool(request, "ui_get_state", { workspaceId });
    expect(afterStop.structuredContent?.ok).toBe(false);
    await keep("5-after-stop", await page.screenshot());

    // ── 8. Opt-in does not survive a reload ─────────────────────────────────
    await driveButton.click();
    await expect(banner).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Let agent drive" })).toBeVisible();
    await expect(banner).toBeHidden();
  } finally {
    await pool.query("DELETE FROM compass_dev.ui_commands WHERE user_id=$1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM compass_dev.ui_sessions WHERE user_id=$1", [userId]).catch(() => undefined);
    await pool.query("DELETE FROM compass_dev.api_keys WHERE id=$1", [keyId]).catch(() => undefined);
    await pool.end();
  }
});
