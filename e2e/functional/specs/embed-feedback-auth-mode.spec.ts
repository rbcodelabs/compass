/**
 * Embed feedback widget — "Who can comment" auth mode functional spec.
 *
 * Journey: Settings → Embedded feedback — the "Who can comment" control on a
 *          feedback source gained a third mode, PORTAL_SSO ("External
 *          reviewers, via SSO"), alongside the existing INTERNAL_SSO ("Your
 *          team, signed in with Compass SSO") and PORTAL ("External
 *          reviewers, by email link"). It is SSO-only — no magic-link
 *          fallback — and the option is always visible but disabled until
 *          the workspace's Portal → SSO Identify toggle is on (see
 *          components/settings/feedback-sources-panel.tsx, isAuthModeSelectable).
 *
 * This spec covers only the settings-panel surface — the new, actual
 * user-facing flow this PR adds. It deliberately does NOT simulate the
 * widget-side SSO JWT exchange (POST /api/embed/sso): there is no reusable
 * fixture/helper for minting a Portal SSO Identify JWT in
 * e2e/functional/fixtures/ (portal-sso.spec.ts mints one inline with `jose`
 * for its own narrower purpose — verifying the portal SSO exchange endpoint
 * itself — rather than exposing a shared helper), and inventing test-only
 * JWT-signing infrastructure here would be scope creep beyond what this PR
 * touches. Widget-side SSO exchange behavior already has coverage of its
 * own endpoint in portal-sso.spec.ts.
 *
 * Both tests below mutate the SAME shared seeded workspace's Portal
 * settings (there is only one e2e-workspace for the whole functional
 * suite — see fixtures/seed-e2e.ts) via the "Public roadmap" and
 * "SSO Identify" toggles. The functional suite runs with a single Playwright
 * worker (`workers: 1` in playwright.config.ts when running the functional
 * project), so cross-file interleaving with portal-sso.spec.ts (which
 * touches the same two toggles) is not a live race in practice — but
 * `.serial()` is still used here, matching workspace-branding.spec.ts's
 * precedent, so this file's own two tests never interleave with each other
 * regardless of how the runner is invoked.
 */
import { test, expect } from "../fixtures/index";

// One artifact, shared by both tests below. The "New feedback source" form
// (including the "Who can comment" select this whole spec is about) does not
// render at all when the workspace has zero artifacts — it shows "Add a
// prototype under Artifacts first" instead (see feedback-sources-panel.tsx's
// `artifacts.length === 0` branch) — so a prerequisite artifact has to exist
// before either test's assertions about the select are reachable.
const SHARED_ARTIFACT_TITLE = `E2E SSO Auth Mode Shared Prototype ${Date.now()}`;

