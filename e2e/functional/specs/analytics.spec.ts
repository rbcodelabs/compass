import { test, expect } from "../fixtures/index";

// The server fixture is available only against the isolated local E2E database.
// Browser tests never contact Vercel or enable production collection.
test.describe("Analytics measurements", () => {
  test("connect, define, link, refresh, and preserve evidence after disconnect", async ({ page, base }) => {
    const metricName = `E2E Analytics Views ${Date.now()}`;
    const experimentName = `E2E Measured Experiment ${Date.now()}`;
    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Connect Vercel" }).click();
    await page.getByLabel("Project ID", { exact: true }).fill("prj_compass_e2e");
    await page.getByLabel("Access token", { exact: true }).fill("compass-e2e-token");
    await page.getByRole("button", { name: "Validate & save" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create metric", exact: true }).click();
    const metricDialog = page.getByRole("dialog");
    await metricDialog.getByLabel("Name", { exact: true }).fill(metricName);
    await metricDialog.getByRole("button", { name: "Save metric" }).click();
    await expect(page.getByText(metricName, { exact: true })).toBeVisible();

    await page.goto(`${base}/experiments`);
    await page.getByRole("button", { name: "New Experiment" }).click();
    await page.getByLabel("Title", { exact: true }).fill(experimentName);
    await page.getByLabel("Hypothesis").fill("A clearer result prompt increases recorded learning.");
    await page.getByLabel("Method").fill("Compare two explicit production windows.");
    await page.getByLabel("Kill Condition").fill("Stop if recorded learning declines.");
    await page.getByRole("button", { name: "Create Experiment" }).click();
    await page.getByRole("button", { name: experimentName, exact: true }).click();
    await page.getByRole("link", { name: "Open full page" }).click();
    const experimentUrl = page.url();
    await page.getByRole("button", { name: "Link metric", exact: true }).click();
    const linkDialog = page.getByRole("dialog");
    await linkDialog.getByLabel("Metric", { exact: true }).selectOption({ label: metricName });
    await linkDialog.getByLabel("Baseline from").fill("2026-09-02");
    await linkDialog.getByLabel("Baseline through").fill("2026-09-08");
    await linkDialog.getByLabel("Follow-up from").fill("2026-09-09");
    await linkDialog.getByLabel("Follow-up through").fill("2026-09-15");
    await linkDialog.getByRole("button", { name: "Link metric", exact: true }).click();
    const measurement = page.getByTestId("metric-measurement").filter({ hasText: metricName });
    await measurement.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(measurement.getByText("Complete", { exact: true }).first()).toBeVisible();
    await expect(measurement.getByText("Baseline", { exact: true })).toBeVisible();
    await expect(measurement.getByText("Follow-up", { exact: true })).toBeVisible();
    // Evidence collection must not conclude the experiment or create a result note.
    await expect(page.getByText("Designing", { exact: true }).first()).toBeVisible();

    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
    await page.goto(experimentUrl);
    await expect(measurement.getByText("Complete", { exact: true }).first()).toBeVisible();
    await measurement.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(measurement.getByRole("alert")).toBeVisible();
    await expect(measurement.getByText("Complete", { exact: true }).first()).toBeVisible();
  });

  test("mobile settings keeps analytics controls and dialogs usable without horizontal overflow", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/settings`);

    const analyticsHeading = page.getByRole("heading", { name: "Analytics", exact: true });
    await analyticsHeading.scrollIntoViewIfNeeded();
    await expect(analyticsHeading).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: "Connect Vercel", exact: true }).click();
    const connectionDialog = page.getByRole("dialog", { name: "Vercel connection" });
    await expect(connectionDialog).toBeVisible();
    const projectId = connectionDialog.getByLabel("Project ID", { exact: true });
    if (await projectId.isEditable()) await projectId.fill("prj_compass_e2e");
    else await expect(projectId).toHaveValue("prj_compass_e2e");
    await connectionDialog.getByLabel("Access token", { exact: true }).fill("compass-e2e-token");
    const validate = connectionDialog.getByRole("button", { name: "Validate & save" });
    await expect(validate).toBeVisible();
    const validateBox = await validate.boundingBox();
    expect(validateBox).not.toBeNull();
    expect((validateBox?.x ?? 0) + (validateBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await validate.click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create metric", exact: true }).click();
    const metricDialog = page.getByRole("dialog", { name: "Create metric" });
    await expect(metricDialog.getByLabel("Name", { exact: true })).toBeVisible();
    await expect(metricDialog.getByLabel("Measure", { exact: true })).toBeVisible();
    const save = metricDialog.getByRole("button", { name: "Save metric" });
    await expect(save).toBeVisible();
    const saveBox = await save.boundingBox();
    expect(saveBox).not.toBeNull();
    expect((saveBox?.x ?? 0) + (saveBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
