import { test, expect } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createHash, randomUUID } from "node:crypto"

type TargetFixture = {
  type: "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT"
  id: string
  originalTitle: string
  deselectedField: string
  deselectedValue: string | null
}

async function seedLegacyProposal(interviewId: string) {
  const prisma = getPrisma()
  const interview = await prisma.pMInterview.findUniqueOrThrow({ where: { id: interviewId }, include: { session: { include: { turns: true } } } })
  const baseline = JSON.parse(interview.fieldBaselineJson) as { fields: Record<string, string | null> }
  const turnIds = interview.session.turns.filter(turn => turn.role === "PARTICIPANT").map(turn => turn.id)
  await prisma.pMInterview.update({ where: { id: interviewId }, data: { generationState: "READY", proposalJson: JSON.stringify({ version: 1, brief: "Previously generated interview brief", proposedFields: Object.fromEntries(Object.entries(baseline.fields).map(([field, value]) => [field, { value, transcriptTurnIds: turnIds }])), openQuestions: [], suggestedNextSteps: [], unknowns: [] }) } })
  await prisma.researchSession.update({ where: { id: interview.sessionId }, data: { status: "COMPLETED" } })
}

test.describe("Capture — PM interview", () => {
  test("Finish saves one pending core conversation and repeated Finish reuses it", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM handoff ${randomUUID()}`, description: "Original description" } })
    let interviewId: string | undefined
    let conversationId: string | undefined
    try {
      const created = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType: "OPPORTUNITY", targetId: opportunity.id } })
      expect(created.status()).toBe(201)
      interviewId = (await created.json()).id
      const responded = await page.request.post(`/api/pm-interviews/${interviewId}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { answer: "Teams cannot find their previous decisions.", idempotencyKey: randomUUID() } })
      expect(responded.status()).toBe(200)
      // Do not open the agent page: real provider processing has its own smoke gate.
      const finish = () => page.request.post(`/api/pm-interviews/${interviewId}/complete?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)
      const first = await finish()
      expect(first.status(), await first.text()).toBe(200)
      const handoff = await first.json()
      conversationId = handoff.conversationId
      expect(handoff).toMatchObject({ conversationUrl: `${base}/agent?c=${conversationId}`, processingStatus: "PENDING" })
      const second = await finish()
      expect(second.status()).toBe(200)
      expect(await second.json()).toEqual(handoff)
      const status = await page.request.get(`/api/agent/conversations/${conversationId}/processing?workspaceId=${workspace.id}`)
      expect(status.status()).toBe(200)
      expect(await status.json()).toMatchObject({ status: "PENDING", interviewId, receipt: null })
      const interview = await prisma.pMInterview.findUniqueOrThrow({ where: { id: interviewId }, include: { session: true } })
      expect(interview.agentConversationId).toBe(conversationId)
      expect(interview.session.status).toBe("COMPLETED")
      expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).description).toBe("Original description")
    } finally {
      if (interviewId) {
        const interview = await prisma.pMInterview.findUnique({ where: { id: interviewId } })
        if (interview) {
          await prisma.researchRequest.deleteMany({ where: { sessionId: interview.sessionId } })
          await prisma.researchTurn.deleteMany({ where: { sessionId: interview.sessionId } })
          await prisma.pMInterview.delete({ where: { id: interviewId } })
          await prisma.researchSession.delete({ where: { id: interview.sessionId } })
          await prisma.researchParticipantToken.deleteMany({ where: { studyId: interview.studyId } })
          await prisma.researchStudy.delete({ where: { id: interview.studyId } })
        }
      }
      if (conversationId) {
        await prisma.agentMessage.deleteMany({ where: { conversationId } })
        await prisma.agentConversation.delete({ where: { id: conversationId } })
      }
      await prisma.opportunity.delete({ where: { id: opportunity.id } })
    }
  })

  test("preserves legacy proposal review, edit, selection, and apply for every supported target", async ({ page, base, workspaceSlug }) => {
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
        await expect(page.getByRole("heading", { name: "Refinement" })).toBeVisible()
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

        // Historical proposals remain reviewable; new Finish never generates them.
        await seedLegacyProposal(interviewId)
        await page.reload()
        await expect(page.getByText("PM interview brief")).toBeVisible({ timeout: 10_000 })
        await expect(page.getByRole("heading", { name: "Proposed changes" })).toBeVisible()
        // SSR headings are visible before hydration. A controlled Base UI
        // checkbox transition proves React is handling input before screenshots
        // touch caret styles or fill replaces a controlled textarea value.
        const deselectedProposal = page.locator("label").filter({ has: page.getByText(target.deselectedField, { exact: true }) })
        const deselectedCheckbox = deselectedProposal.getByRole("checkbox")
        await deselectedCheckbox.uncheck()
        await expect(deselectedCheckbox).not.toBeChecked()
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
        await titleProposal.locator("textarea").blur()
        await expect(titleProposal.locator("textarea")).toHaveValue(editedTitle)
        const [applyResponse] = await Promise.all([
          page.waitForResponse(response => response.url().includes(`/api/pm-interviews/${interviewId}/apply`) && response.request().method() === "POST", { timeout: 20_000 }),
          page.getByRole("button", { name: "Apply selected changes" }).click(),
        ])
        expect(applyResponse.request().postDataJSON().editedValues.title).toBe(editedTitle)
        expect(applyResponse.ok(), await applyResponse.text()).toBe(true)
        await expect(page.getByText("Proposal applied.")).toBeVisible({ timeout: 10_000 })

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
      await seedLegacyProposal(interviewId)
      await page.reload()
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

  test("fences public access, stale baselines, and concurrent apply on the real service", async ({ page, baseURL, workspaceSlug }) => {
    const prisma = getPrisma()
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } })
    const opportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM adversarial ${Date.now()}`, description: "Original" } })
    const interviewIds: string[] = []
    const disposableOpportunityIds: string[] = []
    const disposableExperimentIds: string[] = []
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
        await seedLegacyProposal(id)
      }

      const raceId = await createInterview()
      await prepareProposal(raceId)
      expect((await page.request.get(`/api/pm-interviews/${raceId}?orgSlug=e2e-test-org&workspaceSlug=e2e-planning`)).status()).toBe(404)
      const requests = ["A", "B"].map(label => ({ selectedFields: ["title"], editedValues: { title: `Concurrent ${label}` }, idempotencyKey: `apply-${label}-${raceId}` }))
      const raced = await Promise.all(requests.map(data => page.request.post(`/api/pm-interviews/${raceId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data })))
      expect(raced.map(response => response.status()).sort()).toEqual([200, 409])
      const winner = raced.findIndex(response => response.status() === 200)
      const receipt = await raced[winner].json() as { after: { title: string } }
      const storedWinner = await prisma.pMInterview.findUniqueOrThrow({ where: { id: raceId }, select: { disposition: true, dispositionIdempotencyKey: true } })
      expect(storedWinner).toEqual({ disposition: "APPLIED", dispositionIdempotencyKey: requests[winner].idempotencyKey })
      const replay = await page.request.post(`/api/pm-interviews/${raceId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: requests[winner] })
      const replayBody = await replay.text()
      expect(replay.status(), replayBody).toBe(200)
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
      const anonymousRequest = (method: "GET" | "POST", path: string, body?: unknown) => fetch(`${baseURL}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      })
      expect((await anonymousRequest("POST", "/api/research/start", { token: copiedToken, modality: "CHAT" })).status).toBe(404)
      const anonymousPmRoutes = [
        anonymousRequest("POST", `/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { targetType: "OPPORTUNITY", targetId: opportunity.id }),
        anonymousRequest("GET", `/api/pm-interviews/${publicId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/start?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { modality: "VOICE" }),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { answer: "No", idempotencyKey: "anonymous-answer-0001" }),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/complete?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/review-baseline?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { selectedFields: ["title"], idempotencyKey: "anonymous-apply-0001" }),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/dismiss?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { idempotencyKey: "anonymous-dismiss-0001" }),
        anonymousRequest("POST", `/api/pm-interviews/${publicId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { leaseId: null, settlement: "FINALIZED" }),
      ]
      expect((await Promise.all(anonymousPmRoutes)).map(response => response.status)).toEqual(Array(9).fill(401))

      const deletedOpportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM deleted target ${Date.now()}`, description: "Delete after proposal" } })
      disposableOpportunityIds.push(deletedOpportunity.id)
      const deletedIdResponse = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType: "OPPORTUNITY", targetId: deletedOpportunity.id } })
      expect(deletedIdResponse.status()).toBe(201)
      const deletedId = ((await deletedIdResponse.json()) as { id: string }).id
      interviewIds.push(deletedId)
      await prepareProposal(deletedId)
      await prisma.opportunity.delete({ where: { id: deletedOpportunity.id } })
      disposableOpportunityIds.splice(disposableOpportunityIds.indexOf(deletedOpportunity.id), 1)
      const deletedRead = await page.request.get(`/api/pm-interviews/${deletedId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)
      expect(deletedRead.status()).toBe(200)
      expect(await deletedRead.json()).toMatchObject({ applicationDisabledReason: "The source item was deleted; interview history remains readable." })
      expect((await page.request.post(`/api/pm-interviews/${deletedId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], idempotencyKey: `deleted-${deletedId}` } })).status()).toBe(409)

      const runningExperiment = await prisma.experiment.create({ data: { workspaceId: workspace.id, title: `PM running target ${Date.now()}`, hypothesis: "A prediction", method: "Five sessions", killCondition: "No signal", status: "DESIGNING" } })
      disposableExperimentIds.push(runningExperiment.id)
      const experimentResponse = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType: "EXPERIMENT", targetId: runningExperiment.id } })
      expect(experimentResponse.status()).toBe(201)
      const experimentInterviewId = ((await experimentResponse.json()) as { id: string }).id
      interviewIds.push(experimentInterviewId)
      await prepareProposal(experimentInterviewId)
      await prisma.experiment.update({ where: { id: runningExperiment.id }, data: { status: "RUNNING", updatedAt: new Date() } })
      const runningRead = await page.request.get(`/api/pm-interviews/${experimentInterviewId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)
      expect(runningRead.status()).toBe(200)
      expect(await runningRead.json()).toMatchObject({ applicationDisabledReason: "Experiment protocol can only change while designing." })
      expect((await page.request.post(`/api/pm-interviews/${experimentInterviewId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], idempotencyKey: `running-${experimentInterviewId}` } })).status()).toBe(409)

      const voiceId = await createInterview()
      const start = await page.request.post(`/api/pm-interviews/${voiceId}/start?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { modality: "VOICE" } })
      expect(start.status()).toBe(200)
      const { sessionId: voiceSessionId, resumeToken: voiceResumeToken } = await start.json() as { sessionId: string; resumeToken: string }
      const voiceSession = { sessionId: voiceSessionId, resumeToken: voiceResumeToken }
      const provision = await page.request.post(`/api/pm-interviews/${voiceId}/voice-session?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: voiceSession })
      expect(provision.status()).toBe(200)
      const { leaseId } = await provision.json() as { leaseId: string }
      const speechId = `input:voice-${voiceId}`
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { ...voiceSession, leaseId, action: "SPEECH_START", speechId } })).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId, settlement: "FINALIZED" } })).status()).toBe(409)
      const voiceEvent = { ...voiceSession, leaseId, action: "FINAL", clientEventId: `voice-${voiceId}`, reportedOrdinal: 0, role: "PARTICIPANT", content: "A synthetic finalized PM voice answer", speechId }
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: voiceEvent })).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId, settlement: "FINALIZED" } })).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId, settlement: "FINALIZED" } })).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${voiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { ...voiceEvent, clientEventId: `late-${voiceId}`, reportedOrdinal: 1 } })).status()).toBe(404)
      const voiceRecord = await prisma.pMInterview.findUniqueOrThrow({ where: { id: voiceId }, include: { session: true } })
      expect(voiceRecord.session).toMatchObject({ modality: "CHAT", voiceLeaseId: null })
      expect(JSON.parse(voiceRecord.transitionReceiptJson!)).toMatchObject({ version: 1, phase: "TRANSITIONED", leaseId, settlement: "FINALIZED", finalizedEventCount: 1, lastFinalizedOrdinal: 0 })

      const discardVoiceId = await createInterview()
      const discardStart = await page.request.post(`/api/pm-interviews/${discardVoiceId}/start?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { modality: "VOICE" } })
      const { sessionId: discardSessionId, resumeToken: discardResumeToken } = await discardStart.json() as { sessionId: string; resumeToken: string }
      const discardSession = { sessionId: discardSessionId, resumeToken: discardResumeToken }
      const discardProvision = await page.request.post(`/api/pm-interviews/${discardVoiceId}/voice-session?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: discardSession })
      const discardLease = ((await discardProvision.json()) as { leaseId: string }).leaseId
      expect((await page.request.post(`/api/pm-interviews/${discardVoiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { ...discardSession, leaseId: discardLease, action: "SPEECH_START", speechId: `input:discard-${discardVoiceId}` } })).status()).toBe(200)
      expect((await page.request.post(`/api/pm-interviews/${discardVoiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId: discardLease, settlement: "DISCARD_PENDING" } })).status()).toBe(200)
      expect(JSON.parse((await prisma.pMInterview.findUniqueOrThrow({ where: { id: discardVoiceId } })).transitionReceiptJson!)).toMatchObject({ phase: "TRANSITIONED", leaseId: discardLease, settlement: "DISCARD_PENDING" })

      const racingVoiceId = await createInterview()
      const racingStart = await page.request.post(`/api/pm-interviews/${racingVoiceId}/start?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { modality: "VOICE" } })
      const { sessionId: racingSessionId, resumeToken: racingResumeToken } = await racingStart.json() as { sessionId: string; resumeToken: string }
      const racingSession = { sessionId: racingSessionId, resumeToken: racingResumeToken }
      const racingProvision = await page.request.post(`/api/pm-interviews/${racingVoiceId}/voice-session?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: racingSession })
      const racingLease = ((await racingProvision.json()) as { leaseId: string }).leaseId
      const racingSpeechId = `input:race-${racingVoiceId}`
      const speechStart = await page.request.post(`/api/pm-interviews/${racingVoiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { ...racingSession, leaseId: racingLease, action: "SPEECH_START", speechId: racingSpeechId } })
      expect(speechStart.status(), await speechStart.text()).toBe(200)
      const racingFinal = { ...racingSession, leaseId: racingLease, action: "FINAL", clientEventId: `race-${racingVoiceId}`, reportedOrdinal: 0, role: "PARTICIPANT", content: "A final event racing the text transition", speechId: racingSpeechId }
      const [finalRace, transitionRace] = await Promise.all([
        page.request.post(`/api/pm-interviews/${racingVoiceId}/voice-event?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: racingFinal }),
        page.request.post(`/api/pm-interviews/${racingVoiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId: racingLease, settlement: "DISCARD_PENDING" } }),
      ])
      expect([200, 404, 409], await finalRace.text()).toContain(finalRace.status())
      expect([200, 409], await transitionRace.text()).toContain(transitionRace.status())
      expect([finalRace.status(), transitionRace.status()]).toContain(200)
      const transitionRetry = await page.request.post(`/api/pm-interviews/${racingVoiceId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId: racingLease, settlement: "DISCARD_PENDING" } })
      expect(transitionRetry.status(), await transitionRetry.text()).toBe(200)
      const racingRecord = await prisma.pMInterview.findUniqueOrThrow({ where: { id: racingVoiceId }, include: { session: true } })
      const racingTurns = await prisma.researchTurn.findMany({ where: { sessionId: racingSession.sessionId, content: racingFinal.content } })
      const racingReceipt = JSON.parse(racingRecord.transitionReceiptJson!) as { phase: string; settlement: string; finalizedEventCount: number; lastFinalizedOrdinal: number | null }
      expect(racingRecord.session).toMatchObject({ modality: "CHAT", voiceLeaseId: null })
      expect(racingTurns).toHaveLength(finalRace.status() === 200 ? 1 : 0)
      expect(racingReceipt).toMatchObject({ phase: "TRANSITIONED", settlement: "DISCARD_PENDING", finalizedEventCount: racingTurns.length, lastFinalizedOrdinal: racingTurns.length ? 0 : null })

      const nonOwnerId = await createInterview()
      await prepareProposal(nonOwnerId)
      await prisma.pMInterview.update({ where: { id: nonOwnerId }, data: { initiatingUserId: randomUUID(), updatedAt: new Date() } })
      const nonOwnerRead = await page.request.get(`/api/pm-interviews/${nonOwnerId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`)
      expect(nonOwnerRead.status()).toBe(200)
      const nonOwnerHistory = await nonOwnerRead.json() as { owner: boolean; proposal: unknown; session: { turns: unknown[] } }
      expect(nonOwnerHistory).toMatchObject({ owner: false })
      expect(nonOwnerHistory.proposal).not.toBeNull()
      expect(nonOwnerHistory.session.turns.length).toBeGreaterThan(1)
      const nonOwnerMutations = [
        page.request.post(`/api/pm-interviews/${nonOwnerId}/start?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { modality: "VOICE" } }),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { answer: "No", idempotencyKey: "non-owner-answer-0001" } }),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/complete?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/review-baseline?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], idempotencyKey: "non-owner-apply-0001" } }),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/dismiss?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { idempotencyKey: "non-owner-dismiss-0001" } }),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/continue-in-text?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { leaseId: null, settlement: "FINALIZED" } }),
        page.request.post(`/api/pm-interviews/${nonOwnerId}/voice-session?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { sessionId: "synthetic", resumeToken: "synthetic" } }),
      ]
      expect((await Promise.all(nonOwnerMutations)).map(response => response.status())).toEqual(Array(8).fill(404))

      const rollbackOpportunity = await prisma.opportunity.create({ data: { workspaceId: workspace.id, title: `PM rollback target ${Date.now()}`, description: "Original transaction value" } })
      disposableOpportunityIds.push(rollbackOpportunity.id)
      const rollbackIdResponse = await page.request.post(`/api/pm-interviews?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { targetType: "OPPORTUNITY", targetId: rollbackOpportunity.id } })
      expect(rollbackIdResponse.status()).toBe(201)
      const rollbackId = ((await rollbackIdResponse.json()) as { id: string }).id
      interviewIds.push(rollbackId)
      await prepareProposal(rollbackId)
      const failedApply = await page.request.post(`/api/pm-interviews/${rollbackId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, {
        headers: { "x-e2e-pm-fail-receipt-finalization": "1" },
        data: { selectedFields: ["title"], editedValues: { title: "Must roll back" }, idempotencyKey: `rollback-${rollbackId}` },
      })
      expect(failedApply.status(), await failedApply.text()).toBe(500)
      expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: rollbackOpportunity.id } })).title).toBe(rollbackOpportunity.title)
      expect(await prisma.pMInterview.findUniqueOrThrow({ where: { id: rollbackId }, select: { disposition: true, receiptJson: true, dispositionIdempotencyKey: true } })).toEqual({ disposition: "PENDING", receiptJson: null, dispositionIdempotencyKey: null })

      const removedMemberId = await createInterview()
      const { initiatingUserId } = await prisma.pMInterview.findUniqueOrThrow({ where: { id: removedMemberId }, select: { initiatingUserId: true } })
      const membership = await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace.id, userId: initiatingUserId }, select: { id: true, workspaceId: true, userId: true, role: true } })
      await prisma.workspaceMember.delete({ where: { id: membership.id } })
      try {
        const removedMemberRequests = [
          page.request.get(`/api/pm-interviews/${removedMemberId}?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`),
          page.request.post(`/api/pm-interviews/${removedMemberId}/respond?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { answer: "No", idempotencyKey: "removed-answer-0001" } }),
          page.request.post(`/api/pm-interviews/${removedMemberId}/apply?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { selectedFields: ["title"], idempotencyKey: "removed-apply-0001" } }),
          page.request.post(`/api/pm-interviews/${removedMemberId}/dismiss?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { idempotencyKey: "removed-dismiss-0001" } }),
          page.request.post(`/api/pm-interviews/${removedMemberId}/voice-session?orgSlug=e2e-test-org&workspaceSlug=${workspaceSlug}`, { data: { sessionId: "synthetic", resumeToken: "synthetic" } }),
        ]
        expect((await Promise.all(removedMemberRequests)).map(response => response.status())).toEqual(Array(5).fill(404))
      } finally {
        await prisma.workspaceMember.create({ data: membership })
      }
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
      await prisma.experiment.deleteMany({ where: { id: { in: disposableExperimentIds } } })
      await prisma.opportunity.deleteMany({ where: { id: { in: disposableOpportunityIds } } })
      await prisma.opportunity.delete({ where: { id: opportunity.id } })
    }
  })
})
