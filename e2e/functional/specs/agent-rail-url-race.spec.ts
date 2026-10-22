import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";

/**
 * A rail state change that lands while a sidebar navigation is still pending
 * must not cancel that navigation (the URL mirror writes with replaceState, and
 * a write of the old path used to supersede the in-flight push).
 *
 * The navigation is held by delaying its RSC request, so the window is
 * seconds wide rather than milliseconds.
 */
const rail = (page: Page) => page.locator('[data-slot="agent-rail"]');

test("a rail change during a pending navigation does not cancel it", async ({ page, base }) => {
  test.setTimeout(120_000);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await page.goto(`${base}/okrs?rail=help`);
  await expect(rail(page)).toBeVisible({ timeout: 30_000 });
  await expect(nav.getByRole("link", { name: "Roadmap", exact: true })).toBeVisible();

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let delayed = 0;
  await page.route("**/roadmap**", async (route) => {
    if (route.request().headers()["rsc"]) {
      delayed += 1;
      await held;
    }
    await route.continue();
  });

  await nav.getByRole("link", { name: "Roadmap", exact: true }).click();
  await expect.poll(() => delayed).toBeGreaterThan(0);
  // Rail state changes mid-navigation: Help -> Library.
  await rail(page).getByRole("button", { name: /Rail view/ }).click();
  await page.getByRole("menuitem", { name: /Library/ }).click();
  await expect(rail(page).getByRole("button", { name: "Rail view: Library" })).toBeVisible();
  release();

  await expect(page).toHaveURL(/\/roadmap/, { timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("rail")).toBe("library");
});
