/**
 * TOOL_APPROVAL surfaces (TASK-149, A3): the approval page, the pending list, and the Approve / Deny actions.
 *
 * What a browser flow can and cannot reach today: the production registry is EMPTY and the test-only registry injection is
 * refused outside NODE_ENV=test (lib/tool-approval/registry.ts, deliberately not weakened). So a click on Approve in this
 * suite records a real decision through the real server action and decision service, and the real executor then refuses with
 * "tool not registered": the page shows "Approved, not run" and nothing changes in the workspace. That is asserted up to the
 * executor and no further. The applied effect (execute once, replay-safe, stale, failed) is covered against real Postgres with
 * an injected test registry in __tests__/tool-approval-surface.integration.test.ts.
 *
 * The chat card needs a live agent turn to put a tool result in a transcript, so it is covered by component tests
 * (__tests__/tool-approval-card.test.tsx), not here.
 */
import { randomUUID } from "node:crypto"
import { expect, test } from "../fixtures/index"
import type { Page } from "@playwright/test"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"
import { seedDecidedToolApproval, seedHostileToolApproval, seedRichToolApproval, seedToolApproval, type DecidedState } from "../fixtures/tool-approval"

// The page may clip with overflow-x-hidden, so check the document AND the main column's own scroll width: content that is merely hidden still counts as overflow.
const noPageOverflow = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main")
    return document.documentElement.scrollWidth <= window.innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1)
  })

