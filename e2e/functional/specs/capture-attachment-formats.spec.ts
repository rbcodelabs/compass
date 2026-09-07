import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { Pool } from "pg"
import { test, expect } from "../fixtures/index"

// Real private storage, routes, database and Chromium. The functional runner's
// synthetic interviewer is used; no paid model or voice resource is created.
test("GIF and HEIC originals remain private and downloadable after resume", async ({ browser, page: member, baseURL, base }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const studyId = randomUUID()
  const token = randomUUID().replaceAll("-", "").repeat(2)
  const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 800 } })
  try {
    const workspace = await pool.query(`SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`)
    await pool.query(`INSERT INTO compass_dev.research_studies(id,workspace_id,name,goal,study_type,guide,status) VALUES($1,$2,'Attachment format research','Understand planning','CUSTOMER_INTERVIEW',$3,'ACTIVE')`, [studyId, workspace.rows[0].id, JSON.stringify([{ id: "one", text: "Tell me about your planning." }])])
    await pool.query(`INSERT INTO compass_dev.research_participant_tokens(id,study_id,token_hash,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '1 day')`, [randomUUID(), studyId, createHash("sha256").update(token).digest("hex")])
    const page = await context.newPage()
    await page.goto(`${baseURL}/research/${token}`)
    await page.getByRole("button", { name: /Use chat/ }).click()
    await page.getByRole("button", { name: "Start interview" }).click()
    await expect(page.getByText("Tell me about your planning.")).toBeVisible()
    const formats = [
      { name: "test-image.gif", mimeType: "image/gif" },
      { name: "test-image.heic", mimeType: "image/heic" },
    ]
    const saved: Array<{ id: string; name: string; bytes: Buffer }> = []
    for (const [index, format] of formats.entries()) {
      const bytes = readFileSync(`e2e/fixtures/${format.name}`)
      const uploaded = page.waitForResponse(response => response.url().endsWith("/api/research/attachments") && response.request().method() === "POST")
      await page.getByLabel("Share screenshot or PDF").setInputFiles({ ...format, buffer: bytes })
      const response = await uploaded
      expect(response.status()).toBe(200)
      const attachment = await response.json()
      saved.push({ id: attachment.id, name: format.name, bytes })
      await expect(page.getByRole("link", { name: format.name })).toBeVisible()
      await page.getByRole("button", { name: "Send" }).click()
      await expect(page.getByText("What made that difficult for you?", { exact: true })).toHaveCount(index + 1)
    }
    await page.reload()
    await expect(page.getByText(/HEIC is preserved for researchers/)).toBeVisible()
    await expect(page.getByRole("img", { name: "test-image.heic" })).toHaveCount(0)
    const gif = page.getByRole("img", { name: "test-image.gif" })
    await expect.poll(() => gif.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await gif.dispatchEvent("error")
    await expect(page.getByText(/Preview unavailable. Download the original/)).toBeVisible()
    const session = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), `compass-research-session-${token.slice(-16)}`) as { sessionId: string; resumeToken: string }
    for (const file of saved) {
      const downloaded = await context.request.post(`${baseURL}/api/research/attachments/${file.id}`, { data: { token, ...session } })
      expect(downloaded.status()).toBe(200)
      expect(await downloaded.body()).toEqual(file.bytes)
      expect(downloaded.headers()["cache-control"]).toBe("private, no-store")
      expect((await context.request.post(`${baseURL}/api/research/attachments/${file.id}`, { data: { token, ...session, resumeToken: "a".repeat(64) } })).status()).toBe(404)
      expect((await context.request.get(`${baseURL}/api/research/member-attachments/${file.id}`)).status()).toBe(404)
      const memberDownload = await member.request.get(`${baseURL}/api/research/member-attachments/${file.id}`)
      expect(memberDownload.status()).toBe(200)
      expect(await memberDownload.body()).toEqual(file.bytes)
      await expect(page.getByRole("link", { name: file.name })).toHaveAttribute("download", file.name)
    }
    await page.screenshot({ path: "public/screenshots/docs/research-attachment-formats-desktop.png", fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: "public/screenshots/docs/research-attachment-formats-mobile.png", fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await member.goto(`${base}/capture/studies/${studyId}/sessions/${session.sessionId}`)
    await expect(member.getByText(/HEIC is preserved for researchers/)).toBeVisible()
    for (const file of saved) await expect(member.getByRole("link", { name: file.name })).toHaveAttribute("href", `/api/research/member-attachments/${file.id}`)
  } finally {
    await context.close()
    await pool.end()
  }
})