test.describe.serial("Embed feedback — Who can comment auth mode", () => {
  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ storageState: "e2e/functional/.auth/user.json" });
    const page = await context.newPage();
    await page.goto(`${baseURL}/e2e-test-org/e2e-workspace/docs/artifacts/new`);
    await page.getByLabel("Title").fill(SHARED_ARTIFACT_TITLE);
    await page.getByLabel("Self-contained HTML file").setInputFiles({
      name: "prototype.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><html><body>SSO auth mode E2E prototype</body></html>"),
    });
    await page.getByRole("button", { name: "Create artifact" }).click();
    await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/);
    await context.close();
  });

  test(
    "External reviewers, via SSO is disabled and unselectable when the workspace has no SSO Identify configured",
    async ({ page, base }) => {
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      // ── Ensure the portal is public — the SSO Identify toggle only renders
      //        once it is (see portal-settings-panel.tsx's portalIsPublic gate),
      //        same prerequisite portal-sso.spec.ts relies on. ────────────────
      const roadmapToggle = page.getByTestId("portal-toggle-roadmap");
      const roadmapWasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
      if (!roadmapWasPublic) {
        await roadmapToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── Force SSO Identify OFF for this test, remembering the prior state
      //        so it can be restored exactly. ─────────────────────────────────
      const ssoToggle = page.getByTestId("portal-toggle-sso");
      await expect(ssoToggle).toBeVisible({ timeout: 5_000 });
      const ssoWasEnabled = (await ssoToggle.getAttribute("aria-checked")) === "true";
      if (ssoWasEnabled) {
        await ssoToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── The "who can comment" select on the create-source form always
      //        lists all three options, but "External reviewers, via SSO"
      //        must be disabled and inert while SSO Identify is off. ─────────
      const authModeSelect = page.getByLabel("Who can comment", { exact: true });
      await authModeSelect.click();

      const ssoOption = page.getByRole("option", { name: "External reviewers, via SSO" });
      await expect(ssoOption).toBeVisible();
      await expect(ssoOption).toHaveAttribute("data-disabled", "");

      // Clicking a disabled Radix SelectItem must be a no-op: the trigger's
      // displayed value stays on the default (INTERNAL_SSO) rather than
      // switching to the mode that cannot legally be used yet.
      await ssoOption.click({ force: true });
      await expect(authModeSelect).toContainText("Your team, signed in with Compass SSO");

      await page.keyboard.press("Escape");

      // ── Restore toggles to their original state. ────────────────────────────
      const ssoCheckedAfter = await ssoToggle.getAttribute("aria-checked");
      if (ssoCheckedAfter === "true" && !ssoWasEnabled) {
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

  test(
    "creating a source with, and editing an existing source to, External reviewers via SSO persists once SSO Identify is configured",
    async ({ page, base }) => {
      const stamp = Date.now();
      const artifactTitle = SHARED_ARTIFACT_TITLE;
      const createdSourceName = `E2E SSO Created Source ${stamp}`;
      const editedSourceName = `E2E SSO Edited Source ${stamp}`;

      // ── 1. Make the portal public and turn on SSO Identify — the
      //        prerequisite for PORTAL_SSO to be selectable at all. ──────────
      await page.goto(`${base}/settings`);
      await page.waitForLoadState("networkidle");

      const roadmapToggle = page.getByTestId("portal-toggle-roadmap");
      const roadmapWasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
      if (!roadmapWasPublic) {
        await roadmapToggle.click();
        await page.waitForLoadState("networkidle");
      }

      const ssoToggle = page.getByTestId("portal-toggle-sso");
      await expect(ssoToggle).toBeVisible({ timeout: 5_000 });
      const ssoWasEnabled = (await ssoToggle.getAttribute("aria-checked")) === "true";
      if (!ssoWasEnabled) {
        await ssoToggle.click();
        await page.waitForLoadState("networkidle");
      }

      // ── 2. Create a feedback source with "Who can comment" set to
      //        External reviewers, via SSO from the start, against the
      //        artifact created in beforeAll. ─────────────────────────────────

      await page.locator("#new-feedback-source-name").fill(createdSourceName);

      await page.getByLabel("Prototype").click();
      await page.getByRole("option", { name: artifactTitle }).click();

      const createAuthModeSelect = page.getByLabel("Who can comment", { exact: true });
      await createAuthModeSelect.click();
      const createSsoOption = page.getByRole("option", { name: "External reviewers, via SSO" });
      await expect(createSsoOption).not.toHaveAttribute("data-disabled", "");
      await createSsoOption.click();

      // The hint below the select swaps to the PORTAL_SSO-eligible wording
      // once it is actually selectable and selected (see authModeHint()).
      await expect(
        page.getByText(/Reviewers sign in only through Portal SSO Identify/)
      ).toBeVisible();

      await page.getByRole("button", { name: "Create and mint a token" }).click();

      // Dismiss the one-time token reveal so it doesn't obscure later assertions.
      await page.getByRole("button", { name: /I.?ve saved it/ }).click();
      await page.waitForLoadState("networkidle");

      const createdSelect = page.getByRole("combobox", { name: `Who can comment on ${createdSourceName}` });
      await expect(createdSelect).toContainText("External reviewers, via SSO");

      // ── 3. Persistence check #1: reload and confirm the created source kept
      //        its auth mode. ─────────────────────────────────────────────────
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("combobox", { name: `Who can comment on ${createdSourceName}` })
      ).toContainText("External reviewers, via SSO");

      // ── 4. Create a second source with the default auth mode, then EDIT it
      //        to External reviewers, via SSO — covers the second render site
      //        (the edit-existing-source form is a separate code path from the
      //        create-source form; see feedback-sources-panel.tsx). ───────────
      await page.locator("#new-feedback-source-name").fill(editedSourceName);
      await page.getByLabel("Prototype").click();
      await page.getByRole("option", { name: artifactTitle }).click();
      // Leave "Who can comment" on its default (Your team, signed in with
      // Compass SSO) — nothing to select here.
      await page.getByRole("button", { name: "Create and mint a token" }).click();
      await page.getByRole("button", { name: /I.?ve saved it/ }).click();
      await page.waitForLoadState("networkidle");

      const editedSelect = page.getByRole("combobox", { name: `Who can comment on ${editedSourceName}` });
      await expect(editedSelect).toContainText("Your team, signed in with Compass SSO");

      await editedSelect.click();
      await page.getByRole("option", { name: "External reviewers, via SSO" }).click();
      await page.waitForLoadState("networkidle");
      await expect(editedSelect).toContainText("External reviewers, via SSO");

      // ── 5. Persistence check #2: reload and confirm the EDIT stuck too. ─────
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("combobox", { name: `Who can comment on ${editedSourceName}` })
      ).toContainText("External reviewers, via SSO");

      // ── 6. Regression guard: with SSO Identify back off, both sources keep
      //        their PORTAL_SSO selection (grandfathered) and now show the
      //        ineligibility hint instead of the normal PORTAL_SSO hint,
      //        since the mode they already hold can no longer be freshly
      //        chosen (see authModeHint()'s "not(ssoIdentifyEnabled)" branch). ─
      await ssoToggle.scrollIntoViewIfNeeded();
      await ssoToggle.click();
      await expect(ssoToggle).toHaveAttribute("aria-checked", "false", { timeout: 10_000 });
      await page.waitForLoadState("networkidle");

      // Confirm the toggle-off actually persisted server-side, not just in
      // client state — reload and re-read. Polls rather than a single reload
      // because under a slow/loaded dev server the revalidated read can very
      // briefly still reflect the pre-toggle value even after the client-side
      // mutation's own network request has settled.
      await expect
        .poll(
          async () => {
            await page.reload();
            await page.waitForLoadState("networkidle");
            return ssoToggle.getAttribute("aria-checked");
          },
          { timeout: 30_000, intervals: [1_000, 2_000, 4_000] }
        )
        .toBe("false");

      const ineligibleHint =
        "Enable Portal SSO Identify in Settings → Portal first — until then this option cannot be selected.";
      const createdSourceCard = page
        .locator('[data-testid^="feedback-source-"]')
        .filter({ hasText: createdSourceName });
      const editedSourceCard = page
        .locator('[data-testid^="feedback-source-"]')
        .filter({ hasText: editedSourceName });
      await expect(createdSourceCard.getByRole("combobox")).toContainText("External reviewers, via SSO");
      await expect(createdSourceCard.getByText(ineligibleHint)).toBeVisible();
      await expect(editedSourceCard.getByRole("combobox")).toContainText("External reviewers, via SSO");
      await expect(editedSourceCard.getByText(ineligibleHint)).toBeVisible();

      // ── 7. Restore toggles to their original state. ──────────────────────────
      if (ssoWasEnabled) {
        const ssoCheckedAfter = await ssoToggle.getAttribute("aria-checked");
        if (ssoCheckedAfter === "false") {
          await ssoToggle.click();
          await page.waitForLoadState("networkidle");
        }
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
