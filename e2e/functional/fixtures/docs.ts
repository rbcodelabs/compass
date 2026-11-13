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

/**
 * Open the Library in the agent rail (idempotent). The Library, with its New menu and the hidden .canvas import input, is the rail's
 * "Library" view, not part of the Docs route, and the rail starts closed, so those controls do not exist in the DOM until it is opened.
 * Waits for the pane's contents (the create menu) rather than the pane shell, since the tree loads after the rail opens.
 */
export async function openLibrary(page: Page): Promise<void> {
  const toggle = page.getByTestId("library-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await page.getByTestId("library-create-menu").waitFor({ state: "attached", timeout: 30_000 });
}

/**
 * Close the Library rail again so a canvas editor gets its full width (a docked rail narrows it and shifts pointer coordinates).
 * Best effort, mirroring clickNewDoc: dispatchEvent because a phone-width overlay drawer covers the toggle.
 */
export async function closeLibrary(page: Page): Promise<void> {
  const toggle = page.getByTestId("library-toggle");
  if ((await toggle.getAttribute("aria-pressed").catch(() => null)) === "true") await toggle.dispatchEvent("click").catch(() => {});
  await page.getByTestId("rail-library").waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
}

/**
 * Create a blank diagram from the Library's New menu, wait for its page, then close the rail. Returns the diagram's id as it appears
 * in the first URL: the page later rewrites that URL to the document key (DOC-n), but Library links keep using the id.
 */
export async function createDiagramFromLibrary(page: Page): Promise<string> {
  await openLibrary(page);
  await page.getByTestId("library-create-menu").click();
  await page.getByRole("menuitem", { name: "New diagram" }).click();
  let id = "";
  await page.waitForURL((url) => {
    const match = /\/docs\/([0-9a-f-]+)$/.exec(url.pathname);
    if (match) id = match[1];
    return match !== null;
  }, { timeout: 15_000 });
  await closeLibrary(page);
  return id;
}

/**
 * Feed a .canvas file to the Library's hidden import input. Leaves the rail open: a rejected file reports its error inside the pane,
 * and a successful import navigates away on its own. Callers on the success path call closeLibrary once the new page has loaded.
 */
export async function importCanvasFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await openLibrary(page);
  await page.getByTestId("import-canvas-input").setInputFiles(file);
}
