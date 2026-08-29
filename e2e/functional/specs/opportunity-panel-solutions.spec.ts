/**
 * Opportunity panel → Solutions functional spec.
 *
 * Journey: create an opportunity on the Discovery board → open its sidebar
 *          panel → add a solution *from the panel* → confirm it appears in the
 *          list and bumps the section count without reopening the panel →
 *          click the solution row to hop to the Solution panel.
 *
 * Covers three things the opportunity panel could not do before:
 *
 *   1. Adding a solution at all (previously full-page only).
 *   2. Refreshing its own list afterwards. The panel fetches client-side, so
 *      `revalidatePath` alone left the list and the "Solutions (N)" count stale
 *      until the panel was closed and reopened — the same class of bug as the
 *      Plan & Discussion count fixed in #120.
 *   3. Navigating to a solution. Solutions used to render as plain text, a
 *      dead end, even though solution → opportunity already worked.
 */
import { test, expect } from "../fixtures/index";

test.describe("Opportunity panel — solutions", () => {
  test("add a solution from the panel, list and count update, row opens the solution panel", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const oppTitle = `E2E OppPanel Opportunity ${ts}`;
    const solTitle = `E2E OppPanel Solution ${ts}`;

    // ── 1. Create an opportunity ──────────────────────────────────────────
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(oppTitle);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

    // ── 2. Open its sidebar panel ─────────────────────────────────────────
    await page.getByRole("button", { name: oppTitle, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/detail=opportunity/);

    // Empty state before anything is added.
    await expect(panel.getByText("No solutions yet.")).toBeVisible();

    // ── 3. Add a solution from inside the panel ───────────────────────────
    await panel.getByRole("button", { name: "Add Solution" }).click();
    // Scoped to the panel: the opportunity full page renders its own
    // AddSolutionForm, and both can be mounted at once (the form gives each
    // instance a useId()-derived input id precisely so they don't collide).
    await panel.getByLabel("Title").fill(solTitle);
    await panel.getByRole("button", { name: "Add Solution" }).click();

    // ── 4. The panel refetches — no reopen needed ─────────────────────────
    await expect(panel.getByText(solTitle)).toBeVisible({ timeout: 15_000 });
    // Section count reflects the new solution. This is the assertion that
    // fails if onAdded/refresh is ever dropped.
    await expect(panel.getByText("(1)", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(panel.getByText("No solutions yet.")).not.toBeVisible();

    // Status renders as a friendly label, not the raw enum.
    await expect(panel.getByText("Idea", { exact: true })).toBeVisible();

    // ── 5. The solution row is a hop, not dead text ───────────────────────
    await panel.getByRole("button", { name: new RegExp(solTitle) }).click();
    await expect(page).toHaveURL(/detail=solution/, { timeout: 10_000 });
    await expect(panel.getByRole("heading", { name: "Solution" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(panel.getByText(solTitle)).toBeVisible();
  });
});
