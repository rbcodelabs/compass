import pg from "pg";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { openFullPage } from "../fixtures/full-page";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import { E2E_ORG_SLUG, E2E_USER_EMAIL, E2E_WORKSPACE_SLUG } from "../fixtures/seed-e2e";

const title = "New teams struggle to reach their first shared insight";

async function seedOpportunity() {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [workspace] } = await pool.query(
      "SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug=$1 AND w.slug=$2",
      [E2E_ORG_SLUG, E2E_WORKSPACE_SLUG],
    );
    const { rows: [opportunity] } = await pool.query(
      "INSERT INTO compass_dev.opportunities (id,workspace_id,title,description,status,customer_segment) VALUES (gen_random_uuid(),$1,$2,$3,'EXPLORING','New teams') RETURNING id",
      [workspace.id, title, "Getting research into the workspace is easy. Turning it into a shared understanding takes too much coordination."],
    );
    await pool.query(
      "INSERT INTO compass_dev.solutions (id,workspace_id,opportunity_id,title,description,status) VALUES (gen_random_uuid(),$1,$2,'A shared first-insight recap','Give the team a starting point for a useful conversation.','IDEA')",
      [workspace.id, opportunity.id],
    );
    return opportunity.id as string;
  } finally {
    await pool.end();
  }
}

// #593 replaced the opportunity "Discussion" region with the object Conversations section (ObjectConversationsSection).
const conversationsSection = (scope: Page | Locator) => scope.getByTestId("object-conversations-section");
const composerIn = (scope: Page | Locator) => scope.getByTestId("object-conversation-composer");
const conversationPanel = (page: Page) =>
  page
    .locator('[data-slot="pinned-panel"]')
    .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
    .or(page.getByRole("dialog", { name: "Conversation", exact: true }));

