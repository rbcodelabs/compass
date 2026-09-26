import pg from "pg";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { Page } from "@playwright/test";

async function seed(kind: "opportunities" | "tasks" | "roadmap_items", description = "Research context") {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [workspace] } = await pool.query("SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'");
    const title = "Turn customer signals into a clear next step";
    const { rows: [item] } = await pool.query(
      `INSERT INTO compass_dev.${kind} (id,workspace_id,title,description) VALUES (gen_random_uuid(),$1,$2,$3) RETURNING id`,
      [workspace.id, title, description],
    );
    return { id: item.id as string, title };
  } finally { await pool.end(); }
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `public/screenshots/docs/markdown-description-${name}.png`, fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
}

test("rich description persists; cancel and failed save preserve the right draft", async ({ page, base }) => {
  const item = await seed("opportunities");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/discovery?detail=opportunity:${item.id}`);
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  const rich = page.getByRole("textbox", { name: "Description", exact: true });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  let patchRequests = 0;
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().includes(`/api/panels/entity/opportunity/${item.id}`)) patchRequests += 1;
  });
  await rich.fill("A shared understanding");
  await page.getByRole("button", { name: "Markdown", exact: true }).focus();
  expect(patchRequests).toBe(0);
  await expect(rich).toBeVisible();
  await rich.focus();
  await rich.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rich).toHaveCount(0);
  await page.reload();
  await expect(page.locator("strong").filter({ hasText: "A shared understanding" })).toBeVisible();
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await rich.fill("Discard this draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Discard this draft", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await rich.fill("Keep this draft for retry");
  let reject = true;
  await page.route("**/api/panels/entity/opportunity/**", async route => {
    if (route.request().method() === "PATCH" && reject) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Please retry"}' });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(rich).toHaveText("Keep this draft for retry");
  reject = false;
  await rich.press("ControlOrMeta+Enter");
  await expect(rich).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Keep this draft for retry", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("source tables round trip and editor fits desktop, narrow pinned panel and mobile", async ({ page, base }) => {
  const item = await seed("opportunities");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/discovery?detail=opportunity:${item.id}`);
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Description Markdown source", exact: true });
  await source.fill("## Evidence\n\n| Signal | Next step |\n| --- | --- |\n| Unclear handoff | Test a shared recap |");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("cell", { name: "Test a shared recap", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  await capture(page, "desktop");
  await page.getByRole("button", { name: "Pin panel", exact: true }).click();
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await page.getByRole("separator", { name: "Resize panel" }).press("Home");
  await expect(page.locator('[data-slot="pinned-panel"]')).toHaveCSS("width", "320px");
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, "narrow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, "mobile");
});

test("full-page Task keeps image and HTML source intact", async ({ page, base }) => {
  const original = "## Research\n\n![Flow](https://example.test/flow.png)\n\n<details>Interview notes</details>";
  const item = await seed("tasks", original);
  await page.goto(`${base}/tasks/${item.id}`);
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Description Markdown source", exact: true });
  await expect(source).toHaveValue(original);
  await expect(page.getByRole("button", { name: "Rich", exact: true })).toBeDisabled();
  await source.fill(original + "\n\nFollow up this week.");
  await capture(page, "task-source");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(source).toHaveValue(original + "\n\nFollow up this week.");
});

test("Roadmap dialog saves description in its existing transaction", async ({ page, base }) => {
  const item = await seed("roadmap_items");
  await page.goto(`${base}/roadmap`);
  const card = page.locator('[data-slot="card"]').filter({ has: page.getByRole("button", { name: item.title, exact: true }) });
  await card.hover();
  await card.getByRole("button", { name: "Card actions" }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Description Markdown source", exact: true }).fill("## Shared learning\n\n**One experiment** this week.");
  await capture(page, "roadmap");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: item.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared learning", exact: true })).toBeVisible();
});
