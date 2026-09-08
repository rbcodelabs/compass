import { randomUUID, createHash } from "node:crypto"
import { Pool } from "pg"
import { test, expect } from "../fixtures/index"

// Real Chromium and real Compass routes/DB. Only microphone/WebRTC/provider are
// deterministic substitutes; this test never contacts a paid voice service.
for (const studyType of ["CUSTOMER_INTERVIEW", "USABILITY_TEST"]) {
  test(`browser voice ${studyType} retains failed saves and finishes only after retry`, async ({ browser, baseURL }) => {
    test.skip(process.env.COMPASS_RESEARCH_BROWSER_VOICE_ENABLED !== "1", "Dedicated default-off browser voice test run")
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const id = randomUUID(); const token = randomUUID().replaceAll("-", "").repeat(2)
    try {
      const workspace = await pool.query(`SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`)
      await pool.query(`INSERT INTO compass_dev.research_studies(id,workspace_id,name,goal,study_type,guide,status,app_url) VALUES($1,$2,$3,'Understand real experience',$4,$5,'ACTIVE',$6)`, [id, workspace.rows[0].id, `E2E browser voice ${studyType}`, studyType, JSON.stringify([{ id: "one", text: "Tell me about the last time." }]), studyType === "USABILITY_TEST" ? "https://example.com" : null])
      await pool.query(`INSERT INTO compass_dev.research_participant_tokens(id,study_id,token_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 day')`, [randomUUID(), id, createHash("sha256").update(token).digest("hex")])
      const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } })
      try {
        await context.addInitScript(() => {
          const state = window as unknown as { voiceChannel: EventTarget; micStopped: boolean }
          class Channel extends EventTarget { readyState = "open"; send() {}; close() { this.readyState = "closed" } }
          class Peer {
            channel = new Channel(); ontrack = null; connectionState = "connected"
            createDataChannel() { state.voiceChannel = this.channel; return this.channel }
            addTrack() {}; async createOffer() { return { type: "offer", sdp: "synthetic-local-offer" } }
            async setLocalDescription() {}; async setRemoteDescription() { this.channel.dispatchEvent(new Event("open")) }; close() {}
          }
          Object.defineProperty(window, "RTCPeerConnection", { value: Peer })
          Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { state.micStopped = true } }] }) } })
        })
        const page = await context.newPage()
        await page.route("https://example.com/**", (route) => route.fulfill({ body: "<h1>Synthetic product</h1>", contentType: "text/html" }))
        await page.route("https://api.openai.com/**", (route) => {
          expect(route.request().url()).toBe("https://api.openai.com/v1/realtime/calls")
          return route.fulfill({ body: "synthetic-local-answer" })
        })
        let failed = false
        await page.route("**/api/research/voice-event", async (route) => {
          if (route.request().postDataJSON().action === "FINAL" && !failed) {
            failed = true
            return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save outage" }) })
          }
          return route.continue()
        })
        await page.goto(`${baseURL}/research/${token}`)
        await page.getByRole("button", { name: /Use voice/ }).click()
        await page.getByRole("button", { name: "Start voice session" }).click()
        await expect(page.getByText(/Connected —/)).toBeVisible({ timeout: 30_000 })
        await page.evaluate(() => (window as unknown as { voiceChannel: EventTarget }).voiceChannel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "participant-one", delta: "I expected this task" }) })))
        await expect(page.getByText("I expected this task", { exact: false })).toBeVisible()
        await page.screenshot({ path: `public/screenshots/docs/browser-voice-${studyType.toLowerCase()}-desktop.png`, fullPage: true })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: `public/screenshots/docs/browser-voice-${studyType.toLowerCase()}-mobile.png`, fullPage: true })
        await page.evaluate(() => (window as unknown as { voiceChannel: EventTarget }).voiceChannel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "participant-one", transcript: "I expected this task to be simpler." }) })))
        await expect(page.getByRole("button", { name: "Retry saving transcript" })).toBeVisible()
        expect(await page.evaluate(() => (window as unknown as { micStopped: boolean }).micStopped)).toBe(true)
        await expect(page.getByRole("button", { name: "Retry finishing session" })).toBeDisabled()
        expect((await pool.query(`SELECT status FROM compass_dev.research_sessions WHERE study_id=$1`, [id])).rows[0].status).toBe("IN_PROGRESS")
        await page.getByRole("button", { name: "Retry saving transcript" }).click()
        await expect(page.getByRole("button", { name: "Retry finishing session" })).toBeEnabled()
        await page.getByRole("button", { name: "Retry finishing session" }).click()
        await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible()
        const evidence = await pool.query(`SELECT e.claimed_speaker,e.content,s.status FROM compass_dev.research_participant_voice_events e JOIN compass_dev.research_sessions s ON s.id=e.session_id WHERE s.study_id=$1`, [id])
        expect(evidence.rows).toEqual([{ claimed_speaker: "PARTICIPANT", content: "I expected this task to be simpler.", status: "COMPLETED" }])
      } finally { await context.close() }
    } finally { await pool.end() }
  })
}
