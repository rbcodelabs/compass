import { test, expect } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createHash } from "node:crypto"

type TargetFixture = {
  type: "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT"
  id: string
  originalTitle: string
  deselectedField: string
  deselectedValue: string | null
}

test.describe("Capture — PM interview", () => {
  test("uses the real UI to launch, interview, review, edit, select, and apply every supported target", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const suffix = Date.now().toString()
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM opportunity ${suffix}`, description: "Teams lose decisions after planning.", customerSegment: "Product teams", status: "EXPLORING" } })
    const solution = await prisma.solution.create({ data: { opportunityId: opportunity.id, title: `PM solution ${suffix}`, description: "Capture decisions beside the plan.", status: "IDEA" } })
    const assumption = await prisma.assumption.create({ data: { solutionId: solution.id, title: `PM assumption ${suffix}`, description: "Teams will record decisions while context is fresh.", riskLevel: "HIGH", status: "UNTESTED" } })
    const experiment = await prisma.experiment.create({ data: { workspaceId: workspace.id, assumptionId: assumption.id, title: `PM experiment ${suffix}`, hypothesis: "A prompt increases recorded decisions.", method: "Prototype prompt", killCondition: "No increase after five sessions", status: "DESIGNING" } })
    const targets: TargetFixture[] = [
      { type: "OPPORTUNITY", id: opportunity.id, originalTitle: opportunity.title, deselectedField: "description", deselectedValue: opportunity.description },
      { type: "SOLUTION", id: solution.id, originalTitle: solution.title, deselectedField: "description", deselectedValue: solution.description },
      { type: "ASSUMPTION", id: assumption.id, originalTitle: assumption.title, deselectedField: "description", deselectedValue: assumption.description },
      { type: "EXPERIMENT", id: experiment.id, originalTitle: experiment.title, deselectedField: "hypothesis", deselectedValue: experiment.hypothesis },
    ]
    const evidenceBefore = await prisma.evidence.count({ where: { workspaceId: workspace.id } })
    const synthesisBefore = await prisma.researchSynthesis.count()
    const resultBefore = await prisma.experimentResult.count({ where: { experimentId: experiment.id } })
    const interviewIds: string[] = []

    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { throw new Error("Synthetic microphone unavailable") } } })
      })
      for (const [index, target] of targets.entries()) {
        await page.goto(`${base}/capture/pm/new`)
        await expect(page.getByRole("heading", { name: "Flesh this out" })).toBeVisible()
        if (index === 0) {
          await page.setViewportSize({ width: 1280, height: 960 })
          await page.screenshot({ path: "public/screenshots/docs/pm-interview-picker-desktop.png", fullPage: true })
          await page.setViewportSize({ width: 390, height: 844 })
          await page.screenshot({ path: "public/screenshots/docs/pm-interview-picker-mobile.png", fullPage: true })
          await page.setViewportSize({ width: 1280, height: 960 })
        }
        await page.getByLabel("Choose an item").selectOption(`${target.type}:${target.id}`)
        await Promise.all([
          page.waitForURL(/\/capture\/pm\/[a-f0-9-]+$/, { timeout: 20_000 }),
          page.getByRole("button", { name: "Start PM interview" }).click(),
        ])
        const interviewId = new URL(page.url()).pathname.split("/").at(-1)!
        interviewIds.push(interviewId)

        await expect(page.getByText(target.originalTitle)).toBeVisible()
        await expect(page.getByText(/about 15 minutes/i)).toBeVisible()
        await expect(page.getByText(/PM answers remain internal interpretation—not customer validation/i)).toBeVisible()

        if (index === 0) {
          await page.getByRole("button", { name: /Start voice/ }).click()
          const startVoiceSession = page.getByRole("button", { name: "Start voice session" })
          if (await startVoiceSession.isVisible().catch(() => false)) {
            await startVoiceSession.click()
            await expect(page.getByRole("alert").filter({ hasText: "Synthetic microphone unavailable" })).toBeVisible()
            await page.getByRole("button", { name: "Use chat instead" }).click()
          } else {
            await expect(page.getByRole("alert").filter({ hasText: "Continue in text" })).toBeVisible()
          }
        } else {
          await page.getByRole("button", { name: /Use text/ }).click()
        }

        const answer = `The PM clarified the ${target.type.toLowerCase()} and named the riskiest belief ${suffix}.`
        await page.getByLabel("Your answer").fill(answer)
        await page.getByRole("button", { name: "Send answer" }).click()
        await expect(page.getByText(answer)).toBeVisible()
        await expect(page.getByText("What concrete observation would most challenge that belief?")).toBeVisible()

        if (index === 0) {
          await page.reload()
          await page.getByRole("button", { name: /Use text/ }).click()
          await expect(page.getByText(answer)).toBeVisible()
          await expect(page.getByText("What concrete observation would most challenge that belief?")).toBeVisible()
        }

        await page.getByRole("button", { name: "Finish and review" }).click()
        await expect(page.getByText("PM interview brief")).toBeVisible()
        await expect(page.getByRole("heading", { name: "Proposed changes" })).toBeVisible()
        if (index === 0) {
          await page.screenshot({ path: "public/screenshots/docs/pm-interview-review-desktop.png", fullPage: true })
          await page.setViewportSize({ width: 390, height: 844 })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
          await page.screenshot({ path: "public/screenshots/docs/pm-interview-review-mobile.png", fullPage: true })
          await page.setViewportSize({ width: 1280, height: 960 })
        }

        const editedTitle = `Clarified ${target.type.toLowerCase()} ${suffix}`
        const titleProposal = page.locator("label").filter({ has: page.getByText("title", { exact: true }) })
        await titleProposal.locator("textarea").fill(editedTitle)
        const deselectedProposal = page.locator("label").filter({ has: page.getByText(target.deselectedField, { exact: true }) })
        await deselectedProposal.getByRole("checkbox").uncheck()
        await page.getByRole("button", { name: "Apply selected changes" }).click()
        await expect(page.getByText("Proposal applied.")).toBeVisible()

        const savedInterview = await prisma.pMInterview.findUniqueOrThrow({ where: { id: interviewId }, include: { session: { include: { turns: { orderBy: { sequence: "asc" } } } } } })
        expect(savedInterview.disposition).toBe("APPLIED")
        expect(savedInterview.receiptJson).not.toBeNull()
        expect(savedInterview.session.status).toBe("COMPLETED")
        expect(savedInterview.session.turns.map(turn => turn.sequence)).toEqual(savedInterview.session.turns.map((_, turnIndex) => turnIndex))
        expect(savedInterview.session.turns.some(turn => turn.role === "PARTICIPANT" && turn.content === answer)).toBe(true)
        expect(await prisma.researchSynthesis.count({ where: { studyId: savedInterview.studyId } })).toBe(0)

        if (target.type === "OPPORTUNITY") {
          await expect(prisma.opportunity.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({ title: editedTitle, description: target.deselectedValue, customerSegment: "Product teams", status: "EXPLORING" })
        } else if (target.type === "SOLUTION") {
          await expect(prisma.solution.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({ title: editedTitle, description: target.deselectedValue, status: "IDEA", opportunityId: opportunity.id })
        } else if (target.type === "ASSUMPTION") {
          await expect(prisma.assumption.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({ title: editedTitle, description: target.deselectedValue, riskLevel: "HIGH", status: "UNTESTED", solutionId: solution.id })
        } else {
          await expect(prisma.experiment.findUniqueOrThrow({ where: { id: target.id } })).resolves.toMatchObject({ title: editedTitle, hypothesis: target.deselectedValue, method: experiment.method, killCondition: experiment.killCondition, status: "DESIGNING", assumptionId: assumption.id })
        }
      }

      expect(await prisma.evidence.count({ where: { workspaceId: workspace.id } })).toBe(evidenceBefore)
      expect(await prisma.researchSynthesis.count()).toBe(synthesisBefore)
      expect(await prisma.experimentResult.count({ where: { experimentId: experiment.id } })).toBe(resultBefore)
      await page.goto(`${base}/capture`)
      await expect(page.getByRole("link", { name: "PM interview" }).first()).toBeVisible()
    } finally {
      const records = await prisma.pMInterview.findMany({ where: { id: { in: interviewIds } }, select: { studyId: true, sessionId: true } })
      const sessionIds = records.map(record => record.sessionId), studyIds = records.map(record => record.studyId)
      await prisma.researchParticipantVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceCommand.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceCall.deleteMany({ where: { sessionId: { in: sessionIds } } })
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

  test("dismisses a generated proposal through the review UI without changing the target", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const title = `PM dismissal ${Date.now()}`
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title, description: "Keep this unchanged." } })
    let interviewId: string | null = null
    try {
      await page.goto(`${base}/capture/pm/new`)
      await page.getByLabel("Choose an item").selectOption(`OPPORTUNITY:${opportunity.id}`)
      await Promise.all([
        page.waitForURL(/\/capture\/pm\/[a-f0-9-]+$/, { timeout: 20_000 }),
        page.getByRole("button", { name: "Start PM interview" }).click(),
      ])
      interviewId = new URL(page.url()).pathname.split("/").at(-1)!
      await page.getByRole("button", { name: /Use text/ }).click()
      await page.getByLabel("Your answer").fill("This needs more evidence before any wording changes.")
      await page.getByRole("button", { name: "Send answer" }).click()
      await expect(page.getByText("What concrete observation would most challenge that belief?")).toBeVisible()
      await page.getByRole("button", { name: "Finish and review" }).click()
      await expect(page.getByText("PM interview brief")).toBeVisible()
      const [dismissResponse] = await Promise.all([
        page.waitForResponse(response => response.url().includes(`/api/pm-interviews/${interviewId}/dismiss`) && response.request().method() === "POST", { timeout: 20_000 }),
        page.getByRole("button", { name: "Dismiss proposal" }).click(),
      ])
      expect(dismissResponse.ok(), await dismissResponse.text()).toBe(true)
      await expect(page.getByText("Proposal dismissed.")).toBeVisible({ timeout: 10_000 })
      await expect(prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).resolves.toMatchObject({ title, description: "Keep this unchanged." })
    } finally {
      if (interviewId) {
        const record = await prisma.pMInterview.findUnique({ where: { id: interviewId }, select: { studyId: true, sessionId: true } })
        if (record) {
          await prisma.researchRequest.deleteMany({ where: { sessionId: record.sessionId } })
          await prisma.researchTurn.deleteMany({ where: { sessionId: record.sessionId } })
          await prisma.pMInterview.delete({ where: { id: interviewId } })
          await prisma.researchSession.delete({ where: { id: record.sessionId } })
          await prisma.researchParticipantToken.deleteMany({ where: { studyId: record.studyId } })
          await prisma.researchStudy.delete({ where: { id: record.studyId } })
        }
      }
      await prisma.opportunity.delete({ where: { id: opportunity.id } })
    }
  })

  test("fences public access, stale baselines, and concurrent apply on the real service", async ({ page, browser, baseURL, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM adversarial ${Date.now()}`, description: "Original" } })
    const interviewIds: string[] = []
    try {
      const createInterview = async () => {
        const response = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType: "OPPORTUNITY", targetId: opportunity.id } })
        expect(response.status(), await response.text()).toBe(201)
        const created = await response.json() as { id: string }
        interviewIds.push(created.id)
        return created.id
      }
      const prepareProposal = async (id: string) => {
        expect((await page.request.post(`/api/pm-interviews/${id}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { answer: "A bounded PM answer", idempotencyKey: `answer-${id}` } })).status()).toBe(200)
        expect((await page.request.post(`/api/pm-interviews/${id}/complete?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)).status()).toBe(200)
      }

      const raceId = await createInterview()
      await prepareProposal(raceId)
      expect((await page.request.get(`/api/pm-interviews/${raceId}?orgSlug=e2e-test-org&workspaceSlug=e2e-planning`)).status()).toBe(404)
      const requests = ["A", "B"].map(label => ({ selectedFields: ["title"], editedValues: { title: `Concurrent ${label}` }, idempotencyKey: `apply-${label}-${raceId}` }))
      const raced = await Promise.all(requests.map(data => page.request.post(`/api/pm-interviews/${raceId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data })))
      expect(raced.map(response => response.status()).sort()).toEqual([200, 409])
      const winner = raced.findIndex(response => response.status() === 200)
      const receipt = await raced[winner].json() as { after: { title: string } }
      expect((await page.request.post(`/api/pm-interviews/${raceId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: requests[winner] })).status()).toBe(200)
      expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).title).toBe(receipt.after.title)

      const staleId = await createInterview()
      await prepareProposal(staleId)
      const unchangedTimestamp = (await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).updatedAt
      await prisma.opportunity.update({ where: { id: opportunity.id }, data: { title: "Changed without a newer timestamp", updatedAt: unchangedTimestamp } })
      const staleApply = await page.request.post(`/api/pm-interviews/${staleId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], editedValues: { title: "Reviewed PM title" }, idempotencyKey: `stale-${staleId}` } })
      expect(staleApply.status()).toBe(409)
      const staleRead = await (await page.request.get(`/api/pm-interviews/${staleId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)).json()
      expect(staleRead).toMatchObject({ generationState: "STALE", reviewBaseline: { fields: { title: "Changed without a newer timestamp" } } })
      expect((await page.request.post(`/api/pm-interviews/${staleId}/review-baseline?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${staleId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], editedValues: { title: "Reviewed PM title" }, idempotencyKey: `stale-${staleId}` } })).status()).toBe(200)

      const publicId = await createInterview()
      const publicRecord = await prisma.pMInterview.findUniqueOrThrow({ where: { id: publicId }, select: { studyId: true } })
      const copiedToken = `copied-${publicId}`
      await prisma.researchParticipantToken.updateMany({ where: { studyId: publicRecord.studyId }, data: { tokenHash: createHash("sha256").update(copiedToken).digest("hex") } })
      const anonymous = await browser.newContext({ storageState: undefined })
      try {
        expect((await anonymous.request.post(`${baseURL}/api/research/start`, { data: { token: copiedToken, modality: "CHAT" } })).status()).toBe(404)
      } finally { await anonymous.close() }
    } finally {
      const records = await prisma.pMInterview.findMany({ where: { id: { in: interviewIds } }, select: { studyId: true, sessionId: true } })
      const sessionIds = records.map(record => record.sessionId), studyIds = records.map(record => record.studyId)
      await prisma.researchParticipantVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceCommand.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceEvent.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchVoiceCall.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchRequest.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.researchTurn.deleteMany({ where: { sessionId: { in: sessionIds } } })
      await prisma.pMInterview.deleteMany({ where: { id: { in: interviewIds } } })
      await prisma.researchSession.deleteMany({ where: { id: { in: sessionIds } } })
      await prisma.researchParticipantToken.deleteMany({ where: { studyId: { in: studyIds } } })
      await prisma.researchStudy.deleteMany({ where: { id: { in: studyIds } } })
      await prisma.opportunity.delete({ where: { id: opportunity.id } })
    }
  })
})
