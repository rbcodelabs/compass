import { test, expect } from "../fixtures/index";

// The Metrics dashboard reuses the same Vercel connection as the analytics
// suite; connecting is defensive here too (another spec file in this run may
// have already connected it against the shared local database).
test.describe("Metrics dashboard", () => {
  test("lists metrics, creates one, edits it, resizes via the card menu, and archives it", async ({ page, base }) => {
    const metricName = `E2E Dashboard Metric ${Date.now()}`;
    const renamedMetricName = `${metricName} (renamed)`;

    await page.goto(`${base}/settings`);
    const connectionButton = page.getByRole("button", { name: /^(Connect Vercel|Manage)$/ });
    await connectionButton.click();
    const connectionDialog = page.getByRole("dialog", { name: "Vercel connection" });
    const projectId = connectionDialog.getByLabel("Project ID", { exact: true });
    if (await projectId.isEditable()) await projectId.fill("prj_compass_e2e");
    await connectionDialog.getByLabel("Access token", { exact: true }).fill("compass-e2e-token");
    await connectionDialog.getByRole("button", { name: "Validate & save" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();

    // Page loads and lists metrics.
    await page.goto(`${base}/metrics`);
    await expect(page.getByTestId("metrics-summary")).toBeVisible();
    await expect(page.getByTestId("metrics-grid").or(page.getByRole("button", { name: "Create your first metric" }))).toBeVisible();

    // Create a metric from the new page.
    await page.getByRole("button", { name: "New metric", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create metric" });
    await createDialog.getByLabel("Name", { exact: true }).fill(metricName);
    await createDialog.getByLabel("Measure", { exact: true }).selectOption("pageviews");
    await createDialog.getByLabel("Unit", { exact: true }).fill("views");
    await createDialog.getByRole("button", { name: "Create metric", exact: true }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 30_000 });
    const card = page.getByTestId("metric-card").filter({ hasText: metricName });
    await expect(card).toBeVisible();
    // A brand-new metric is fresh, not a silent zero.
    await expect(card.getByText("Fresh", { exact: true })).toBeVisible();

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
});
