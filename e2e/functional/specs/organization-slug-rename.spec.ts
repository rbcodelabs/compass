/**
 * Organization URL slug rename functional spec.
 *
 * Journey: Organization Settings → "Organization URL" → type a new slug →
 *          "Change URL slug" opens a confirmation warning that old links stop
 *          working (nothing has changed yet) → confirm → land on the new slug's
 *          settings page → a workspace page opens under the new slug → the OLD
 *          url is a 404 (there is deliberately no redirect) → a reserved word
 *          is refused → rename back to the original slug.
 *
 * The functional suite runs serially (workers: 1) against one seeded org that
 * every other spec addresses by the fixed slug "e2e-test-org". This spec
 * therefore MUST restore it: the `finally` renames back through the same UI
 * even if an assertion fails halfway, so a red run cannot strand the rest of
 * the suite on a slug it no longer resolves.
 *
 * The seeded e2e user is an organization ADMIN (seed-e2e.ts), which is what
 * `resolveOrgAdmin` requires.
 */
import { test, expect } from "../fixtures/index";

test.describe("Organization URL slug rename", () => {
  // Regression: on a phone the confirm step opened below the fold, the page did not
  // scroll to it, and the fixed bottom nav covered the confirm button so a tap hit
  // the "Opportunities" link instead. Nothing is submitted, so no cleanup is needed.
  test("mobile: confirm button is not covered by the bottom nav", async ({ page, orgSlug }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Organization URL slug", { exact: true }).fill(`${orgSlug}-mobile`);
    await page.getByRole("button", { name: "Change URL slug" }).click();

    const confirm = page.getByRole("button", { name: "Yes, change URL slug" });
    await expect(confirm).toBeVisible();
    await expect
      .poll(
        async () =>
          confirm.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return hit === el || el.contains(hit);
          }),
        { message: "elementFromPoint at the confirm button's centre should be the button" },
      )
      .toBe(true);
  });

  test("rename → new URL works → old URL 404s → rename back", async ({ page, orgSlug, workspaceSlug }) => {
    const renamed = `e2e-renamed-${Date.now()}`;
    let renamedOnce = false;

    const slugField = () => page.getByLabel("Organization URL slug", { exact: true });
    async function changeSlugTo(from: string, to: string) {
      await page.goto(`/${from}/settings`);
      await page.waitForLoadState("networkidle");
      await expect(slugField()).toHaveValue(from);
      // Unchanged slug cannot be submitted.
      await expect(page.getByRole("button", { name: "Change URL slug" })).toBeDisabled();
      await slugField().fill(to);
      await page.getByRole("button", { name: "Change URL slug" }).click();
      // The confirmation spells out the consequences and has not renamed anything yet.
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Old links stop working immediately");
      await expect(dialog).toContainText("portal");
      await dialog.getByRole("button", { name: "Yes, change URL slug" }).click();
      await page.waitForURL(`**/${to}/settings`, { timeout: 20_000 });
    }

    try {
      // ── 1. Rename ────────────────────────────────────────────────────────
      await changeSlugTo(orgSlug, renamed);
      renamedOnce = true;
      await expect(page).toHaveURL(new RegExp(`/${renamed}/settings$`));
      await expect(slugField()).toHaveValue(renamed);

      // ── 2. The new URL works for a workspace page ─────────────────────────
      await page.goto(`/${renamed}/${workspaceSlug}/okrs`);
      await expect(page).toHaveURL(new RegExp(`/${renamed}/${workspaceSlug}/okrs$`));
      await expect(page.getByText("This page could not be found")).toHaveCount(0);

      // ── 3. The old URL is gone: no redirect, a 404 ────────────────────────
      const oldResponse = await page.goto(`/${orgSlug}/${workspaceSlug}/okrs`);
      expect(oldResponse?.status()).toBe(404);
      await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${workspaceSlug}/okrs$`));

      // ── 4. A reserved word is refused before any request is made ──────────
      await page.goto(`/${renamed}/settings`);
      await slugField().fill("portal");
      await expect(page.getByRole("alert").first()).toContainText(/reserved/i);
      await expect(page.getByRole("button", { name: "Change URL slug" })).toBeDisabled();
    } finally {
      // ── 5. Rename back so the rest of the suite finds the fixed slug ──────
      if (renamedOnce) {
        await changeSlugTo(renamed, orgSlug);
        await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings$`));
      }
    }
  });
});
