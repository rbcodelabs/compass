import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

// The Metrics dashboard reuses the same Vercel connection as the analytics
// suite; connecting is defensive here too (another spec file in this run may
// have already connected it against the shared local database).
async function connectVercel(page: Page, base: string) {
  await page.goto(`${base}/settings`);
  const connectionButton = page.getByRole("button", { name: /^(Connect Vercel|Manage)$/ });
  await connectionButton.click();
  const connectionDialog = page.getByRole("dialog", { name: "Vercel connection" });
  const projectId = connectionDialog.getByLabel("Project ID", { exact: true });
  if (await projectId.isEditable()) await projectId.fill("prj_compass_e2e");
  await connectionDialog.getByLabel("Access token", { exact: true }).fill("compass-e2e-token");
  await connectionDialog.getByRole("button", { name: "Validate & save" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
}

async function createMetric(page: Page, name: string) {
  await page.getByRole("button", { name: "New metric", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Create metric" });
  await createDialog.getByLabel("Name", { exact: true }).fill(name);
  await createDialog.getByLabel("Measure", { exact: true }).selectOption("pageviews");
  await createDialog.getByLabel("Unit", { exact: true }).fill("views");
  await createDialog.getByRole("button", { name: "Create metric", exact: true }).click();
  await expect(createDialog).not.toBeVisible({ timeout: 30_000 });
}

/**
 * Simulates a real native HTML5 drag-and-drop (dragstart -> dragover -> drop
 * -> dragend) with a DataTransfer shared across all four events, exactly as
 * a browser's own native drag gesture would. Deliberately not `page.mouse`
 * moves: this component uses the browser's native `draggable` attribute
 * (not a pointer-based DnD library), and only real dragstart/dragover/drop
 * events reach its onDragStart/onDragOver/onDrop handlers.
 */
async function nativeDrag(page: Page, source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
}

async function cardOrder(page: Page): Promise<(string | null)[]> {
  return page.getByTestId("metric-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-metric-name")));
}

test.describe("Metrics dashboard", () => {
  test("lists metrics, creates one, edits it, resizes via the card menu, and archives it", async ({ page, base }) => {
    const metricName = `E2E Dashboard Metric ${Date.now()}`;
    const renamedMetricName = `${metricName} (renamed)`;

    await connectVercel(page, base);

    // Page loads and lists metrics.
    await page.goto(`${base}/metrics`);
    await expect(page.getByTestId("metrics-summary")).toBeVisible();
    await expect(page.getByTestId("metrics-grid").or(page.getByRole("button", { name: "Create your first metric" }))).toBeVisible();

    // Create a metric from the new page.
    await createMetric(page, metricName);
    const card = page.getByTestId("metric-card").filter({ hasText: metricName });
    await expect(card).toBeVisible();
    // A brand-new metric is fresh, not a silent zero, and its unsynced value
    // must not show the "last sync failed" copy reserved for a real failure
    // (a fresh, never-synced metric and a failed one both have a null value,
    // but only one of them has actually failed anything).
    await expect(card.getByText("Fresh", { exact: true })).toBeVisible();
    await expect(card.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(card.getByText("Unavailable — last sync failed", { exact: true })).toHaveCount(0);

    // Edit it.
    await card.getByRole("button", { name: `${metricName} card options` }).click();
    await page.getByRole("menuitem", { name: "Edit metric" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit metric" });
    const nameField = editDialog.getByLabel("Name", { exact: true });
    await nameField.fill("");
    await nameField.fill(renamedMetricName);
    await editDialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(editDialog).not.toBeVisible({ timeout: 30_000 });
    const renamedCard = page.getByTestId("metric-card").filter({ hasText: renamedMetricName });
    await expect(renamedCard).toBeVisible();

    // Resize via the card menu (S/M/L), not raw pointer drag.
    await renamedCard.getByRole("button", { name: `${renamedMetricName} card options` }).click();
    await page.getByTestId("resize-lg").click();
    await expect(renamedCard).toHaveAttribute("data-size", "lg");
    await page.keyboard.press("Escape");

    // Archive it — the metric leaves the dashboard, per the confirm copy.
    await renamedCard.getByRole("button", { name: `${renamedMetricName} card options` }).click();
    await page.getByRole("menuitem", { name: "Archive metric" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Archive metric", exact: true }).click();
    await expect(confirm).not.toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("metric-card").filter({ hasText: renamedMetricName })).toHaveCount(0);
  });

  test("drag-to-reorder updates the visual order and persists it, without crashing the page", async ({ page, base }) => {
    // Regression test for a startTransition() call that was nested inside the
    // setMetrics() functional updater in onDrop: React invokes that updater
    // during the render phase, so calling startTransition from inside it threw
    // "Cannot call startTransition while rendering", cascading into "Cannot
    // update a component (Router) while rendering a different component" and
    // tripping Next's error boundary. Only a real native drag exercises this
    // — clicks and the card menu never touch onDrop at all.
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

    await connectVercel(page, base);

    const nameA = `E2E Drag A ${Date.now()}`;
    const nameB = `E2E Drag B ${Date.now()}`;
    await page.goto(`${base}/metrics`);
    await createMetric(page, nameA);
    await createMetric(page, nameB);

    const cardA = page.getByTestId("metric-card").filter({ hasText: nameA });
    const cardB = page.getByTestId("metric-card").filter({ hasText: nameB });
    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();

    // New metrics are appended, so A (created first) renders before B.
    const before = await cardOrder(page);
    expect(before.indexOf(nameA)).toBeLessThan(before.indexOf(nameB));

    await nativeDrag(page, cardA.getByTestId("metric-card-drag-handle"), cardB);

    // The page must still be alive and interactive. This is the actual bug:
    // a render-phase exception took the whole page down here before anything
    // about the resulting order could even be checked.
    await expect(page.getByTestId("metrics-summary")).toBeVisible();
    await expect(page.getByTestId("metrics-grid")).toBeVisible();
    expect(pageErrors, "uncaught page errors during drag-reorder").toEqual([]);
    const renderErrors = consoleErrors.filter((message) => /Cannot update a component|Cannot call startTransition|while rendering/i.test(message));
    expect(renderErrors, "React render-phase errors during drag-reorder").toEqual([]);

    // Dropping A onto B moves A to just after B.
    const after = await cardOrder(page);
    expect(after.indexOf(nameB)).toBeLessThan(after.indexOf(nameA));

    // Persisted server-side, not just optimistic client state.
    await page.reload();
    const afterReload = await cardOrder(page);
    expect(afterReload.indexOf(nameB)).toBeLessThan(afterReload.indexOf(nameA));
  });
});
