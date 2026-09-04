import { test, expect } from "../fixtures/index"

test.describe("Capture — research study", () => {
  test("edits an unused protocol, locks it after participation, and manages the lifecycle", async ({ page, base, browser, baseURL }) => {
    await page.goto(`${base}/capture/new`)
    await page.getByLabel("Study name").fill(`E2E lifecycle ${Date.now()}`)
    await page.getByLabel("What are you trying to learn?").fill("Understand current planning")
    await page.getByLabel("Target duration").selectOption("20")
    await page.getByRole("textbox", { name: "Question 1", exact: true }).fill("Tell me about your last planning session.")
    await page.getByRole("button", { name: "Create and activate study" }).click()
    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+\?token=/)

    await page.getByLabel("Study name").fill("E2E lifecycle edited")
    await page.getByLabel("Research goal").fill("Understand current planning workflows")
    await page.getByLabel("Discussion guide").fill("Tell me about the last time you planned.\nWhat was hardest?")
    await page.getByRole("button", { name: "Save study" }).click()
    await expect(page.getByRole("heading", { name: "E2E lifecycle edited" })).toBeVisible()
    await expect(page.getByText("Target", { exact: true }).locator("..").getByText("20 minutes", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Rotate participant link" }).click()
    const shareUrl = await page.getByRole("textbox", { name: "Participant link" }).inputValue()
    const firstToken = new URL(shareUrl).pathname.split("/").at(-1)!
    const anonymous = await browser.newContext({ storageState: undefined })
    const started = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: firstToken },
    })
    expect(started.status()).toBe(200)

    await page.reload()
    await expect(page.getByText(/protocol is locked/i)).toBeVisible()
    await expect(page.getByLabel("Research goal")).toBeDisabled()
    await expect(page.getByLabel("Study name")).toBeEnabled()
    await page.getByRole("button", { name: "Close study" }).click()
    await expect(page.getByText("closed", { exact: true })).toBeVisible()
    expect((await anonymous.request.post(`${baseURL}/api/research/start`, { data: { token: firstToken } })).status()).toBe(404)
    await expect(page.getByRole("button", { name: "Activate study" })).toBeVisible()
    await page.getByRole("button", { name: "Activate study" }).click()
    await expect(page).toHaveURL(/\?token=/)
    await expect(page.getByText("active", { exact: true })).toBeVisible()
    const secondToken = new URL(await page.getByRole("textbox", { name: "Participant link" }).inputValue()).pathname.split("/").at(-1)!
    expect(secondToken).not.toBe(firstToken)
    expect((await anonymous.request.post(`${baseURL}/api/research/start`, { data: { token: firstToken } })).status()).toBe(404)
    expect((await anonymous.request.post(`${baseURL}/api/research/start`, { data: { token: secondToken } })).status()).toBe(200)
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "Archive study" }).click()
    await expect(page).toHaveURL(`${base}/capture`)
    await expect(page.getByRole("heading", { name: "E2E lifecycle edited" })).not.toBeVisible()
    expect((await anonymous.request.post(`${baseURL}/api/research/start`, { data: { token: secondToken } })).status()).toBe(404)
    await anonymous.close()
  })

  test("persists and resumes a secure anonymous interview for member review", async ({ page, base, browser, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/capture/new`)
    await page.getByLabel("Study name").fill(`E2E interview ${Date.now()}`)
    await page.getByLabel("What are you trying to learn?").fill("How customers currently plan their work")
    await page.getByRole("textbox", { name: "Question 1", exact: true }).fill("Tell me about the last time you planned your week.")
    await page.getByRole("button", { name: "Add question" }).click()
    await page.getByRole("textbox", { name: "Question 2", exact: true }).fill("What was difficult?")
    await page.getByRole("button", { name: "Create and activate study" }).click()

    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+\?token=/)
    const studyId = new URL(page.url()).pathname.split("/").at(-1)!
    const shareUrl = await page.getByRole("textbox", { name: "Participant link" }).inputValue()
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
    const idempotentStarted = await idempotentStart.json() as { sessionId: string; resumeToken: string }
    const idempotentSession = { sessionId: idempotentStarted.sessionId, resumeToken: idempotentStarted.resumeToken }
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
    const idempotentResumeBody = await idempotentResume.json()
    expect(idempotentResume.status(), JSON.stringify(idempotentResumeBody)).toBe(200)
    const idempotentTurns = idempotentResumeBody.turns as Array<{ role: string; content: string }>
    expect(idempotentTurns.filter((turn) => turn.content === duplicateBody.answer)).toHaveLength(1)

    const singleFlightStart = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken },
    })
    const singleFlightStarted = await singleFlightStart.json() as { sessionId: string; resumeToken: string }
    const singleFlightSession = { sessionId: singleFlightStarted.sessionId, resumeToken: singleFlightStarted.resumeToken }
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

  test("runs guided mobile chat with private evidence and canonical voice events", async ({ page, base, browser, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${base}/capture/new`)
    await page.getByLabel("Guided usability test").check()
    await page.getByLabel("Study name").fill(`E2E guided UX ${Date.now()}`)
    await page.getByLabel("What are you trying to learn?").fill("Learn where teams struggle to compare plans")
    await page.getByLabel("Live product URL").fill("https://example.com/pricing")
    await page.getByLabel("Target duration").selectOption("15")
    const tasks = [
      "Find a plan that could support a growing team.",
      "Compare the available options.",
      "Work out what the plan would cost your team.",
      "Find answers to a question about billing.",
      "Decide what you would do next.",
    ]
    await page.getByRole("textbox", { name: "Task 1", exact: true }).fill(tasks[0])
    for (let index = 1; index < tasks.length; index += 1) {
      await page.getByRole("button", { name: "Add task" }).click()
      await page.getByRole("textbox", { name: `Task ${index + 1}`, exact: true }).fill(tasks[index])
    }
    await page.getByRole("button", { name: "Create and activate study" }).click()

    await expect(page).toHaveURL(/\/capture\/studies\/[a-f0-9-]+\?token=/)
    const studyId = new URL(page.url()).pathname.split("/").at(-1)!
    const shareUrl = await page.getByRole("textbox", { name: "Participant link" }).inputValue()
    const participantToken = new URL(shareUrl).pathname.split("/").at(-1)!
    await expect(page.getByText("Type", { exact: true }).locator("..").getByText("Guided usability test", { exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: "https://example.com/pricing" })).toBeVisible()

    const anonymous = await browser.newContext({ storageState: undefined })
    const participant = await anonymous.newPage()
    await participant.setViewportSize({ width: 390, height: 844 })
    await participant.goto(shareUrl.replace(/^https?:\/\/[^/]+/, baseURL!))
    await expect(participant.getByText(/Please think aloud/)).toBeVisible()
    await participant.getByRole("button", { name: /Use chat/ }).click()
    const openProduct = participant.getByRole("link", { name: /Open product/ })
    await expect(openProduct).toHaveAttribute("rel", "noopener noreferrer")
    await expect(participant.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups")
    await expect(participant.locator("iframe")).toHaveAttribute("referrerpolicy", "no-referrer")
    await participant.getByRole("button", { name: "Start session" }).click()
    await expect(participant.getByText(tasks[0])).toBeVisible()
    await participant.getByLabel("Share screenshot or PDF").setInputFiles("e2e/fixtures/test-image.png")
    await expect(participant.getByText("test-image.png")).toBeVisible()
    await participant.getByRole("textbox", { name: "Your response" }).fill("I expected the team price to be clearer here.")
    await participant.getByRole("button", { name: "Send" }).click()
    await expect(participant.getByText("What made that difficult for you?")).toBeVisible()
    const storedChatSession = await participant.evaluate((key) => localStorage.getItem(key), `compass-research-session-${participantToken.slice(-16)}`)
    expect(storedChatSession).not.toBeNull()
    const resumeResponsePromise = participant.waitForResponse((response) => response.url().endsWith("/api/research/start") && response.request().method() === "POST")
    await participant.reload()
    const resumeResponse = await resumeResponsePromise
    const resumeBody = await resumeResponse.json()
    expect(resumeResponse.status(), JSON.stringify(resumeBody)).toBe(200)
    await expect(participant.getByText("I expected the team price to be clearer here.")).toBeVisible()
    expect(await participant.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await participant.getByRole("button", { name: "Finish interview" }).click()
    await expect(participant.getByRole("heading", { name: "Thank you" })).toBeVisible()

    const voiceStart = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken, modality: "VOICE" },
    })
    expect(voiceStart.status()).toBe(200)
    const voiceStarted = await voiceStart.json() as { sessionId: string; resumeToken: string }
    const voiceSession = { sessionId: voiceStarted.sessionId, resumeToken: voiceStarted.resumeToken }
    const voiceCredential = await anonymous.request.post(`${baseURL}/api/research/voice-session`, {
      data: { token: participantToken, ...voiceSession },
    })
    expect(voiceCredential.status()).toBe(200)
    const { leaseId } = await voiceCredential.json() as { leaseId: string }
    const participantEvent = {
      token: participantToken, ...voiceSession, leaseId, action: "FINAL",
      providerEventId: "e2e-participant-final-1", role: "PARTICIPANT",
      content: "I expected the comparison to explain the tradeoffs.",
    }
    expect((await anonymous.request.post(`${baseURL}/api/research/voice-event`, { data: participantEvent })).status()).toBe(200)
    const replay = await anonymous.request.post(`${baseURL}/api/research/voice-event`, { data: participantEvent })
    expect((await replay.json()).replayed).toBe(true)
    expect((await anonymous.request.post(`${baseURL}/api/research/voice-event`, { data: {
      token: participantToken, ...voiceSession, leaseId, action: "FINAL",
      providerEventId: "e2e-interviewer-final-1", role: "INTERVIEWER",
      content: "What tradeoff did you expect to see explained?",
    } })).status()).toBe(200)
    const resumedVoice = await anonymous.request.post(`${baseURL}/api/research/start`, {
      data: { token: participantToken, ...voiceSession },
    })
    const voiceTurns = (await resumedVoice.json()).turns as Array<{ content: string }>
    expect(voiceTurns.filter((turn) => turn.content === participantEvent.content)).toHaveLength(1)
    expect((await anonymous.request.post(`${baseURL}/api/research/voice-event`, { data: {
      token: participantToken, ...voiceSession, leaseId, action: "DISCONNECT",
    } })).status()).toBe(200)
    expect((await anonymous.request.post(`${baseURL}/api/research/complete`, { data: {
      token: participantToken, ...voiceSession,
    } })).status()).toBe(200)
    await anonymous.close()

    await page.goto(`${base}/capture/studies/${studyId}`)
    await expect(page.getByText("Chat session")).toBeVisible()
    await expect(page.getByText("Voice session")).toBeVisible()
    await expect(page.getByText("I expected the team price to be clearer here.")).toBeVisible()
    await expect(page.getByText("I expected the comparison to explain the tradeoffs.")).toBeVisible()
    await expect(page.getByRole("link", { name: "test-image.png" })).toBeVisible()
  })
})
