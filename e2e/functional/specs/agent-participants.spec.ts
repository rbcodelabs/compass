import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Shared agent conversations (PR #396): owner invites a workspace member, the
 * invitee sees the thread, strangers get 404, the owner removes, a participant
 * leaves.
 *
 * No LLM turn is needed. Conversations and messages are read straight from the
 * database by the page and by /api/agent/conversations/[id]/participants, so the
 * spec seeds a conversation owned by the signed-in dev user via pg and drives the
 * real participants panel and routes. Nothing here sends a message or starts an
 * agent run, so the Agent SDK sandbox, Vercel Blob and the model gateway are
 * never touched.
 *
 * Three real users (dev-credentials logins):
 *   A  the signed-in dev user (storageState) - conversation owner
 *   B  a workspace member who starts out NOT a participant
 *   C  a signed-in user who is NOT a member of the workspace
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

test("owner shares an agent conversation, the invitee sees it, outsiders are blocked, removal and leave revoke access", async ({
  page,
  base,
  browser,
  playwright,
}) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const baseURL = test.info().project.use.baseURL as string;
  const suffix = randomUUID().slice(0, 8);
  const bEmail = `agent-share-b-${suffix}@localhost.dev`;
  const cEmail = `agent-share-c-${suffix}@localhost.dev`;
  const bName = `Sharing Teammate ${suffix}`;
  const title = `Shared chat ${suffix}`;
  const ownerMessage = `Owner question ${suffix}`;
  const agentReply = `Agent answer ${suffix}`;
  const conversationId = randomUUID();
  const contexts: BrowserContext[] = [];
  const disposables: APIRequestContext[] = [];
  let workspaceId = "";
  let aUserId = "";
  let bUserId = "";
  let cUserId = "";

  async function signIn(email: string) {
    const login = await playwright.request.newContext({ baseURL });
    disposables.push(login);
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const signedIn = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(signedIn.status());
    const context = await browser.newContext({ storageState: await login.storageState(), baseURL });
    contexts.push(context);
    return context;
  }

  const participantsUrl = (id = conversationId) =>
    `/api/agent/conversations/${id}/participants?workspaceId=${workspaceId}`;
  const participantUrl = (userId: string) =>
    `/api/agent/conversations/${conversationId}/participants/${userId}?workspaceId=${workspaceId}`;
  const activeRows = async () =>
    (
      await pool.query<{ user_id: string; removed_at: Date | null }>(
        `SELECT user_id, removed_at FROM "${S}".agent_conversation_participants WHERE conversation_id = $1`,
        [conversationId],
      )
    ).rows;

  try {
    // ── Users and seed: B is a workspace member, C is signed in but not a member
    const bContext = await signIn(bEmail);
    const cContext = await signIn(cEmail);
    const bPage = await bContext.newPage();
    const bApi = bContext.request;
    const cApi = cContext.request;

    const { rows: users } = await pool.query<{ id: string; email: string }>(
      `UPDATE "${S}".users SET name = CASE email WHEN $1 THEN $2::text ELSE 'Sharing Outsider' END
        WHERE email = ANY($3::text[]) RETURNING id, email`,
      [bEmail, bName, [bEmail, cEmail]],
    );
    bUserId = users.find((u) => u.email === bEmail)!.id;
    cUserId = users.find((u) => u.email === cEmail)!.id;
    expect(bUserId && cUserId, "dev login must have created both users").toBeTruthy();

    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    workspaceId = ids.workspace_id;
    aUserId = ids.owner_id;
    await pool.query(
      `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, bUserId],
    );

    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [conversationId, workspaceId, aUserId, title],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at)
       VALUES (gen_random_uuid(), $1, 'user', $2, $3, NOW() - interval '2 seconds'),
              (gen_random_uuid(), $1, 'assistant', $4, NULL, NOW() - interval '1 second')`,
      [conversationId, ownerMessage, aUserId, agentReply],
    );

    // ── Before sharing: only the owner can see it. Everyone else gets 404, never 403
    const ownerRoster = await page.request.get(`${participantsUrl()}&candidates=1`);
    expect(ownerRoster.status()).toBe(200);
    const ownerBody = await ownerRoster.json();
    expect(ownerBody).toMatchObject({ available: true, viewerRole: "OWNER", shareable: true });
    expect(ownerBody.participants).toHaveLength(1);
    expect(ownerBody.participants[0]).toMatchObject({ userId: aUserId, role: "OWNER" });
    expect(
      (ownerBody.candidates as { userId: string; name: string }[]).some((c) => c.userId === bUserId && c.name === bName),
      "the workspace member is offered as an invitee",
    ).toBe(true);
    expect((ownerBody.candidates as { userId: string }[]).some((c) => c.userId === cUserId), "a non-member is never offered").toBe(false);

    expect((await bApi.get(participantsUrl())).status(), "workspace member who is not a participant").toBe(404);
    expect((await cApi.get(participantsUrl())).status(), "signed-in non-member of the workspace").toBe(404);
    expect(
      (await bApi.post(participantsUrl(), { data: { userId: bUserId } })).status(),
      "a non-participant cannot invite themself",
    ).toBe(404);
    expect((await bApi.delete(participantUrl(aUserId))).status(), "a non-participant cannot remove the owner").toBe(404);
    expect((await page.request.get(participantsUrl(randomUUID()))).status(), "unknown conversation").toBe(404);

    await bPage.goto(`${base}/agent?c=${conversationId}`);
    await expect(bPage.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByRole("link", { name: title }), "not in the list before being invited").toHaveCount(0);
    await expect(bPage.getByText(ownerMessage), "messages are not leaked to a non-participant").toHaveCount(0);

    // ── Owner opens the conversation and invites B in the participants panel ────
    await page.goto(`${base}/agent?c=${conversationId}`);
    await expect(page.getByText(ownerMessage)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(agentReply)).toBeVisible();
    const panelToggle = page.getByRole("button", { name: /^Only you/ });
    await expect(panelToggle).toBeVisible({ timeout: 15_000 });
    await panelToggle.click();
    await expect(page.getByRole("list", { name: "Participants" }).getByText("Owner", { exact: true })).toBeVisible();
    const invite = page.getByLabel("Invite a workspace member");
    await expect(invite.locator("option", { hasText: bName })).toHaveCount(1, { timeout: 15_000 });
    await invite.selectOption({ label: bName });
    await page.getByRole("button", { name: "Invite", exact: true }).click();

    const participants = page.getByRole("list", { name: "Participants" });
    await expect(participants.getByText(bName)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Shared with 1 person/ })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${bName}` }), "owner-only control").toBeVisible();
    expect(await activeRows()).toEqual([{ user_id: bUserId, removed_at: null }]);

    // Inviting is idempotent: a second POST adds nothing and does not duplicate the row
    const again = await page.request.post(participantsUrl(), { data: { userId: bUserId } });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ added: false });
    expect(await activeRows()).toHaveLength(1);

    // Only workspace members can be invited
    const outsiderInvite = await page.request.post(participantsUrl(), { data: { userId: cUserId } });
    expect(outsiderInvite.status()).toBe(422);
    expect((await outsiderInvite.json()).code).toBe("INVITEE_NOT_MEMBER");
    expect((await page.request.post(participantsUrl(), { data: { userId: "not-a-uuid" } })).status()).toBe(400);
    expect(await activeRows()).toHaveLength(1);

    // ── The participant now sees the shared conversation, with attribution ──────
    await bPage.goto(`${base}/agent`);
    await expect(bPage.getByRole("link", { name: title })).toBeVisible({ timeout: 30_000 });
    await bPage.getByRole("link", { name: title }).click();
    await bPage.waitForURL(new RegExp(`c=${conversationId}`));
    await expect(bPage.getByText(ownerMessage)).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByText(agentReply)).toBeVisible();
    await expect(bPage.getByText("Dev User", { exact: true }).first(), "the owner's message carries their name").toBeVisible();
    await bPage.getByRole("button", { name: /^Shared with 1 person/ }).click();
    const bList = bPage.getByRole("list", { name: "Participants" });
    await expect(bList.getByText("Dev User")).toBeVisible();
    await expect(bList.getByText("(you)")).toBeVisible();
    await expect(bPage.getByRole("button", { name: "Leave", exact: true }), "a participant may leave").toBeVisible();
    await expect(bPage.getByRole("button", { name: /^Remove / }), "remove is owner-only").toHaveCount(0);

    // API view for B: participant role, may invite other members' lists, cannot remove the owner
    const bRoster = await (await bApi.get(participantsUrl())).json();
    expect(bRoster.viewerRole).toBe("PARTICIPANT");
    expect(bRoster.participants.map((p: { userId: string }) => p.userId).sort()).toEqual([aUserId, bUserId].sort());
    const forbidden = await bApi.delete(participantUrl(aUserId));
    expect(forbidden.status()).toBe(403);
    expect((await forbidden.json()).code).toBe("REMOVE_FORBIDDEN");
    // C is still locked out, and a participant cannot invite a non-member either
    expect((await cApi.get(participantsUrl())).status()).toBe(404);
    expect((await bApi.post(participantsUrl(), { data: { userId: cUserId } })).status()).toBe(422);

    // The owner cannot leave their own conversation
    const ownerLeave = await page.request.delete(participantUrl(aUserId));
    expect(ownerLeave.status()).toBe(409);
    expect((await ownerLeave.json()).code).toBe("OWNER_CANNOT_LEAVE");

    // ── Owner removes B: access is revoked at once, the row is soft-deleted ─────
    await page.getByRole("button", { name: `Remove ${bName}` }).click();
    await expect(participants.getByText(bName)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Only you/ })).toBeVisible();
    const afterRemoval = await activeRows();
    expect(afterRemoval).toHaveLength(1);
    expect(afterRemoval[0].user_id).toBe(bUserId);
    expect(afterRemoval[0].removed_at, "removal is a soft delete").not.toBeNull();
    expect((await bApi.get(participantsUrl())).status()).toBe(404);
    await expect(
      bPage.getByText("You no longer have access to this conversation."),
      "the removed participant's open page notices on the next roster poll",
    ).toBeVisible({ timeout: 30_000 });
    await bPage.goto(`${base}/agent`);
    await expect(bPage.getByRole("heading", { name: "Agent", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bPage.getByRole("link", { name: title })).toHaveCount(0);
    // Removing someone who is no longer in it is a 404, not a silent success
    expect((await page.request.delete(participantUrl(bUserId))).status()).toBe(404);

    // ── Re-invite reuses the row, then B leaves on their own ────────────────────
    const reinvite = await page.request.post(participantsUrl(), { data: { userId: bUserId } });
    expect(reinvite.status()).toBe(201);
    expect(await reinvite.json()).toEqual({ added: true });
    const reinvited = await activeRows();
    expect(reinvited).toEqual([{ user_id: bUserId, removed_at: null }]);

    await bPage.goto(`${base}/agent?c=${conversationId}`);
    await expect(bPage.getByText(ownerMessage)).toBeVisible({ timeout: 30_000 });
    await bPage.getByRole("button", { name: /^Shared with 1 person/ }).click();
    await bPage.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(bPage.getByText("You left this conversation.", { exact: false })).toBeVisible({ timeout: 15_000 });
    expect((await bApi.get(participantsUrl())).status()).toBe(404);
    expect((await activeRows())[0].removed_at).not.toBeNull();

    // The owner still has it, back to private
    await page.goto(`${base}/agent?c=${conversationId}`);
    await expect(page.getByText(ownerMessage)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Only you/ })).toBeVisible({ timeout: 15_000 });

    // ── A workspace member removed from the workspace loses a conversation they were in
    expect((await page.request.post(participantsUrl(), { data: { userId: bUserId } })).status()).toBe(201);
    expect((await bApi.get(participantsUrl())).status()).toBe(200);
    await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, bUserId]);
    expect((await bApi.get(participantsUrl())).status(), "membership is checked live on every call").toBe(404);
  } finally {
    for (const context of contexts) await context.close();
    for (const request of disposables) await request.dispose();
    await pool.query(`DELETE FROM "${S}".agent_conversation_participants WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [conversationId]);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [conversationId]);
    if (bUserId) await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id = $1`, [bUserId]);
    await pool.end();
  }
});
