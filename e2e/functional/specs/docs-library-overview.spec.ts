import { test, expect } from "../fixtures/index";
import getPrisma from "../../../lib/db";

/**
 * The Docs index is a Library overview (not a redirect to the first doc), with By type and Recent views, and a doc's type can be set
 * from its properties. Named docs-library-overview: docs-library.spec.ts already covers the rail's Library pane.
 *
 * Seeded docs carry an updatedAt an hour in the future so they lead the Recent list however many other specs have written docs.
 */
test.describe("Docs library overview", () => {
  const stamp = Date.now();
  const names = {
    adr: `Overview ADR ${stamp}`,
    qa: `Overview QA ${stamp}`,
    untyped: `Overview untyped ${stamp}`,
  };
  const ids: Record<keyof typeof names, string> = { adr: "", qa: "", untyped: "" };

  test.beforeAll(async () => {
    const prisma = getPrisma();
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "e2e-workspace", organization: { slug: "e2e-test-org" } } });
    const future = (minutes: number) => new Date(Date.now() + 3_600_000 + minutes * 60_000);
    const make = (title: string, kind: string | null, minutes: number) =>
      prisma.doc.create({ data: { workspaceId: workspace.id, title, content: "Library overview fixture", kind, updatedAt: future(minutes) } });
    ids.adr = (await make(names.adr, "ADR", 3)).id;
    ids.qa = (await make(names.qa, "QA_REPORT", 2)).id;
    ids.untyped = (await make(names.untyped, null, 1)).id;
  });

  test.afterAll(async () => {
    const prisma = getPrisma();
    const docIds = Object.values(ids).filter(Boolean);
    await prisma.docVersion.deleteMany({ where: { docId: { in: docIds } } });
    await prisma.doc.deleteMany({ where: { id: { in: docIds } } });
  });

  test("shows the overview at /docs without redirecting, with counts per type and the latest docs", async ({ page, base }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/docs`);
    await expect(page).toHaveURL(new RegExp(`${base}/docs$`));
    await expect(page.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();

    for (const kind of ["ADR", "QA_REPORT", "DESIGN", "NOTE", "none"]) await expect(page.getByTestId(`library-kind-count-${kind}`)).toBeVisible();
    await expect(page.getByTestId("library-kind-count-ADR")).toContainText("ADR");
    await expect(page.getByTestId("library-kind-count-QA_REPORT")).toContainText("QA report");
    await expect(page.getByTestId("library-kind-count-none")).toContainText("No type");
    expect(Number((await page.getByTestId("library-kind-count-ADR").getAttribute("data-count")) ?? "0")).toBeGreaterThanOrEqual(1);

    const latest = page.getByTestId("library-latest");
    await expect(latest.getByRole("link", { name: names.adr })).toBeVisible();
    await expect(latest.getByRole("link", { name: names.untyped })).toBeVisible();
    expect(await latest.getByRole("link").count()).toBeLessThanOrEqual(8);
    await latest.getByRole("link", { name: names.adr }).click();
    await expect(page).toHaveURL(new RegExp(`/docs/${ids.adr}$`));
  });

  test("switches to By type and Recent, and files an untyped doc under No type", async ({ page, base }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/docs`);

    await page.getByRole("tab", { name: "By type" }).click();
    await expect(page).toHaveURL(/view=by-type/);
    await expect(page.getByTestId("library-group-ADR").getByRole("link", { name: names.adr })).toBeVisible();
    await expect(page.getByTestId("library-group-QA_REPORT").getByRole("link", { name: names.qa })).toBeVisible();
    await expect(page.getByTestId("library-group-none").getByRole("link", { name: names.untyped })).toBeVisible();
    await expect(page.getByTestId("library-group-ADR").getByRole("link", { name: names.untyped })).toHaveCount(0);
    // No type is listed after every typed group.
    const groups = await page.locator('[data-testid^="library-group-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    expect(groups[groups.length - 1]).toBe("library-group-none");

    await page.getByRole("tab", { name: "Recent" }).click();
    await expect(page).toHaveURL(/view=recent/);
    const titles = await page.getByTestId("library-recent-list").getByRole("link").allTextContents();
    expect(titles.length).toBeLessThanOrEqual(50);
    const position = (name: string) => titles.findIndex((title) => title.includes(name));
    expect(position(names.adr)).toBeGreaterThanOrEqual(0);
    expect(position(names.adr)).toBeLessThan(position(names.qa));
    expect(position(names.qa)).toBeLessThan(position(names.untyped));

    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByTestId("library-latest")).toBeVisible();
  });

  test("setting a type in the doc's properties persists after reload, then moves the doc between groups", async ({ page, base }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/docs/${ids.untyped}`);
    await page.getByRole("button", { name: /^Properties/ }).click();
    const select = page.getByTestId("doc-kind-select");
    await expect(select).toHaveValue("");
    await select.selectOption("DESIGN");
    await expect(page.getByTestId("doc-save-status")).toHaveAttribute("data-state", "saved");

    await page.reload();
    await page.getByRole("button", { name: /^Properties/ }).click();
    await expect(page.getByTestId("doc-kind-select")).toHaveValue("DESIGN");

    await page.goto(`${base}/docs?view=by-type`);
    await expect(page.getByTestId("library-group-DESIGN").getByRole("link", { name: names.untyped })).toBeVisible();
    await expect(page.getByTestId("library-group-none").getByRole("link", { name: names.untyped })).toHaveCount(0);

    // Clearing the type puts it back under No type.
    await page.goto(`${base}/docs/${ids.untyped}`);
    await page.getByRole("button", { name: /^Properties/ }).click();
    await page.getByTestId("doc-kind-select").selectOption("");
    await expect(page.getByTestId("doc-save-status")).toHaveAttribute("data-state", "saved");
    await page.goto(`${base}/docs?view=by-type`);
    await expect(page.getByTestId("library-group-none").getByRole("link", { name: names.untyped })).toBeVisible();
  });

  test("scrolls instead of squashing at phone width, in every view", async ({ page, base }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ["", "?view=by-type", "?view=recent"]) {
      await page.goto(`${base}/docs${view}`);
      await expect(page.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow of the page at ${view || "overview"}`).toBeLessThanOrEqual(1);
    }
    await page.goto(`${base}/docs?view=recent`);
    const row = page.getByTestId("library-recent-list").getByRole("link", { name: names.adr });
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(150);
  });
});
