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
async function seedConversation(opportunityId: string, conversationTitle: string) {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    await pool.query(
      `INSERT INTO compass_dev.agent_conversations (id,workspace_id,user_id,title,target_type,target_id,visibility,status,agent_mode,source,created_at,updated_at)
       SELECT gen_random_uuid(), o.workspace_id, (SELECT id FROM compass_dev.users WHERE email=$3), $2, 'OPPORTUNITY', o.id, 'WORKSPACE', 'OPEN', 'MENTION_ONLY', 'BROWSER', NOW(), NOW()
         FROM compass_dev.opportunities o WHERE o.id=$1`,
      [opportunityId, conversationTitle, E2E_USER_EMAIL],
    );
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

// TASK-195 slice S1/S2 (message actions: Edit / Archive). Rick's binding answers (design section 10): a message can be edited by its
// author OR a workspace admin, and "delete thread" becomes ARCHIVE (the thread leaves the active list and is restorable).
// Selectors below are the ones the message actions are expected to expose; adjust names when the UI lands.
test.fixme("opportunity conversation: author or admin edits a message, archive removes then restores the thread (TASK-195 slice S1/S2)", async ({ page, base }) => {
  const id = await seedOpportunity();
  await page.goto(`${base}/discovery/${id}`);
  const conversations = conversationsSection(page);
  await composerIn(conversations).fill("Test the shared recap with new teams.");
  await conversations.getByRole("button", { name: "Send", exact: true }).click();
  const thread = conversationPanel(page);
  await expect(thread.getByText("Test the shared recap with new teams.", { exact: true })).toBeVisible();

  // Author edits their own message; it shows as edited and survives the full-page/panel hop.
  await thread.getByRole("button", { name: "Edit", exact: true }).first().click();
  await thread.getByRole("textbox", { name: /^Edit message/ }).fill("Test the shared recap this week.");
  await thread.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(thread.getByText("Test the shared recap this week.", { exact: true })).toBeVisible();
  await expect(thread.getByText("Edited", { exact: true })).toBeVisible();
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(conversationsSection(panel).getByRole("button", { name: /^Test the shared recap this week\./ })).toBeVisible();
  expect(await openFullPage(page, panel)).toBe(`${base}/discovery/${id}`);

  // Admin edit of another user's message (seed a second member's message, sign in as workspace admin, edit it).
  // TODO(TASK-195 S2): seed message authored by another workspace member via compass_dev.agent_messages (author_user_id).
  await conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ }).click();
  await conversationPanel(page).getByRole("button", { name: "Edit", exact: true }).last().click();
  await conversationPanel(page).getByRole("textbox", { name: /^Edit message/ }).fill("Edited by an admin.");
  await conversationPanel(page).getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(conversationPanel(page).getByText("Edited by an admin.", { exact: true })).toBeVisible();

  // Archive (not delete): leaves the active list, is restorable.
  await conversationPanel(page).getByRole("button", { name: "Archive", exact: true }).click();
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ })).toHaveCount(0);
  await page.reload();
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ })).toHaveCount(0);
  await conversationsSection(page).getByRole("button", { name: "Show archived", exact: true }).click();
  await conversationsSection(page).getByRole("button", { name: "Restore", exact: true }).click();
  await expect(conversationsSection(page).getByRole("button", { name: /^Test the shared recap this week\./ })).toBeVisible();
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
