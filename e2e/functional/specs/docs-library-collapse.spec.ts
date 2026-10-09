import { test, expect } from "../fixtures/index";
import getPrisma from "../../../lib/db";

test("Library collapses away entirely, the expander sits beside the page title, and width + state survive reload", async ({ page, base }) => {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "e2e-workspace", organization: { slug: "e2e-test-org" } } });
  const title = `Collapse ${Date.now()}`;
  const doc = await prisma.doc.create({ data: { workspaceId: workspace.id, title, content: "Collapse test", sortOrder: 0 } });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/docs/${doc.id}`);

    const pane = page.getByTestId("library-pane");
    const expand = page.getByTestId("library-expand");
    await expect(pane).toBeVisible();
    await expect(expand).toHaveCount(0);

    // Resize from the keyboard, then confirm the width survives a reload.
    const handle = page.getByRole("separator", { name: "Resize library" });
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const grown = await pane.evaluate((el) => el.getBoundingClientRect().width);
    expect(grown).toBeGreaterThan(240);
    await page.reload();
    expect(await page.getByTestId("library-pane").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(grown, 0);

    // Collapse: the pane disappears completely (zero footprint, no rail).
    await page.getByRole("button", { name: "Collapse library" }).click();
    await expect(pane).toBeHidden();
    await expect(expand).toBeVisible();
    await expect(expand).toBeFocused();
    // The content area is the pane's next sibling; it must reach the row's left edge.
    const content = pane.locator("xpath=following-sibling::div[1]");
    const row = (await pane.locator("xpath=..").boundingBox())!;
    expect(Math.abs((await content.boundingBox())!.x - row.x)).toBeLessThanOrEqual(1);

    // The expander sits on the same row as the page title, to its left.
    const titleInput = page.locator(`input[value="${title}"]`);
    const expandBox = (await expand.boundingBox())!;
    const titleBox = (await titleInput.boundingBox())!;
    expect(expandBox.x + expandBox.width).toBeLessThanOrEqual(titleBox.x + 1);
    expect(Math.abs((expandBox.y + expandBox.height / 2) - (titleBox.y + titleBox.height / 2))).toBeLessThan(24);
    await page.screenshot({ path: "test-results/docs-library-collapsed.png" });

    // Collapsed state is server-rendered from the cookie: still gone after reload.
    await page.reload();
    await expect(page.getByTestId("library-pane")).toBeHidden();
    await expect(page.getByTestId("library-expand")).toBeVisible();

    // Expand restores the previous width.
    await page.getByTestId("library-expand").click();
    await expect(page.getByTestId("library-pane")).toBeVisible();
    await expect(page.getByTestId("library-expand")).toHaveCount(0);
    expect(await page.getByTestId("library-pane").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(grown, 0);
    await page.screenshot({ path: "test-results/docs-library-expanded.png" });

    // Mobile: no desktop pane, no expander (the Pages drawer owns navigation).
    await page.getByRole("button", { name: "Collapse library" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("library-pane")).toBeHidden();
    await expect(page.getByTestId("library-expand")).toBeHidden();
    await page.screenshot({ path: "test-results/docs-library-mobile.png" });
  } finally {
    await prisma.doc.delete({ where: { id: doc.id } });
  }
});

test("collapsed Library shows the expander beside the title on artifact, new-artifact and diagram pages", async ({ page, base }) => {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "e2e-workspace", organization: { slug: "e2e-test-org" } } });
  const stamp = Date.now();
  const artifact = await prisma.artifact.create({ data: { workspaceId: workspace.id, title: `Expander artifact ${stamp}`, sourceType: "EXTERNAL_LINK" } });
  const diagram = await prisma.doc.create({ data: { workspaceId: workspace.id, title: `Expander diagram ${stamp}`, docType: "CANVAS", content: '{"nodes":[],"edges":[]}' } });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/docs`);
    const origin = new URL(page.url()).origin;
    const collapseViaCookie = () => page.context().addCookies([{ name: "compass_docs_library", value: "1:260", url: origin }]);
    await collapseViaCookie();
    const cases = [
      { name: "artifact", path: `/docs/artifacts/${artifact.id}`, heading: page.getByRole("heading", { level: 1, name: artifact.title }) },
      { name: "new-artifact", path: "/docs/artifacts/new", heading: page.getByRole("heading", { level: 1, name: "New artifact" }) },
      { name: "diagram", path: `/docs/${diagram.id}`, heading: page.locator(`input[value="${diagram.title}"]`) },
    ];
    for (const c of cases) {
      await page.goto(`${base}${c.path}`);
      await expect(page.getByTestId("library-pane"), c.name).toBeHidden();
      const expand = page.getByTestId("library-expand");
      await expect(expand, c.name).toBeVisible();
      const e = (await expand.boundingBox())!;
      const h = (await c.heading.boundingBox())!;
      expect(e.x + e.width, `${c.name}: expander left of title`).toBeLessThanOrEqual(h.x + 1);
      expect(Math.abs(e.y + e.height / 2 - (h.y + h.height / 2)), `${c.name}: same row`).toBeLessThan(24);
      await page.screenshot({ path: `test-results/docs-library-expander-${c.name}.png` });
      await expand.click();
      await expect(page.getByTestId("library-pane"), c.name).toBeVisible();
      await collapseViaCookie();
    }
  } finally {
    await prisma.artifact.delete({ where: { id: artifact.id } });
    await prisma.doc.delete({ where: { id: diagram.id } });
  }
});
