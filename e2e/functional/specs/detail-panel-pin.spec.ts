/**
 * Functional coverage for pin mode on the shared entity detail panel
 * (components/panels/panel-shell.tsx).
 *
 * Pinned, the panel stops being a modal Sheet and becomes a real layout
 * column. Almost everything that can go wrong with that is invisible to unit
 * tests, because it is about real layout, real stacking contexts, and the gap
 * between a server render and hydration:
 *
 *  - a modal backdrop that still swallows clicks even though nothing looks
 *    like it is covering the page;
 *  - a portalled popup that paints underneath the panel it was opened from
 *    (already shipped once — see the ladder note in components/ui/select.tsx);
 *  - an overlay that flashes for one frame on every load before JS decides
 *    the user is actually pinned.
 *
 * So these assertions deliberately prefer observable behaviour over structure:
 * "this click landed on the thing behind the panel" rather than "no element
 * overlaps".
 *
 * Runs at 1440x900 — wide enough for pinning to be legal (the gate is
 * 1024px), which the functional project's default 1280x720 also clears, but
 * pinned + 720px max panel + 480px main floor needs the headroom to exercise
 * the clamps at all.
 */
import type { Page } from "@playwright/test";

import { test, expect } from "../fixtures/index";
import { createOpportunityFromBoard } from "../fixtures/opportunity-composer";

test.use({ viewport: { width: 1440, height: 900 } });

const PIN_COOKIE = "compass_panel_detail";
const OVERLAY = '[data-slot="sheet-overlay"]';
const SHEET = '[data-slot="sheet-content"]';
const ASIDE = '[data-slot="pinned-panel"]';
const HANDLE = '[data-slot="panel-resize-handle"]';
const MAIN = '[data-slot="sidebar-inset"]';

async function readPinCookie(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === PIN_COOKIE)?.value;
}

async function setPinCookie(page: Page, value: string) {
  await page.context().addCookies([
    { name: PIN_COOKIE, value, domain: "localhost", path: "/" },
  ]);
}

async function clearPinCookie(page: Page) {
  const remaining = (await page.context().cookies()).filter(
    (cookie) => cookie.name !== PIN_COOKIE,
  );
  await page.context().clearCookies();
  await page.context().addCookies(remaining);
}

/** Create an opportunity on the Discovery board and return its title. */
async function createOpportunity(page: Page, base: string, title: string) {
  await page.goto(`${base}/discovery`);
  await page.waitForLoadState("networkidle");
  await createOpportunityFromBoard(page, title);
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  return box.width;
}

