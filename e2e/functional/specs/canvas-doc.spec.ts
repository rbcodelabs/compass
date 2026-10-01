/**
 * JSON Canvas doc functional spec.
 *
 * Journey: create a blank Canvas doc -> add text/link/group cards -> edit the
 * text -> drag a card -> connect an edge between two cards -> color a card ->
 * autosave -> reload (persisted) -> export a .canvas file and validate it.
 * Second test: import a .canvas file carrying unknown fields and confirm they
 * survive an export (interoperability with Obsidian/Geode).
 *
 * Self-seeding: creates its own docs through the UI.
 */
import fs from "node:fs";
import { test, expect } from "../fixtures/index";
import getPrisma from "../../../lib/db";
import type { Page } from "@playwright/test";

const isActionPost = (response: import("@playwright/test").Response) =>
  response.request().method() === "POST" &&
  response.request().headers()["next-action"] !== undefined &&
  response.ok();

async function readExport(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .canvas" }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  return { name: download.suggestedFilename(), json: JSON.parse(fs.readFileSync(filePath!, "utf8")) };
}

async function center(locator: import("@playwright/test").Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("JSON Canvas doc", () => {
  test("create -> edit -> autosave -> reload -> export", async ({ page, base }) => {
    const ts = Date.now();
    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");

    // ── Create a blank canvas from the Canvas menu ────────────────────────────
    await page.getByTestId("new-canvas-menu").click();
    await page.getByRole("menuitem", { name: "Blank canvas" }).click();
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });
    const editor = page.getByTestId("canvas-doc-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    // ── Add a text card and edit its markdown ────────────────────────────────
    await page.getByRole("button", { name: "Add text card" }).click();
    const textarea = page.getByLabel("Edit text (markdown)");
    await expect(textarea).toBeVisible();
    await textarea.fill(`# Heading ${ts}\n\n**bold** body`);
    await textarea.press("ControlOrMeta+Enter");
    const textNode = page.getByTestId("canvas-node-text");
    await expect(textNode.locator("h1")).toContainText(`Heading ${ts}`);

    // ── Add a link card and a group ──────────────────────────────────────────
    await page.getByRole("button", { name: "Add link card" }).click();
    await expect(page.getByTestId("canvas-node-link")).toBeVisible();
    await page.getByLabel("Edit link URL").fill("https://example.com/canvas");
    await page.getByLabel("Edit link URL").press("Enter");
    await expect(page.getByTestId("canvas-node-link")).toContainText("example.com");
    await page.getByRole("button", { name: "Add group" }).click();
    await expect(page.getByTestId("canvas-node-group")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);

    // ── Drag the link card away from the text card ───────────────────────────
    const linkNode = page.getByTestId("canvas-node-link");
    const from = await center(linkNode);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 60, from.y + 170, { steps: 8 });
    await page.mouse.up();

    // ── Connect text -> link with an edge using explicit sides ───────────────
    await textNode.hover();
    const source = await center(textNode.getByTestId("handle-bottom"));
    await linkNode.hover();
    const target = await center(linkNode.getByTestId("handle-top"));
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    // ── Color the text card (preset 4) ───────────────────────────────────────
    await textNode.locator("h1").click();
    await page.getByTestId("color-4").click();

    // ── Autosave through the doc update path, then reload ────────────────────
    await page.waitForResponse(isActionPost, { timeout: 15_000 });
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.getByTestId("canvas-node-text").locator("h1")).toContainText(`Heading ${ts}`);

    // ── Export: valid JSON Canvas with what we built ─────────────────────────
    const { name, json } = await readExport(page);
    expect(name).toMatch(/\.canvas$/);
    expect(json.nodes).toHaveLength(3);
    expect(json.nodes.map((n: { type: string }) => n.type).sort()).toEqual(["group", "link", "text"]);
    const text = json.nodes.find((n: { type: string }) => n.type === "text");
    expect(text.color).toBe("4");
    expect(text.text).toContain(`Heading ${ts}`);
    expect(json.nodes.find((n: { type: string }) => n.type === "link").url).toBe("https://example.com/canvas");
    expect(json.edges).toHaveLength(1);
    expect(json.edges[0]).toMatchObject({ fromNode: text.id, fromSide: "bottom", toSide: "top" });

    // ── Delete, then undo / redo ─────────────────────────────────────────────
    await page.getByTestId("canvas-node-group").locator("span").click();
    await page.getByRole("button", { name: "Delete selection" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
  });

  test("import preserves unknown fields on export", async ({ page, base }) => {
    const imported = {
      metadata: { frontmatter: { keep: true } },
      nodes: [
        { id: "aaaa", type: "text", x: 0, y: 0, width: 240, height: 100, text: "hello import", color: "#ff8800", styleAttributes: { textAlign: "center" } },
        { id: "bbbb", type: "file", x: 400, y: 0, width: 240, height: 80, file: "notes/plan.md", subpath: "#intro" },
      ],
      edges: [{ id: "cccc", fromNode: "aaaa", toNode: "bbbb", label: "relates", futureField: 42 }],
    };

    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-canvas-input").setInputFiles({
      name: "imported-board.canvas",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });
    await expect(page.getByLabel("Canvas title")).toHaveValue("imported-board", { timeout: 15_000 });
    await expect(page.getByTestId("canvas-node-text")).toContainText("hello import");
    // File nodes render as labeled cards (not resolved against Compass docs).
    await expect(page.getByTestId("canvas-node-file")).toContainText("plan.md");

    const { json } = await readExport(page);
    expect(json.metadata).toEqual(imported.metadata);
    expect(json.nodes[0]).toMatchObject({ id: "aaaa", color: "#ff8800", styleAttributes: { textAlign: "center" } });
    expect(json.nodes[1]).toMatchObject({ id: "bbbb", file: "notes/plan.md", subpath: "#intro" });
    expect(json.edges[0]).toMatchObject({ id: "cccc", label: "relates", futureField: 42 });
    // Sides were never chosen, so they must not be invented on export.
    expect(json.edges[0].fromSide).toBeUndefined();
  });

  test("rejects an invalid .canvas file with a clear message", async ({ page, base }) => {
    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-canvas-input").setInputFiles({
      name: "bad.canvas",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ nodes: [{ id: "x", type: "sticky" }] })),
    });
    await expect(page.getByText("Not a valid .canvas file")).toContainText("type must be one of");
    await expect(page).toHaveURL(/\/docs(\/[0-9a-f-]+)?$/);
  });

  test("Compass cards: add via picker -> live data -> persists -> export -> unavailable", async ({ page, base, workspaceSlug }) => {
    const prisma = getPrisma();
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug } });
    const suffix = Date.now().toString();
    const opportunity = await prisma.opportunity.create({
      data: { workspaceId: workspace.id, title: `Canvas card opp ${suffix}`, status: "VALIDATED" },
    });
    const solution = await prisma.solution.create({
      data: { workspaceId: workspace.id, opportunityId: opportunity.id, title: `Canvas card sol ${suffix}` },
    });

    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("new-canvas-menu").click();
    await page.getByRole("menuitem", { name: "Blank canvas" }).click();
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });
    await expect(page.getByTestId("canvas-doc-editor")).toBeVisible({ timeout: 15_000 });
    const docId = page.url().split("/").pop()!;

    // ── Add an opportunity card through the picker ───────────────────────────
    await page.getByRole("button", { name: "Add Compass card" }).click();
    await page.getByLabel("Search Compass objects").fill(`Canvas card opp ${suffix}`);
    await page.getByTestId("canvas-card-results").getByRole("button", { name: new RegExp(`Canvas card opp ${suffix}`) }).click();
    const oppCard = page.getByTestId("compass-card").filter({ hasText: `Canvas card opp ${suffix}` });
    await expect(oppCard).toBeVisible({ timeout: 15_000 });
    // Live data from the server, not just the cached title.
    await expect(oppCard).toHaveAttribute("data-card-state", "live", { timeout: 15_000 });
    await expect(oppCard).toContainText("VALIDATED");

    // ── Add a solution card; dragging a tree page onto the canvas also adds a card ──
    await page.getByRole("button", { name: "Add Compass card" }).click();
    await page.getByLabel("Search Compass objects").fill(`Canvas card sol ${suffix}`);
    await page.getByTestId("canvas-card-results").getByRole("button", { name: new RegExp(`Canvas card sol ${suffix}`) }).click();
    await expect(page.getByTestId("compass-card").filter({ hasText: `Canvas card sol ${suffix}` })).toBeVisible({ timeout: 15_000 });

    await page.locator(`a[href$="/docs/${docId}"]`).first().dragTo(page.getByTestId("canvas-surface"), { targetPosition: { x: 120, y: 120 } });
    await expect(page.getByTestId("compass-card")).toHaveCount(3, { timeout: 15_000 });

    // ── Autosave, reload, still live ─────────────────────────────────────────
    await page.waitForResponse(isActionPost, { timeout: 15_000 });
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("compass-card")).toHaveCount(3, { timeout: 15_000 });
    // (the solution card also mentions its opportunity, so take the first match)
    await expect(page.getByTestId("compass-card").filter({ hasText: `Canvas card opp ${suffix}` }).first()).toHaveAttribute("data-card-state", "live", { timeout: 15_000 });

    // ── Export is valid JSON Canvas: plain link nodes + namespaced compass field ──
    const { json } = await readExport(page);
    expect(json.nodes).toHaveLength(3);
    const exported = json.nodes.find((n: { compass?: { id: string } }) => n.compass?.id === opportunity.id);
    expect(exported).toMatchObject({
      type: "link",
      url: `compass://opportunity/${opportunity.id}`,
      compass: { kind: "opportunity", id: opportunity.id, title: `Canvas card opp ${suffix}` },
    });
    for (const node of json.nodes) expect(node.type).toBe("link");

    // ── Deleting the object degrades the card to a safe unavailable state ─────
    await prisma.solution.delete({ where: { id: solution.id } });
    await prisma.opportunity.delete({ where: { id: opportunity.id } });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("compass-card-unavailable")).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId("canvas-surface")).not.toContainText(`Canvas card opp ${suffix}`);
    await expect(page.getByTestId("canvas-surface")).not.toContainText(`Canvas card sol ${suffix}`);
  });

  test("imported cards: unknown objects are unavailable, invalid refs degrade to plain links", async ({ page, base }) => {
    const missing = "11111111-2222-4333-8444-555555555555";
    const imported = {
      nodes: [
        { id: "k1", type: "link", x: 0, y: 0, width: 280, height: 120, url: `compass://task/${missing}`, compass: { kind: "task", id: missing, title: "Secret title" } },
        { id: "k2", type: "link", x: 400, y: 0, width: 280, height: 90, url: "https://example.com/plain", compass: { kind: "bogus", id: missing } },
      ],
      edges: [],
    };
    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("import-canvas-input").setInputFiles({ name: "cards.canvas", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await page.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 15_000 });

    await expect(page.getByTestId("compass-card-unavailable")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("canvas-surface")).not.toContainText("Secret title");
    // The invalid reference degraded to an ordinary link card.
    await expect(page.getByTestId("canvas-node-link").filter({ hasText: "example.com" })).toBeVisible();

    const { json } = await readExport(page);
    expect(json.nodes[0].compass).toEqual({ kind: "task", id: missing, title: "Secret title" });
    expect(json.nodes[1].compass).toBeUndefined();
    expect(json.nodes[1].url).toBe("https://example.com/plain");
  });
});
