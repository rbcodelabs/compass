import { test, expect } from "../fixtures/index"

test.describe("Capture — research study", () => {
  test("persists and resumes a secure anonymous interview for member review", async ({ page, base, browser, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/capture/new`)
    await page.getByLabel("Study name").fill(`E2E interview ${Date.now()}`)
    await page.getByLabel("What are you trying to learn?").fill("How customers currently plan their work")
    await page.getByRole("textbox", { name: "Question 1", exact: true }).fill("Tell me about the last time you planned your week.")
    await page.getByRole("button", { name: "Add question" }).click()
    await page.getByRole("textbox", { name: "Question 2", exact: true }).fill("What was difficult?")
    await page.getByRole("button", { name: "Create study" }).click()

    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+\?token=/)
    const studyId = new URL(page.url()).pathname.split("/").at(-1)!
    const shareUrl = await page.getByRole("textbox").inputValue()
    expect(shareUrl).toContain("/research/")
    const participantToken = new URL(shareUrl).pathname.split("/").at(-1)!

    const anonymous = await browser.newContext({ storageState: undefined })
    const participant = await anonymous.newPage()
    await participant.setViewportSize({ width: 390, height: 844 })
    await participant.goto(shareUrl.replace(/^https?:\/\/[^/]+/, baseURL!))
    await expect(participant.getByRole("heading", { name: /E2E interview/ })).toBeVisible()
    await participant.getByRole("button", { name: "Start interview" }).click()
    await expect(participant.getByText("Tell me about the last time you planned your week.")).toBeVisible()
    await participant.getByRole("textbox", { name: "Your response" }).fill("I use a spreadsheet every Monday.")
    await participant.getByRole("button", { name: "Send" }).click()
    await expect(participant.getByText("What made that difficult for you?")).toBeVisible()

    await participant.reload()
    await expect(participant.getByText("I use a spreadsheet every Monday.")).toBeVisible()
    await expect(participant.getByText("What made that difficult for you?")).toBeVisible()
    await participant.getByRole("button", { name: "Finish interview" }).click()
    await expect(participant.getByRole("heading", { name: "Thank you" })).toBeVisible()
    expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    const idempotentStart = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken },
    })
    expect(idempotentStart.ok()).toBe(true)
    const idempotentSession = await idempotentStart.json() as { sessionId: string; resumeToken: string }
    const duplicateBody = {
      token: participantToken,
      sessionId: idempotentSession.sessionId,
      resumeToken: idempotentSession.resumeToken,
      idempotencyKey: "e2econcurrentduplicate0001",
      answer: "A concurrency-safe persisted answer.",
    }
    const duplicateResponses = await Promise.all([
      anonymous.request.post(`${baseURL}/api/research/respond`, { data: duplicateBody }),
      anonymous.request.post(`${baseURL}/api/research/respond`, { data: duplicateBody }),
    ])
    expect(duplicateResponses.some((response) => response.status() === 200)).toBe(true)
    expect(duplicateResponses.every((response) => [200, 409].includes(response.status()))).toBe(true)
    const replay = await anonymous.request.post(`${baseURL}/api/research/respond`, { data: duplicateBody })
    expect(replay.status()).toBe(200)
    expect((await replay.json()).replayed).toBe(true)
    const idempotentResume = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken, ...idempotentSession },
    })
    const idempotentTurns = (await idempotentResume.json()).turns as Array<{ role: string; content: string }>
    expect(idempotentTurns.filter((turn) => turn.content === duplicateBody.answer)).toHaveLength(1)

    const singleFlightStart = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken },
    })
    const singleFlightSession = await singleFlightStart.json() as { sessionId: string; resumeToken: string }
    const distinctResponses = await Promise.all([
      anonymous.request.post(`${baseURL}/api/research/respond`, { data: {
        token: participantToken,
        ...singleFlightSession,
        idempotencyKey: "e2edistinctconcurrent0001",
        answer: "First simultaneous answer.",
      } }),
      anonymous.request.post(`${baseURL}/api/research/respond`, { data: {
        token: participantToken,
        ...singleFlightSession,
        idempotencyKey: "e2edistinctconcurrent0002",
        answer: "Second simultaneous answer.",
      } }),
    ])
    expect(distinctResponses.map((response) => response.status()).sort()).toEqual([200, 409])
    const singleFlightResume = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken, ...singleFlightSession },
    })
    const singleFlightTurns = (await singleFlightResume.json()).turns as Array<{ role: string; content: string }>
    expect(singleFlightTurns.filter((turn) => turn.role === "PARTICIPANT")).toHaveLength(1)
    await anonymous.close()

    await page.goto(`${base}/capture/studies/${studyId}`)
    await expect(page.getByText("completed")).toBeVisible()
    await expect(page.getByText("I use a spreadsheet every Monday.")).toBeVisible()
    await expect(page.getByText("What made that difficult for you?").first()).toBeVisible()

    const crossWorkspace = await page.goto(`/rbcodelabs/compass/capture/studies/${studyId}`)
    expect(crossWorkspace?.status()).toBe(404)
  })
})
