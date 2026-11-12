/**
 * TOOL_APPROVAL on the generic review/decision surfaces (TASK-148, A2).
 *
 *  (a) /reviews/[id] is a 404 for a non-admin workspace member (nothing about the approval is disclosed),
 *  (b) for an admin it is only a pointer to /approvals/[id]: no Approve/Deny control, no title, summary or arguments,
 *  (c) TOOL_APPROVAL rows never appear in the Decisions list,
 *  and an ordinary tracked decision keeps its normal review page and its place in the list.
 *
 * The production registry is empty, so the approval row is seeded through the production creator (fixtures/tool-approval.ts).
 */
import { randomUUID } from "node:crypto"
import { expect, test } from "../fixtures/index"
import getPrisma from "../../../lib/db"
import { createTrackedDecisionRequest } from "../../../lib/tracked-decisions"
import { seedToolApproval, type SeededToolApproval } from "../fixtures/tool-approval"

test("tool approval is hidden from members, a pointer for admins, and absent from the Decisions list", async ({ page, base, browser, playwright, workspaceSlug, orgSlug }) => {
  test.setTimeout(240_000)
  const prisma = getPrisma()
  const baseURL = test.info().project.use.baseURL as string
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } })
  const suffix = randomUUID().slice(0, 8)
  const memberEmail = `tool-approval-member-${suffix}@localhost.dev`

  // A second user who is only a plain workspace MEMBER (no org admin role), signed in through the real dev-credentials flow.
  const login = await playwright.request.newContext({ baseURL })
  const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string }
  const signedIn = await login.post("/api/auth/callback/dev-credentials", {
    form: { csrfToken: csrf.csrfToken, email: memberEmail, callbackUrl: `${baseURL}/dashboard` },
    maxRedirects: 0,
  })
  expect([200, 302]).toContain(signedIn.status())
  const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } })
  await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: member.id, role: "MEMBER" } })
  const memberContext = await browser.newContext({ storageState: await login.storageState(), baseURL })
  const memberPage = await memberContext.newPage()

  let approval: SeededToolApproval | undefined
  try {
    approval = await seedToolApproval(workspace.id)
    const tracked = await createTrackedDecisionRequest({
      workspaceId: workspace.id, subjectType: "WORKSPACE", subjectId: workspace.id,
      question: `Tracked control decision ${suffix}`, context: "Ordinary decision that must be unaffected.", idempotencyKey: randomUUID(), sources: [],
    })
    const leaks = [approval.title, approval.summary, approval.argText, `QA-BEFORE-${approval.marker}`]
    const reviewUrl = `${base}/reviews/${approval.requestId}`

    // (a) member: 404, and the body discloses nothing.
    const memberResponse = await memberPage.goto(reviewUrl)
    expect(memberResponse?.status(), "a non-admin member must get HTTP 404 for a tool approval review URL").toBe(404)
    const memberBody = await memberPage.locator("body").innerText()
    for (const leak of leaks) expect(memberBody, `member page leaked ${leak}`).not.toContain(leak)
    await expect(memberPage.getByRole("link", { name: "Open the approval page" })).toHaveCount(0)

    // (b) admin: a pointer only.
    const adminResponse = await page.goto(reviewUrl)
    expect(adminResponse?.status()).toBe(200)
    await expect(page.getByText("This approval is decided on its own page.")).toBeVisible()
    const pointer = page.getByRole("link", { name: "Open the approval page" })
    await expect(pointer).toHaveAttribute("href", `${base}/approvals/${approval.requestId}`)
    for (const name of ["Approve", "Deny", "Reject", "Request changes"]) {
      await expect(page.getByRole("button", { name }), `admin pointer page must not render a "${name}" button`).toHaveCount(0)
    }
    expect(await page.getByRole("button").filter({ hasText: /approve|deny|reject/i }).count()).toBe(0)
    const adminBody = await page.locator("body").innerText()
    for (const leak of leaks) expect(adminBody, `admin pointer page leaked ${leak}`).not.toContain(leak)

    // (c) Decisions list: tracked decision present, approval absent, for admin and member alike.
    for (const [who, p] of [["admin", page], ["member", memberPage]] as const) {
      await p.goto(`${base}/decisions`)
      await expect(p.getByText(`Tracked control decision ${suffix}`).first(), `${who} must still see ordinary decisions`).toBeVisible({ timeout: 30_000 })
      const body = await p.locator("body").innerText()
      for (const leak of leaks) expect(body, `${who} Decisions list leaked ${leak}`).not.toContain(leak)
      expect(body).not.toContain("TOOL_APPROVAL")
    }

    // Regression: the ordinary tracked decision review page is unchanged for an admin.
    await page.goto(`${base}/reviews/${tracked.requestId}`)
    await expect(page.getByRole("heading", { name: `Tracked control decision ${suffix}` })).toBeVisible()
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible()
    await expect(page.getByText("This approval is decided on its own page.")).toHaveCount(0)
  } finally {
    await memberContext.close()
    await login.dispose()
  }
})
