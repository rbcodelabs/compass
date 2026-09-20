import { request as playwrightRequest } from "@playwright/test"
import { test, expect } from "../fixtures/index"

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
)

test.describe("Doc image upload privacy", () => {
  test("uploads through the editor and serves the image only to a workspace member", async ({ page, base }) => {
    await page.goto(`${base}/docs`)
    await page.waitForLoadState("networkidle")
    const previousDocUrl = page.url()
    await page.getByRole("button", { name: "New" }).click()
    await page.waitForURL(
      url => url.href !== previousDocUrl && /\/docs\/[0-9a-f-]+$/.test(url.pathname),
      { timeout: 15_000 }
    )

    const upload = page.waitForResponse(
      response => response.url().endsWith("/api/docs/upload") && response.request().method() === "POST"
    )
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "qa-screenshot.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    })
    expect((await upload).status()).toBe(200)

    const image = page.locator('.ProseMirror img[src^="/api/docs/images/"]')
    await expect(image).toBeVisible({ timeout: 10_000 })
    const imagePath = await image.getAttribute("src")
    expect(imagePath).toMatch(/^\/api\/docs\/images\/[0-9a-f-]+\/[0-9a-f-]{36}\.png$/)

    const authorized = await page.request.get(imagePath!)
    expect(authorized.status()).toBe(200)
    expect(authorized.headers()["content-type"]).toBe("image/png")
    expect(authorized.headers()["cache-control"]).toBe("private, no-store")

    const anonymous = await playwrightRequest.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: { cookies: [], origins: [] },
    })
    try {
      const denied = await anonymous.get(imagePath!, { maxRedirects: 0 })
      expect(denied.status()).toBe(404)
    } finally {
      await anonymous.dispose()
    }
  })
})
