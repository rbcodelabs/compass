/**
 * Portal functional spec.
 *
 * Journey (authenticated): Navigate to Settings → enable Public Roadmap →
 *          verify the portal roadmap link is shown.
 *
 * Journey (unauthenticated): Open the public portal roadmap URL in a fresh
 *          browser context and verify it renders without auth.
 */
import { test, expect } from "../fixtures/index";

test.describe("Portal — public roadmap", () => {
  test(
    "enable public roadmap in settings → portal page loads without auth",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      // ── 1. Go to Settings ─────────────────────────────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // ── 2. Enable the public roadmap toggle ───────────────────────────────
      // The toggle button has role="switch" + aria-checked, but NO aria-label.
      // Its accessible name is empty: the visible label ("Public roadmap") is a
      // sibling <span>, not a <label> element, so getByRole("switch", {name})
      // matches nothing. Use the stable data-testid instead of a positional
      // [role="switch"] locator — positional indices shift when other specs
      // running concurrently against the shared seeded workspace toggle
      // sibling switches, causing intermittent cross-spec flakiness.
      const toggle = page.getByTestId("portal-toggle-roadmap");

      const ariaChecked = await toggle.getAttribute("aria-checked");
      const isChecked = ariaChecked === "true";

      if (!isChecked) {
        await toggle.click();
        // Wait for the server action + route revalidation to complete.
        // After the server action the component receives fresh props via
        // the router refresh which triggers a networkidle settle.
        await page.waitForLoadState("networkidle");
      }

      // ── 3. Verify portal link appears (settings confirms it's enabled) ─────
      const portalUrl = `/portal/${orgSlug}/${workspaceSlug}/roadmap`;

      // ── 4. Open portal roadmap in a NEW (unauthenticated) browser context ──
      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();

      await anonPage.goto(`${baseURL}${portalUrl}`);
      await anonPage.waitForLoadState("networkidle");

      // The portal page should render the public roadmap heading, NOT the
      // "This roadmap is not public" fallback
      await expect(
        anonPage.getByText("This roadmap is not public")
      ).not.toBeVisible({ timeout: 5_000 });

      // Public roadmap content is visible
      await expect(
        anonPage.getByRole("heading", { name: /roadmap/i }).first()
      ).toBeVisible({ timeout: 10_000 });

      await anonContext.close();

      // ── 5. Cleanup: disable the toggle again ──────────────────────────────
      const ariaCheckedAfter = await toggle.getAttribute("aria-checked");
      if (ariaCheckedAfter === "true") {
        await toggle.click();
        await page.waitForLoadState("networkidle");
      }
    }
  );
});

test.describe("Portal — account authentication (portalAuthRequired)", () => {
  test(
    "anonymous vote is rejected, magic-link sign-in lets the same visitor vote",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      // ── 1. Go to Settings ─────────────────────────────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // No aria-label on these toggles (see the roadmap test above), so use
      // the stable data-testid rather than a positional index — indices
      // shift when concurrently-running specs add/remove sibling switches
      // (e.g. the auth-required and SSO toggles only render once the portal
      // is public), which was the root cause of the cross-spec flakiness.
      const feedbackToggle = page.getByTestId("portal-toggle-feedback");

      // ── 2. Ensure feedback is enabled (needed to submit + vote at all) ─────
      const feedbackWasEnabled =
        (await feedbackToggle.getAttribute("aria-checked")) === "true";
      if (!feedbackWasEnabled) {
        await feedbackToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 3. Submit a feedback item anonymously WHILE portalAuthRequired is
      //        still off — this is the item we'll later try to vote on. ─────
      const createRes = await page.request.post(
        `/api/portal/${orgSlug}/${workspaceSlug}/feedback`,
        {
          data: { title: `E2E portal-auth item ${Date.now()}` },
        }
      );
      expect(createRes.ok()).toBe(true);
      const { id: feedbackItemId } = (await createRes.json()) as { id: string };

      // ── 4. Now enable "require an account" — only exists in the DOM now
      //        that feedback is public. ─────────────────────────────────────
      const portalAuthToggle = page.getByTestId("portal-toggle-auth-required");
      await expect(portalAuthToggle).toBeVisible({ timeout: 5_000 });
      const authWasRequired =
        (await portalAuthToggle.getAttribute("aria-checked")) === "true";
      if (!authWasRequired) {
        await portalAuthToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 5. Anonymous vote attempt in a FRESH, unauthenticated context ──────
      const anonContext = await browser.newContext({ storageState: undefined });

      const anonVoteRes = await anonContext.request.post(
        `${baseURL}/api/portal/${orgSlug}/${workspaceSlug}/vote`,
        {
          data: { type: "feedback", itemId: feedbackItemId, voterEmail: "anon@example.com" },
        }
      );
      expect(anonVoteRes.status()).toBe(401);
      const anonVoteBody = (await anonVoteRes.json()) as { code?: string };
      expect(anonVoteBody.code).toBe("PORTAL_AUTH_REQUIRED");

      // ── 6. Drive the magic-link flow in that SAME context ──────────────────
      const testEmail = `e2e-portal-${Date.now()}@example.com`;
      const sendRes = await anonContext.request.post(
        `${baseURL}/api/portal/auth/send`,
        { data: { email: testEmail } }
      );
      expect(sendRes.ok()).toBe(true);
      const sendBody = (await sendRes.json()) as { devVerifyUrl?: string };
      expect(sendBody.devVerifyUrl).toBeTruthy();

      // The devVerifyUrl's host reflects NEXT_PUBLIC_APP_URL, which may not
      // match the port Playwright's webServer actually started on (it's
      // derived per-worktree — see playwright.config.ts) — rebuild it
      // against the known-correct local base instead of trusting the host
      // in the response.
      const verifyPathAndQuery =
        new URL(sendBody.devVerifyUrl!).pathname + new URL(sendBody.devVerifyUrl!).search;

      const anonPage = await anonContext.newPage();
      await anonPage.goto(`${baseURL}${verifyPathAndQuery}`);
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(`Signed in as ${testEmail}`)).toBeVisible({
        timeout: 10_000,
      });

      // ── 7. Vote again in the now-signed-in context → expect success ────────
      const signedInVoteRes = await anonContext.request.post(
        `${baseURL}/api/portal/${orgSlug}/${workspaceSlug}/vote`,
        {
          data: { type: "feedback", itemId: feedbackItemId },
        }
      );
      expect(signedInVoteRes.ok()).toBe(true);
      const signedInVoteBody = (await signedInVoteRes.json()) as {
        success: boolean;
        voteCount: number;
      };
      expect(signedInVoteBody.success).toBe(true);
      expect(signedInVoteBody.voteCount).toBe(1);

      // ── 8. Cleanup: sign out, restore toggles to their original state ──────
      await anonContext.request.post(`${baseURL}/api/portal/auth/signout`);
      await anonContext.close();

      if (!authWasRequired) {
        const authCheckedAfter = await portalAuthToggle.getAttribute("aria-checked");
        if (authCheckedAfter === "true") {
          await portalAuthToggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
      if (!feedbackWasEnabled) {
        const feedbackCheckedAfter = await feedbackToggle.getAttribute("aria-checked");
        if (feedbackCheckedAfter === "true") {
          await feedbackToggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
    }
  );
});
