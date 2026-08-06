/**
 * Discovery Rail functional spec.
 *
 * Journey: Create two opportunities in different statuses → open one's
 *          detail page → rail lists both grouped by status → search filters
 *          the list → click the other opportunity → URL + detail content
 *          update and the rail's search text AND expanded-group state
 *          survive the navigation (the core "don't lose context" behavior).
 *
 * A second test exercises the mobile entry point: the rail renders as a
 * right-side panel (client-fetched via app/api/panels/discovery-rail),
 * opened from the mobile header's "Browse" trigger.
 */
import { test, expect } from "../fixtures/index";

test.describe("Discovery Rail", () => {
  test("rail lists opportunities, filters by search, and survives navigation", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const oppTitleA = `E2E Rail Opp A ${ts}`;
    const oppTitleB = `E2E Rail Opp B ${ts}`;
    const oppTitleC = `E2E Rail Opp C Archived ${ts}`;

    // ── 1. Create three opportunities in different status columns ─────────
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(oppTitleA);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(oppTitleA)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Add opportunity/i }).nth(1).click();
    await page.getByLabel("Title").fill(oppTitleB);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(oppTitleB)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(oppTitleC);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(oppTitleC)).toBeVisible({ timeout: 15_000 });

    // Archive opportunity C via its board card menu so the rail has a
    // non-empty, collapsed-by-default "Archived" group to expand later.
    // Scope to the specific card so ".first()" can't hit a different one —
    // the menu trigger is only visually hidden (opacity-0), not removed
    // from the accessibility tree, so an unscoped lookup would be ambiguous.
    const cardC = page
      .locator("div.group", { has: page.getByRole("button", { name: oppTitleC, exact: true }) })
      .first();
    await cardC.getByRole("button", { name: "Card actions" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: oppTitleC, exact: true })).not.toBeVisible({
      timeout: 15_000,
    });

    // ── 2. Open opportunity A's detail page — rail appears ─────────────────
    await page.getByRole("button", { name: oppTitleA, exact: true }).click();
    await page.getByRole("link", { name: "Open full page" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: oppTitleA })).toBeVisible();

    const search = page.getByPlaceholder("Search opportunities…");
    await expect(search).toBeVisible();
    await expect(page.getByRole("link", { name: oppTitleA })).toBeVisible();
    await expect(page.getByRole("link", { name: oppTitleB })).toBeVisible();

    // ── 3. Expand the Archived group (search still empty, so it's present) ──
    // Scoped via the summary's own text rather than an anchored regex — the
    // "▶" indicator glyph shares a wrapping <span> with the "Archived (n)"
    // text, so an exact/anchored match against the combined text would never
    // hit an element cleanly.
    const archivedDetails = page
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "Archived" }) });
    const archivedSummary = archivedDetails.locator("summary");
    await expect(archivedSummary).toBeVisible();
    await expect(archivedDetails).not.toHaveAttribute("open", "");
    await archivedSummary.click();
    await expect(archivedDetails).toHaveAttribute("open", "");

    // ── 4. Click the other opportunity — navigates without losing the ──────
    //      expanded-group state (search is still empty at this point).
    await page.getByRole("link", { name: oppTitleB }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: oppTitleB })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${base}/discovery/[^/]+$`));
    await expect(archivedDetails).toHaveAttribute("open", "");

    // ── 5. Search filters the list live ─────────────────────────────────────
    const searchTermA = oppTitleA.slice(0, 20);
    await search.fill(searchTermA);
    await expect(page.getByRole("link", { name: oppTitleA })).toBeVisible();
    await expect(page.getByRole("link", { name: oppTitleB })).not.toBeVisible();

    // ── 6. Click the filtered-to opportunity — search text (and value) ─────
    //      survives this second navigation too.
    await page.getByRole("link", { name: oppTitleA }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: oppTitleA })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${base}/discovery/[^/]+$`));
    await expect(search).toHaveValue(searchTermA);
    await expect(page.getByRole("link", { name: oppTitleA })).toBeVisible();
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("rail opens as a right-side panel and navigates", async ({ page, base }) => {
      const ts = Date.now();
      const oppTitleA = `E2E Rail Mobile A ${ts}`;
      const oppTitleB = `E2E Rail Mobile B ${ts}`;

      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: /Add opportunity/i }).first().click();
      await page.getByLabel("Title").fill(oppTitleA);
      await page.getByRole("button", { name: "Create Opportunity" }).click();
      await expect(page.getByText(oppTitleA)).toBeVisible({ timeout: 15_000 });

      await page.getByRole("button", { name: /Add opportunity/i }).nth(1).click();
      await page.getByLabel("Title").fill(oppTitleB);
      await page.getByRole("button", { name: "Create Opportunity" }).click();
      await expect(page.getByText(oppTitleB)).toBeVisible({ timeout: 15_000 });

      await page.getByRole("button", { name: oppTitleA, exact: true }).click();
      await page.getByRole("link", { name: "Open full page" }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitleA })).toBeVisible();

      // Open the mobile panel via the header's "Browse" trigger.
      await page.getByRole("button", { name: "Browse opportunities" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("link", { name: oppTitleB })).toBeVisible({
        timeout: 10_000,
      });

      // Clicking the other opportunity navigates and closes the panel.
      await dialog.getByRole("link", { name: oppTitleB }).click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: oppTitleB })).toBeVisible();
      await expect(dialog).not.toBeVisible();
    });
  });
});
