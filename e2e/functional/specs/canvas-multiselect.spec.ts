/**
 * JSON Canvas multiselect + floating inspector functional spec.
 *
 * Covers: marquee selection, Shift/Ctrl-click toggling, moving a multi-selection
 * as one undoable gesture, bulk recolor through the floating inspector,
 * Ctrl/Cmd+A / Escape, zero layout shift when the inspector appears, the
 * Select/Pan tool toggle, and the group-drag-carries-its-cards regression.
 * Run at a desktop and a phone viewport.
 *
 * Self-seeding: each test imports a .canvas file with known geometry (so the
 * marquee has a deterministic target) through the UI, which creates its own doc.
 *
 *   group g (0,0 300x300) frames cards f1 and f2
 *   t1 t2 t3 are a row of free cards at y=0 to the right of the group
 */
import fs from "node:fs";
import { test, expect } from "../fixtures/index";
import type { Locator, Page } from "@playwright/test";

const SCREENSHOT_DIR = "/tmp/qa-canvas";

const CANVAS = {
  nodes: [
    { id: "g", type: "group", x: 0, y: 0, width: 300, height: 300, label: "Frame" },
    { id: "f1", type: "text", x: 30, y: 40, width: 200, height: 80, text: "framed one" },
    { id: "f2", type: "text", x: 30, y: 160, width: 200, height: 80, text: "framed two" },
    { id: "t1", type: "text", x: 400, y: 0, width: 200, height: 80, text: "free one" },
    { id: "t2", type: "text", x: 700, y: 0, width: 200, height: 80, text: "free two" },
    { id: "t3", type: "text", x: 1000, y: 0, width: 200, height: 80, text: "free three" },
  ],
  edges: [],
};
const ALL_IDS = ["g", "f1", "f2", "t1", "t2", "t3"];

type Box = { x: number; y: number; width: number; height: number };

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const selectedNodes = (page: Page) => page.locator(".react-flow__node.selected");

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return box;
}

async function positions(page: Page, ids: string[] = ALL_IDS) {
  const out: Record<string, Box> = {};
  for (const id of ids) out[id] = await boxOf(node(page, id));
  return out;
}

function expectShift(after: Box, before: Box, dx: number, dy: number, id: string, tol = 2) {
  expect(Math.abs(after.x - before.x - dx), `${id} x shift (got ${after.x - before.x}, want ${dx})`).toBeLessThanOrEqual(tol);
  expect(Math.abs(after.y - before.y - dy), `${id} y shift (got ${after.y - before.y}, want ${dy})`).toBeLessThanOrEqual(tol);
}

function expectUnmoved(after: Box, before: Box, id: string) {
  expectShift(after, before, 0, 0, id, 1)
}

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

/** Marquee that fully encloses t1..t3 and starts on empty pane (between the group and t1). */
async function marqueeFreeRow(page: Page) {
  const t1 = await boxOf(node(page, "t1"));
  const t3 = await boxOf(node(page, "t3"));
  await dragBy(
    page,
    { x: t1.x - t1.width * 0.25, y: t1.y - t1.height * 0.4 },
    t3.x + t3.width + t3.width * 0.25 - (t1.x - t1.width * 0.25),
    t3.y + t3.height + t3.height * 0.4 - (t1.y - t1.height * 0.4),
  );
}

async function openSeededCanvas(page: Page, base: string, name: string) {
  await page.goto(`${base}/docs`);
  await page.waitForLoadState("networkidle");
  await page.getByTestId("import-canvas-input").setInputFiles({
    name: `${name}.canvas`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(CANVAS)),
  });
  await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByTestId("canvas-doc-editor")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".react-flow__node")).toHaveCount(ALL_IDS.length, { timeout: 15_000 });
  // Phones open view-first (locked); unlock so the same editing flows apply.
  const unlock = page.getByRole("button", { name: "Unlock editing" });
  if (await unlock.count()) await unlock.click();
  await expect(page.getByRole("button", { name: "Lock editing" })).toBeVisible();
  // fitView animates/settles after mount; wait for geometry to stop moving.
  let prev = JSON.stringify(await positions(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const next = JSON.stringify(await positions(page));
    if (next === prev) break;
    prev = next;
  }
}

async function readExport(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .canvas" }).click();
  const download = await downloadPromise;
  return JSON.parse(fs.readFileSync((await download.path())!, "utf8")) as { nodes: Array<{ id: string; color?: string }> };
}

