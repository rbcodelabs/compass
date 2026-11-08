/**
 * Agent model catalog picker (Settings > Workspace agents).
 *
 * Journey (opencode harness): the New cloud agent form offers the full AI Gateway catalog behind a search box and a provider
 * filter -> a catalog model is picked, the agent is created and the choice survives a reload (checked in the form AND in the
 * database) -> an agent whose stored model is no longer offered is still editable and keeps that model until the manager
 * changes it -> a forged save naming a model that is not in the catalog is refused server-side and changes nothing.
 * Journey (claude harness): the Model field stays the curated <select> and explains why the catalog is not offered.
 *
 * The harness is a property of the dev server (AGENT_HARNESS), so each test detects which variant it is looking at and skips
 * the other one with a stated reason. A default run exercises the claude variant; E2E_AGENT_HARNESS=opencode (forwarded to the
 * dev server by playwright.config.ts, deliberately not set suite-wide) exercises the catalog variant. The catalog is the real
 * public gateway list (the server fetches it, so the browser cannot stub it); the test only relies on the Anthropic provider
 * being present and skips when the gateway is unreachable.
 */
import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const FORGED_MODEL = "evil/not-in-the-catalog";
const STALE_MODEL = "retired/model-that-left-the-catalog";

function pool() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Model catalog test requires the dedicated local compass_e2e database");
  return new pg.Pool({ connectionString: url.toString() });
}

async function openNewAgentForm(page: Page, base: string) {
  await page.goto(`${base}/settings`);
  await page.getByRole("heading", { name: "Workspace agents", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "New cloud agent" }).click();
  const form = page.getByRole("form", { name: "New cloud agent" });
  await form.getByLabel("Owner").selectOption("WORKSPACE");
  return form;
}

async function storedModel(db: pg.Pool, name: string) {
  return ((await db.query("SELECT model FROM compass_dev.agents WHERE name = $1", [name])).rows[0]?.model ?? null) as string | null;
}

test("opencode harness: search, provider filter, pick a catalog model, persist it, keep a stale one, refuse a forged one", async ({ page, base }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const db = pool();
  const suffix = randomUUID().slice(0, 8);
  const name = `Catalog agent ${suffix}`;
  const staleName = `Stale model agent ${suffix}`;
  try {
    const form = await openNewAgentForm(page, base);
    const search = form.getByRole("searchbox", { name: "Search models" });
    test.skip((await search.count()) === 0, "Server runs the claude harness (or the catalog is unreachable): the catalog picker is not rendered. Start the dev server with AGENT_HARNESS=opencode.");

    const providerFilter = form.getByLabel("Filter by provider");
    const list = form.getByRole("listbox", { name: "Models" });
    const selected = form.getByTestId("model-selected");
    await expect(selected).toHaveText("Selected: System default");
    // Curated entries come first as Recommended; the catalog adds provider groups after them.
    await expect(list.getByRole("group", { name: "Recommended" })).toBeVisible();
    const optionCount = await list.getByRole("option").count();
    expect(optionCount, "the full catalog, not just the curated list").toBeGreaterThan(20);

    // Search narrows by name, id or provider; a nonsense query shows the empty state.
    await search.fill("zzzz-no-such-model");
    await expect(list.getByText("No models match.")).toBeVisible();
    await search.fill("claude");
    expect(await list.getByRole("option").count()).toBeLessThan(optionCount);
    // Provider filter combines with the search.
    await providerFilter.selectOption("anthropic");
    const anthropicOptions = list.getByRole("option").filter({ hasText: "anthropic/" });
    await expect(anthropicOptions.first()).toBeVisible();
    await expect(list.getByRole("option").filter({ hasText: /^(?!System default).*openai\//i })).toHaveCount(0);

    // Pick a catalog model that is not in the curated list.
    const pick = anthropicOptions.first();
    const pickedId = (await pick.locator("span").nth(1).textContent())!.trim();
    await pick.click();
    await expect(selected).toContainText(pickedId);
    await expect(pick).toHaveAttribute("aria-selected", "true");

    await form.getByLabel("Agent name").fill(name);
    await form.getByLabel("Instructions").fill("Answer briefly.");
    await form.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByText("Agent created and enabled in this workspace.")).toBeVisible({ timeout: 20_000 });
    expect(await storedModel(db, name), "the catalog id is what was stored").toBe(pickedId);

    // Reload: the edit form still shows the saved model.
    await page.reload();
    const row = page.locator("li").filter({ hasText: name });
    await row.getByRole("button", { name: `Edit ${name}` }).click();
    const edit = page.getByRole("form", { name: `Edit ${name}` });
    await expect(edit.getByTestId("model-selected")).toContainText(pickedId);

    // Forged save: swap the model id in the real server-action request for one that is not in the catalog.
    let forged = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData();
      if (request.method() === "POST" && request.headers()["next-action"] && body?.includes(pickedId)) {
        forged += 1;
        return route.continue({ postData: body.replace(pickedId, FORGED_MODEL) });
      }
      return route.continue();
    });
    await edit.getByLabel("Instructions").fill("Answer briefly, forged save.");
    await edit.getByRole("button", { name: "Save agent" }).click();
    // The refused action must surface an error and the stored model must be untouched.
    await expect.poll(() => forged, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
    expect(await storedModel(db, name), "a model outside the catalog is refused server-side").toBe(pickedId);
    await page.unroute("**/*");

    // A stored model that is no longer offered stays visible and is kept when something else is edited.
    await db.query("UPDATE compass_dev.agents SET model = $2 WHERE name = $1", [name, STALE_MODEL]);
    await page.reload();
    await page.locator("li").filter({ hasText: name }).getByRole("button", { name: `Edit ${name}` }).click();
    const stale = page.getByRole("form", { name: `Edit ${name}` });
    await expect(stale.getByTestId("model-selected")).toContainText(`${STALE_MODEL} (no longer offered)`);
    await stale.getByLabel("Instructions").fill("Answer briefly, stale model kept.");
    await stale.getByRole("button", { name: "Save agent" }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` })).toHaveCount(0, { timeout: 15_000 });
    expect(await storedModel(db, name), "an unchanged stale model is not wiped by an unrelated edit").toBe(STALE_MODEL);

    // 390px phone: the picker does not overflow the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator("li").filter({ hasText: name }).getByRole("button", { name: `Edit ${name}` }).click();
    await expect(page.getByRole("form", { name: `Edit ${name}` }).getByRole("searchbox", { name: "Search models" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await db.query("DELETE FROM compass_dev.agents WHERE name = ANY($1)", [[name, staleName]]).catch(() => undefined);
    await db.end();
  }
});

test("claude harness: the Model field stays the curated list and explains why", async ({ page, base }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const form = await openNewAgentForm(page, base);
  const searchable = (await form.getByRole("searchbox", { name: "Search models" }).count()) > 0;
  test.skip(searchable, "Server runs the opencode harness: the catalog picker is rendered instead (covered by the test above).");
  const select = form.getByLabel("Model");
  await expect(select).toHaveJSProperty("tagName", "SELECT");
  await expect(select.locator("option").first()).toHaveText("System default");
  await expect(form.getByText(/Only Claude models can be used here/)).toBeVisible();
  await expect(form.getByText(/opencode harness/)).toBeVisible();
  // Only the curated entries (default + built-ins + COMPASS_CLOUD_AGENT_MODELS), never a few hundred catalog rows.
  expect(await select.locator("option").count()).toBeLessThanOrEqual(6);
});
