import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

/**
 * Browser contract tests for the real BoardScroller mounted by Discovery.
 * Controlled overflow content makes each scroll owner deterministic without
 * copying the wheel listener or depending on other journeys' seeded cards.
 * Full board layouts/touch gestures remain covered by kanban-mobile-scroll.
 */
async function scrollFixture(page: Page, base: string, options: { mobile?: boolean; boardVertical?: boolean; nested?: "vertical" | "horizontal" } = {}) {
  await page.setViewportSize(options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.goto(`${base}/discovery?view=board`);
  await page.waitForLoadState("networkidle");
  const board = page.getByRole("region", { name: /opportunit.*board/i });
  await expect(board).toBeVisible();
  await board.evaluate((element, options) => {
    // Keep the actual mounted Board and its production native wheel listener.
    const wrapper = document.createElement("div");
    wrapper.dataset.testid = "wheel-page-scrollport";
    wrapper.style.cssText = `width:${options.mobile ? 320 : 560}px;height:300px;overflow:auto;position:fixed;left:20px;top:100px;z-index:1000;background:white;`;
    element.before(wrapper);
    wrapper.append(element);
    const board = element as HTMLElement;
    board.style.cssText = `display:block;flex:none;width:${options.mobile ? 320 : 560}px;height:240px;overflow-x:auto;overflow-y:${options.boardVertical ? "auto" : "hidden"};scroll-snap-type:none;`;
    const track = document.createElement("div");
    track.style.cssText = `width:1600px;height:${options.boardVertical ? 1000 : 200}px;`;
    const target = document.createElement("div");
    target.dataset.testid = "wheel-target";
    target.style.cssText = "width:220px;height:150px;background:#eee;";
    if (options.nested) {
      target.style.overflow = "auto";
      const content = document.createElement("div");
      content.style.cssText = `width:${options.nested === "horizontal" ? 900 : 180}px;height:${options.nested === "vertical" ? 900 : 120}px;`;
      // A path is deliberately the native hit target, reproducing HTMLElement-only ancestry.
      content.innerHTML = '<svg width="180" height="120"><path data-testid="wheel-svg" d="M0 0H180V120H0Z" fill="#777" /></svg>';
      target.append(content);
    } else {
      target.textContent = "Wheel over the actual Board";
    }
    track.append(target);
    board.replaceChildren(track);
    const below = document.createElement("div");
    below.style.height = "1200px";
    wrapper.append(below);
  }, options);
  return { board, target: page.getByTestId(options.nested ? "wheel-svg" : "wheel-target"), nested: page.getByTestId("wheel-target"), outer: page.getByTestId("wheel-page-scrollport") };
}

async function wheel(page: Page, target: Locator, x: number, y: number) {
  await target.hover();
  await page.mouse.wheel(x, y);
}

const left = (locator: Locator) => locator.evaluate(element => element.scrollLeft);
const top = (locator: Locator) => locator.evaluate(element => element.scrollTop);

test("desktop vertical wheel pans the real board and horizontal wheel input stays native", async ({ page, base }, testInfo) => {
  const { board, target } = await scrollFixture(page, base);
  await wheel(page, target, 0, 100);
  await expect.poll(() => left(board)).toBeGreaterThan(50);
  await board.evaluate(element => { element.scrollLeft = 0; });
  await wheel(page, target, 120, 10);
  await expect.poll(() => left(board)).toBeGreaterThan(50);
  await page.screenshot({ path: testInfo.outputPath("board-wheel-desktop.png") });
});

test("SVG hit targets retain their nested vertical scroll owner", async ({ page, base }) => {
  const { board, target, nested, outer } = await scrollFixture(page, base, { nested: "vertical" });
  await wheel(page, target, 0, 100);
  await expect.poll(() => top(nested)).toBeGreaterThan(50);
  expect(await left(board)).toBe(0);
  // At the nested boundary, vertical chaining must never turn into Board panning.
  await nested.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const box = (await nested.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 75);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => top(outer)).toBeGreaterThan(25);
  expect(await left(board)).toBe(0);
});

test("SVG hit targets retain nested horizontal wheel scrolling", async ({ page, base }) => {
  const { board, target, nested } = await scrollFixture(page, base, { nested: "horizontal" });
  await wheel(page, target, 100, 0);
  await expect.poll(() => left(nested)).toBeGreaterThan(50);
  expect(await left(board)).toBe(0);
});

test("vertical wheel over a nested horizontal SVG scrollport never pans the Board", async ({ page, base }) => {
  const { board, target, outer } = await scrollFixture(page, base, { nested: "horizontal" });
  await wheel(page, target, 0, 100);
  await expect.poll(() => top(outer)).toBeGreaterThan(25);
  expect(await left(board)).toBe(0);
});

test("Board-owned vertical overflow keeps vertical wheel movement including at its boundary", async ({ page, base }) => {
  const { board, target, outer } = await scrollFixture(page, base, { boardVertical: true });
  await wheel(page, target, 0, 100);
  await expect.poll(() => top(board)).toBeGreaterThan(50);
  expect(await left(board)).toBe(0);
  await board.evaluate(element => { element.scrollTop = element.scrollHeight; });
  // Hit the Board itself at the end; its first child is now out of view.
  const box = (await board.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => top(outer)).toBeGreaterThan(25);
  expect(await left(board)).toBe(0);
});

test("narrow screens keep native vertical wheel navigation through a wide Board", async ({ page, base }, testInfo) => {
  const { board, target, outer } = await scrollFixture(page, base, { mobile: true });
  await wheel(page, target, 0, 100);
  await expect.poll(() => top(outer)).toBeGreaterThan(25);
  expect(await left(board)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("board-wheel-mobile.png") });
});

test("desktop horizontal Board boundary releases vertical wheel to its ancestor", async ({ page, base }) => {
  const { board, outer } = await scrollFixture(page, base);
  await board.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const end = await left(board);
  const box = (await board.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => top(outer)).toBeGreaterThan(25);
  expect(await left(board)).toBe(end);
});

test("keyboard navigation retains the nested native vertical scrollport", async ({ page, base }) => {
  const { board, nested } = await scrollFixture(page, base, { nested: "vertical" });
  await nested.evaluate(element => { (element as HTMLElement).tabIndex = 0; });
  await nested.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => top(nested)).toBeGreaterThan(50);
  expect(await left(board)).toBe(0);
});

test("the same mounted Board switches wheel ownership at the 767px and 768px breakpoint", async ({ page, base }) => {
  const { board, target, outer } = await scrollFixture(page, base);
  for (const width of [767, 768, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await outer.evaluate(element => { element.scrollTop = 0; });
    await board.evaluate(element => { element.scrollLeft = 0; });
    await wheel(page, target, 0, 100);
    if (width < 768) {
      await expect.poll(() => top(outer)).toBeGreaterThan(25);
      expect(await left(board)).toBe(0);
    } else {
      await expect.poll(() => left(board)).toBeGreaterThan(50);
      expect(await top(outer)).toBe(0);
    }
  }
});
