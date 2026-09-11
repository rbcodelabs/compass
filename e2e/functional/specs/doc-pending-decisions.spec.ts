import { test, expect } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"

test.describe("Docs pending decision toolbar", () => {
  test("request → pending toolbar → request changes → revised pending → approve", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const doc = await prisma.doc.create({ data: { workspaceId: workspace.id, title: "Launch readiness", content: "Review the launch plan before release." } })
    const docUrl = `${base}/docs/${doc.id}`
    const question = `Is this launch ready? ${doc.id}`
    await page.goto(docUrl)
    await page.getByRole("link", { name: "Request decision", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`subjectId=${doc.id}`))
    await page.getByLabel("Decision question").fill(question)
    await page.getByLabel("Context").fill("Please review the launch readiness document.")
    await page.getByRole("button", { name: "Request decision", exact: true }).click()
    await expect(page.getByRole("heading", { name: question })).toBeVisible()
    const reviewUrl = page.url()
    // Use the subject link to exercise client navigation and action revalidation.
    await page.getByRole("link", { name: /Launch readiness/ }).first().click()
    await expect(page).toHaveURL(new RegExp(`/docs/${doc.id}$`))
    await page.getByRole("link", { name: "Decision pending, 1 request" }).click()
    await expect(page).toHaveURL(reviewUrl)
    await page.getByLabel("Rationale").fill("Clarify the rollout timing.")
    await page.getByRole("button", { name: "Request changes", exact: true }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await page.getByRole("link", { name: /Launch readiness/ }).first().click()
    // Previously this asserted a bare "Request decision" link — the recorded
    // decision vanished from the document and invited a duplicate request.
    // The outcome is now surfaced instead.
    await expect(page.getByRole("button", { name: /^Changes requested by / })).toBeVisible()
    await expect(page.getByRole("link", { name: "Request decision", exact: true })).toBeHidden()
    await page.goto(reviewUrl)
    await page.getByRole("link", { name: "Create revised request" }).click()
    await page.getByLabel("Context").fill("Rollout timing is now documented.")
    await page.getByRole("button", { name: "Request decision", exact: true }).click()
    await expect(page.getByRole("heading", { name: question })).toBeVisible()
    await page.getByRole("link", { name: /Launch readiness/ }).first().click()
    await page.getByRole("link", { name: "Decision pending, 1 request" }).click()
    await page.getByRole("button", { name: "Approve", exact: true }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await page.getByRole("link", { name: /Launch readiness/ }).first().click()

    // The outcome is durable on the document, and reaches both the decision
    // itself and a follow-up request without losing the prefilled subject.
    const outcome = page.getByRole("button", { name: /^Approved by / })
    await expect(outcome).toBeVisible()
    await expect(page.getByRole("link", { name: "Request decision", exact: true })).toBeHidden()
    await outcome.click()
    const outcomeMenu = page.getByRole("menu")
    // `reviewUrl` is absolute (page.url()); the href is workspace-relative.
    await expect(outcomeMenu.getByRole("menuitem", { name: question })).toHaveAttribute("href", new URL(reviewUrl).pathname)
    await expect(outcomeMenu.getByRole("menuitem", { name: "Request another decision" })).toHaveAttribute("href", new RegExp(`subjectId=${doc.id}`))
    await outcomeMenu.getByRole("menuitem", { name: question }).click()
    await expect(page).toHaveURL(reviewUrl)
  })

  test("multiple requests, exact association, keyboard links and responsive themes", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const doc = await prisma.doc.create({ data: { workspaceId: workspace.id, title: "Launch plan", content: "# Launch readiness\n\nA shared plan for the release.\n\n## Rollout\n\nStart with a small cohort, review feedback, then expand access." } })
    const other = await prisma.doc.create({ data: { workspaceId: workspace.id, title: "Supporting notes" } })
    const first = await createTrackedDecisionRequest({ workspaceId: workspace.id, subjectType: "DOC", subjectId: doc.id, question: "Approve the launch plan?", context: "The team is ready to begin the rollout.", idempotencyKey: crypto.randomUUID() })
    const second = await createTrackedDecisionRequest({ workspaceId: workspace.id, subjectType: "DOC", subjectId: doc.id, question: "Is the staged rollout ready for the first customer cohort and the expanded support schedule?", context: "Confirm that support coverage is ready.", idempotencyKey: crypto.randomUUID() })
    await createTrackedDecisionRequest({ workspaceId: workspace.id, subjectType: "DOC", subjectId: other.id, question: "Review supporting notes?", context: `References ${doc.id}`, sources: [{ type: "DOC", id: doc.id }], idempotencyKey: crypto.randomUUID() })
    await page.goto(`${base}/docs/${doc.id}`)
    const button = page.getByRole("button", { name: "Decisions pending, 2 requests" })
    await button.focus()
    await page.keyboard.press("ArrowDown")
    const menu = page.getByRole("menu")
    await expect(menu.getByRole("menuitem")).toHaveCount(2)
    await expect(menu.getByRole("menuitem").first()).toHaveAttribute("href", `${base}/reviews/${second.requestId}`)
    await expect(menu.getByRole("menuitem").last()).toHaveAttribute("href", `${base}/reviews/${first.requestId}`)
    await page.keyboard.press("Escape")
    await expect(button).toBeFocused()
    for (const [viewport, size] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(size)
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => { document.documentElement.classList.toggle("dark", value === "dark"); document.documentElement.style.colorScheme = value }, theme)
        await button.click()
        await expect(menu.getByRole("menuitem").first()).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        if (process.env.UPDATE_DOC_DECISION_SCREENSHOTS === "1") await page.screenshot({ animations: "disabled", path: `public/screenshots/docs/docs-pending-decision-${viewport}-${theme}.png` })
        await page.keyboard.press("Escape")
      }
    }
    await button.focus()
    await page.keyboard.press("ArrowDown")
    await menu.getByRole("menuitem").first().focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(new RegExp(`/reviews/${second.requestId}$`))
  })
})
