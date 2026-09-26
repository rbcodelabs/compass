import { test, expect } from "../fixtures/index"
import type { Page } from "@playwright/test"

/**
 * Native, same-origin element-anchored feedback on a Compass-hosted
 * (HTML_UPLOAD) artifact — the "leave feedback" picker built into Compass's
 * own artifact-viewer chrome, distinct from the embeddable widget in
 * e2e/functional/specs/in-app-feedback.spec.ts, which only targets an
 * external https:// origin. This spec drives the real sandboxed iframe with
 * real browser clicks, so it is also the only place the injected pick-mode
 * script (lib/artifact-preview-html.ts) gets executed for real — jsdom does
 * not execute srcdoc scripts, so the unit suite only exercises the parent
 * side of the message protocol (__tests__/artifact-preview.test.tsx).
 */
async function createArtifact(page: Page, base: string, title = "Checkout prototype") {
  await page.goto(`${base}/docs/artifacts/new`)
  await page.getByLabel("Title").fill(title)
  await page.getByLabel("Self-contained HTML file").setInputFiles({
    name: "checkout.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<!doctype html><html><head><style>body{font:16px system-ui;padding:24px;background:#fff;color:#171717}button{display:block;margin-top:16px;padding:10px 16px;border-radius:8px}</style></head><body><h1>Checkout preview</h1><p>Review your order before continuing.</p><button id="cta" onclick="document.title=\'clicked\'">Buy now</button></body></html>',
    ),
  })
  await page.getByRole("button", { name: "Create artifact" }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Checkout preview" })).toBeVisible()
}

function pin(page: Page) {
  return page.getByRole("button", { name: /^Feedback from/ })
}

test("A workspace member can pick an element, leave anchored feedback, and see it as a pin on reload and in full screen", async ({ page, base }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await createArtifact(page, base)

  // Entering pick mode never lets the prototype's own click handler fire —
  // the swallowed click is the whole point (see onPickClick's doc comment in
  // lib/artifact-preview-html.ts).
  await page.getByRole("button", { name: "Leave feedback" }).click()
  await expect(page.getByText(/click an element in the preview/i)).toBeVisible()
  await page.frameLocator("iframe").getByRole("button", { name: "Buy now" }).click()
  // The onclick handler would create a <title> element (there was none in the
  // uploaded markup) if it ever ran. Its absence is proof the click never reached it.
  await expect(page.frameLocator("iframe").locator("title")).toHaveCount(0)

  await expect(page.getByText(/commenting on: button/i)).toBeVisible()
  await page.getByRole("textbox", { name: "Anchored feedback" }).fill("Move this button above the fold.")
  await page.getByRole("button", { name: "Post feedback" }).click()
  await expect(page.getByRole("textbox", { name: "Anchored feedback" })).toHaveCount(0)

  await expect(pin(page)).toBeVisible()
  await expect(pin(page)).toHaveAttribute("aria-label", /Move this button above the fold\./)

  // The comment is an ordinary root ARTIFACT comment underneath the anchor,
  // so it also shows up in the whole-artifact Discussion thread. (Panel
  // open/close/pin responsive behavior itself is covered by
  // artifact-comments.spec.ts — this only checks the anchor didn't fork the
  // comment into a separate, invisible-to-Discussion record.)
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(page.getByText("Move this button above the fold.", { exact: true })).toBeVisible()

  // Re-anchoring survives a fresh load: the selector is re-resolved against
  // the live sandbox DOM rather than replayed from a cache.
  await page.reload()
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Checkout preview" })).toBeVisible()
  await expect(pin(page)).toBeVisible()

  await page.getByRole("link", { name: "View full screen" }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+\/full-screen$/)
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Checkout preview" })).toBeVisible()
  await expect(pin(page)).toBeVisible()

  await page.getByRole("link", { name: "Back to artifact" }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  await expect(pin(page)).toBeVisible()
})

test("Escape cancels pick mode without leaving a draft comment behind", async ({ page, base }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await createArtifact(page, base, "Cancel prototype")
  await page.getByRole("button", { name: "Leave feedback" }).click()
  // Shift the browser's focused frame into the sandbox first — clicking an
  // empty area of body (not the button) never counts as a pick (isPickable
  // excludes documentElement/body), but does move keyboard focus into the
  // frame so the following top-level Escape reaches the sandbox's own
  // document, where the pick-mode listener lives (see onPickEscape in
  // lib/artifact-preview-html.ts).
  await page.frameLocator("iframe").locator("body").click({ position: { x: 4, y: 4 } })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Leave feedback" })).toBeVisible()
  await expect(page.getByText(/click an element in the preview/i)).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Anchored feedback" })).toHaveCount(0)
})

test("A stale anchor is flagged rather than positioned at the wrong element", async ({ page, base }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await createArtifact(page, base, "Stale anchor prototype")
  await page.getByRole("button", { name: "Leave feedback" }).click()
  await page.frameLocator("iframe").getByRole("button", { name: "Buy now" }).click()
  await page.getByRole("textbox", { name: "Anchored feedback" }).fill("Anchored to the CTA.")
  await page.getByRole("button", { name: "Post feedback" }).click()
  await expect(pin(page)).toBeVisible()

  // Replace the revision with markup that no longer contains anything the
  // stored selector or fingerprint can confidently match.
  await page.locator('input[name="file"]').setInputFiles({
    name: "v2.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html><body><h1>Redesigned checkout</h1><p>Completely different layout.</p></body></html>"),
  })
  await page.getByRole("button", { name: "Replace current revision" }).click()
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Redesigned checkout" })).toBeVisible()

  await expect(page.getByText(/1 pinned comment could not be re-anchored precisely/i)).toBeVisible()
  await expect(pin(page)).toHaveCount(0)
})
