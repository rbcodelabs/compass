import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

// #593 replaced the docked Agent Rail with the Conversation panel (Right PanelShell, opened by ⌘J as ?detail=conversation:new).
// It docks as an <aside data-slot="pinned-panel"> on wide viewports and is a dialog (Sheet) below 1024px.
const rail = (page: Page) =>
  page
    .locator('[data-slot="pinned-panel"]')
    .filter({ has: page.getByRole("heading", { name: "Conversation", exact: true }) })
    .or(page.getByRole("dialog", { name: "Conversation", exact: true }));

test("blank Agent Rail surfaces screen-responsive starter questions, pins while typing, stages via ✎, and 1-click fires with pageUrl", async ({
  page,
  base,
}) => {
  test.setTimeout(120_000);
  const conversationId = randomUUID();
  const streamedReply = `Grounded OKR analysis ${conversationId.slice(0, 8)}`;
  const nav = page.getByRole("navigation", { name: "Main navigation" });

  await page.route("**/api/agent/page-suggestions*", async (route) => {
    const reqUrl = new URL(route.request().url());
    const targetPageUrl = reqUrl.searchParams.get("pageUrl") ?? "";

    if (targetPageUrl.includes("/okrs")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          label: "OKRs",
          pageUrl: `${base}/okrs`,
          revisionKey: "e2e-rev-okrs",
          mode: "reading",
          suggestions: [
            "Which active Key Results have zero linked NOW roadmap items?",
            "Compare Q4 Objective progress against our discovery pipeline",
            "What assumptions pose the highest risk to our top Objective?",
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        label: "Roadmap",
        pageUrl: `${base}/roadmap`,
        revisionKey: "e2e-rev-roadmap",
        mode: "reading",
        suggestions: [
          "Which NOW roadmap items lack validated discovery assumptions?",
          "How balanced is our NOW workload against WIP limits?",
          "What blockers threaten our NEXT horizon commitments?",
        ],
      }),
    });
  });

  let capturedTurnBody: Record<string, unknown> | null = null;
  await page.route("**/api/agent/turn", async (route) => {
    capturedTurnBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    const events =
      `event: status\ndata: ${JSON.stringify({ phase: "running", conversationId })}\n\n` +
      `event: result\ndata: ${JSON.stringify({ text: streamedReply, conversationId })}\n\n`;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events,
    });
  });

  // 1. Open blank Agent Rail on Roadmap -> Viewing · Roadmap + 3 starter rows
  await page.goto(`${base}/roadmap`);
  await expect(nav.getByRole("link", { name: "Roadmap", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press("ControlOrMeta+j");
  await expect(rail(page)).toBeVisible();

  const stack = rail(page).getByTestId("empty-rail-suggestions");
  await expect(stack).toBeVisible({ timeout: 15_000 });
  await expect(stack).toContainText("Viewing · Roadmap");
  const rows = stack.getByTestId("empty-rail-suggestion-fire");
  await expect(rows).toHaveCount(3);

  // 2. Click ✎ stage-edit -> populates composer without firing, pins stack across background navigation
  await stack.getByTestId("empty-rail-suggestion-edit").first().click({ force: true });
  const composer = rail(page).getByPlaceholder(/message the agent/i);
  await expect(composer).toHaveValue(
    "Which NOW roadmap items lack validated discovery assumptions?",
  );
  await expect(stack.getByTestId("empty-rail-suggestions-pinned")).toHaveText(
    "Pinned while typing",
  );
  expect(capturedTurnBody).toBeNull();

  // The panel is URL state (?detail=), so a sidebar link would close it. Navigate the way an in-panel link does: client-side,
  // carrying the open panel across to the next page (this is the "background navigation" the pinned stack must survive).
  // No real in-panel link carries ?detail= across pages today; if panel persistence across navigation is added (separate
  // panel-persistence task), replace this router push with a click on that link.
  await page.evaluate(() => {
    const next = (window as unknown as { next: { router: { push: (href: string) => void } } }).next;
    next.router.push(`${window.location.pathname.replace(/\/roadmap$/, "/okrs")}${window.location.search}`);
  });
  await expect(page).toHaveURL(/\/okrs/);
  await expect(rail(page)).toBeVisible();
  await expect(stack).toContainText("Viewing · Roadmap");

  // Clearing composer draft reconciles stack to OKRs
  await composer.fill("");
  await expect(stack).toContainText("Viewing · OKRs", { timeout: 15_000 });
  await expect(stack.getByTestId("empty-rail-suggestions-pinned")).toHaveCount(0);

  // 3. 1-click fire -> sends message + snapshotted pageUrl in /api/agent/turn and hides empty-rail stack
  await stack.getByTestId("empty-rail-suggestion-fire").first().click();
  await expect(rail(page).getByText(streamedReply)).toBeVisible({ timeout: 15_000 });
  await expect(stack).toHaveCount(0);

  expect(capturedTurnBody).toMatchObject({
    message: "Which active Key Results have zero linked NOW roadmap items?",
    pageUrl: `${base}/okrs`,
  });
});
