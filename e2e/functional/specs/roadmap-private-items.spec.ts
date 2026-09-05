/**
 * Private roadmap items functional spec.
 *
 * Journey:
 *   1. Add a roadmap item with the "Private" checkbox checked, and a second,
 *      ordinary public item, via the inline Add Item form on the Board.
 *   2. Confirm the private item shows a "Private" badge on the internal
 *      Board and the public item does not.
 *   3. Open the private item's Edit dialog to read its UUID off the title
 *      input's `id` attribute (`edit-title-<uuid>`) — the app doesn't
 *      otherwise expose roadmap item IDs in the DOM.
 *   4. Enable Public Roadmap in Settings (if not already on).
 *   5. Load the public portal roadmap anonymously and confirm the public
 *      item is listed while the private item's title never appears.
 *   6. Defense in depth: POST directly to the vote API with the private
 *      item's ID and confirm it 404s exactly like a nonexistent item would
 *      (not a 403 that would confirm the ID belongs to a real item).
 *   7. Cleanup: restore the Public Roadmap toggle to its original state.
 */
import { test, expect } from "../fixtures/index";

test.describe("Roadmap — private items", () => {
  test(
    "private item is hidden from the public portal and not votable, public item is unaffected",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      const ts = Date.now();
      const privateTitle = `E2E Private Item ${ts}`;
      const publicTitle = `E2E Public Item ${ts}`;

      // ── 1. Add a private item and a public item on the Board ───────────────
      await page.goto(`${base}/roadmap`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(privateTitle);
      await page.getByRole("checkbox", { name: "Private (hidden from public roadmap)" }).click();
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      const privateCard = page.locator('[data-slot="card"]').filter({ hasText: privateTitle });
      await expect(privateCard).toBeVisible({ timeout: 10_000 });

      await page.getByRole("button", { name: "Add item" }).nth(1).click();
      await page.getByLabel("Title").fill(publicTitle);
      // Private checkbox defaults unchecked — leave it alone for a public item.
      await page.getByRole("button", { name: "Add Item", exact: true }).click();

      const publicCard = page.locator('[data-slot="card"]').filter({ hasText: publicTitle });
      await expect(publicCard).toBeVisible({ timeout: 10_000 });

      // ── 2. Private badge shows on the private card only ─────────────────────
      await expect(privateCard.getByText("Private", { exact: true })).toBeVisible();
      await expect(publicCard.getByText("Private", { exact: true })).not.toBeVisible();

      // ── 3. Read the private item's UUID off the Edit dialog's title input ──
      await privateCard.hover();
      await privateCard.getByLabel("Card actions").click();
      await page.getByRole("menuitem", { name: "Edit" }).click();

      const titleInput = page.locator('input[id^="edit-title-"]');
      const inputId = await titleInput.getAttribute("id");
      const privateItemId = inputId!.replace("edit-title-", "");
      expect(privateItemId).toMatch(/^[0-9a-f-]{36}$/);

      // The dialog's Private checkbox should reflect the saved state too.
      await expect(page.getByRole("checkbox", { name: "Private (hidden from public roadmap)" })).toBeChecked();

      await page.keyboard.press("Escape");
      await expect(titleInput).not.toBeVisible({ timeout: 5_000 });

      // ── 4. Enable Public Roadmap in Settings (restore afterward) ───────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      const roadmapToggle = page.getByTestId("portal-toggle-roadmap");
      const roadmapWasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
      if (!roadmapWasPublic) {
        await roadmapToggle.click();
        await page.waitForLoadState("networkidle");
      }
      const authToggle = page.getByRole("switch", { name: "Require portal sign-in" });
      const authWasRequired = (await authToggle.getAttribute("aria-checked")) === "true";
      if (authWasRequired) {
        await authToggle.click();
        await expect(authToggle).toHaveAttribute("aria-checked", "false");
      }

      try {
        // ── 5. Anonymous portal view: public item shows, private item never
        //      does ────────────────────────────────────────────────────────
        const anonContext = await browser.newContext({ storageState: undefined });
        const anonPage = await anonContext.newPage();

        await anonPage.goto(
          `${baseURL}/portal/${orgSlug}/${workspaceSlug}/roadmap`
        );
        await anonPage.waitForLoadState("networkidle");

        await expect(anonPage.getByText(publicTitle)).toBeVisible({ timeout: 10_000 });
        await expect(anonPage.getByText(privateTitle)).not.toBeVisible();
        await expect(anonPage.getByText(privateTitle)).toHaveCount(0);

        // ── 6. Direct vote API call against the private item's real ID 404s,
        //      same as a nonexistent item — defense in depth even if the ID
        //      leaks some other way ─────────────────────────────────────────
        const voteRes = await anonContext.request.post(
          `${baseURL}/api/portal/${orgSlug}/${workspaceSlug}/vote`,
          {
            data: {
              type: "roadmap",
              itemId: privateItemId,
              voterEmail: `e2e-private-vote-${ts}@example.com`,
            },
          }
        );
        expect(voteRes.status()).toBe(404);
        const voteBody = (await voteRes.json()) as { error?: string };
        expect(voteBody.error).toBe("Roadmap item not found");

        await anonContext.close();
      } finally {
        // ── 7. Cleanup: restore the toggle to its original state ─────────────
        if (!roadmapWasPublic) {
          const checkedAfter = await roadmapToggle.getAttribute("aria-checked");
          if (checkedAfter === "true") {
            await roadmapToggle.click();
            await page.waitForLoadState("networkidle");
          }
        }
        if (authWasRequired) {
          await authToggle.click();
          await expect(authToggle).toHaveAttribute("aria-checked", "true");
        }
      }
    }
  );
});