test.describe("Detail panel pin mode", () => {
  test.beforeEach(async ({ page }) => {
    await clearPinCookie(page);
  });

  // ── AC1 ───────────────────────────────────────────────────────────────────
  test("with no cookie the panel is an overlay, exactly as before", async ({ page, base }) => {
    const title = `Pin E2E Default ${Date.now()}`;
    await createOpportunity(page, base, title);

    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page).toHaveURL(/detail=opportunity/);

    // The unpinned default is what keeps every existing sheet-content spec
    // green, so it is asserted directly rather than assumed.
    await expect(page.locator(SHEET)).toBeVisible();
    await expect(page.locator(OVERLAY)).toHaveCount(1);
    await expect(page.locator(ASIDE)).toHaveCount(0);
    expect(await readPinCookie(page)).toBeUndefined();
  });

  // ── AC2, AC3 ──────────────────────────────────────────────────────────────
  test("pinning removes the backdrop, writes the cookie, and leaves main content genuinely clickable", async ({
    page,
    base,
  }) => {
    const stamp = Date.now();
    const first = `Pin E2E Docked A ${stamp}`;
    const second = `Pin E2E Docked B ${stamp}`;
    await createOpportunity(page, base, first);
    await createOpportunity(page, base, second);

    await page.getByRole("button", { name: first, exact: true }).click();
    await expect(page.locator(SHEET)).toBeVisible();

    await page.getByRole("button", { name: "Pin panel" }).click();

    // AC2 — structural half: the modal and its backdrop are gone entirely.
    await expect(page.locator(ASIDE)).toBeVisible();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    await expect(page.locator(SHEET)).toHaveCount(0);
    await expect(page.locator(ASIDE)).toContainText(first);

    // AC3 — the preference is persisted in the documented format.
    expect(await readPinCookie(page)).toMatch(/^1:\d+$/);

    // AC2 — behavioural half, and the one that actually matters. A removed
    // backdrop is not the same as a usable page: Base UI's modal also applies
    // aria-hidden and pointer-events to sibling trees. Click a *different*
    // opportunity card in main content and require the app to respond to it.
    await page.getByRole("button", { name: second, exact: true }).click();
    await expect(page.locator(ASIDE)).toContainText(second, { timeout: 15_000 });
    await expect(page.locator(ASIDE)).not.toContainText(first);
  });

  // ── AC4 ───────────────────────────────────────────────────────────────────
  test("a pinned reload shows no overlay at any point, including before hydration", async ({
    page,
    base,
  }) => {
    const title = `Pin E2E Reload ${Date.now()}`;
    await createOpportunity(page, base, title);
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Pin panel" }).click();
    await expect(page.locator(ASIDE)).toBeVisible();

    const pinnedUrl = page.url();
    await page.goto(pinnedUrl, { waitUntil: "domcontentloaded" });

    // Sampled once, synchronously, at domcontentloaded — deliberately NOT via
    // a retrying matcher, which would happily paper over a one-frame flash by
    // waiting for it to pass. The pinned aside is server-rendered, so if the
    // pin state were decided on the client instead, this is where the modal
    // backdrop would be caught.
    expect(await page.locator(OVERLAY).count()).toBe(0);
    expect(await page.locator(ASIDE).count()).toBe(1);

    await expect(page.locator(ASIDE)).toContainText(title, { timeout: 15_000 });
    expect(await page.locator(OVERLAY).count()).toBe(0);
  });

  // ── AC5 ───────────────────────────────────────────────────────────────────
  test("dragging the handle resizes the panel and the new width survives a reload", async ({
    page,
    base,
  }) => {
    const title = `Pin E2E Drag ${Date.now()}`;
    await createOpportunity(page, base, title);
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Pin panel" }).click();
    await expect(page.locator(ASIDE)).toBeVisible();

    const before = await widthOf(page, ASIDE);
    const handle = await page.locator(HANDLE).boundingBox();
    if (!handle) throw new Error("resize handle has no bounding box");

    // Drag left: for a right-hand panel that means wider.
    const startX = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 80, y, { steps: 12 });
    await page.mouse.up();

    const after = await widthOf(page, ASIDE);
    expect(Math.abs(after - (before + 80))).toBeLessThanOrEqual(4);

    expect(await readPinCookie(page)).toBe(`1:${Math.round(after)}`);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(ASIDE)).toBeVisible();
    const reloaded = await widthOf(page, ASIDE);
    expect(Math.abs(reloaded - after)).toBeLessThanOrEqual(4);
  });

  // ── AC6 ───────────────────────────────────────────────────────────────────
  test("width clamps hold at both ends and main content never drops below its floor", async ({
    page,
    base,
  }) => {
    const title = `Pin E2E Clamp ${Date.now()}`;
    await createOpportunity(page, base, title);
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Pin panel" }).click();
    await expect(page.locator(ASIDE)).toBeVisible();

    const handle = await page.locator(HANDLE).boundingBox();
    if (!handle) throw new Error("resize handle has no bounding box");
    const y = handle.y + handle.height / 2;

    // Drag far past the left edge of the window.
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(-500, y, { steps: 15 });
    await page.mouse.up();

    const widest = await widthOf(page, ASIDE);
    expect(widest).toBeLessThanOrEqual(720);
    expect(await widthOf(page, MAIN)).toBeGreaterThanOrEqual(480);

    // And far past the right edge.
    const handleNow = await page.locator(HANDLE).boundingBox();
    if (!handleNow) throw new Error("resize handle has no bounding box");
    await page.mouse.move(handleNow.x + handleNow.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(3000, y, { steps: 15 });
    await page.mouse.up();

    const narrowest = await widthOf(page, ASIDE);
    expect(narrowest).toBeGreaterThanOrEqual(320);
    expect(await widthOf(page, MAIN)).toBeGreaterThanOrEqual(480);

    // Every persisted value stayed inside the supported range too.
    expect(await readPinCookie(page)).toMatch(/^1:(3[2-9]\d|[4-6]\d\d|7[0-1]\d|720)$/);
  });

  // ── AC7 ───────────────────────────────────────────────────────────────────
  test("a portalled Select inside a pinned panel is still clickable", async ({ page, base }) => {
    // Regression guard for the stacking-layer note in components/ui/select.tsx.
    // This exact class of bug — a popup that renders and is keyboard-reachable
    // but silently refuses mouse clicks — has shipped before.
    const stamp = Date.now();
    const opportunityTitle = `Pin E2E Select Opp ${stamp}`;
    const solutionTitle = `Pin E2E Select Sol ${stamp}`;

    await createOpportunity(page, base, opportunityTitle);
    await page.getByRole("button", { name: opportunityTitle, exact: true }).click();

    const sheet = page.locator(SHEET);
    await sheet.getByRole("button", { name: "Add Solution" }).click();
    await sheet.getByLabel("Title").fill(solutionTitle);
    await sheet.getByRole("button", { name: "Add Solution" }).click();
    await expect(sheet.getByText(solutionTitle)).toBeVisible({ timeout: 20_000 });

    // Not `exact` — the solution row's accessible name is prefixed with its
    // status badge ("Idea Pin E2E Select Sol …"), so an exact match never hits.
    await sheet.getByRole("button", { name: solutionTitle }).click();
    await expect(page).toHaveURL(/detail=solution/);

    await page.getByRole("button", { name: "Pin panel" }).click();
    const aside = page.locator(ASIDE);
    await expect(aside).toBeVisible();

    // Drive the Solution header's status dropdown, not "Promote to Roadmap".
    // The panel only renders the promote control once a Solution is VALIDATED
    // or IN_DELIVERY (`canPromote` in components/panels/solution-panel.tsx),
    // and this fixture is a freshly created Solution, which defaults to IDEA —
    // so that button never appeared and the test timed out before it reached
    // the Select it exists to guard. The status dropdown is rendered for every
    // status and is the same portalled Select primitive, so it exercises the
    // stacking behaviour this test is actually about.
    const trigger = aside.getByRole("combobox").first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    // The popup is portalled to <body>, so its z-index is compared against
    // every other overlay in the document — not against the aside it came
    // from. A real click, not a keyboard selection, is the whole point.
    const option = page.getByRole("option", { name: "Validated" });
    await expect(option).toBeVisible();
    await option.click();

    await expect(trigger).toContainText("Validated");
  });

  // ── AC8 ───────────────────────────────────────────────────────────────────
  test("narrow viewports demote a pinned preference back to an overlay", async ({ page, base }) => {
    const title = `Pin E2E Narrow ${Date.now()}`;
    await createOpportunity(page, base, title);

    // Seed the preference the way a returning user arrives with it, so the
    // demotion is exercised on the server-seeded path and not only after a
    // client-side toggle.
    await setPinCookie(page, "1:520");

    for (const viewport of [
      { width: 900, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/discovery`);
      await page.waitForLoadState("networkidle");

      await page.getByRole("button", { name: title, exact: true }).first().click();
      await expect(page).toHaveURL(/detail=opportunity/);

      // Below the 1024px gate the aside is CSS-gated off regardless of what
      // JS believes, and the overlay takes over.
      await expect(
        page.locator(ASIDE),
        `aside must not paint at ${viewport.width}px`,
      ).toBeHidden();
      await expect(
        page.locator(SHEET),
        `overlay must take over at ${viewport.width}px`,
      ).toBeVisible({ timeout: 15_000 });

      // The preference itself is untouched — the suspension is the
      // environment's, not the user's, so widening the window must restore the
      // pinned layout with no re-click.
      expect(await readPinCookie(page)).toBe("1:520");

      await page.keyboard.press("Escape");
    }

    // Widening restores it, with no further interaction.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: title, exact: true }).first().click();
    await expect(page.locator(ASIDE)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });
});
