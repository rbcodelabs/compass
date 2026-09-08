import { chromium } from "@playwright/test"
import { createServer } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { awaitResearchReplyReceipt } from "../e2e/functional/fixtures/research-reply-receipt"
import { observeResearchReply } from "../e2e/functional/fixtures/research-reply-observer"

const committed = { message: "Saved question", turn: { id: "turn", role: "INTERVIEWER", content: "Saved question", sequence: 2 }, replayed: false }
describe.skipIf(process.env.RUN_RESEARCH_REPLY_BROWSER !== "1")("same-fetch browser receipt observer", () => {
  it.each(["committed", "aborted", "incomplete", "oversized"] as const)("preserves the committed contract with %s transport", async mode => {
    let calls = 0
    let finish: (() => void) | undefined
    const server = createServer((request, response) => {
      if (request.url !== "/api/research/respond") { response.end("<html>synthetic fixture</html>"); return }
      calls++
      response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" })
      response.write(JSON.stringify({ type: "delta", text: "Draft" }) + "\n")
      finish = () => {
        if (mode === "aborted") response.destroy()
        else if (mode === "incomplete") response.end()
        else if (mode === "oversized") response.end("x".repeat(128 * 1024))
        else response.end(JSON.stringify({ type: "final", result: committed }) + "\n")
      }
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      const address = server.address() as { port: number }
      // Reproduce CDP body loss without breaking the actual page's fetch reader.
      const cdp = await page.context().newCDPSession(page)
      let requestId: string | undefined
      cdp.on("Network.responseReceived", event => { if (new URL(event.response.url).pathname === "/api/research/respond") requestId = event.requestId })
      await cdp.send("Network.enable", { maxTotalBufferSize: 1, maxResourceBufferSize: 1 })
      await page.goto(`http://127.0.0.1:${address.port}`)
      const observed = await observeResearchReply(page)
      const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/research/respond")
      await page.evaluate(() => {
        const state = window as unknown as { replyRead: Promise<{ complete: boolean; text: string }>; draftRead: boolean }
        state.replyRead = (async () => {
          try {
            const result = await fetch("/api/research/respond", { method: "POST" })
            const reader = result.body!.getReader()
            let text = ""
            while (true) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); state.draftRead = true }
            return { complete: true, text }
          } catch { return { complete: false, text: "" } }
        })()
      })
      await response
      await page.waitForFunction(() => (window as unknown as { draftRead: boolean }).draftRead)
      const report = vi.fn()
      const receipt = awaitResearchReplyReceipt(observed(), report)
      // Install a rejection handler before terminating the controlled stream.
      const outcome = receipt.then(value => ({ value }), () => ({ value: null }))
      expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "committed" }))
      finish!()
      const application = await page.evaluate(() => (window as unknown as { replyRead: Promise<{ complete: boolean; text: string }> }).replyRead)
      if (mode === "committed") {
        expect(application.complete).toBe(true)
        expect(application.text).toContain('"type":"final"')
        // Query the deliberately constrained CDP session, not Playwright's
        // separate session, whose cache may still happen to retain the body.
        expect(requestId).toBeDefined()
        await expect(cdp.send("Network.getResponseBody", { requestId: requestId! })).rejects.toThrow(/(No (data|resource).*given identifier|evicted)/)
        expect((await outcome).value).toEqual(committed)
      } else {
        expect((await outcome).value).toBeNull()
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "failed" }))
        if (mode === "aborted") expect(application.complete).toBe(false)
      }
      expect(calls).toBe(1)
      expect(JSON.stringify(report.mock.calls)).not.toContain("Saved question")
    } finally {
      try { await browser?.close() } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
  }, 15_000)
})
