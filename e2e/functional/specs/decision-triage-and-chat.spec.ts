import { randomUUID } from "node:crypto"
import { expect, test } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"

test.describe("Decision Inbox Triage, Slide-Over Drawer, and Chat Quick Card", () => {
  test("steps through pending queue on Inbox Triage, renders semantic outcome banners, and keeps zero overflow on desktop and mobile", async ({
    page,
    base,
    workspaceSlug,
    orgSlug,
  }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
      include: { members: { take: 1 } },
    })
    const requesterUserId = workspace.members[0]?.userId ?? null
    const suffix = randomUUID().slice(0, 8)

    const opportunity = await prisma.opportunity.create({
      data: { workspaceId: workspace.id, title: `Review fatigue ${suffix}` },
    })
    const solution = await prisma.solution.create({
      data: { workspaceId: workspace.id, opportunityId: opportunity.id, title: `Inbox Triage layout ${suffix}` },
    })

    await createTrackedDecisionRequest({
      workspaceId: workspace.id,
      subjectType: "SOLUTION",
      subjectId: solution.id,
      requestedById: requesterUserId,
      question: `Pause legacy export pipeline? ${suffix}`,
      context: "## Context\n\nLegacy export usage dropped below **1%** of weekly active teams.",
      sources: [{ type: "OPPORTUNITY", id: opportunity.id }],
      idempotencyKey: randomUUID(),
    })

    const second = await createTrackedDecisionRequest({
      workspaceId: workspace.id,
      subjectType: "SOLUTION",
      subjectId: solution.id,
      requestedById: requesterUserId,
      question: `Ship Inbox Triage as default review view? ${suffix}`,
      context: "## Recommendation\n\nPut the ballot above the fold and move long evidence into tabs.",
      options: [
        { label: "Ship Inbox Triage", description: "Make the triage hero card the default layout." },
        { label: "Keep behind feature flag", description: "Roll out gradually." },
      ],
      sources: [{ type: "OPPORTUNITY", id: opportunity.id }],
      idempotencyKey: randomUUID(),
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/reviews/${second.requestId}`)

    await expect(page.getByRole("heading", { name: `Ship Inbox Triage as default review view? ${suffix}` })).toBeVisible()
    await expect(page.getByTestId("decision-display-id")).toHaveText(/^DEC-\d+$/)
    await expect(page.getByText("Awaiting review")).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Pending decisions queue" })).toContainText(/of \d+ pending/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // Verify mobile viewport has zero horizontal overflow too
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })

    // Step to the next pending decision via the queue stepper
    await page.getByRole("link", { name: "Next pending decision" }).click()
    await expect(page.getByRole("heading", { name: `Pause legacy export pipeline? ${suffix}` })).toBeVisible()

    // Record a Reject outcome and verify semantic danger banner (not green!) + Next pending jump
    await page.getByLabel("Rationale").fill("Hold off until enterprise migration completes next month.")
    await page.getByRole("button", { name: "Reject", exact: true }).click()

    const banner = page.getByTestId("decision-outcome-banner")
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute("data-outcome", "REJECT")
    await expect(banner).toContainText("Decision recorded: Reject")
    await expect(page.getByText("Rejected", { exact: true })).toBeVisible()
  })

  test("renders Chat Option 3 Quick Card in /agent, opens aligned DecisionPanel drawer, and syncs live inline choice approval", async ({
    page,
    base,
    workspaceSlug,
    orgSlug,
  }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    })

    // Resolve the exact signed-in E2E session user so AgentConversation ownership always matches
    const sessionJson = (await (await page.request.get("/api/auth/session")).json()) as {
      user?: { id?: string; email?: string }
    }
    const sessionUser = sessionJson.user?.id
      ? { id: sessionJson.user.id }
      : await prisma.user.findUniqueOrThrow({ where: { email: sessionJson.user!.email! }, select: { id: true } })
    const suffix = randomUUID().slice(0, 8)

    const decision = await createTrackedDecisionRequest({
      workspaceId: workspace.id,
      subjectType: "WORKSPACE",
      subjectId: workspace.id,
      requestedById: sessionUser.id,
      question: `Which embedded chat card style should we ship? ${suffix}`,
      context: "Option 3 keeps chat compact while opening the slide-over drawer for full briefs and pushback.",
      options: [
        { label: "Option 3 Quick Card", description: "Compact inline card + drawer handoff." },
        { label: "Link pill only", description: "Minimal pill with no inline action." },
      ],
      idempotencyKey: randomUUID(),
    })

    const conversation = await prisma.agentConversation.create({
      data: {
        workspaceId: workspace.id,
        userId: sessionUser.id,
        title: `Decision card QA ${suffix}`,
        summary: "Requested a decision on the embedded chat card.",
        messages: {
          create: [
            {
              role: "user",
              content: "Raise a decision so I can pick the embedded chat card direction.",
              authorUserId: sessionUser.id,
            },
            {
              role: "assistant",
              content: `I requested a tracked decision for your review: [Review decision](${base}/reviews/${decision.requestId}).`,
            },
          ],
        },
      },
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/agent?c=${conversation.id}`)

    const chatCard = page.getByTestId("tracked-decision-chat-card")
    await expect(chatCard).toBeVisible({ timeout: 20_000 })
    await expect(chatCard).toContainText(`Which embedded chat card style should we ship? ${suffix}`)
    await expect(chatCard).toContainText("Awaiting review")
    await expect(chatCard).toContainText("Option 3 keeps chat compact")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // Verify mobile viewport has zero horizontal overflow on /agent with card mounted
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(chatCard).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })

    // Open the aligned DecisionPanel slide-over drawer directly from the Chat Quick Card
    await chatCard.getByRole("button", { name: /Read brief & decide/i }).click()
    await expect(page).toHaveURL(new RegExp(`detail=review%3A${decision.requestId}`))
    const drawer = page.getByRole("dialog")
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId("display-id")).toHaveText(/^DEC-\d+$/)
    await expect(drawer.getByRole("heading", { name: `Which embedded chat card style should we ship? ${suffix}` })).toBeVisible()

    // Close drawer (Escape) and confirm choice directly inline on the Chat Option 3 Quick Card
    await page.keyboard.press("Escape")
    await chatCard.getByRole("radio", { name: "Option 3 Quick Card" }).click()
    await chatCard.getByRole("button", { name: "Confirm choice" }).click()

    await expect(chatCard).toContainText("Approved")
    await expect(chatCard).toContainText("Decision recorded: Option 3 Quick Card")
  })
})
