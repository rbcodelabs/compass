import { test, expect } from "../fixtures/index";

// The server fixture is available only against the isolated local E2E database.
// Browser tests never contact Vercel or enable production collection.
test.describe("Analytics measurements", () => {
  test("connect, define, link, refresh, and preserve evidence after disconnect", async ({ page, base }) => {
    const metricName = `E2E Daily Visitors ${Date.now()}`;
    const experimentName = `E2E Measured Experiment ${Date.now()}`;
    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Connect Vercel" }).click();
    await page.getByLabel("Project ID", { exact: true }).fill("prj_compass_e2e");
    await page.getByLabel("Access token", { exact: true }).fill("compass-e2e-token");
    await page.getByRole("button", { name: "Validate & save" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();

    // Metric definitions are created on the standalone Metrics page, not Settings.
    await page.goto(`${base}/metrics`);
    await page.getByRole("button", { name: "New metric", exact: true }).click();
    const metricDialog = page.getByRole("dialog");
    await metricDialog.getByLabel("Name", { exact: true }).fill(metricName);
    await metricDialog.getByLabel("Measure", { exact: true }).selectOption("daily_visitors");
    await metricDialog.getByLabel("Unit", { exact: true }).fill("visitors");
    await metricDialog.getByRole("button", { name: "Create metric", exact: true }).click();
    await expect(metricDialog).not.toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("metric-card").filter({ hasText: metricName })).toBeVisible();

    await page.goto(`${base}/experiments`);
    await page.getByRole("button", { name: "New Experiment" }).click();
    await page.getByLabel("Title", { exact: true }).fill(experimentName);
    await page.getByLabel("Hypothesis").fill("A clearer result prompt increases recorded learning.");
    await page.getByLabel("Method").fill("Compare two explicit production windows.");
    await page.getByLabel("Kill Condition").fill("Stop if recorded learning declines.");
    await page.getByRole("button", { name: "Create Experiment" }).click();
    await page.getByRole("button", { name: experimentName, exact: true }).click();
    const fullPageHref = await page.getByRole("link", { name: "Open full page" }).getAttribute("href");
    expect(fullPageHref).toBeTruthy();
    // A direct visit exercises the full record rather than the intercepted panel route.
    await page.goto(fullPageHref!);
    const experimentUrl = page.url();
    await page.getByRole("button", { name: "Link metric", exact: true }).click();
    const linkDialog = page.getByRole("dialog");
    await linkDialog.getByLabel("Metric", { exact: true }).selectOption({ label: metricName });
    await expect(linkDialog.getByRole("radio", { name: "Track over time" })).toBeChecked();
    await expect(linkDialog.getByLabel("Baseline from")).toHaveCount(0);
    await linkDialog.getByRole("button", { name: "Link metric", exact: true }).click();
    const measurement = page.getByTestId("metric-measurement").filter({ hasText: metricName });
    await measurement.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(measurement.getByText("Complete", { exact: true }).first()).toBeVisible();
    await expect(measurement.getByText("Baseline", { exact: true })).toHaveCount(0);
    await expect(measurement.getByText("Follow-up", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Designing", { exact: true }).first()).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await measurement.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "public/screenshots/docs/analytics-tracking-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await measurement.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "public/screenshots/docs/analytics-tracking-mobile.png" });

    await measurement.getByRole("button", { name: /Compare periods/ }).click();
    await linkDialog.getByRole("button", { name: /Save comparison/ }).click();
    await expect(linkDialog.getByRole("alert").first()).toBeVisible();
    await linkDialog.getByLabel("Baseline from").fill("2026-09-02");
    await linkDialog.getByLabel("Baseline through").fill("2026-09-01");
    await linkDialog.getByLabel("Follow-up from").fill("2026-09-09");
    await linkDialog.getByLabel("Follow-up through").fill("2026-09-15");
    await linkDialog.getByRole("button", { name: /Save comparison/ }).click();
    await expect(linkDialog.getByRole("alert").first()).toBeVisible();
    await linkDialog.getByLabel("Baseline through").fill("2026-12-31");
    await linkDialog.getByRole("button", { name: /Save comparison/ }).click();
    await expect(linkDialog.getByRole("alert").first()).toBeVisible();
    await linkDialog.getByLabel("Baseline through").fill("2026-09-08");
    await linkDialog.getByLabel("Follow-up from").fill("2026-09-09");
    await linkDialog.getByLabel("Follow-up through").fill("2026-09-15");
    await linkDialog.getByRole("button", { name: /Save comparison/ }).click();
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

  test("mobile settings keeps the Vercel connection dialog usable without horizontal overflow", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/settings`);

    const analyticsHeading = page.getByRole("heading", { name: "Analytics", exact: true });
    await analyticsHeading.scrollIntoViewIfNeeded();
    await expect(analyticsHeading).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: /^(Connect Vercel|Manage)$/ }).click();
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
  });
});
