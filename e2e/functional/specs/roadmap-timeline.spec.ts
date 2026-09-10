import { test, expect } from "../fixtures/index";

test("dated and undated items support native zoom, date editing and Board roundtrips", async ({ page, base }) => {
  const prefix = `E2E Timeline ${Date.now()}`;
  const month = new Date().toISOString().slice(0, 7);
  const start = `${month}-05`;
  const end = `${month}-25`;
  await page.goto(`${base}/roadmap`);
  for (const [title, dated] of [[`${prefix} dated`, true], [`${prefix} undated`, false]] as const) {
    await page.getByRole("button", { name: "Add item", exact: true }).nth(1).click();
    await page.getByLabel("Title", { exact: true }).fill(title);
    if (dated) {
      await page.getByLabel("Start date (optional)").fill(start);
      await page.getByLabel("End date (optional)").fill(end);
    }
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(page.getByTestId("timeline-engine-native")).toBeVisible();
  for (const zoom of ["Quarter", "Month"]) {
    await page.getByRole("button", { name: zoom, exact: true }).click();
    await expect(page.getByRole("button", { name: zoom, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: `Edit dates for ${prefix} undated`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Start", { exact: true }).fill(start);
  await dialog.getByLabel("End", { exact: true }).fill(end);
  await dialog.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Reload timeline" }).click();
  await page.getByRole("button", { name: `Edit dates for ${prefix} undated`, exact: true }).click();
  await expect(dialog.getByLabel("Start", { exact: true })).toHaveValue(start);
  await expect(dialog.getByLabel("End", { exact: true })).toHaveValue(end);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(page.getByText(`${prefix} dated`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${prefix} undated`, { exact: true })).toBeVisible();
});
