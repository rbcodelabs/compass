import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Follow a detail panel's "Open full page" link and wait until the full-page
 * route has actually replaced the panel.
 *
 * The panel (overlay sheet or pinned column) renders the same heading, tabs
 * and "Add Solution"-style controls as the destination page, and the hop is a
 * client-side Next.js navigation that fires no new document load. So a
 * heading assertion or `networkidle` can pass while the outgoing panel is
 * still mounted, and the next click lands on the panel's form — which then
 * unmounts mid-submit. Two conditions together prove the hop committed:
 *
 *   1. the URL is exactly the link's destination, and
 *   2. the detail panel (sheet or pinned aside) is gone.
 *
 * Returns the destination pathname so callers can reuse it (e.g. to reload).
 *
 * @param scope where to find the link — defaults to the whole page; pass the
 *   panel locator when more than one "Open full page" link could be present.
 */
export async function openFullPage(page: Page, scope: Page | Locator = page): Promise<string> {
  const link = scope.getByRole("link", { name: "Open full page" });
  const href = await link.getAttribute("href");
  if (!href) throw new Error('"Open full page" link has no href');
  const destination = new URL(href, page.url());

  await link.click();
  await page.waitForURL(
    (url) => url.pathname === destination.pathname && url.search === destination.search,
  );
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="pinned-panel"][data-panel-id="detail"]')).toHaveCount(0);

  return destination.pathname;
}
