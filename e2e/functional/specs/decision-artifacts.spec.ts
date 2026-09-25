import { expect, test } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"

test.describe("Decision supporting artifacts", () => {
  for (const decided of [false, true]) {
    test(`${decided ? "decided" : "pending"} request supports live prototype links without changing approval evidence`, async ({ page, base, workspaceSlug }, testInfo) => {
      const prisma = getPrisma()
      const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
      const question = `Which checkout direction should we explore? ${decided ? "Recorded decision" : "Pending decision"}`
      const revision = await createTrackedDecisionRequest({ workspaceId: workspace.id, subjectType: "WORKSPACE", subjectId: workspace.id, question, context: "Compare the supporting prototype. Linked materials are live, not frozen approval evidence.", idempotencyKey: crypto.randomUUID() })
      const decisionUrl = `${base}/reviews/${revision.requestId}`
      await page.goto(decisionUrl)
      if (decided) {
        await page.getByLabel("Rationale").fill("Explore the alternatives before committing.")
        await page.getByRole("button", { name: "Request changes", exact: true }).click()
        await expect(page.getByText(/Decision recorded:/)).toBeVisible()
      }
      const snapshot = () => prisma.reviewRequest.findUniqueOrThrow({ where: { id: revision.requestId }, include: { revisions: { orderBy: { revisionNumber: "asc" } }, decisions: { orderBy: { id: "asc" } } } })
      const before = await snapshot()
      const title = `Checkout exploration — compact rows, contextual badges and expandable previews (${decided ? "decided" : "pending"})`
      await page.goto(`${base}/docs/artifacts/new`)
      await page.getByLabel("Title").fill(title)
      await page.getByLabel("Self-contained HTML file").setInputFiles({ name: "checkout.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><html><body><h1>Checkout exploration</h1><button onclick=\"this.textContent='Selected'\">Try direction A</button></body></html>") })
      await page.getByRole("button", { name: "Create artifact", exact: true }).click()
      await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/)
      const artifactUrl = page.url()
      const artifactId = artifactUrl.split("/").at(-1)!

      await page.goto(decisionUrl)
      await expect(page.getByLabel("Artifact to link")).toBeVisible()
      await page.getByLabel("Artifact to link").selectOption(artifactId)
      await page.getByRole("button", { name: "Link", exact: true }).click()
      const artifactLink = page.getByRole("link", { name: title, exact: true })
      await expect(artifactLink).toBeVisible()
      expect(await snapshot()).toEqual(before)
      await artifactLink.click()
      await expect(page).toHaveURL(artifactUrl)
      await page.frameLocator(`iframe[title="${title} preview"]`).getByRole("button", { name: "Try direction A" }).click()
      await expect(page.frameLocator(`iframe[title="${title} preview"]`).getByRole("button", { name: "Selected" })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Linked decisions" })).toBeVisible()
      if (decided) {
        for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
          await page.setViewportSize(viewport)
          await page.getByRole("heading", { name: "Linked decisions" }).scrollIntoViewIfNeeded()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          const capture = { fullPage: true, animations: "disabled" as const, style: "nextjs-portal { display: none }" }
          await page.screenshot({ path: testInfo.outputPath(`artifact-decisions-${viewport.label}.png`), ...capture })
          if (process.env.UPDATE_DECISION_ARTIFACT_SCREENSHOTS === "1") await page.screenshot({ path: `public/screenshots/docs/artifact-decisions-${viewport.label}.png`, ...capture })
        }
      }
      await page.getByRole("link", { name: question, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/reviews/${revision.requestId}$`))

      // Replace through the real upload action, then follow the backlink without a hard reload.
      // Each hop between these two pages is a client-side navigation, and both
      // pages render overlapping text (the artifact title link, "Revision 2"),
      // so wait for the destination URL before asserting on or acting in it.
      await artifactLink.click()
      await expect(page).toHaveURL(artifactUrl)
      await page.locator('input[type="file"]').setInputFiles({ name: "checkout-v2.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><html><body><h1>Checkout exploration: direction B</h1><p>Distinct second revision content</p></body></html>") })
      await page.getByRole("button", { name: "Replace current revision", exact: true }).click()
      await expect(page.frameLocator(`iframe[title="${title} preview"]`).getByRole("heading", { name: "Checkout exploration: direction B", exact: true })).toBeVisible()
      await expect(page.frameLocator(`iframe[title="${title} preview"]`).getByRole("button", { name: "Try direction A" })).toHaveCount(0)
      await page.getByRole("link", { name: question, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/reviews/${revision.requestId}$`))
      await expect(page.getByText(/Revision 2/i).first()).toBeVisible()
      expect(await snapshot()).toEqual(before)

      if (decided) {
        for (const viewport of [{ width: 1280, height: 800, label: "desktop" }, { width: 390, height: 844, label: "mobile" }]) {
          await page.setViewportSize(viewport)
          await artifactLink.scrollIntoViewIfNeeded()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          const capture = { fullPage: true, animations: "disabled" as const, style: "nextjs-portal { display: none }" }
          await page.screenshot({ path: testInfo.outputPath(`decision-artifacts-${viewport.label}.png`), ...capture })
          if (process.env.UPDATE_DECISION_ARTIFACT_SCREENSHOTS === "1") await page.screenshot({ path: `public/screenshots/docs/decision-artifacts-${viewport.label}.png`, ...capture })
        }
      }
      await artifactLink.click()
      await expect(page).toHaveURL(artifactUrl)
      await page.getByRole("button", { name: "Archive", exact: true }).click()
      await expect(page.getByText("This artifact is archived.")).toBeVisible()
      await page.getByRole("link", { name: question, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/reviews/${revision.requestId}$`))
      await expect(artifactLink).toBeVisible()
      await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible()
      await page.getByRole("button", { name: /Unlink/ }).click()
      await expect(artifactLink).toHaveCount(0)
      expect(await prisma.artifactLink.count({ where: { artifactId, linkedType: "REVIEW_REQUEST", linkedId: revision.requestId } })).toBe(0)
      expect(await snapshot()).toEqual(before)
      await page.goto(artifactUrl)
      await expect(page.getByRole("link", { name: question, exact: true })).toHaveCount(0)
    })
  }
})
