/**
 * Chat model picker (TASK-44).
 *
 * Journey: a shared cloud agent is created with its own model -> the chat's Model menu names what Default resolves to and
 * follows the Agent menu -> an explicit pick is carried on the turn request and survives a reload -> a remembered model that is
 * no longer offered resets to Default -> the real turn route refuses an unlisted model with a 400 -> a 390px phone does not
 * overflow.
 *
 * The sandbox is stubbed at the browser: the turn request is intercepted and answered with a canned event stream, so the
 * request body (what the client really sent) is what is asserted. Server-side validation and precedence are covered against the
 * real route handler in __tests__/api-agent-turn-route.test.ts, plus one live 400 here.
 *
 * Needs the agents module (seeded) and COMPASS_CLOUD_AGENT_MODELS=claude-opus-4-5 on the dev server (playwright.config.ts sets
 * both); without a second model the picker rightly has nothing to offer.
 */
import { test, expect } from "../fixtures/index";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e";

const OPUS = "claude-opus-4-5";

test("the chat model picker shows the effective model, sends an explicit pick, remembers it and refuses an unlisted one", async ({ page, base }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Model picker test requires the dedicated local compass_e2e database");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const name = `Model agent ${randomUUID().slice(0, 8)}`;
  try {
    // A shared agent that has its own model.
    await page.goto(`${base}/settings`);
    await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "New cloud agent" }).click();
    const form = page.getByRole("form", { name: "New cloud agent" });
    await form.getByLabel("Owner").selectOption("WORKSPACE");
    await form.getByLabel("Agent name").fill(name);
    await form.getByLabel("Instructions").fill("Answer briefly.");
    await form.getByLabel("Model").selectOption(OPUS);
    await form.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByText("Agent created and enabled in this workspace.")).toBeVisible({ timeout: 20_000 });

    const workspaceId = (await pool.query("SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON w.organization_id = o.id WHERE w.slug = 'e2e-workspace' AND o.slug = 'e2e-test-org'")).rows[0].id as string;
    const userId = (await pool.query("SELECT id FROM compass_dev.users WHERE email = $1", [E2E_USER_EMAIL])).rows[0].id as string;
    const storageKey = `compass:agent-model:${userId}:${workspaceId}`;

    // The sandbox cannot boot here: answer the turn request with a canned stream and keep the body the client sent.
    const turnBodies: Record<string, unknown>[] = [];
    await page.route("**/api/agent/turn", async (route) => {
      turnBodies.push(route.request().postDataJSON());
      const events = `event: status\ndata: ${JSON.stringify({ phase: "running", conversationId: "00000000-0000-4000-8000-000000000001" })}\n\nevent: result\ndata: ${JSON.stringify({ text: "ok", conversationId: "00000000-0000-4000-8000-000000000001" })}\n\n`;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: events });
    });

    await page.goto(`${base}/agent`);
    const agentMenu = page.getByLabel("Agent", { exact: true });
    const modelMenu = page.getByLabel("Model", { exact: true });
    await expect(agentMenu).toBeVisible({ timeout: 15_000 });
    await expect(modelMenu).toBeVisible();

    // Default names what it resolves to, and follows the agent until a model is picked.
    await expect(modelMenu.getByRole("option", { name: "Default (Claude Sonnet 5)" })).toHaveCount(1);
    await agentMenu.selectOption({ label: `${name} (shared)` });
    await expect(modelMenu.getByRole("option", { name: `Default (${OPUS})` })).toHaveCount(1);
    await agentMenu.selectOption({ label: "Compass Agent" });
    await expect(modelMenu.getByRole("option", { name: "Default (Claude Sonnet 5)" })).toHaveCount(1);
    await expect(modelMenu.getByRole("option")).toHaveText(["Default (Claude Sonnet 5)", "Claude Sonnet 5", OPUS]);

    // Default sends no model.
    await page.getByPlaceholder(/message the agent/i).fill("first");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => turnBodies.length).toBe(1);
    expect(turnBodies[0]).not.toHaveProperty("model");

    // An explicit pick, with the agent that has a different model of its own, is what the turn carries.
    await page.goto(`${base}/agent`);
    await agentMenu.selectOption({ label: `${name} (shared)` });
    await modelMenu.selectOption("claude-sonnet-5");
    await page.getByPlaceholder(/message the agent/i).fill("second");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => turnBodies.length).toBe(2);
    expect(turnBodies[1]).toMatchObject({ model: "claude-sonnet-5", agentId: expect.any(String) });

    // COMPASS_CAPTURE_MODEL_PICKER=<dir> saves the composer at each width for visual review; unset, nothing is written.
    const capture = async (label: string) => {
      if (process.env.COMPASS_CAPTURE_MODEL_PICKER) await page.screenshot({ path: `${process.env.COMPASS_CAPTURE_MODEL_PICKER}/chat-model-picker-${label}.png` });
    };
    await capture("desktop-1440");

    // Remembered across a reload, for this user and workspace only.
    await page.goto(`${base}/agent`);
    await expect(modelMenu).toHaveValue("claude-sonnet-5");
    expect(await page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toBe("claude-sonnet-5");

    // A remembered model that is no longer offered resets to Default and is forgotten.
    await page.evaluate((key) => window.localStorage.setItem(key, "claude-retired-1"), storageKey);
    await page.goto(`${base}/agent`);
    await expect(modelMenu).toHaveValue("");
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toBeNull();

    // The real route never trusts the client: an unlisted model is a 400 before anything is written.
    const refused = await page.request.post("/api/agent/turn", { data: { workspaceId, message: "hi", model: "claude-made-up" } });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "INVALID_MODEL" });

    // Phone: both menus fit, nothing overflows.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/agent`);
    await expect(modelMenu).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture("mobile-390");
    for (const menu of [agentMenu, modelMenu]) {
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
  } finally {
    const ids = (await pool.query("SELECT id FROM compass_dev.agents WHERE name = $1", [name])).rows.map((r) => r.id);
    if (ids.length) {
      await pool.query("DELETE FROM compass_dev.workspace_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.user_default_agents WHERE agent_id = ANY($1::uuid[])", [ids]).catch(() => undefined);
      await pool.query("DELETE FROM compass_dev.agent_tool_calls WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agent_workspace_grants WHERE agent_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM compass_dev.agents WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.end();
  }
});
