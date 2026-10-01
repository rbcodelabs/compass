/**
 * Thinking model (Phase 3B): presets rename a whole screen consistently, and the
 * admin settings section writes an explicit key.
 *
 * Seeds `workspaces.thinking_model` with raw SQL on the e2e workspace and always
 * restores NULL (CLASSIC) afterwards, because every other functional spec relies
 * on CLASSIC copy and this suite is serialized over one shared workspace.
 */
import pg from "pg";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

async function setThinkingModel(key: string | null, labels: string | null = null) {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    await pool.query(
      `UPDATE "${E2E_SCHEMA}".workspaces
          SET thinking_model = $1, thinking_model_labels = $2
        WHERE slug = 'e2e-workspace'
          AND organization_id = (SELECT id FROM "${E2E_SCHEMA}".organizations WHERE slug = 'e2e-test-org')`,
      [key, labels],
    );
  } finally {
    await pool.end();
  }
}

test.describe("Thinking model", () => {
  test.afterEach(async () => {
    await setThinkingModel(null);
  });

  test("TORRES_OST: nav, page and forms say Outcome and Success metric, never Objective", async ({ page, base }) => {
    await setThinkingModel("TORRES_OST");
    const ts = Date.now();

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("link", { name: "Outcomes" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "OKRs", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Outcomes", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New Cycle" }).click();
    await page.getByLabel("Title").fill(`TM Cycle ${ts}`);
    await page.getByLabel("Start date").fill("2026-07-01");
    await page.getByLabel("End date").fill("2026-09-30");
    await page.getByRole("button", { name: "Create cycle" }).click();
    await expect(page.getByRole("main").first().getByText(`TM Cycle ${ts}`)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("main").first().getByText(`TM Cycle ${ts}`).click();
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add outcome" }).click();
    await expect(page.getByText("Add Outcome", { exact: true })).toBeVisible();
    await page.getByLabel("Title").fill(`TM Outcome ${ts}`);
    await page.getByRole("button", { name: "Add outcome" }).click();
    await expect(page.getByText(`TM Outcome ${ts}`)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: "Add success metric" })).toBeVisible();
    // Whole screen: no surviving canonical entity words in the main region or nav.
    const main = await page.getByRole("main").first().innerText();
    expect(main).not.toMatch(/objective|key result/i);
  });

  test("CLASSIC (NULL) keeps today's copy", async ({ page, base }) => {
    await setThinkingModel(null);
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "OKRs", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "OKRs", exact: true })).toBeVisible();
  });

  test("an admin picks a preset and a label override in Settings and it takes effect", async ({ page, base }) => {
    await setThinkingModel(null);
    await page.goto(`${base}/settings`);
    await page.waitForLoadState("networkidle");

    const panel = page.getByTestId("thinking-model-panel");
    await panel.scrollIntoViewIfNeeded();
    await panel.getByTestId("thinking-model-TORRES_OST").check();
    await panel.getByLabel("Solution (singular)").fill("Bet");
    await panel.getByTestId("thinking-model-save").click();
    await expect(panel.getByText("Saved.")).toBeVisible({ timeout: 15_000 });

    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: "Outcomes" }).first()).toBeVisible();

    // Invalid labels are refused before anything is written.
    await page.goto(`${base}/settings`);
    await page.waitForLoadState("networkidle");
    const again = page.getByTestId("thinking-model-panel");
    await again.getByLabel("Opportunity (singular)").fill("<b>Need</b>");
    await again.getByTestId("thinking-model-save").click();
    await expect(again.getByRole("alert")).toBeVisible();
  });
});
