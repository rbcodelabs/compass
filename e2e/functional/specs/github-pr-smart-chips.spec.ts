/**
 * GitHub PR smart chips across TipTap Docs, rich description editors, rendered Markdown descriptions, Conversation transcripts, and Portal Docs.
 */
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { clickNewDoc } from "../fixtures/docs";
import getPrisma from "../../../lib/db";
import { E2E_USER_EMAIL } from "../fixtures/seed-e2e";

const SHOT_DIR = "test-results/visual-verification";
const APPROVED_PR_URL = "https://github.com/rbcodelabs/compass/pull/209";
const UNAPPROVED_PR_URL = "https://github.com/unapproved/repo/pull/99";

const PR_SUMMARY = {
  owner: "rbcodelabs",
  repo: "compass",
  number: 209,
  url: APPROVED_PR_URL,
  title: "Support smart PR chips",
  state: "open",
  author: "rickbowman",
  baseRef: "main",
  headRef: "feat/pr-chips",
  body: "Adds smart PR chips across Docs, editors, and Markdown.",
  additions: 84,
  deletions: 12,
  changedFiles: 4,
  commits: 2,
  comments: 1,
  reviewComments: 0,
  mergeable: true,
  checks: "passing",
  failingChecks: [],
  updatedAt: "2026-11-16T22:00:00Z",
};

async function stubPullRequestApi(page: Page) {
  await page.route("**/api/panels/github-pr*", async (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("id");
    if (id === "rbcodelabs/compass/209") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PR_SUMMARY) });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) });
  });
}

