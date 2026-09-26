/**
 * Passkey (WebAuthn) login functional spec.
 *
 * Journey: sign in via the existing dev-credentials session (auth.setup.ts) →
 *          register a passkey on /settings/passkeys using Playwright's
 *          virtual WebAuthn authenticator → sign out → sign back in with the
 *          passkey button on /login → land on /dashboard.
 *
 * IMPORTANT — why this spec self-skips on the local functional harness:
 * auth.ts registers the `Passkey` provider (and `experimental.enableWebAuthn`)
 * only in its production/preview branch. The dev branch (NODE_ENV ===
 * "development") intentionally has no WebAuthn provider — see auth.ts's own
 * doc comment and the project brief this spec was written against, which is
 * explicit that the dev-credentials-only branch must not be touched. The
 * functional suite's webServer always runs `pnpm dev`, and Next.js forces
 * NODE_ENV to "development" for that command regardless of what env vars are
 * passed to it — there is no way to get the production auth branch live
 * under this harness's `pnpm dev` webServer. So instead of assuming success
 * or silently no-op-ing, this spec asks NextAuth itself (GET
 * /api/auth/providers) whether "passkey" is registered and explicitly skips
 * with that reasoning when it isn't — which is every run of the local
 * functional suite today. The moment this spec runs against a
 * production/preview deployment (where auth.ts's production branch is live),
 * the same assertions exercise the full registration + sign-in ceremony via
 * Playwright's virtual authenticator (context.credentials, Playwright
 * >=1.55) with no changes needed.
 */
import { test, expect } from "../fixtures/index";

test.describe("Passkey login", () => {
  test("register a passkey, sign out, then sign back in with it", async ({ page, context, request, base }) => {
    test.setTimeout(120_000);

    const providers = (await (await request.get("/api/auth/providers")).json()) as Record<string, unknown>;
    test.skip(
      !("passkey" in providers),
      "Passkey provider is only registered in auth.ts's production/preview branch. " +
        "The functional suite's `pnpm dev` webServer always runs NODE_ENV=development " +
        "(Next.js forces this regardless of env vars), so the WebAuthn ceremony can only " +
        "be exercised against a preview/production deployment, not this local harness."
    );

    // Overrides navigator.credentials.create()/get() for every page in this
    // context via a virtual authenticator. Must be installed before the
    // first page touches WebAuthn. The app drives both the registration and
    // authentication ceremonies itself below — no credential is pre-seeded.
    await context.credentials.install();

    // ── 1. Register a passkey ────────────────────────────────────────────
    await page.goto("/settings/passkeys");
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText(/multiDevice|singleDevice/i)).toBeVisible();

    // ── 2. Sign out ───────────────────────────────────────────────────────
    await page.goto(`${base}/okrs`);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");

    // ── 3. Sign back in with the passkey ─────────────────────────────────
    await page.getByRole("button", { name: /sign in with a passkey/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
