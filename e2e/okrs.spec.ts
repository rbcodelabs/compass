import { test, expect } from "@playwright/test";

// This file runs in the `chromium` and `mobile` projects which both depend on
// `auth-setup`. The browser context already has a valid session loaded from
// e2e/.auth/user.json — no login step needed here.

test.describe("OKRs", () => {
  test("loads the OKRs page after following the dashboard redirect", async ({
    page,
  }) => {
    // Start from the root — the dashboard will redirect to the first workspace.
    await page.goto("/dashboard");

    // Wait for the redirect chain to settle on a workspace page.
    // The URL pattern is /<orgSlug>/<workspaceSlug>/<section>.
    await page.waitForURL(/\/[^/]+\/[^/]+\//, { timeout: 15_000 });

    // Navigate explicitly to the OKRs section of whatever workspace we landed in.
    const currentUrl = new URL(page.url());
    const segments = currentUrl.pathname.split("/").filter(Boolean);
    // segments[0] = orgSlug, segments[1] = workspaceSlug
    if (segments.length >= 2) {
      await page.goto(`/${segments[0]}/${segments[1]}/okrs`);
    }

    await expect(page).toHaveURL(/\/okrs/, { timeout: 10_000 });
  });

  test("shows an OKR-related heading or empty state on the OKRs page", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForURL(/\/[^/]+\/[^/]+\//, { timeout: 15_000 });

    const currentUrl = new URL(page.url());
    const segments = currentUrl.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      await page.goto(`/${segments[0]}/${segments[1]}/okrs`);
    }

    await expect(page).toHaveURL(/\/okrs/, { timeout: 10_000 });

    // The page should render some recognisable OKR UI element.
    // Accept an existing cycle card, an empty-state message, or a "New Cycle" button.
    const okrContent = page
      .locator("[data-testid='cycle-card']")
      .or(page.getByRole("button", { name: /new cycle|create cycle/i }))
      .or(page.getByText(/no cycles|get started|okr/i));

    await expect(okrContent.first()).toBeVisible({ timeout: 10_000 });
  });
});
