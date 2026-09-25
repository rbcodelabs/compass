/**
 * Assumption ↔ Experiment linking functional spec.
 *
 * Journey: Create opportunity → solution → assumption → click "Test this
 *          assumption" CTA on the OST tree → land on Experiments with the
 *          assumption picker pre-filled → create the experiment → verify
 *          the OST tree now shows the linked experiment under the
 *          assumption instead of "No experiments yet".
 *
 * This exercises the UI-layer gap the createExperiment server action already
 * supported (assumptionId has been wired end-to-end since the action was
 * written — see __tests__/actions/experiments.test.ts) but that no UI
 * surface ever collected before this feature: the OST tree had no CTA to
 * start a linked experiment, and create-experiment-form had no assumption
 * picker at all.
 */
import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

test.describe("Assumption ↔ Experiment linking", () => {
  test(
    "test this assumption CTA pre-fills the experiment form and links back",
    async ({ page, base }) => {
      const ts = Date.now();
      const oppTitle = `E2E AEL Opportunity ${ts}`;
      const solTitle = `E2E AEL Solution ${ts}`;
      const assumptionTitle = `E2E AEL Assumption ${ts}`;
      const expTitle = `E2E AEL Experiment ${ts}`;

      // ── 1. Create an opportunity ──────────────────────────────────────────
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await createOpportunityFromBoard(page, oppTitle);
      await expect(page.getByText(oppTitle)).toBeVisible({ timeout: 15_000 });

      await page.getByRole("button", { name: oppTitle, exact: true }).click();
      await page.getByRole("link", { name: "Open full page" }).click();
      await expect(page).toHaveURL(new RegExp(`${base}/discovery/[0-9a-f-]{36}$`));
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitle })).toBeVisible();

      // ── 2. Add a solution ─────────────────────────────────────────────────
      await page.getByRole("button", { name: "Add Solution" }).click();
      await page.getByLabel("Title").fill(solTitle);
      await page.getByRole("button", { name: "Add Solution" }).last().click();
      await expect(page.getByText(solTitle)).toBeVisible({ timeout: 10_000 });

      // ── 3. Open the solution's sidebar panel and add an assumption ─────────
      // Assumption management moved off the (now-compact, non-expanding)
      // solution card into the Solution panel — see solution-panel.tsx.
      await page.getByRole("button", { name: solTitle, exact: true }).click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Add Assumption" }).click();
      await panel.getByPlaceholder("Assumption title").fill(assumptionTitle);
      await panel.getByRole("button", { name: "Add", exact: true }).click();

      // The panel refetches its own data after adding (no reload needed), so
      // the new assumption shows up in place.
      await expect(panel.getByText(assumptionTitle).first()).toBeVisible({ timeout: 10_000 });

      // ── 4. Switch to the OST Tree tab ──────────────────────────────────────
      // The OST Tree tab reads page-level (server-rendered) data captured at
      // the initial page load, not the panel's client-fetched data — reload
      // so it reflects the assumption just added via the panel.
      // Close the panel FIRST: panel-context.tsx makes the URL the single
      // source of truth for what's open, so reloading with the panel param
      // still on the URL just reopens the (modal) sheet, which then covers
      // the tabs underneath. Esc closes via router.replace(), dropping the
      // param, so the subsequent reload comes back with no panel open.
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible({ timeout: 10_000 });

      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: "OST", exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: "OST", exact: true }).getByText(assumptionTitle)).toBeVisible({ timeout: 10_000 });

      // "No experiments yet" + the new CTA should be visible for this
      // brand-new, unlinked assumption.
      await expect(page.getByText("No experiments yet")).toBeVisible();
      const cta = page.getByRole("link", { name: "Test this assumption →" });
      await expect(cta).toBeVisible();

      // ── 5. Follow the CTA to the Experiments page ──────────────────────────
      await cta.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/experiments\?assumptionId=/);

      // The create-experiment form should already be open (prefilled), with
      // the assumption picker showing our assumption pre-selected.
      await expect(page.getByText("New Experiment")).toBeVisible();
      await expect(
        page.getByRole("combobox").filter({ hasText: assumptionTitle })
      ).toBeVisible({ timeout: 10_000 });

      // ── 6. Fill in and submit the experiment ────────────────────────────────
      await page.getByLabel("Title").fill(expTitle);
      await page.getByLabel("Hypothesis").fill("We believe linking assumptions works.");
      await page.getByLabel("Method").fill("Manual QA pass.");
      await page.getByLabel("Kill Condition").fill("Abandon if the link never appears.");
      await page.getByRole("button", { name: "Create Experiment" }).click();

      await expect(page.getByText(expTitle)).toBeVisible({ timeout: 15_000 });

      // ── 7. Verify the OST tree now shows the linked experiment ─────────────
      await page.goto(`${base}/discovery`);
      await page.getByRole("button", { name: oppTitle, exact: true }).click();
      await page.getByRole("link", { name: "Open full page" }).click();
      await expect(page).toHaveURL(new RegExp(`${base}/discovery/[0-9a-f-]{36}$`));
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: "OST", exact: true }).click();

      await expect(page.getByText(assumptionTitle)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("link", { name: expTitle })).toBeVisible({
        timeout: 10_000,
      });
    }
  );
});
