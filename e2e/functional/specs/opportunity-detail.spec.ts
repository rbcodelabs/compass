import pg from "pg";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

const title = "New teams struggle to reach their first shared insight";

async function seedOpportunity() {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [workspace] } = await pool.query(
      "SELECT w.id FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'",
    );
    const { rows: [opportunity] } = await pool.query(
      "INSERT INTO compass_dev.opportunities (id,workspace_id,title,description,status,customer_segment) VALUES (gen_random_uuid(),$1,$2,$3,'EXPLORING','New teams') RETURNING id",
      [workspace.id, title, "Getting research into the workspace is easy. Turning it into a shared understanding takes too much coordination."],
    );
    await pool.query(
      "INSERT INTO compass_dev.solutions (id,opportunity_id,title,description,status) VALUES (gen_random_uuid(),$1,'A shared first-insight recap','Give the team a starting point for a useful conversation.','IDEA')",
      [opportunity.id],
    );
    return opportunity.id as string;
  } finally {
    await pool.end();
  }
}

test("opportunity discussion persists between full page and panel", async ({ page, base }) => {
  const id = await seedOpportunity();
  await page.goto(`${base}/discovery/${id}`);
  const discussion = page.getByRole("region", { name: "Discussion", exact: true });
  await expect(discussion.getByText("No comments yet.")).toBeVisible();
  await discussion.getByLabel("Add comment", { exact: true }).fill("Test the shared recap with new teams.");
  await discussion.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(discussion.getByText("Test the shared recap with new teams.", { exact: true })).toBeVisible();
  await discussion.getByRole("button", { name: /Reply to / }).click();
  await discussion.getByRole("textbox", { name: /Reply to / }).fill("Measure whether a second teammate participates.");
  await discussion.getByRole("button", { name: "Post reply", exact: true }).click();
  await expect(discussion.getByText("Measure whether a second teammate participates.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Evidence/ }).click();
  await expect(discussion.getByText("Test the shared recap with new teams.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(discussion.getByText("Measure whether a second teammate participates.", { exact: true })).toBeVisible();
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  const panelDiscussion = panel.getByRole("region", { name: "Discussion", exact: true });
  await expect(panel.getByRole("link", { name: "Open full page" })).toHaveCount(1);
  await expect(panel.locator('[data-slot="sheet-header"]').getByRole("link", { name: "Open full page" })).toHaveAttribute("href", `${base}/discovery/${id}`);
  await expect(panelDiscussion.getByText("Test the shared recap with new teams.", { exact: true })).toBeVisible();
  await panelDiscussion.getByRole("button", { name: /Edit comment by / }).first().click();
  await panelDiscussion.getByRole("textbox", { name: /Edit comment by / }).fill("Test the shared recap this week.");
  await panelDiscussion.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(panelDiscussion.getByText("Test the shared recap this week.", { exact: true })).toBeVisible();
  await panelDiscussion.getByRole("button", { name: /Resolve thread by / }).click();
  await expect(panelDiscussion.getByRole("button", { name: /Expand resolved thread by / })).toBeVisible();
  await panel.getByRole("link", { name: "Open full page" }).click();
  await expect(page).toHaveURL(new RegExp(`/discovery/${id}`));
  await expect(discussion.getByRole("button", { name: /Expand resolved thread by / })).toBeVisible();
  await discussion.getByRole("button", { name: /Reopen thread by / }).click();
  await expect(discussion.getByText("Test the shared recap this week.", { exact: true })).toBeVisible();
  await expect(discussion.getByText("Measure whether a second teammate participates.", { exact: true })).toBeVisible();
});

test("opportunity layout responds to available width without losing comment drafts", async ({ page, base }) => {
  const id = await seedOpportunity();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${base}/discovery/${id}`);
  const discussion = page.getByRole("region", { name: "Discussion", exact: true });
  await expect(discussion.getByText("No comments yet.")).toBeVisible();
  await discussion.getByLabel("Add comment", { exact: true }).fill("The interviews point to a gap in the handoff.");
  await discussion.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(discussion.getByText("The interviews point to a gap in the handoff.", { exact: true })).toBeVisible();
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
  await discussion.getByLabel("Add comment", { exact: true }).fill("Unfinished observation");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(discussion.getByLabel("Add comment", { exact: true })).toHaveValue("Unfinished observation");
  const mobileTabs = await tabs.boundingBox();
  const mobileDiscussion = await discussion.boundingBox();
  expect(mobileDiscussion!.y).toBeGreaterThan(mobileTabs!.y + mobileTabs!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-page-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await discussion.getByLabel("Add comment", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-discussion-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(discussion.getByLabel("Add comment", { exact: true })).toHaveValue("Unfinished observation");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/discovery?detail=opportunity:${id}`);
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(panel.getByRole("region", { name: "Discussion", exact: true }).getByText("The interviews point to a gap in the handoff.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-panel-mobile.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-panel-desktop.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.getByRole("button", { name: "Pin panel", exact: true }).click();
  const pinned = page.locator('[data-slot="pinned-panel"]');
  await expect(pinned.getByRole("link", { name: "Open full page" })).toHaveCount(1);
  await expect(pinned.locator('[data-slot="opportunity-detail"]').getByRole("link", { name: "Open full page" })).toHaveCount(0);
  await expect(pinned.getByRole("region", { name: "Discussion", exact: true }).getByText("The interviews point to a gap in the handoff.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await pinned.getByRole("button", { name: title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-pinned-desktop.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: "public/screenshots/docs/opportunity-detail-pinned-dark.png", fullPage: true, animations: "disabled", style: "nextjs-portal { visibility: hidden; }" });
});

test("opportunity discussion retries a failed load and retains a failed post", async ({ page, base }) => {
  const id = await seedOpportunity();
  let rejectLoad = true;
  let rejectPost = false;
  await page.route("**/api/comments**", async route => {
    if (route.request().method() === "GET" && rejectLoad) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Discussion temporarily unavailable" }) });
    } else if (route.request().method() === "POST" && rejectPost) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Please retry your comment" }) });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${base}/discovery/${id}`);
  const discussion = page.getByRole("region", { name: "Discussion", exact: true });
  await expect(discussion.getByRole("alert")).toHaveText("Discussion temporarily unavailable");
  rejectLoad = false;
  await discussion.getByRole("button", { name: "Retry discussion" }).click();
  await expect(discussion.getByText("No comments yet.")).toBeVisible();
  rejectPost = true;
  await discussion.getByLabel("Add comment", { exact: true }).fill("Preserve this observation.");
  await discussion.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(discussion.getByRole("alert")).toHaveText("Please retry your comment");
  await expect(discussion.getByLabel("Add comment", { exact: true })).toHaveValue("Preserve this observation.");
  rejectPost = false;
  await discussion.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(discussion.getByText("Preserve this observation.", { exact: true })).toBeVisible();
});
