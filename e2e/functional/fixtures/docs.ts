import type { Page } from "@playwright/test";

/**
 * Create a new document from the Library (the agent rail's "Library" view) and wait for its page.
 *
 * /docs redirects to an existing document whenever the workspace has one (the seed adds a baseline doc), and the Library, with its
 * New menu, lives in the rail rather than on the Docs route, so specs create a doc through the rail instead of a bare "New" button.
 * Waits for the URL to move to a different document, so a redirect to the existing doc is never mistaken for the new one.
 */
export async function clickNewDoc(page: Page): Promise<void> {
  const before = page.url();
  const toggle = page.getByTestId("library-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await page.getByTestId("library-create-menu").click();
  await page.getByRole("menuitem", { name: "New doc" }).click();
  await page.waitForURL((url) => url.href !== before && /\/docs\/[0-9a-f-]+$/.test(url.pathname), { timeout: 15_000 });
  // The rail may be an overlay drawer that covers the page (phone width); close it so the editor and its controls are reachable. A
  // docked rail has nothing to uncover, so this is best effort: the toggle first, then Escape.
  const overlay = page.locator('aside[data-mode="overlay"][aria-label="Library"]');
  if (await overlay.isVisible().catch(() => false)) {
    await page.getByTestId("library-toggle").click({ timeout: 3_000, force: true }).catch(() => {});
    if (await overlay.isVisible().catch(() => false)) await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
  }
}
