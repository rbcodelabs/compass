import { test, expect } from "../fixtures/index";
import getPrisma from "../../../lib/db";

test("unified Library keeps search and filters reachable for long collections on desktop and mobile", async ({ page, base }) => {
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: "e2e-workspace", organization: { slug: "e2e-test-org" } } });
  const prefix = `Library ${Date.now()}`;
  const docs: Array<{ id: string; title: string }> = [];
  let diagram: { id: string; title: string } | undefined;
  let artifact: { id: string; title: string } | undefined;
  try {
  for (let index = 0; index < 50; index++) docs.push(await prisma.doc.create({ data: {
    workspaceId: workspace.id, title: `${prefix} notes ${String(index).padStart(2, "0")}`, content: "Synthetic library notes", sortOrder: index,
  } }));
  diagram = await prisma.doc.create({ data: { workspaceId: workspace.id, title: `${prefix} diagram`, docType: "CANVAS", parentId: docs[0].id, content: '{"nodes":[],"edges":[]}' } });
  artifact = await prisma.artifact.create({ data: { workspaceId: workspace.id, title: `${prefix} prototype`, sourceType: "EXTERNAL_LINK" } });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/docs/${docs[0].id}`);
      // The Library is the agent rail's Library view; the Docs header button opens it
      // (docked on wide screens, an overlay drawer on narrow ones).
      await page.getByRole("button", { name: "Show library" }).click();
      const library = page.getByTestId("rail-library").getByRole("navigation", { name: "Library" });
      await expect(library.getByRole("link", { name: artifact.title, exact: true })).toBeVisible();
      const search = library.getByRole("textbox", { name: "Find in library" });
      const before = await search.boundingBox();
      const scroll = library.getByTestId("library-scroll");
      expect(await scroll.evaluate(element => element.clientHeight)).toBeGreaterThan(0);
      expect(await library.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      expect(await search.boundingBox()).toEqual(before);
      await expect(library.getByRole("button", { name: "Artifacts", exact: true })).toBeVisible();
      await library.getByRole("button", { name: "Diagrams", exact: true }).click();
      await expect(library.getByRole("link", { name: diagram.title, exact: true })).toBeVisible();
      await expect(library.getByRole("link", { name: docs[0].title, exact: true })).toBeVisible();
      await library.getByRole("button", { name: "All", exact: true }).click();
      await search.fill("prototype");
      await expect(library.getByRole("link", { name: artifact.title, exact: true })).toBeVisible();
      await search.fill("");
      await scroll.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: `public/screenshots/docs/docs-library-${viewport.width < 768 ? "mobile" : "desktop"}.png` });
    }
  } finally {
    if (diagram) await prisma.doc.delete({ where: { id: diagram.id } });
    await prisma.doc.deleteMany({ where: { id: { in: docs.map(doc => doc.id) } } });
    if (artifact) await prisma.artifact.delete({ where: { id: artifact.id } });
  }
});