async function layoutProbe(page: Page) {
  const toolbar = page.getByRole("button", { name: "Add text card" }).locator('xpath=ancestor::div[contains(@class,"sticky")][1]');
  const surface = await boxOf(page.getByTestId("canvas-surface"));
  const headerBoxes: Box[] = [];
  const appHeader = page.locator("header");
  for (let i = 0; i < (await appHeader.count()); i++) {
    const b = await appHeader.nth(i).boundingBox();
    if (b) headerBoxes.push(b);
  }
  return {
    surface,
    toolbar: await boxOf(toolbar),
    title: await boxOf(page.getByLabel("Canvas title")),
    headerBoxes,
    doc: await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    })),
  };
}

function defineSuite(label: string, viewport: { width: number; height: number }) {
  test.describe(`Canvas multiselect @ ${label}`, () => {
    test.use({ viewport });

    test("1. marquee over empty canvas selects the cards it encloses", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-marquee-${label}`);
      await expect(selectedNodes(page)).toHaveCount(0);
      await expect(page.getByTestId("canvas-inspector")).toHaveCount(0);

      await marqueeFreeRow(page);

      await expect(selectedNodes(page)).toHaveCount(3);
      for (const id of ["t1", "t2", "t3"]) await expect(node(page, id)).toHaveClass(/selected/);
      for (const id of ["g", "f1", "f2"]) await expect(node(page, id)).not.toHaveClass(/selected/);
      await expect(page.getByRole("button", { name: "Delete 3 selected" })).toBeEnabled();
      await expect(page.getByTestId("canvas-selection-count")).toHaveText("3 selected");
      await expect(page.getByTestId("canvas-surface").getByTestId("canvas-inspector")).toBeVisible();

      // The bulk delete is one undoable step.
      await page.getByRole("button", { name: "Delete 3 selected" }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(3);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(6);
    });

    test("2. Shift-click and Ctrl/Cmd-click toggle a card in the selection", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-toggle-${label}`);
      await node(page, "t1").click();
      await expect(selectedNodes(page)).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Delete selection" })).toBeEnabled();

      await node(page, "t2").click({ modifiers: ["Shift"] });
      await expect(selectedNodes(page)).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Delete 2 selected" })).toBeEnabled();

      await node(page, "t3").click({ modifiers: ["ControlOrMeta"] });
      await expect(selectedNodes(page)).toHaveCount(3);

      // Toggling off removes just that card.
      await node(page, "t2").click({ modifiers: ["Shift"] });
      await expect(selectedNodes(page)).toHaveCount(2);
      await expect(node(page, "t2")).not.toHaveClass(/selected/);
      await node(page, "t1").click({ modifiers: ["ControlOrMeta"] });
      await expect(selectedNodes(page)).toHaveCount(1);
      await expect(node(page, "t3")).toHaveClass(/selected/);
      await expect(page.getByRole("button", { name: "Delete selection" })).toBeEnabled();
    });

    test("3. dragging one selected card moves all selected cards; one Undo restores them", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-drag-${label}`);
      await marqueeFreeRow(page);
      await expect(selectedNodes(page)).toHaveCount(3);
      // Baseline is taken after the marquee: on a phone the marquee ends near the viewport edge and
      // React Flow auto-pans, which legitimately shifts every card together.
      const before = await positions(page);

      const t2 = before.t2;
      // Drag left/down: dragging toward the right viewport edge triggers React Flow's auto-pan on phones.
      await dragBy(page, { x: t2.x + t2.width / 2, y: t2.y + t2.height / 2 }, -60, 40);

      // The pointer travels 60x40px, but the drag threshold/rounding swallows a few px,
      // so compare against the delta the dragged card actually moved.
      const moved = await positions(page);
      const dx = moved.t2.x - before.t2.x;
      const dy = moved.t2.y - before.t2.y;
      expect(dx, "dragged card moved left").toBeLessThan(-20);
      expect(dy, "dragged card moved down").toBeGreaterThan(10);
      for (const id of ["t1", "t2", "t3"]) expectShift(moved[id], before[id], dx, dy, id, 1.5);
      for (const id of ["g", "f1", "f2"]) expectUnmoved(moved[id], before[id], id);

      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(async () => {
          const now = await positions(page);
          return ALL_IDS.every((id) => Math.abs(now[id].x - before[id].x) <= 1 && Math.abs(now[id].y - before[id].y) <= 1);
        }, { message: "one Undo should restore every moved card to its original position" })
        .toBe(true);

      // Redo re-applies the whole move in one step too.
      // Redo via the toolbar button: after a keyboard Undo the selection clears and focus falls to <body>,
      // so a second keyboard shortcut is ignored (reported as an observation, not asserted here).
      await page.getByRole("button", { name: "Redo" }).click();
      await expect
        .poll(async () => {
          const now = await positions(page);
          return ["t1", "t2", "t3"].every((id) => Math.abs(now[id].x - before[id].x - dx) <= 2 && Math.abs(now[id].y - before[id].y - dy) <= 2);
        })
        .toBe(true);
    });

    test("4. bulk recolor through the floating inspector recolors every selected card", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-color-${label}`);

      // Give t1 a different color first so the selection starts mixed.
      await node(page, "t1").click();
      await page.getByTestId("canvas-surface").getByTestId("canvas-inspector").getByTestId("color-2").click();
      await page.keyboard.press("Escape");
      await expect(selectedNodes(page)).toHaveCount(0);

      await marqueeFreeRow(page);
      await expect(selectedNodes(page)).toHaveCount(3);
      const inspector = page.getByTestId("canvas-surface").getByTestId("canvas-inspector");
      await expect(inspector).toBeVisible();
      // Mixed colors: no swatch reports itself as active.
      for (const key of ["none", "1", "2", "3", "4", "5", "6"]) {
        await expect(inspector.getByTestId(`color-${key}`)).toHaveAttribute("aria-pressed", "false");
      }

      await inspector.getByTestId("color-5").click();
      await expect(inspector.getByTestId("color-5")).toHaveAttribute("aria-pressed", "true");
      let exported = await readExport(page);
      for (const id of ["t1", "t2", "t3"]) expect(exported.nodes.find((n) => n.id === id)?.color, `${id} color`).toBe("5");
      for (const id of ["g", "f1", "f2"]) expect(exported.nodes.find((n) => n.id === id)?.color, `${id} color`).toBeUndefined();

      // Recolor is one undo step: t1 goes back to its own color, the others to none.
      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(async () => {
          const e = await readExport(page);
          return ["t1", "t2", "t3"].map((id) => e.nodes.find((n) => n.id === id)?.color ?? null);
        })
        .toEqual(["2", null, null]);

      // "No color" clears every selected card.
      await marqueeFreeRow(page);
      await expect(selectedNodes(page)).toHaveCount(3);
      await inspector.getByTestId("color-none").click();
      exported = await readExport(page);
      for (const id of ["t1", "t2", "t3"]) expect(exported.nodes.find((n) => n.id === id)?.color, `${id} color`).toBeUndefined();
    });

    test("5. Ctrl/Cmd+A selects everything and Escape clears the selection", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-all-${label}`);
      // Keyboard shortcuts live on the editor element, so focus must be inside it:
      // clicking a card provides that (clicking bare pane does not; see report).
      await node(page, "t1").click();
      await expect(selectedNodes(page)).toHaveCount(1);

      await page.keyboard.press("ControlOrMeta+A");
      await expect(selectedNodes(page)).toHaveCount(6);
      await expect(page.getByRole("button", { name: "Delete 6 selected" })).toBeEnabled();
      await expect(page.getByTestId("canvas-selection-count")).toHaveText("6 selected");

      await page.keyboard.press("Escape");
      await expect(selectedNodes(page)).toHaveCount(0);
      await expect(page.getByTestId("canvas-inspector")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete selection" })).toBeDisabled();
    });

    test("6. selecting never shifts the layout, and the inspector floats inside the canvas", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-layout-${label}`);
      const before = await layoutProbe(page);

      // Marquee selection.
      await marqueeFreeRow(page);
      await expect(selectedNodes(page)).toHaveCount(3);
      const inspector = page.getByTestId("canvas-surface").getByTestId("canvas-inspector");
      await expect(inspector).toBeVisible();
      const during = await layoutProbe(page);
      expect(during, "layout while 3 cards are selected").toEqual(before);

      const surface = await boxOf(page.getByTestId("canvas-surface"));
      const inspectorBox = await boxOf(inspector);
      expect(inspectorBox.x, "inspector left edge").toBeGreaterThanOrEqual(surface.x - 0.5);
      expect(inspectorBox.y, "inspector top edge").toBeGreaterThanOrEqual(surface.y - 0.5);
      expect(inspectorBox.x + inspectorBox.width, "inspector right edge").toBeLessThanOrEqual(surface.x + surface.width + 0.5);
      expect(inspectorBox.y + inspectorBox.height, "inspector bottom edge").toBeLessThanOrEqual(surface.y + surface.height + 0.5);

      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/multiselect-selected-${label}.png` });

      // Single selection, select-all, then deselect: layout is identical throughout.
      await page.keyboard.press("Escape");
      await expect(selectedNodes(page)).toHaveCount(0);
      expect(await layoutProbe(page), "layout after Escape").toEqual(before);

      await node(page, "t1").click();
      await expect(inspector).toBeVisible();
      expect(await layoutProbe(page), "layout with one card selected").toEqual(before);

      await page.keyboard.press("ControlOrMeta+A");
      await expect(selectedNodes(page)).toHaveCount(6);
      expect(await layoutProbe(page), "layout with all cards selected").toEqual(before);

      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);
      expect(await layoutProbe(page), "layout after deselecting").toEqual(before);
    });

    test("7. Pan tool pans without selecting; Select tool marquee works again", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-pan-${label}`);
      const selectTool = page.getByRole("button", { name: /^Select tool/ });
      const panTool = page.getByRole("button", { name: /^Pan tool/ });
      await expect(selectTool).toHaveAttribute("aria-pressed", "true");
      await expect(panTool).toHaveAttribute("aria-pressed", "false");

      const start = await positions(page);
      const t1 = start.t1;
      const emptyPoint = { x: t1.x - t1.width * 0.25, y: t1.y - t1.height * 0.4 };

      // Select mode: dragging empty space draws a marquee and does not move the viewport.
      await dragBy(page, emptyPoint, 20, 20);
      for (const id of ALL_IDS) expectUnmoved((await positions(page, [id]))[id], start[id], id);

      await panTool.click();
      await expect(panTool).toHaveAttribute("aria-pressed", "true");
      await expect(selectTool).toHaveAttribute("aria-pressed", "false");
      await expect(selectedNodes(page)).toHaveCount(0);

      const dx = -36;
      const dy = 28;
      await dragBy(page, emptyPoint, dx, dy);
      const panned = await positions(page);
      for (const id of ALL_IDS) expectShift(panned[id], start[id], dx, dy, id);
      await expect(selectedNodes(page), "Pan drag must select nothing").toHaveCount(0);
      await expect(page.getByTestId("canvas-inspector")).toHaveCount(0);

      // A drag that would enclose t1..t3 as a marquee still only pans.
      const p1 = panned.t1;
      const p3 = panned.t3;
      await dragBy(page, { x: p1.x - p1.width * 0.25, y: p1.y - p1.height * 0.4 }, 0, 10);
      await expect(selectedNodes(page)).toHaveCount(0);
      void p3;

      await selectTool.click();
      await expect(selectTool).toHaveAttribute("aria-pressed", "true");
      const beforeMarquee = await positions(page);
      await marqueeFreeRow(page);
      await expect(selectedNodes(page)).toHaveCount(3);
      const afterMarquee = await positions(page);
      for (const id of ALL_IDS) expectUnmoved(afterMarquee[id], beforeMarquee[id], id);
    });

    test("8. regression: dragging a group carries the cards it frames", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-group-${label}`);
      const before = await positions(page);
      const g = before.g;

      // Grab the group on its empty bottom-left strip (below the framed cards, clear of the
      // bottom-center connection handle, which would start an edge instead of a drag).
      const dx = 44;
      const dy = 30;
      await dragBy(page, { x: g.x + g.width * 0.2, y: g.y + g.height * 0.93 }, dx, dy);

      const moved = await positions(page);
      // Compare against what the group itself moved (drag threshold/rounding swallows a few px).
      const gdx = moved.g.x - before.g.x;
      const gdy = moved.g.y - before.g.y;
      expect(gdx, "group moved right").toBeGreaterThan(dx * 0.5 * (g.width / 300));
      expect(gdy, "group moved down").toBeGreaterThan(0);
      for (const id of ["g", "f1", "f2"]) expectShift(moved[id], before[id], gdx, gdy, id, 1.5);
      for (const id of ["t1", "t2", "t3"]) expectUnmoved(moved[id], before[id], id);

      await page.keyboard.press("ControlOrMeta+Z");
      await expect
        .poll(async () => {
          const now = await positions(page);
          return ALL_IDS.every((id) => Math.abs(now[id].x - before[id].x) <= 1 && Math.abs(now[id].y - before[id].y) <= 1);
        }, { message: "one Undo should put the group and its framed cards back" })
        .toBe(true);
    });

    test("9. select-all then drag moves each card exactly once (group members are not double-moved)", async ({ page, base }) => {
      await openSeededCanvas(page, base, `qa-multiselect-allgroup-${label}`);
      const before = await positions(page);
      await node(page, "t1").click();
      await page.keyboard.press("ControlOrMeta+A");
      await expect(selectedNodes(page)).toHaveCount(6);

      const t2 = before.t2;
      await dragBy(page, { x: t2.x + t2.width / 2, y: t2.y + t2.height / 2 }, -60, 40);
      const moved = await positions(page);
      const dx = moved.t2.x - before.t2.x;
      const dy = moved.t2.y - before.t2.y;
      expect(dx, "dragged card moved left").toBeLessThan(-20);
      for (const id of ALL_IDS) expectShift(moved[id], before[id], dx, dy, id, 1.5);
    });
  });
}

defineSuite("1280x800", { width: 1280, height: 800 });
defineSuite("390x844", { width: 390, height: 844 });
