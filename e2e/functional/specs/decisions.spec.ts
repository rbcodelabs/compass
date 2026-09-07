import { expect, test } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"

test.describe("Decisions", () => {
  test("shows supporting product sources and opens a linked detail panel", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const suffix = Date.now().toString()
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `Brand opportunity ${suffix}` } })
    const solution = await prisma.solution.create({ data: { opportunityId: opportunity.id, title: `Brand concepts ${suffix}` } })
    const assumption = await prisma.assumption.create({ data: { solutionId: solution.id, title: `Visitors recognize the product ${suffix}` } })
    const experiment = await prisma.experiment.create({ data: {
      workspaceId: workspace.id,
      assumptionId: assumption.id,
      title: `Five-second brand test ${suffix}`,
      hypothesis: "Visitors can identify the product after five seconds.",
      method: "Show randomized concepts and ask for product recall.",
      killCondition: "Fewer than half identify the product correctly.",
    } })
    const revision = await createTrackedDecisionRequest({
      workspaceId: workspace.id,
      subjectType: "EXPERIMENT",
      subjectId: experiment.id,
      question: `Is the brand test ready? ${suffix}`,
      context: "## Recommendation\n\nKeep the experiment in **Designing** until recruitment is ready.",
      idempotencyKey: crypto.randomUUID(),
      sources: [
        { type: "ASSUMPTION", id: assumption.id },
        { type: "SOLUTION", id: solution.id },
        { type: "OPPORTUNITY", id: opportunity.id },
      ],
    })

    await page.goto(`${base}/reviews/${revision.requestId}`)
    await expect(page.getByRole("heading", { name: `Is the brand test ready? ${suffix}` })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible()
    await expect(page.getByText(`Visitors recognize the product ${suffix}`)).toBeVisible()
    await expect(page.getByText("Keep the experiment in Designing until recruitment is ready.")).toBeVisible()

    await page.getByRole("link", { name: new RegExp(`Visitors recognize the product ${suffix}`) }).click()
    await expect(page).toHaveURL(/detail=assumption/)
    await expect(page.getByRole("dialog")).toContainText(`Visitors recognize the product ${suffix}`)
  })

  test("request → request changes → revise → approve", async ({ page, base }) => {
    const question = `Should we ship the simple decision flow? ${Date.now()}`
    await page.goto(`${base}/decisions`)
    await expect(page.getByRole("heading", { name: "Decisions", exact: true })).toBeVisible()
    await page.getByRole("link", { name: "New decision" }).click()
    await page.getByLabel("Decision question").fill(question)
    await page.getByLabel("Context").fill("The team needs one clear, recorded call.")
    await page.getByRole("button", { name: "Request decision" }).click()

    await expect(page.getByRole("heading", { name: question })).toBeVisible()
    await page.getByLabel("Rationale").fill("Clarify the empty state before shipping.")
    await page.getByRole("button", { name: "Request changes" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await page.getByRole("link", { name: "Create revised request" }).click()
    await expect(page.getByLabel("Decision question")).toHaveValue(question)
    await page.getByLabel("Context").fill("The empty state is now clear and actionable.")
    await page.getByRole("button", { name: "Request decision" }).click()

    await page.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText(/Decision recorded:/)).toBeVisible()
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible()
    await page.goto(`${base}/decisions?tab=decided&q=${encodeURIComponent(question)}`)
    await expect(page.getByText(question).first()).toBeVisible()
  })
})