/** An anchored, workspace-visible conversation on the opportunity: what a posted comment turned into after #593. */
async function seedConversation(opportunityId: string, conversationTitle: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO compass_dev.agent_conversations (id,workspace_id,user_id,title,target_type,target_id,visibility,status,agent_mode,source,created_at,updated_at)
       SELECT gen_random_uuid(), o.workspace_id, (SELECT id FROM compass_dev.users WHERE email=$3), $2, 'OPPORTUNITY', o.id, 'WORKSPACE', 'OPEN', 'MENTION_ONLY', 'BROWSER', NOW(), NOW()
         FROM compass_dev.opportunities o WHERE o.id=$1 RETURNING id`,
      [opportunityId, conversationTitle, E2E_USER_EMAIL],
    );
    return row.id;
  } finally {
    await pool.end();
  }
}

test("opportunity conversations persist between full page and panel", async ({ page, base }) => {
  const id = await seedOpportunity();
  await page.goto(`${base}/discovery/${id}`);
  const conversations = conversationsSection(page);
  await expect(conversations.getByText(/No conversations on this item yet/)).toBeVisible();
  await composerIn(conversations).fill("Test the shared recap with new teams.");
  await conversations.getByRole("button", { name: "Send", exact: true }).click();
  await expect(conversations.getByRole("button", { name: /^Test the shared recap with new teams\./ })).toBeVisible();
  // Send opens the new conversation in the Conversation panel; a follow-up there is the old "reply".
  const thread = conversationPanel(page);
  await expect(thread).toBeVisible();
  await thread.getByPlaceholder(/message the agent/i).fill("Measure whether a second teammate participates.");
  await thread.getByRole("button", { name: "Send message" }).click();
  await expect(thread.getByText("Measure whether a second teammate participates.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Evidence/ }).click();
  await expect(conversations.getByRole("button", { name: /^Test the shared recap with new teams\./ })).toBeVisible();
  await page.reload();
  await expect(conversationPanel(page).getByText("Measure whether a second teammate participates.", { exact: true })).toBeVisible();
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  const panelConversations = conversationsSection(panel);
  await expect(panel.getByRole("link", { name: "Open full page" })).toHaveCount(1);
  await expect(panel.locator('[data-slot="sheet-header"]').getByRole("link", { name: "Open full page" })).toHaveAttribute("href", `${base}/discovery/${id}`);
  await expect(panelConversations.getByRole("button", { name: /^Test the shared recap with new teams\./ })).toBeVisible();
  expect(await openFullPage(page, panel)).toBe(`${base}/discovery/${id}`);
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap with new teams\./ })).toBeVisible();
});

test("opportunity conversation: author edits a message, resolve/reopen, archive then restore (no delete)", async ({ page, base }) => {
  const id = await seedOpportunity();
  await page.goto(`${base}/discovery/${id}`);
  const conversations = conversationsSection(page);
  await composerIn(conversations).fill("Test the shared recap with new teams.");
  await conversations.getByRole("button", { name: "Send", exact: true }).click();
  const thread = conversationPanel(page);
  await expect(thread.getByText("Test the shared recap with new teams.", { exact: true })).toBeVisible();

  await thread.getByRole("button", { name: /^Edit comment by/ }).first().click();
  await thread.getByRole("textbox", { name: /^Edit comment by/ }).fill("Test the shared recap this week.");
  await thread.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(thread.getByText("Test the shared recap this week.", { exact: true })).toBeVisible();
  await expect(thread.getByText("Edited", { exact: true })).toBeVisible();
  // The thread title follows the first message, so after the edit the row is named by the edited text.

  await thread.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(thread.getByText("Resolved", { exact: true })).toBeVisible();
  await thread.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(thread.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();

  // The edit and the thread persist across the panel and the full page.
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(conversationsSection(panel).getByRole("button", { name: /^Test the shared recap this week\./ })).toBeVisible();
  expect(await openFullPage(page, panel)).toBe(`${base}/discovery/${id}`);
  await conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ }).click();
  await expect(conversationPanel(page).getByText("Test the shared recap this week.", { exact: true })).toBeVisible();

  // Archive, not delete: leaves the active list and returns on restore.
  await conversationPanel(page).getByRole("button", { name: "Archive conversation" }).click();
  await page.getByRole("alertdialog", { name: "Archive this conversation?" }).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // Archiving closes the Conversation panel itself.
  await expect(conversationPanel(page)).toHaveCount(0);
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ })).toHaveCount(0);
  await conversationsSection(page).getByRole("button", { name: /^Show archived/ }).click();
  const archivedRow = conversationsSection(page).getByRole("listitem").filter({ hasText: "Test the shared recap this week" });
  await archivedRow.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(conversationsSection(page).getByRole("status")).toContainText("Conversation restored.");
  await conversationsSection(page).getByRole("button", { name: /^Show archived/ }).click();
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week/ })).toBeVisible();
});

// A workspace admin may edit another member's message (edit is author OR admin). The signed-in dev user is the workspace admin.
test("opportunity conversation: a workspace admin can edit another member's message", async ({ page, base }) => {
  const id = await seedOpportunity();
  const conversationId = await seedConversation(id, "Member thread for admin edit");
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const memberEmail = `admin-edit-${conversationId.slice(0, 8)}@localhost.dev`;
  try {
    await pool.query(
      `WITH member AS (INSERT INTO compass_dev.users (id,email,name) VALUES (gen_random_uuid(),$2,'Casey Member') RETURNING id),
            ws AS (SELECT workspace_id FROM compass_dev.agent_conversations WHERE id=$1),
            wm AS (INSERT INTO compass_dev.workspace_members (id,workspace_id,user_id,role,created_at) SELECT gen_random_uuid(), ws.workspace_id, member.id, 'MEMBER', NOW() FROM ws, member)
       INSERT INTO compass_dev.agent_messages (id,conversation_id,role,content,author_user_id,author_name,author_type,message_kind,created_at)
       SELECT gen_random_uuid(), $1, 'user', 'Member says ship it.', member.id, 'Casey Member', 'HUMAN', 'COMMENT', NOW() FROM member`,
      [conversationId, memberEmail],
    );
  } finally {
    await pool.end();
  }
  await page.goto(`${base}/discovery/${id}?detail=conversation:${conversationId}`);
  const thread = conversationPanel(page);
  await expect(thread.getByText("Member says ship it.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await thread.getByRole("button", { name: "Edit comment by Casey Member" }).click();
  await thread.getByRole("textbox", { name: "Edit comment by Casey Member" }).fill("Admin corrected this.");
  await thread.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(thread.getByText("Admin corrected this.", { exact: true })).toBeVisible();
  await expect(thread.getByText("Edited", { exact: true })).toBeVisible();
});

test("opportunity layout responds to available width without losing conversation drafts", async ({ page, base }) => {
  const id = await seedOpportunity();
  const conversationTitle = "The interviews point to a gap in the handoff.";
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${base}/discovery/${id}`);
  const discussion = conversationsSection(page);
  await expect(discussion.getByText(/No conversations on this item yet/)).toBeVisible();
  // Seed the conversation instead of sending it: sending opens the Conversation panel, which docks and changes the very width
  // this test measures. Sending is covered by the first test.
  await seedConversation(id, conversationTitle);
  await page.reload();
  await expect(discussion.getByRole("button", { name: new RegExp(`^${conversationTitle}`) })).toBeVisible();
  const tabs = page.getByRole("tablist");
  const wideTabs = await tabs.boundingBox();
  const wideDiscussion = await discussion.boundingBox();
  expect(wideTabs).not.toBeNull();
  expect(wideDiscussion).not.toBeNull();
  expect(wideDiscussion!.x).toBeGreaterThanOrEqual(wideTabs!.x + wideTabs!.width);
  await page.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-page-desktop.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.setViewportSize({ width: 1280, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-page-1280.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await composerIn(discussion).fill("Unfinished observation");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composerIn(discussion)).toHaveText("Unfinished observation");
  const mobileTabs = await tabs.boundingBox();
  const mobileDiscussion = await discussion.boundingBox();
  expect(mobileDiscussion!.y).toBeGreaterThan(mobileTabs!.y + mobileTabs!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-page-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await composerIn(discussion).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-discussion-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(composerIn(discussion)).toHaveText("Unfinished observation");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(conversationsSection(panel).getByRole("button", { name: new RegExp(`^${conversationTitle}`) })).toBeVisible();
  await panel.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-panel-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-panel-desktop.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.getByRole("button", { name: "Pin panel", exact: true }).click();
  const pinned = page.locator('[data-slot="pinned-panel"]');
  await expect(pinned.getByRole("link", { name: "Open full page" })).toHaveCount(1);
  await expect(pinned.locator('[data-slot="opportunity-detail"]').getByRole("link", { name: "Open full page" })).toHaveCount(0);
  await expect(conversationsSection(pinned).getByRole("button", { name: new RegExp(`^${conversationTitle}`) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await pinned.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-pinned-desktop.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-pinned-dark.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
});
