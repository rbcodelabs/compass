import type { Page } from "@playwright/test";

/**
 * Create a new document from the Library (the agent rail's "Library" view) and wait for its page.
 *
 * /docs is the Library overview (it no longer redirects to a document), and the Library, with its New menu, lives in the rail rather than
 * on the Docs route, so specs create a doc through the rail instead of a bare "New" button. Waits for the URL to move to a document
 * page that is not the one it started on, so landing on an existing doc is never mistaken for the new one.
 */
export async function clickNewDoc(page: Page): Promise<void> {
  const before = page.url();
  const toggle = page.getByTestId("library-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await page.getByTestId("library-create-menu").click();
  await page.getByRole("menuitem", { name: "New doc" }).click();
  await page.waitForURL((url) => url.href !== before && /\/docs\/[0-9a-f-]+$/.test(url.pathname), { timeout: 15_000 });
  // Close the Library rail again so the editor and its controls are reachable: a phone-width overlay drawer covers the page, and a
  // docked rail narrows the editor and puts its resize handle over it. Toggle first (works in both modes), then Escape for a drawer
  // that is still showing. Best effort: nothing here should fail the calling spec.
  const toggleNow = page.getByTestId("library-toggle");
  if ((await toggleNow.getAttribute("aria-pressed").catch(() => null)) === "true") {
    // dispatchEvent, not click(): at phone width the drawer covers the toggle, so a coordinate click would land on the drawer.
    await toggleNow.dispatchEvent("click").catch(() => {});
  }
  const overlay = page.locator('aside[data-mode="overlay"][aria-label="Library"]');
  if (await overlay.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await overlay.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
}
