/**
 * Build the roadmap from Discovery.
 *
 * Journeys:
 *   1. Palette: `/` opens it, search finds a validated solution, Enter creates a
 *      linked roadmap item at the suggested slot (default six weeks) with an
 *      Undo toast; the same solution is then listed as scheduled and inert; the
 *      bar survives a reload.
 *   2. Undo: the rail's "Schedule" button creates an item, Undo archives it and
 *      the solution is back in the rail, still unscheduled after a reload.
 *   3. Drag from the rail: a ghost bar with dates and the release tip follows the
 *      pointer, and the drop creates the item with the row's squad and the date
 *      under the pointer.
 *   4. Draw a range on an empty row: the "Schedule from…" popover creates an item
 *      over exactly that range.
 *   5. Auto-sync: a solution moved to In delivery is added once, flagged auto, and
 *      shown in the rail's Auto-added section; Undo removes only the roadmap item
 *      (the solution keeps its status) and auto-sync never re-adds it.
 *   6. Empty roadmap: "Build from discovery" batch-creates linked items from a preset.
 *   7. Responsive: below 1320px the rail stacks above the timeline,
 *      which scrolls horizontally instead of squashing.
 *
 * dnd-kit's PointerSensor needs real mouse movement, so drags are simulated with
 * page.mouse.move/down/up in several steps.
 */
