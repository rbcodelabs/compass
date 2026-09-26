import { test, expect } from "../fixtures/index"
import type { Page } from "@playwright/test"

async function createArtifact(page: Page, base: string, title = "Checkout prototype") {
  await page.goto(`${base}/docs/artifacts/new`)
  await page.getByLabel("Title").fill(title)
  await page.getByLabel("Self-contained HTML file").setInputFiles({
    name: "checkout.html", mimeType: "text/html",
    buffer: Buffer.from('<!doctype html><html><head><style>body{font:16px system-ui;padding:24px;background:#fff;color:#171717}h1{font-size:28px}input{display:block;margin-top:12px;padding:10px;border:1px solid #bbb;border-radius:8px}</style></head><body><h1>Checkout preview</h1><p>Review your order before continuing.</p><label>Delivery note <input aria-label="Delivery note"></label></body></html>'),
  })
  await page.getByRole("button", { name: "Create artifact" }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Checkout preview" })).toBeVisible()
}

const pinned = (page: Page) => page.getByRole("complementary", { name: "Comments" })

test("Artifact comments support the discussion lifecycle across revisions and archive", async ({ page, base }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createArtifact(page, base)
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await page.getByRole("button", { name: "Pin panel", exact: true }).click()
  await page.getByRole("textbox", { name: "Add comment" }).fill("Review the **delivery note**.")
  await page.getByRole("button", { name: "Post comment", exact: true }).click()
  await expect(pinned(page).locator("strong").filter({ hasText: "delivery note" })).toBeVisible()
  await pinned(page).getByRole("button", { name: /^Reply to/ }).click()
  await pinned(page).getByRole("textbox", { name: /^Reply to/ }).fill("Reply draft")
  await pinned(page).getByRole("textbox", { name: /^Reply to/ }).press("Escape")
  await expect(pinned(page)).toBeVisible()
  await pinned(page).getByRole("button", { name: /^Reply to/ }).click()
  await pinned(page).getByRole("textbox", { name: /^Reply to/ }).fill("Looks good.")
  await pinned(page).getByRole("button", { name: "Post reply" }).click()
  await expect(pinned(page).getByText("Looks good.", { exact: true })).toBeVisible()
  await pinned(page).getByRole("button", { name: /^Edit comment by/ }).first().click()
  await pinned(page).getByRole("textbox", { name: /^Edit comment by/ }).fill("Reviewed delivery note.")
  await pinned(page).getByRole("button", { name: "Save edit" }).click()
  await expect(pinned(page).getByText("Reviewed delivery note.", { exact: true })).toBeVisible()
  await pinned(page).getByRole("button", { name: /^Resolve thread/ }).click()
  await pinned(page).getByRole("button", { name: /^Expand resolved thread/ }).click()
  await expect(pinned(page).getByText("Looks good.", { exact: true })).toBeVisible()
  await pinned(page).getByRole("button", { name: /^Reopen thread/ }).click()
  await page.getByRole("textbox", { name: "Add comment" }).fill("Draft survives revision refresh")
  await page.locator('input[name="file"]').setInputFiles({ name: "v2.html", mimeType: "text/html", buffer: Buffer.from("<html><body><h1>Revision two</h1></body></html>") })
  await page.getByRole("button", { name: "Replace current revision" }).click()
  await expect(page.frameLocator("iframe").getByRole("heading", { name: "Revision two" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Add comment" })).toHaveValue("Draft survives revision refresh")
  await expect(pinned(page).getByText("Reviewed delivery note.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByText("This artifact is archived.")).toBeVisible()
  await expect(pinned(page).getByText("Reviewed delivery note.", { exact: true })).toBeVisible()
  page.once("dialog", (dialog) => dialog.accept())
  await pinned(page).getByRole("button", { name: /^Delete thread by/ }).click()
  await expect(pinned(page).getByText("No comments yet.")).toBeVisible()
})

test("Artifact pinning preserves preview and drafts, isolates cookies, and adapts to small screens", async ({ page, base }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const longTitle = "Checkout prototype for reviewing delivery details with the fulfillment team"
  await createArtifact(page, base, longTitle)
  await page.context().addCookies([
    { name: "compass_panel_docsComments", value: "1:336", url: page.url() },
    { name: "compass_panel_docsHistory", value: "0:512", url: page.url() },
  ])
  await page.frameLocator("iframe").getByRole("textbox", { name: "Delivery note" }).fill("Preview stays mounted")
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await page.getByRole("textbox", { name: "Add comment" }).fill("The delivery note is easy to find. Could we clarify when it will be shared?")
  await page.getByRole("button", { name: "Post comment", exact: true }).click()
  await expect(page.getByText("The delivery note is easy to find. Could we clarify when it will be shared?", { exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: "Add comment" }).fill("Keep this draft")
  await page.getByRole("button", { name: "Pin panel", exact: true }).click()
  await page.frameLocator("iframe").getByRole("textbox", { name: "Delivery note" }).press("Escape")
  await expect(pinned(page)).toBeVisible()
  const handle = pinned(page).getByRole("separator", { name: "Resize panel" })
  await handle.press("Home")
  await handle.press("ArrowLeft")
  await expect(handle).toHaveAttribute("aria-valuenow", "336")
  await pinned(page).getByRole("button", { name: "Close panel" }).click()
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Add comment" })).toHaveValue("Keep this draft")
  await expect(page.frameLocator("iframe").getByRole("textbox", { name: "Delivery note" })).toHaveValue("Preview stays mounted")
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.classList.toggle("dark", value === "dark"), theme)
    for (const width of [1440, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const surface = width >= 1440 ? pinned(page) : page.getByRole("dialog", { name: "Comments" })
      // The Docs tree consumes width too; even a desktop viewport can suspend pinning.
      const visibleSurface = await pinned(page).count() ? pinned(page) : surface
      await expect(visibleSurface).toBeVisible()
      await expect(visibleSurface).toHaveCSS("opacity", "1")
      await expect(page.getByRole("textbox", { name: "Add comment" })).toHaveValue("Keep this draft")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (await pinned(page).count()) expect((await page.locator('[data-slot="artifact-content-column"]').boundingBox())!.width).toBeGreaterThanOrEqual(479)
      await page.screenshot({ path: testInfo.outputPath(`artifact-comments-${theme}-${width}.png`), animations: "disabled" })
      if (width === 390) {
        await visibleSurface.getByRole("button", { name: /^Reply to/ }).click()
        await visibleSurface.getByRole("textbox", { name: /^Reply to/ }).press("Escape")
        await expect(visibleSurface).toBeVisible()
        await expect(visibleSurface.getByRole("textbox", { name: /^Reply to/ })).toHaveCount(0)
      }
    }
  }
  await page.getByRole("dialog", { name: "Comments" }).getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("heading", { name: longTitle })).toBeVisible()
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible()
  expect((await page.getByRole("heading", { name: longTitle }).boundingBox())!.width).toBeGreaterThan(300)
  for (const control of [page.getByRole("heading", { name: longTitle }), page.getByRole("button", { name: "Comments", exact: true }), page.getByRole("button", { name: "Archive", exact: true })]) {
    const bounds = (await control.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("artifact-comments-closed-mobile.png"), animations: "disabled" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(pinned(page)).toBeVisible()
  await expect(page.frameLocator("iframe").getByRole("textbox", { name: "Delivery note" })).toHaveValue("Preview stays mounted")
  const cookies = await page.context().cookies()
  expect(cookies.find((cookie) => cookie.name === "compass_panel_docsComments")?.value).toBe("1:336")
  expect(cookies.find((cookie) => cookie.name === "compass_panel_docsHistory")?.value).toBe("0:512")
  expect(cookies.find((cookie) => cookie.name === "compass_panel_artifactComments")?.value).toBe("1:336")
  await page.reload()
  await expect(pinned(page)).toHaveCount(0)
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await expect(pinned(page).getByRole("separator")).toHaveAttribute("aria-valuenow", "336")
  await expect(page.getByRole("textbox", { name: "Add comment" })).toHaveValue("")
})

test("External Artifacts expose the same comments without embedding the external site", async ({ page, base }) => {
  await page.goto(`${base}/docs/artifacts/new`)
  await page.getByLabel("Title").fill("External checkout reference")
  await page.getByRole("button", { name: "External link", exact: true }).click()
  await page.getByLabel("External URL").fill("https://example.com/prototype")
  await page.getByRole("button", { name: "Create artifact" }).click()
  await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
  await expect(page.locator("iframe")).toHaveCount(0)
  await page.getByRole("button", { name: "Comments", exact: true }).click()
  await page.getByRole("textbox", { name: "Add comment" }).fill("Review the external reference.")
  await page.getByRole("button", { name: "Post comment", exact: true }).click()
  await expect(page.getByText("Review the external reference.", { exact: true })).toBeVisible()
})