test("admins see the effect and decide; members get a 404; every state reads right; both viewports fit", async ({ page, base, browser, playwright, workspaceSlug, orgSlug }) => {
  test.setTimeout(420_000)
  const prisma = getPrisma()
  const baseURL = test.info().project.use.baseURL as string
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } })
  const suffix = randomUUID().slice(0, 8)
  const memberEmail = `tool-approval-ui-member-${suffix}@localhost.dev`

  const login = await playwright.request.newContext({ baseURL })
  const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string }
  const signedIn = await login.post("/api/auth/callback/dev-credentials", { form: { csrfToken: csrf.csrfToken, email: memberEmail, callbackUrl: `${baseURL}/dashboard` }, maxRedirects: 0 })
  expect([200, 302]).toContain(signedIn.status())
  const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } })
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: member.id, role: "MEMBER" } })
  const memberContext = await browser.newContext({ storageState: await login.storageState(), baseURL })
  const memberPage = await memberContext.newPage()
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "dev@localhost.dev" } })

  try {
    // 1. Effect diff: nested objects, a list with one member added and one removed, a shape change.
    const rich = await seedRichToolApproval(workspace.id)
    const richUrl = `${base}/approvals/${rich.requestId}`
    await page.setViewportSize({ width: 1280, height: 800 })
    const response = await page.goto(richUrl)
    expect(response?.status()).toBe(200)
    await expect(page.getByRole("heading", { name: new RegExp(rich.marker) })).toBeVisible()
    await expect(page.getByTestId("approval-state")).toHaveAttribute("data-state", "PENDING")
    const diff = page.getByTestId("effect-diff")
    await expect(diff).toContainText("Changed")
    await expect(diff).toContainText("Added")
    await expect(diff).toContainText("Removed")
    await expect(diff).toContainText("labels[]")
    await expect(diff).toContainText("limits.region")
    await expect(diff).toContainText("limits.maxItems")
    await expect(diff.locator('[data-side="before"]').first()).toBeVisible()
    await expect(diff.locator('[data-side="after"]').first()).toBeVisible()
    await page.getByRole("button", { name: /Call arguments/ }).click()
    await expect(page.getByTestId("approval-args")).toContainText(`QA-NAME-${rich.marker}-renamed`)
    await expect(page.getByTestId("approve-button")).toBeEnabled()
    await expect(page.getByTestId("deny-button")).toBeEnabled()
    expect(await noPageOverflow(page)).toBe(true)

    // 2. Hostile content: HTML-looking and very long text is shown as text, inside its own box, on both viewports.
    const hostile = await seedHostileToolApproval(workspace.id)
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.goto(`${base}/approvals/${hostile.requestId}`)
      await expect(page.getByTestId("effect-diff")).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { __approval_xss?: boolean }).__approval_xss), "approval content must never execute").toBeUndefined()
      expect(await page.locator("main script, main img[src='x']").count()).toBe(0)
      await expect(page.locator("main")).toContainText("<script>window.__approval_xss = true</script>")
      expect(await noPageOverflow(page), `no horizontal page overflow at ${viewport.width}px`).toBe(true)
    }

    // 3. Mobile: Approve / Deny are at least 44px tall and fit inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(richUrl)
    for (const id of ["approve-button", "deny-button"]) {
      const box = (await page.getByTestId(id).boundingBox())!
      expect(box.height, `${id} touch target height`).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
    }
    await page.setViewportSize({ width: 1280, height: 800 })

    // 4. A member gets a plain 404 for the page and the list, and no link on the Decisions page.
    const leaks = [rich.title, rich.summary, rich.argText, `QA-NAME-${rich.marker}`]
    for (const path of [`${base}/approvals/${rich.requestId}`, `${base}/approvals`]) {
      const res = await memberPage.goto(path)
      expect(res?.status(), `member must get 404 for ${path}`).toBe(404)
      const text = await memberPage.locator("body").innerText()
      for (const leak of leaks) expect(text).not.toContain(leak)
    }
    await memberPage.goto(`${base}/decisions`)
    await expect(memberPage.getByRole("heading", { name: "Decisions" }).first()).toBeVisible({ timeout: 30_000 })
    await expect(memberPage.getByRole("link", { name: "Tool approvals" })).toHaveCount(0)
    await page.goto(`${base}/decisions`)
    await expect(page.getByRole("link", { name: "Tool approvals" })).toHaveAttribute("href", `${base}/approvals`)

    // 5. An id that is not a tool approval in this workspace is a 404, even for an admin.
    const tracked = await createTrackedDecisionRequest({
      workspaceId: workspace.id, subjectType: "WORKSPACE", subjectId: workspace.id, question: `Ordinary decision ${suffix}`, context: "Not an approval.", idempotencyKey: randomUUID(), sources: [],
    })
    expect((await page.goto(`${base}/approvals/${tracked.requestId}`))?.status()).toBe(404)
    expect((await page.goto(`${base}/approvals/${randomUUID()}`))?.status()).toBe(404)

    // 6. Deny: the decision is recorded, nothing runs, the buttons go away and the outcome reads Denied.
    const toDeny = await seedToolApproval(workspace.id)
    await page.goto(`${base}/approvals/${toDeny.requestId}`)
    await page.waitForLoadState("networkidle")
    await page.getByTestId("deny-button").click()
    await expect(page.getByTestId("approval-state")).toHaveAttribute("data-state", "DENIED", { timeout: 30_000 })
    await expect(page.getByTestId("approval-outcome")).toContainText("Denied by")
    await expect(page.getByTestId("approve-button")).toHaveCount(0)
    await expect(page.getByTestId("deny-button")).toHaveCount(0)
    expect(await prisma.decisionRecord.count({ where: { requestId: toDeny.requestId } })).toBe(1)
    expect(await prisma.decisionApplication.count({ where: { targetId: toDeny.requestId } })).toBe(0)

    // 7. Approve (a double click): one decision is recorded and the real executor refuses, so the page reads "Approved, not run".
    const before = (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id }, select: { description: true } })).description
    const toApprove = await seedToolApproval(workspace.id)
    await page.goto(`${base}/approvals/${toApprove.requestId}`)
    await page.waitForLoadState("networkidle")
    await page.getByTestId("approve-button").dblclick()
    await expect(page.getByTestId("approval-state")).toHaveAttribute("data-state", "NOT_RUN", { timeout: 30_000 })
    await expect(page.getByTestId("approval-outcome")).toContainText("Approved by")
    await expect(page.getByTestId("approve-button")).toHaveCount(0)
    expect(await prisma.decisionRecord.count({ where: { requestId: toApprove.requestId } }), "a double click makes one decision").toBe(1)
    expect(await prisma.decisionApplication.count({ where: { targetId: toApprove.requestId } }), "the executor refused before claiming a receipt").toBe(0)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id }, select: { description: true } })).description).toBe(before)

    // 8. Every end state reads right and offers no buttons.
    const states: Array<[DecidedState, string]> = [
      ["APPLIED", "APPLIED"], ["FAILED", "FAILED"], ["STALE", "STALE"], ["BLOCKED", "BLOCKED"], ["UNKNOWN_OUTCOME", "UNKNOWN_OUTCOME"], ["NOT_RUN", "NOT_RUN"], ["EXPIRED", "EXPIRED"], ["DENIED", "DENIED"],
    ]
    for (const [seed, expected] of states) {
      const seeded = await seedDecidedToolApproval(workspace.id, seed, admin.id)
      await page.goto(`${base}/approvals/${seeded.requestId}`)
      await expect(page.getByTestId("approval-state"), seed).toHaveAttribute("data-state", expected)
      await expect(page.getByTestId("approval-outcome")).toBeVisible()
      await expect(page.getByTestId("approve-button")).toHaveCount(0)
      await expect(page.getByTestId("deny-button")).toHaveCount(0)
      if (seed === "UNKNOWN_OUTCOME") await expect(page.getByTestId("approval-outcome")).toContainText("operator must check")
      if (seed === "FAILED") await expect(page.getByTestId("approval-receipt")).toContainText("the target rejected the change")
    }

    // 9. The list: waiting requests link to their pages; decided ones show their state. Mobile fits.
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.goto(`${base}/approvals`)
      await expect(page.getByRole("heading", { name: "Tool approvals" })).toBeVisible()
      await expect(page.getByRole("link", { name: new RegExp(rich.marker) })).toHaveAttribute("href", `${base}/approvals/${rich.requestId}`)
      await expect(page.getByRole("region", { name: "Recently decided" })).toContainText("Denied")
      expect(await noPageOverflow(page), `list fits at ${viewport.width}px`).toBe(true)
    }
  } finally {
    await memberContext.close()
    await login.dispose()
  }
})
