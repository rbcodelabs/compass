import { test, expect } from "../fixtures/index"
import getPrisma from "../../../lib/db"

test.describe("Capture — PM interview", () => {
  test("launches, interviews, reviews, edits, selects, and applies all supported targets", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const suffix = Date.now().toString()
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM opportunity ${suffix}`, description: "Teams lose decisions after planning." } })
    const solution = await prisma.solution.create({ data: { opportunityId: opportunity.id, title: `PM solution ${suffix}`, description: "Capture decisions beside the plan." } })
    const assumption = await prisma.assumption.create({ data: { solutionId: solution.id, title: `PM assumption ${suffix}`, description: "Teams will record decisions while context is fresh." } })
    const experiment = await prisma.experiment.create({ data: { workspaceId: workspace.id, assumptionId: assumption.id, title: `PM experiment ${suffix}`, hypothesis: "A prompt increases recorded decisions.", method: "Prototype prompt", killCondition: "No increase after five sessions", status: "DESIGNING" } })
    const targets = [
      ["OPPORTUNITY", opportunity.id], ["SOLUTION", solution.id], ["ASSUMPTION", assumption.id], ["EXPERIMENT", experiment.id],
    ] as const
    const interviewIds: string[] = []
    try {
      for (const [targetType, targetId] of targets) {
        const created = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType, targetId } })
        expect(created.status(), await created.text()).toBe(201)
        const interview = await created.json() as { id: string }
        interviewIds.push(interview.id)
        const response = await page.request.post(`/api/pm-interviews/${interview.id}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { answer: `The PM clarified the ${targetType.toLowerCase()} and named the riskiest belief.`, idempotencyKey: `pm-answer-${targetType.toLowerCase()}-${suffix}` } })
        expect(response.status(), await response.text()).toBe(200)
        const completed = await page.request.post(`/api/pm-interviews/${interview.id}/complete?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)
        expect(completed.status(), await completed.text()).toBe(200)
        const editedTitle = `Clarified ${targetType.toLowerCase()} ${suffix}`
        const applied = await page.request.post(`/api/pm-interviews/${interview.id}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], editedValues: { title: editedTitle }, idempotencyKey: `pm-apply-${targetType.toLowerCase()}-${suffix}` } })
        expect(applied.status(), await applied.text()).toBe(200)
        const delegate = targetType === "OPPORTUNITY" ? prisma.opportunity : targetType === "SOLUTION" ? prisma.solution : targetType === "ASSUMPTION" ? prisma.assumption : prisma.experiment
        const readback = await (delegate as typeof prisma.opportunity).findUnique({ where: { id: targetId }, select: { title: true } })
        expect(readback?.title).toBe(editedTitle)
      }
      await page.goto(`${base}/capture`)
      await expect(page.getByRole("link", { name: "PM interview" }).first()).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${base}/capture/pm/${interviewIds[0]}`)
      await expect(page.getByText("PM interview brief")).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    } finally {
      const records = await prisma.pMInterview.findMany({ where: { id: { in: interviewIds } }, select: { studyId: true, sessionId: true } })
      const sessionIds = records.map(record => record.sessionId), studyIds = records.map(record => record.studyId)
      await prisma.researchParticipantVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchRequest.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchTurn.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.pMInterview.deleteMany({ where: { id: { in: interviewIds } } })
      await prisma.researchSession.deleteMany({ where: { id: { in: sessionIds } } })
      await prisma.researchParticipantToken.deleteMany({ where: { studyId: { in: studyIds } } })
      await prisma.researchStudy.deleteMany({ where: { id: { in: studyIds } } })
      await prisma.experiment.deleteMany({ where: { id: experiment.id } })
      await prisma.assumption.deleteMany({ where: { id: assumption.id } })
      await prisma.solution.deleteMany({ where: { id: solution.id } })
      await prisma.opportunity.deleteMany({ where: { id: opportunity.id } })
    }
  })
})
