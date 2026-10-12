/**
 * Organization URL slug rename functional spec.
 *
 * Journey: Organization Settings → "Organization URL" → type a new slug →
 *          "Change URL slug" opens a confirmation (nothing has changed yet) →
 *          confirm → land on the new slug's settings page → the OLD url still
 *          works (redirects to the same path under the new slug, query kept) →
 *          a workspace page opens through the new slug → rename back to the
 *          original slug (the retired-slug history row is consumed) → both
 *          addresses resolve again.
 *
 * The functional suite runs serially (workers: 1) against one seeded org that
 * every other spec addresses by the fixed slug "e2e-test-org". This spec
 * therefore MUST restore it: the rename-back is part of the journey, and a
 * `finally` repeats it through the same UI if an
 * assertion fails halfway, so a red run cannot strand the rest of the suite
 * on a slug it no longer resolves. (The old slug redirects to the new one in
 * the meantime, but fixed-slug assertions elsewhere would still be wrong.)
 *
 * The seeded e2e user is an organization ADMIN (seed-e2e.ts), which is what
 * `resolveOrgAdmin` requires.
 */
import { test, expect } from "../fixtures/index";

test.describe("Organization URL slug rename", () => {
  test("rename → old URL redirects → rename back", async ({ page, orgSlug, workspaceSlug }) => {
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
      await expect(dialog).toContainText("Old links keep working");
      await expect(dialog).toContainText("cannot follow a redirect");
      await dialog.getByRole("button", { name: "Yes, change URL slug" }).click();
      await page.waitForURL(`**/${to}/settings`, { timeout: 20_000 });
    }

    try {
      // ── 1. Rename ────────────────────────────────────────────────────────
      await changeSlugTo(orgSlug, renamed);
      renamedOnce = true;
      await expect(page).toHaveURL(new RegExp(`/${renamed}/settings$`));
      await expect(slugField()).toHaveValue(renamed);

      // ── 2. The old URL redirects, preserving path and query ───────────────
      await page.goto(`/${orgSlug}/${workspaceSlug}/okrs?keep=1`);
      await expect(page).toHaveURL(new RegExp(`/${renamed}/${workspaceSlug}/okrs\\?keep=1$`));
      // The page rendered (no not-found shell) under the new slug.
      await expect(page.getByText("This page could not be found")).toHaveCount(0);

      // ── 3. A reserved word is refused before any request is made ──────────
      await page.goto(`/${renamed}/settings`);
      await slugField().fill("portal");
      await expect(page.getByRole("alert").first()).toContainText(/reserved/i);
      await expect(page.getByRole("button", { name: "Change URL slug" })).toBeDisabled();
    } finally {
      // ── 4. Rename back; the retired original slug becomes live again ──────
      if (renamedOnce) {
        await changeSlugTo(renamed, orgSlug);
        await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings$`));
      }
    }

    // ── 5. Both addresses resolve again: the original is live, the interim one redirects ──
    await page.goto(`/${orgSlug}/${workspaceSlug}/okrs`);
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${workspaceSlug}/okrs$`));
    await page.goto(`/${renamed}/${workspaceSlug}/okrs`);
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${workspaceSlug}/okrs$`));
  });
});