import { test, expect } from "../fixtures/index";
import {
  createFreshWorkspace,
  createSolution,
  inclusiveDays,
  localToday,
  openTimeline,
  railCard,
  revealBar,
  setPanelStatus,
  timelineBar,
} from "../fixtures/roadmap-candidates";

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100)}`;

test.describe("Roadmap: schedule from discovery", () => {
  test("palette schedules a validated solution at the suggested slot, then lists it as scheduled", async ({ page, base }) => {
    const title = `E2E Palette Solution ${stamp()}`;
    await createSolution(page, base, title);
    await openTimeline(page, base);
    await expect(railCard(page, title)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("auto-sync-indicator")).toContainText("Auto-sync on");

    // `/` opens the palette from the page; Escape closes it again.
    await page.locator("body").press("/");
    const palette = page.getByRole("dialog", { name: "Schedule from discovery" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).not.toBeVisible();

    // The header button does the same.
    await page.getByRole("button", { name: /Schedule from discovery/ }).click();
    await expect(palette).toBeVisible();
    const search = palette.getByRole("combobox", { name: /^Search/ });
    await expect(search).toBeFocused();
    await search.fill(title);
    const option = palette.getByRole("option").filter({ hasText: title }).first();
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(palette).not.toBeVisible();
    await expect(page.getByTestId("undo-toast").filter({ hasText: "Created roadmap item" })).toBeVisible({ timeout: 15_000 });
    await expect(railCard(page, title)).toHaveCount(0);

    const bar = await revealBar(page, title);
    const start = (await bar.getAttribute("data-start"))!;
    const end = (await bar.getAttribute("data-end"))!;
    expect(start >= localToday(), "starts at or after today").toBe(true);
    expect(inclusiveDays(start, end), "default length is six weeks").toBe(42);

    // Already-scheduled solutions are listed but inert.
    await page.locator("body").press("/");
    await palette.getByRole("combobox", { name: /^Search/ }).fill(title);
    const scheduled = palette.getByRole("option").filter({ hasText: title }).first();
    await expect(scheduled).toContainText("scheduled");
    await expect(scheduled).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");

    // Persists, and is linked to its solution (the detail panel shows the solution title).
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect((await revealBar(page, title))).toHaveAttribute("data-start", start);
    await expect(railCard(page, title)).toHaveCount(0);
  });

  test("Undo archives the created item and the solution returns to the rail", async ({ page, base }) => {
    const title = `E2E Undo Solution ${stamp()}`;
    await createSolution(page, base, title);
    await openTimeline(page, base);

    await railCard(page, title).getByRole("button", { name: `Schedule ${title} at the suggested slot` }).click();
    const toast = page.getByTestId("undo-toast").filter({ hasText: title });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(railCard(page, title)).toHaveCount(0);
    await revealBar(page, title);

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(timelineBar(page, title)).toHaveCount(0, { timeout: 10_000 });
    await expect(railCard(page, title)).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(railCard(page, title)).toBeVisible();
    await expect(timelineBar(page, title)).toHaveCount(0);
  });

  test("dragging a rail card shows a ghost with dates and a release tip, and the drop creates the item", async ({ page, base }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    const title = `E2E Drag Solution ${stamp()}`;
    await createSolution(page, base, title);
    await openTimeline(page, base);

    const handle = railCard(page, title).getByLabel("Drag to schedule");
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const lane = page.getByTestId("timeline-drop-lane:NEXT:unassigned");
    await lane.scrollIntoViewIfNeeded();
    const laneBox = (await lane.boundingBox())!;
    const scrollBox = (await page.getByTestId("native-timeline-scroll").boundingBox())!;
    const targetX = scrollBox.x + Math.min(scrollBox.width - 300, 500);
    const targetY = laneBox.y + laneBox.height / 2;

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20, { steps: 8 });
    await page.mouse.move(targetX, targetY, { steps: 30 });

    const ghost = page.getByTestId("timeline-drop-ghost");
    await expect(ghost).toBeVisible();
    await expect(ghost).toContainText(title);
    await expect(ghost).toContainText("6 wks");
    await expect(page.getByTestId("timeline-drop-tip")).toContainText("Release to create roadmap item");
    await page.mouse.up();

    await expect(railCard(page, title)).toHaveCount(0, { timeout: 15_000 });
    await expect(ghost).toHaveCount(0);
    const bar = timelineBar(page, title);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    expect(inclusiveDays((await bar.getAttribute("data-start"))!, (await bar.getAttribute("data-end"))!)).toBe(42);
    await expect(page.getByTestId("undo-toast").filter({ hasText: "Created roadmap item" })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(railCard(page, title)).toHaveCount(0);
  });

  test("drawing a range on an empty row offers 'Schedule from…' and creates the item over that range", async ({ page, base }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    const title = `E2E Range Solution ${stamp()}`;
    await createSolution(page, base, title);
    await openTimeline(page, base);
    await expect(railCard(page, title)).toBeVisible();

    const lane = page.getByTestId("timeline-drop-lane:LATER:unassigned");
    await lane.scrollIntoViewIfNeeded();
    const laneBox = (await lane.boundingBox())!;
    const scrollBox = (await page.getByTestId("native-timeline-scroll").boundingBox())!;
    const startX = scrollBox.x + 200;
    const endX = startX + 240; // 20 days at 12px per day
    const y = laneBox.y + laneBox.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 12 });
    await expect(page.getByTestId("timeline-range-draft")).toBeVisible();
    await page.mouse.up();

    const popover = page.getByRole("dialog", { name: "Schedule from…" });
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: new RegExp(title) }).click();

    await expect(railCard(page, title)).toHaveCount(0, { timeout: 15_000 });
    const bar = timelineBar(page, title);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    const days = inclusiveDays((await bar.getAttribute("data-start"))!, (await bar.getAttribute("data-end"))!);
    expect(days).toBeGreaterThanOrEqual(19);
    expect(days).toBeLessThanOrEqual(22);
  });

  test("moving a solution to In delivery auto-adds it once; Undo removes only the roadmap item and it is never re-added", async ({ page, base }) => {
    const title = `E2E Auto Solution ${stamp()}`;
    await createSolution(page, base, title, "Validated");

    // Validated stays in the rail: it is ready to schedule, not auto-added.
    await openTimeline(page, base);
    await expect(railCard(page, title)).toBeVisible();
    await expect(timelineBar(page, title)).toHaveCount(0);

    // In delivery auto-adds it, and the person who made the change is told and can undo.
    // The rail card opens the solution's detail panel right here on the roadmap.
    await railCard(page, title).getByRole("button", { name: title, exact: true }).click();
    await setPanelStatus(page, "Validated", "In delivery");
    await expect(page.getByTestId("undo-toast").filter({ hasText: "Auto-added" })).toBeVisible({ timeout: 15_000 });

    await openTimeline(page, base);
    const bar = await revealBar(page, title);
    await expect(bar.getByText("auto", { exact: true })).toBeVisible();
    await expect(railCard(page, title)).toHaveCount(0);
    const auto = page.getByTestId("schedule-rail-auto");
    await expect(auto).toContainText(title);

    // Undo from the rail: the roadmap item goes, the solution returns to the rail.
    await auto.getByRole("button", { name: `Undo auto-add of ${title}` }).click();
    await expect(timelineBar(page, title)).toHaveCount(0, { timeout: 10_000 });
    await expect(railCard(page, title)).toBeVisible();

    // The solution itself was not touched: still In delivery.
    await railCard(page, title).getByRole("button", { name: title, exact: true }).click();
    await expect(page.locator('[data-slot="sheet-content"] [role="combobox"]').filter({ hasText: "In delivery" })).toBeVisible();

    // Leave and re-enter In delivery: suppressed, never re-added.
    await setPanelStatus(page, "In delivery", "Validated");
    await setPanelStatus(page, "Validated", "In delivery");
    await openTimeline(page, base);
    await page.getByRole("button", { name: "Go to today", exact: true }).click();
    await expect(timelineBar(page, title)).toHaveCount(0);
    await expect(railCard(page, title)).toBeVisible();
  });

  test("an empty roadmap offers Build from discovery, which creates linked items from a preset", async ({ page, orgSlug }) => {
    const ts = stamp();
    const workspaceBase = await createFreshWorkspace(page, orgSlug, `E2E Sched ${ts}`);
    const first = `E2E Build First ${ts}`;
    const second = `E2E Build Second ${ts}`;
    await createSolution(page, workspaceBase, first);
    await createSolution(page, workspaceBase, second);

    await openTimeline(page, workspaceBase);
    const empty = page.getByTestId("roadmap-empty-state");
    await expect(empty).toBeVisible();
    await expect(empty.getByText(/2 validated solutions across 2 opportunities are ready to plan/)).toBeVisible();
    await expect(empty.getByRole("button", { name: "Add an item manually" })).toBeVisible();

    await empty.getByRole("button", { name: "Build from discovery" }).click();
    await expect(empty.getByRole("group", { name: "Start with" })).toBeVisible();
    await expect(empty.getByRole("button", { name: /All validated solutions · 2/ })).toHaveAttribute("aria-pressed", "true");
    await empty.getByRole("button", { name: "Create 2 roadmap items" }).click();

    await expect(page.getByTestId("roadmap-empty-state")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("undo-toast").filter({ hasText: "Created 2 roadmap items from discovery" })).toBeVisible();
    await revealBar(page, first);
    await revealBar(page, second);
    await expect(page.getByTestId("schedule-rail-empty")).toContainText("Everything from Discovery is on the roadmap.");

    // Undo returns both to the rail and the empty state comes back after a reload.
    await page.getByTestId("undo-toast").getByRole("button", { name: "Undo" }).click();
    await expect(railCard(page, first)).toBeVisible({ timeout: 10_000 });
    await expect(railCard(page, second)).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("roadmap-empty-state")).toBeVisible();
  });

  test("on a narrow screen the rail stacks above the timeline and the timeline scrolls horizontally", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTimeline(page, base);
    const rail = page.getByTestId("schedule-rail");
    const scroll = page.getByTestId("native-timeline-scroll");
    await expect(rail).toBeVisible();
    const railBox = (await rail.boundingBox())!;
    const scrollBox = (await scroll.boundingBox())!;
    expect(railBox.y + railBox.height, "rail sits above the timeline").toBeLessThanOrEqual(scrollBox.y + 1);
    expect(railBox.width, "rail uses the full width").toBeGreaterThan(300);
    const { scrollWidth, clientWidth } = await scroll.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(scrollWidth, "timeline scrolls horizontally instead of squashing").toBeGreaterThan(clientWidth);
  });
});
