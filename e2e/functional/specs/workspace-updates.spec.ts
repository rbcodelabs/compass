import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/index";
import { updatesFixture } from "../fixtures/workspace-updates";

test.describe("Workspace Updates", () => {
  test("a real task creation appears as a source-linked update", async ({ page, base }) => {
    const fixture = await updatesFixture();
    try {
      const title = `E2E Updates task ${randomUUID()}`;
      await page.goto(`${base}/tasks`);
      const todo = page.locator('[data-task-column="TODO"]');
      await todo.getByRole("button", { name: /Add task/i }).click();
      await page.getByLabel("Title").fill(title);
      await todo.getByRole("button", { name: "Add Task", exact: true }).click();
      await expect(todo.getByRole("button", { name: title, exact: true })).toBeVisible();
      await page.goto(`${base}/updates`);
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: /Behind this update/ }).first().click();
      const source = page.getByRole("link", { name: title, exact: true }).last();
      await expect(source).toHaveAttribute("href", new RegExp(`${base}/tasks/[0-9a-f-]{36}$`));
      await source.click();
      await page.waitForURL(new RegExp(`${base}/tasks/[0-9a-f-]{36}$`));
      await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
    } finally { await fixture.cleanup(); }
  });

  test("anonymous visitors cannot read the workspace feed", async ({ browser, baseURL, base }) => {
    const anonymous = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const page = await anonymous.newPage();
      await page.goto(`${base}/updates`);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("heading", { name: "Updates", exact: true })).toHaveCount(0);
    } finally { await anonymous.close(); }
  });

  test("opening and keyboard expansion preserve unread state; catch-up persists and Undo restores it", async ({ page, base }) => {
    const fixture = await updatesFixture();
    try {
      const parent = await fixture.task("Make project setup easier");
      const child = await fixture.task("Explain the first setup step", parent);
      await fixture.event(child, { groupId: parent, kind: "STATUS_CHANGED", after: "DONE" });
      await page.goto(`${base}/updates`);
      await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
      await expect(page.getByText("Make project setup easier", { exact: true }).first()).toBeVisible();
      const details = page.getByRole("button", { name: /Behind this update/ }).first();
      await details.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("link", { name: "Explain the first setup step", exact: true })).toBeVisible();
      expect((await fixture.readState())[0].caught_up_revision).toBe(0);
      await page.reload();
      await expect(page.getByText("Make project setup easier", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Mark caught up", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(1);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(0);
      await expect(page.getByText("Make project setup easier", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Mark caught up", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(1);
      await page.reload();
      await expect(page.getByText("Make project setup easier", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Past week", exact: true }).click();
      await expect(page.getByText("Make project setup easier", { exact: true }).first()).toBeVisible();
    } finally { await fixture.cleanup(); }
  });

  test("a frozen paginated snapshot cannot mark an arriving update as read", async ({ page, base }) => {
    const fixture = await updatesFixture();
    try {
      const grouped = await fixture.task("Review onboarding progress");
      for (let i = 0; i < 105; i++) await fixture.event(grouped);
      await page.goto(`${base}/updates`);
      const load = page.getByRole("button", { name: "Load more updates", exact: true });
      await expect(load).toBeVisible();
      const mark = page.getByRole("button", { name: "Mark caught up", exact: true });
      await expect(mark).toBeDisabled();
      const late = await fixture.task("A new milestone arrived while browsing");
      await fixture.event(late);
      await load.click();
      await expect(load).toBeHidden();
      await expect(page.getByText("A new milestone arrived while browsing", { exact: true })).toHaveCount(0);
      await mark.click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(105);
      await page.reload();
      await expect(page.getByText("A new milestone arrived while browsing", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Review onboarding progress", { exact: true })).toHaveCount(0);
    } finally { await fixture.cleanup(); }
  });

  test("deleted sources are suppressed without preventing pagination or catch-up", async ({ page, base }) => {
    const fixture = await updatesFixture();
    try {
      const visible = await fixture.task("An accessible milestone");
      await fixture.event(visible);
      for (let i = 0; i < 105; i++) await fixture.event(randomUUID());
      await page.goto(`${base}/updates`);
      const load = page.getByRole("button", { name: "Load more updates", exact: true });
      await load.click();
      await expect(load).toBeHidden();
      await expect(page.getByText("An accessible milestone", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Mark caught up", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(106);
    } finally { await fixture.cleanup(); }
  });

  test("another tab marking the same revision invalidates the first tab's Undo", async ({ page, context, base }) => {
    const fixture = await updatesFixture();
    const other = await context.newPage();
    try {
      const task = await fixture.task("A shared milestone");
      await fixture.event(task);
      await page.goto(`${base}/updates`);
      await other.goto(`${base}/updates`);
      await expect(other.getByText("A shared milestone", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Mark caught up", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].caught_up_revision).toBe(1);
      const firstVersion = (await fixture.readState())[0].version;
      await other.getByRole("button", { name: "Mark caught up", exact: true }).click();
      await expect.poll(async () => (await fixture.readState())[0].version).not.toBe(firstVersion);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Catch-up changed in another tab" })).toBeVisible();
      expect((await fixture.readState())[0].caught_up_revision).toBe(1);
      await page.reload();
      await expect(page.getByText("A shared milestone", { exact: true })).toHaveCount(0);
    } finally { await other.close(); await fixture.cleanup(); }
  });

  for (const [size, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } })) {
    test(`Updates navigation and grouped cards stay usable on ${size} in light and dark themes`, async ({ page, base }, testInfo) => {
      const fixture = await updatesFixture();
      try {
        const parent = await fixture.task("Help new teams find their first useful insight");
        const child = await fixture.task("Clarify the setup checklist", parent);
        await fixture.event(child, { groupId: parent, kind: "STATUS_CHANGED", after: "DONE" });
        const second = await fixture.task("Review the research plan with the team");
        await fixture.event(second, { kind: "COMMENT_ADDED" });
        await page.setViewportSize(viewport);
        await page.goto(base);
        await expect(page).toHaveURL(new RegExp(`${base}/updates$`));
        const nav = page.getByRole("navigation", { name: size === "mobile" ? "Primary navigation" : "Main navigation" });
        await expect(nav.getByRole("link", { name: "Updates", exact: true })).toBeVisible();
        if (size === "mobile") {
          const decisions = nav.getByRole("link", { name: "Decisions", exact: true });
          await decisions.scrollIntoViewIfNeeded();
          const box = await decisions.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          await nav.getByRole("link", { name: "Updates", exact: true }).scrollIntoViewIfNeeded();
        }
        for (const theme of ["light", "dark"]) {
          await page.evaluate(value => localStorage.setItem("compass-theme", value), theme);
          await page.reload();
          await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`updates-${size}-${theme}.png`), fullPage: true });
          if (process.env.UPDATE_UPDATES_SCREENSHOTS === "1") {
            await page.screenshot({ path: `public/screenshots/docs/updates-${size}-${theme}.png`, fullPage: true });
          }
        }
        await page.evaluate(() => localStorage.setItem("compass-theme", "light"));
        await page.reload();
        const expansion = page.getByRole("button", { name: /Behind this update/ }).first();
        await expansion.click();
        await expect(expansion).toHaveAttribute("aria-expanded", "true");
        await page.screenshot({ path: testInfo.outputPath(`updates-${size}-expanded.png`) });
        if (process.env.UPDATE_UPDATES_SCREENSHOTS === "1") {
          await page.screenshot({ path: `public/screenshots/docs/updates-${size}-expanded.png` });
        }
        await page.getByRole("button", { name: "Mark caught up", exact: true }).click();
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undo).toBeVisible();
        await expect(undo).toBeEnabled();
        if (size === "mobile") {
          const undoBox = await undo.boundingBox();
          const navBox = await nav.boundingBox();
          expect(undoBox!.y + undoBox!.height).toBeLessThanOrEqual(navBox!.y);
        }
        await page.screenshot({ path: testInfo.outputPath(`updates-${size}-caught-up.png`) });
        if (process.env.UPDATE_UPDATES_SCREENSHOTS === "1") {
          await page.screenshot({ path: `public/screenshots/docs/updates-${size}-caught-up.png` });
        }
      } finally { await fixture.cleanup(); }
    });
  }
});