async function pastePlainText(page: Page, selector: string, text: string) {
  await page.locator(selector).evaluate((el, value) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", value);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.describe("GitHub PR smart chips", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

  test("Docs editor & Portal Docs: bare PR paste rewrites label, custom label & comment anchors stay intact, click opens PR sidebar, and Portal/unapproved fall back to plain links", async ({
    page,
    base,
    orgSlug,
    workspaceSlug,
    browser,
    baseURL,
  }) => {
    await stubPullRequestApi(page);
    const ts = Date.now();
    let createdDocId: string | null = null;
    const anon = await browser.newContext({ storageState: undefined });

    try {
      await page.goto(`${base}/docs`);
      await page.waitForLoadState("networkidle");
      const prevUrl = page.url();
      await clickNewDoc(page);
      await page.waitForURL((u) => u.href !== prevUrl && /\/docs\/(?:[0-9a-f-]+|DOC-\d+)$/.test(u.pathname), { timeout: 15_000 });
      await page.waitForLoadState("networkidle");

      const editor = page.locator(".ProseMirror");
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await expect(editor.locator("p.is-editor-empty")).toBeVisible();
      await page.waitForTimeout(300);

      const titleInput = page.getByPlaceholder("Untitled");
      await titleInput.fill(`E2E PR Smart Chips ${ts}`);
      await titleInput.blur();

      // 1. Paste a bare GitHub PR URL in prose: rewrites to `#209 Support smart PR chips` and keeps MarkViewContent mounted.
      await editor.click();
      await page.keyboard.type("Shipped in ");
      await pastePlainText(page, ".ProseMirror", APPROVED_PR_URL);

      const readyChip = editor.locator('a[data-github-pr-link="ready"]').first();
      await expect(readyChip).toBeVisible({ timeout: 10_000 });
      await expect(readyChip).toContainText("#209 Support smart PR chips");
      await expect(readyChip.locator("[data-mark-view-content]")).toHaveCount(1);

      // 2. Add a custom [label](url) PR link on a second line; custom text must remain untouched.
      await page.keyboard.press("Enter");
      await page.keyboard.type("See Custom PR label");
      await page.waitForTimeout(1500);
      await expect(page.getByTestId("doc-save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });

      for (let i = 0; i < "Custom PR label".length; i++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }
      const bubble = page.getByTestId("doc-bubble-menu");
      await expect(bubble).toBeVisible({ timeout: 5_000 });
      await bubble.getByTitle("Link").click();
      await page.getByLabel("Link address").fill(APPROVED_PR_URL);
      await page.keyboard.press("Enter");

      const customChip = editor.locator('a[data-github-pr-link="ready"]').filter({ hasText: "Custom PR label" });
      await expect(customChip).toBeVisible({ timeout: 10_000 });
      await expect(customChip).toHaveText("Custom PR label");

      // 3. Collapse the selection after `Custom PR label` with ArrowRight, then paste an unapproved PR URL on a third line.
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Unapproved: ");
      await pastePlainText(page, ".ProseMirror", UNAPPROVED_PR_URL);
      const unapprovedLink = editor.locator(`a[href="${UNAPPROVED_PR_URL}"]`);
      await expect(unapprovedLink).toHaveText(UNAPPROVED_PR_URL);
      await expect(unapprovedLink).not.toHaveAttribute("data-github-pr-link", "ready");
      await expect(customChip).toHaveText("Custom PR label");

      // Hover preview card displays branch & author metadata, then closes cleanly when moving away.
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await readyChip.hover();
      await expect(page.getByText("feat/pr-chips → main")).toBeVisible({ timeout: 5_000 });
      await page.screenshot({ path: `${SHOT_DIR}/01-doc-pr-hover-card.png` });
      await page.mouse.move(10, 10);
      await expect(page.getByText("feat/pr-chips → main")).toBeHidden({ timeout: 5_000 });

      // 4. Wait for autosave, then select `Custom` inside customChip's MarkViewContent via native DOM Range (proving ProseMirror owns MarkViewContent) and anchor an inline comment.
      await page.waitForTimeout(1500);
      await expect(page.getByTestId("doc-save-status")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
      await customChip.locator("[data-mark-view-content]").evaluate((el) => {
        const editorEl = el.closest<HTMLElement>(".ProseMirror");
        editorEl?.focus();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode();
        if (!textNode) throw new Error("Missing text node inside MarkViewContent");
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, "Custom".length);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      const commentBtn = page.getByTitle("Comment on selection");
      await expect(commentBtn).toBeVisible({ timeout: 5_000 });
      await commentBtn.click();
      await page.getByRole("textbox", { name: "Comment", exact: true }).fill(`Inline chip comment ${ts}`);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(editor.locator(".doc-comment-highlight")).toContainText("Custom", { timeout: 10_000 });

      // 5. Reload and confirm Markdown round-trip preserves both chips and the inline comment highlight.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(editor.locator('a[data-github-pr-link="ready"]').filter({ hasText: "#209 Support smart PR chips" })).toBeVisible({ timeout: 10_000 });
      await expect(editor.locator('a[data-github-pr-link="ready"]').filter({ hasText: "Custom PR label" })).toBeVisible({ timeout: 10_000 });
      await expect(editor.locator(".doc-comment-highlight")).toContainText("Custom", { timeout: 10_000 });

      // 6. Click the PR smart chip -> opens the pullRequest detail sidebar in place.
      await page.screenshot({ path: `${SHOT_DIR}/02-doc-pr-chips-and-comment.png` });
      await editor.locator('a[data-github-pr-link="ready"]').first().click();
      const prPanel = page.locator('[data-slot="sheet-content"]');
      await expect(prPanel).toBeVisible({ timeout: 10_000 });
      await expect(prPanel).toContainText("rbcodelabs/compass #209");
      await expect(prPanel).toContainText("Adds smart PR chips across Docs, editors, and Markdown.");
      await page.screenshot({ path: `${SHOT_DIR}/03-doc-pr-sidebar.png` });
      await page.keyboard.press("Escape");

      // 7. Publish to Portal -> anonymous viewer sees plain anchors and zero PR smart chips or PR API calls.
      const match = /\/docs\/([^/?#]+)/.exec(new URL(page.url()).pathname);
      createdDocId = match?.[1] ?? null;
      const savedPublish = page.waitForResponse((r) => r.url().includes("/publish") && r.request().method() === "POST");
      await page.getByRole("switch", { name: "Publish to portal" }).click();
      const publishRes = await savedPublish;
      expect(publishRes.status()).toBe(200);
      const publishUrlMatch = /\/api\/docs\/([^/]+)\/publish/.exec(publishUrlMatchOf(publishRes.url()));
      if (publishUrlMatch?.[1]) createdDocId = publishUrlMatch[1];

      const anonPage = await anon.newPage();
      let anonPrFetches = 0;
      anonPage.on("request", (req) => {
        if (req.url().includes("/api/panels/github-pr")) anonPrFetches++;
      });
      const portalRes = await anonPage.goto(`${baseURL}/portal/${orgSlug}/${workspaceSlug}/docs/${createdDocId}`);
      expect(portalRes?.status()).toBe(200);
      await expect(anonPage.locator('[data-entity-card="pullRequest"]')).toHaveCount(0);
      await expect(anonPage.getByRole("link", { name: "#209 Support smart PR chips" })).toHaveAttribute("href", APPROVED_PR_URL);
      await expect(anonPage.getByRole("link", { name: "Custom PR label" })).toHaveAttribute("href", APPROVED_PR_URL);
      expect(anonPrFetches).toBe(0);
      await anonPage.screenshot({ path: `${SHOT_DIR}/04-portal-doc-plain-fallback.png` });
    } finally {
      await anon.close();
      if (createdDocId) {
        const prisma = getPrisma();
        await prisma.docComment.deleteMany({ where: { docId: createdDocId } }).catch(() => undefined);
        await prisma.docVersion.deleteMany({ where: { docId: createdDocId } }).catch(() => undefined);
        await prisma.doc.deleteMany({ where: { id: createdDocId } }).catch(() => undefined);
      }
    }
  });

  test("Rich description editor & rendered Markdown (descriptions + Conversation transcripts) render PR smart chips and open the PR sidebar", async ({
    page,
    base,
    orgSlug,
    workspaceSlug,
  }) => {
    await stubPullRequestApi(page);
    const prisma = getPrisma();
    const workspace = await prisma.workspace.findFirstOrThrow({
      where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    });
    const ts = Date.now();
    let conversationId: string | null = null;
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `E2E PR Chip Task ${ts}`,
        status: "TODO",
        priority: "MEDIUM",
      },
    });

    try {
      await page.goto(`${base}/tasks/${task.id}`);
      await page.waitForLoadState("networkidle");

      // 1. Rich description editor (MarkdownDescriptionEditor): paste bare PR URL -> rewrites in-editor -> save -> renders in MarkdownContent.
      await page.getByRole("button", { name: "Edit description" }).click();
      const descEditor = page.getByRole("textbox", { name: "Description" });
      await expect(descEditor).toBeVisible();
      await descEditor.click();
      await descEditor.evaluate((el, value) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", value);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, APPROVED_PR_URL);

      await expect(descEditor.locator('a[data-github-pr-link="ready"]')).toContainText("#209 Support smart PR chips", { timeout: 10_000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // Saved description renders via MarkdownContent with PullRequestChip.
      const descSection = page.locator('[data-slot="task-detail"]');
      const savedDescChip = descSection.locator('a[data-entity-card="pullRequest"]').first();
      await expect(savedDescChip).toBeVisible({ timeout: 10_000 });
      await expect(savedDescChip).toContainText("#209 Support smart PR chips");

      // 2. Conversation transcript (Markdown + AgentMarkdownLink): bare URL, custom [label](url), and unapproved fallback.
      // #593 replaced the Discussion comment composer with Conversations. A person's own turn renders as plain text, so the chip
      // coverage that used to sit on a posted comment now sits on an agent reply in a conversation anchored to this task: seed one
      // and open it from the task's Conversations section, as a person would.
      const user = await prisma.user.findFirstOrThrow({ where: { email: E2E_USER_EMAIL } });
      const conversation = await prisma.agentConversation.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          title: `PR chip thread ${ts}`,
          targetType: "TASK",
          targetId: task.id,
          visibility: "WORKSPACE",
          status: "OPEN",
          agentMode: "MENTION_ONLY",
          source: "BROWSER",
        },
      });
      conversationId = conversation.id;
      await prisma.agentMessage.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: `Shipped ${APPROVED_PR_URL} ([review link](${APPROVED_PR_URL})) vs ${UNAPPROVED_PR_URL}`,
          authorName: "Compass Agent",
          authorType: "AGENT",
        },
      });
      await page.reload();
      await page.getByTestId("object-conversations-section").getByRole("button", { name: new RegExp(`^PR chip thread ${ts}`) }).click();
      const transcript = page
        .locator('[data-slot="pinned-panel"]')
        .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
        .or(page.getByRole("dialog", { name: "Conversation", exact: true }));
      // Scope to the message itself: the conversation header also shows a chip for the last PR link it saw.
      const shipped = transcript.getByText("Shipped");
      await expect(shipped).toBeVisible({ timeout: 10_000 });
      const commentChips = shipped.locator('a[data-entity-card="pullRequest"]');
      await expect(commentChips).toHaveCount(2, { timeout: 10_000 });
      await expect(commentChips.nth(0)).toContainText("#209 Support smart PR chips");
      await expect(commentChips.nth(1)).toHaveText("review link");

      const fallbackLink = shipped.locator(`a[href="${UNAPPROVED_PR_URL}"]`);
      await expect(fallbackLink).toHaveText(UNAPPROVED_PR_URL);
      await expect(fallbackLink).not.toHaveAttribute("data-entity-card", "pullRequest");

      // Clicking the PR chip in the transcript opens the pullRequest detail sidebar.
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${SHOT_DIR}/05-task-description-and-comments-pr-chips.png` });
      await commentChips.nth(0).click();
      const prPanel = page.locator('[data-slot="sheet-content"]');
      await expect(prPanel).toBeVisible({ timeout: 10_000 });
      await expect(prPanel).toContainText("rbcodelabs/compass #209");
    } finally {
      if (conversationId) {
        await prisma.agentMessage.deleteMany({ where: { conversationId } }).catch(() => undefined);
        await prisma.agentConversation.deleteMany({ where: { id: conversationId } }).catch(() => undefined);
      }
      await prisma.task.deleteMany({ where: { id: task.id } }).catch(() => undefined);
    }
  });
  // Slice S1 (shared-message renderer) shipped: a PERSON's message renders markdown, bold and PR chips like the old Discussion did.
  test("Conversation transcript renders PR chips and bold markdown in a person-authored message", async ({
    page,
    base,
    orgSlug,
    workspaceSlug,
  }) => {
    await stubPullRequestApi(page);
    const prisma = getPrisma();
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } });
    const ts = Date.now();
    const task = await prisma.task.create({ data: { workspaceId: workspace.id, title: `E2E PR Chip Person Task ${ts}`, status: "TODO", priority: "MEDIUM" } });
    const user = await prisma.user.findFirstOrThrow({ where: { email: E2E_USER_EMAIL } });
    let conversationId: string | null = null;
    try {
      const conversation = await prisma.agentConversation.create({
        data: { workspaceId: workspace.id, userId: user.id, title: `Person PR chip thread ${ts}`, targetType: "TASK", targetId: task.id, visibility: "WORKSPACE", status: "OPEN", agentMode: "MENTION_ONLY", source: "BROWSER" },
      });
      conversationId = conversation.id;
      await prisma.agentMessage.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          authorUserId: user.id,
          content: `**Shipped** ${APPROVED_PR_URL} ([review link](${APPROVED_PR_URL})) vs ${UNAPPROVED_PR_URL}`,
        },
      });
      await page.goto(`${base}/tasks/${task.id}`);
      await page.getByTestId("object-conversations-section").getByRole("button", { name: new RegExp(`^Person PR chip thread ${ts}`) }).click();
      const transcript = page
        .locator('[data-slot="pinned-panel"]')
        .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
        .or(page.getByRole("dialog", { name: "Conversation", exact: true }));
      const message = transcript.getByText("Shipped").first();
      await expect(message).toBeVisible({ timeout: 10_000 });
      await expect(transcript.locator("strong").filter({ hasText: "Shipped" })).toBeVisible();
      const chips = transcript.locator('a[data-entity-card="pullRequest"]');
      await expect(chips).toHaveCount(2);
      await expect(chips.nth(0)).toContainText("#209 Support smart PR chips");
      await expect(chips.nth(1)).toHaveText("review link");
      const fallback = transcript.locator(`a[href="${UNAPPROVED_PR_URL}"]:not([data-entity-card])`).first();
      await expect(fallback).toHaveText(UNAPPROVED_PR_URL);
    } finally {
      if (conversationId) {
        await prisma.agentMessage.deleteMany({ where: { conversationId } }).catch(() => undefined);
        await prisma.agentConversation.deleteMany({ where: { id: conversationId } }).catch(() => undefined);
      }
      await prisma.task.deleteMany({ where: { id: task.id } }).catch(() => undefined);
    }
  });
});

function publishUrlMatchOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}
