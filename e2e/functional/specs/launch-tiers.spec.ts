/**
 * Launch Tiers + Checklists + Positioning Brief functional spec.
 *
 * Journey (authenticated): add a roadmap item → open it via the card's
 *          "Launch" menu action → the roadmap-item panel's Launch section shows
 *          the tier picker → pick the Silent Launch tier (auto-seeds a 2-item
 *          checklist and moves the item to LAUNCHING) → the panel re-renders in
 *          the checklist state showing "0/2 done" → toggle the first item to
 *          Done → "1/2 done" → create the positioning brief → lands on the docs
 *          editor with the GTM template content → back on the board the card is
 *          in the Launching column with a "1/2" launch chip.
 *
 * Journey (public): enable the public roadmap, then in a fresh unauthenticated
 *          context confirm the item appears under the portal's "Launching"
 *          column.
 *
 * This is the first user-facing journey for the GTM launch UI (the feature
 * shipped MCP-only in PR #72), so it's a new spec. The launch surface reuses
 * the shared entity-detail panel rather than a bespoke panel type, so this
 * drives the same panel the detail-panel spec covers, just its Launch section.
 */
import { test, expect } from "../fixtures/index";

test.describe("Launch tiers, checklist & positioning brief", () => {
  test(
    "card Launch menu → tier picker auto-seeds → toggle item → brief → portal Launching column",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      const ts = Date.now();
      const itemTitle = `E2E Launch Item ${ts}`;

      // The roadmap board + panel both mount @dnd-kit, which emits a known,
      // pre-existing hydration-mismatch warning (see canvas/detail-panel specs)
      // — filter it so the spec still catches genuinely new console errors.
      const KNOWN = ["DndDescribedBy"];
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (KNOWN.some((s) => text.includes(s))) return;
        consoleErrors.push(text);
      });
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      const panel = page.locator('[data-slot="sheet-content"]');

      // ── 1. Add a roadmap item in the NOW column ────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add item" }).first().click();
      await page.getByLabel("Title").fill(itemTitle);
      // exact — otherwise this also matches the still-collapsed "Add item"
      // triggers in the other columns (substring, case-insensitive by default).
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      const card = page.locator('[data-slot="card"]').filter({ hasText: itemTitle });
      await expect(card).toBeVisible({ timeout: 10_000 });

      // ── 2. Open the panel via the card's "Launch" menu action ──────────────
      await card.hover();
      await card.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Launch" }).click();

      await expect(page).toHaveURL(/detail=roadmapItem/, { timeout: 10_000 });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(itemTitle);

      // ── 3. Launch section shows the tier picker; pick Silent Launch (2 items)
      const tierButton = panel.getByRole("button", { name: "Set launch tier: Silent Launch" });
      await expect(tierButton).toBeVisible();
      await tierButton.click();

      // The picker calls setLaunchTier (auto-seeds a checklist + flips the item
      // to LAUNCHING) then refreshes the panel into the checklist state.
      await expect(panel.getByText(/0\/2 done/)).toBeVisible({ timeout: 15_000 });

      // ── 4. Toggle the first checklist item to Done → progress becomes 1/2 ──
      // Target a checklist-item Select by its current "Pending" label rather
      // than positionally — the panel also renders the PanelTitle's horizon
      // status editor as a combobox, so a bare nth(0) could hit the wrong one.
      const firstStatus = panel.getByRole("combobox").filter({ hasText: "Pending" }).first();
      await expect(firstStatus).toBeEnabled({ timeout: 10_000 });
      await firstStatus.click();
      // base-ui renders the listbox in a portal the panel's Sheet stacks over,
      // so a pointer click on the option is intercepted by the overlay (the
      // same reason detail-panel.spec avoids driving in-panel Selects). Drive
      // the open Select via keyboard typeahead instead, which doesn't hit-test.
      await page.getByRole("option", { name: "Done" }).waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.type("Done");
      await page.keyboard.press("Enter");

      await expect(panel.getByText(/1\/2 done/)).toBeVisible({ timeout: 15_000 });

      // ── 5. Create the positioning brief → navigates to the docs editor with
      //       the GTM template content ─────────────────────────────────────
      await panel.getByRole("button", { name: "Create positioning brief" }).click();
      await expect(page).toHaveURL(/\/docs\/[^/?#]+/, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      // GTM_POSITIONING_BRIEF_TEMPLATE opens with a "Problem Statement" section.
      await expect(page.getByText("Problem Statement").first()).toBeVisible({ timeout: 15_000 });

      // ── 6. Back on the board, the card is now in the Launching column with a
      //       "1/2" launch chip ───────────────────────────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      // The Launching column exists and the item's chip reflects 1-of-2 done.
      const launchChip = page.locator('[title="Launch checklist: 1 of 2 done"]');
      await expect(launchChip).toBeVisible({ timeout: 10_000 });
      await expect(launchChip).toContainText("1/2");

      // ── 7. Public portal: enable the roadmap, then confirm the item shows
      //       under the "Launching" column in an unauthenticated context ─────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");
      // The public-roadmap toggle has no accessible name (see portal.spec.ts),
      // so locate it by its stable data-testid rather than a positional index.
      const toggle = page.getByTestId("portal-toggle-roadmap");
      const wasEnabled = (await toggle.getAttribute("aria-checked")) === "true";
      if (!wasEnabled) {
        await toggle.click();
        await page.waitForLoadState("networkidle");
      }

      const portalUrl = `${baseURL}/portal/${orgSlug}/${workspaceSlug}/roadmap`;
      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();
      await anonPage.goto(portalUrl);
      await anonPage.waitForLoadState("networkidle");

      await expect(anonPage.getByText("This roadmap is not public")).not.toBeVisible({ timeout: 5_000 });
      // The public "Launching" column header (a <span>, not a heading role) and
      // our item are both present.
      await expect(anonPage.getByText("Launching", { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(anonPage.getByText(itemTitle)).toBeVisible({ timeout: 10_000 });

      await anonContext.close();

      // ── 8. Cleanup: restore the toggle to its original state ───────────────
      if (!wasEnabled) {
        const stillOn = (await toggle.getAttribute("aria-checked")) === "true";
        if (stillOn) {
          await toggle.click();
          await page.waitForLoadState("networkidle");
        }
      }

      expect(consoleErrors).toEqual([]);
    }
  );
});
