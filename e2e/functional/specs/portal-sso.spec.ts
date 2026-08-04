/**
 * Portal SSO Identify functional spec.
 *
 * Journey: An org admin enables SSO Identify in Settings and generates a
 * shared secret. A "customer backend" (this test) signs a JWT with that
 * secret and hits the SSO exchange endpoint in a fresh, unauthenticated
 * browser context — mirroring exactly what a real customer integration
 * would do. Verifies the visitor lands signed in, and that the endpoint
 * fails closed for a token signed with the wrong secret.
 */
import { test, expect } from "../fixtures/index";
import { SignJWT } from "jose";

test.describe("Portal — SSO Identify", () => {
  test(
    "enable SSO in settings, generate a secret, and sign in a visitor via a customer-signed JWT",
    async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
      // ── 1. Go to Settings ─────────────────────────────────────────────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // ── 2. Ensure the portal is public (SSO section only renders once it
      //        is) — reuse the roadmap toggle via its stable data-testid,
      //        same as portal.spec.ts. ────────────────────────────────────
      const roadmapToggle = page.getByTestId("portal-toggle-roadmap");
      const roadmapWasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
      if (!roadmapWasPublic) {
        await roadmapToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 3. Enable SSO Identify — located by its stable data-testid rather
      //        than positional index (see portal.spec.ts for why). ──────────
      const ssoToggle = page.getByTestId("portal-toggle-sso");
      await expect(ssoToggle).toBeVisible({ timeout: 5_000 });
      const ssoWasEnabled = (await ssoToggle.getAttribute("aria-checked")) === "true";
      if (!ssoWasEnabled) {
        await ssoToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 4. Generate a secret and capture the one-time reveal. ───────────────
      await page.getByRole("button", { name: /generate secret|rotate secret/i }).click();
      const secretCode = page.locator("code").filter({ hasText: /^[A-Za-z0-9+/]+=*$/ }).first();
      await expect(secretCode).toBeVisible({ timeout: 5_000 });
      const rawSecret = (await secretCode.textContent())?.trim();
      expect(rawSecret).toBeTruthy();

      // Dismiss the reveal so the panel returns to steady state.
      await page.getByRole("button", { name: /saved it/i }).click();
      await page.waitForLoadState("networkidle");

      // ── 5. Mint a customer-signed JWT with the real secret, exactly as a
      //        customer backend would, and exchange it in a FRESH,
      //        unauthenticated browser context. ──────────────────────────────
      const key = new TextEncoder().encode(rawSecret!);
      const testEmail = `e2e-sso-${Date.now()}@customer.example`;
      const now = Math.floor(Date.now() / 1000);
      const goodToken = await new SignJWT({ email: testEmail, name: "E2E SSO Visitor" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(key);

      const anonContext = await browser.newContext({ storageState: undefined });
      const anonPage = await anonContext.newPage();
      await anonPage.goto(
        `${baseURL}/api/portal/${orgSlug}/${workspaceSlug}/sso?token=${encodeURIComponent(goodToken)}`
      );
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(`Signed in as ${testEmail}`)).toBeVisible({
        timeout: 10_000,
      });

      // ── 6. Fail-closed check: a token signed with the WRONG secret must be
      //        rejected in the same unauthenticated context. ─────────────────
      const wrongKey = new TextEncoder().encode("not-the-real-secret-not-the-real-secret");
      const badToken = await new SignJWT({ email: "attacker@evil.example" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(wrongKey);

      const badRes = await anonContext.request.get(
        `${baseURL}/api/portal/${orgSlug}/${workspaceSlug}/sso?token=${encodeURIComponent(badToken)}`
      );
      expect(badRes.status()).toBe(400);

      await anonContext.request.post(`${baseURL}/api/portal/auth/signout`);
      await anonContext.close();

      // ── 7. Cleanup: disable SSO, restore roadmap toggle to its original
      //        state. Regenerating on next run naturally invalidates this
      //        secret, but disabling SSO removes it from the DB too. ────────
      const ssoCheckedAfter = await ssoToggle.getAttribute("aria-checked");
      if (ssoCheckedAfter === "true") {
        await ssoToggle.click();
        await page.waitForLoadState("networkidle");
      }
      if (!roadmapWasPublic) {
        const roadmapCheckedAfter = await roadmapToggle.getAttribute("aria-checked");
        if (roadmapCheckedAfter === "true") {
          await roadmapToggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
    }
  );
});
