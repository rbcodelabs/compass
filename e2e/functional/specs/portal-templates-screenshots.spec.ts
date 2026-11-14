/**
 * Design-review screenshots for the four Portal Home templates, regenerated only on request:
 *   pnpm build:e2e && PORTAL_TEMPLATE_SCREENSHOTS=<output dir> pnpm test:e2e:functional -- e2e/functional/specs/portal-templates-screenshots.spec.ts
 * Seeds public roadmap items and four published docs, publishes a representative home in each template and
 * captures the customer's full page at 1440 and 390 wide, light and dark. Restores everything it touches.
 * Skipped in normal runs.
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "../fixtures/index";
import getPrisma from "../../../lib/db";

const outDir = process.env.PORTAL_TEMPLATE_SCREENSHOTS;
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }] as const;
const SCHEMES = ["light", "dark"] as const;
const TEMPLATES = ["editorial", "bento", "shell", "docs_hub"] as const;

test.skip(!outDir, "set PORTAL_TEMPLATE_SCREENSHOTS=<dir> to capture");

test("portal template screenshots", async ({ page, orgSlug, workspaceSlug, browser, baseURL }) => {
  test.setTimeout(600_000);
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } });
  fs.mkdirSync(outDir!, { recursive: true });
  const ts = Date.now();
  const homeUrl = `/portal/${orgSlug}/${workspaceSlug}`;
  const homeApi = `/api/portal-home/${orgSlug}/${workspaceSlug}`;
  const before = { roadmapPublic: workspace.roadmapPublic, feedbackEnabled: workspace.feedbackEnabled, portalAuthRequired: workspace.portalAuthRequired };
  await prisma.workspace.update({ where: { id: workspace.id }, data: { roadmapPublic: true, feedbackEnabled: true, portalAuthRequired: false } });

  const docTitles = [`Getting started with Acme ${ts}`, `How we prioritize ${ts}`, `API and webhooks guide ${ts}`, `Release notes policy ${ts}`];
  const docs = [];
  for (const title of docTitles) {
    docs.push(await prisma.doc.create({ data: { workspaceId: workspace.id, title, content: `${title} A short guide. ${title} explains how this works in practice.`, publishedAt: new Date() } }));
  }
  const items = [];
  for (const [title, horizon] of [["Single sign-on for teams", "NOW"], ["Faster dashboard loading", "NOW"], ["Slack notifications", "NOW"], ["CSV import", "SHIPPED"], ["Dark mode", "SHIPPED"]] as const) {
    items.push(await prisma.roadmapItem.create({ data: { workspaceId: workspace.id, title: `${title} ${ts}`, horizon, isPrivate: false } }));
  }

  const widgets = [
    { id: `shot-ann-${ts}`, type: "announcement", size: "L", order: 0, visibility: "everyone", config: { eyebrow: "New", headline: "Docs now live on the portal", body: "Our product team can now publish guides straight to this page. Start with the getting-started tour, then dig into how we prioritize.", primaryCta: { label: "Browse docs", url: `${homeUrl}/docs` }, secondaryCta: null } },
    { id: `shot-docs-${ts}`, type: "docs", size: "L", order: 1, visibility: "everyone", config: { heading: "Docs", maxItems: 4, mode: "all", docIds: [] } },
    { id: `shot-links-${ts}`, type: "key_links", size: "S", order: 2, visibility: "everyone", config: { title: "Key links", links: [{ kind: "url", label: "Product changelog", url: "https://example.com/changelog" }, { kind: "url", label: "System status", url: "https://example.com/status" }] } },
    { id: `shot-road-${ts}`, type: "roadmap_spotlight", size: "M", order: 3, visibility: "everyone", config: { title: "On the roadmap", itemIds: [], show: "status" } },
    { id: `shot-recent-${ts}`, type: "recent_updates", size: "M", order: 4, visibility: "everyone", config: { title: "Recently shipped", limit: 4 } },
    { id: `shot-fb-${ts}`, type: "feedback_cta", size: "S", order: 5, visibility: "everyone", config: { title: "Missing something?", description: "Tell us what would make Acme better.", buttonLabel: "Share feedback", showTopIdeas: false } },
  ];

  const anon = await browser.newContext({ storageState: undefined });
  const anonPage = await anon.newPage();
  const original = await (await page.request.get(homeApi)).json();
  try {
    for (const template of TEMPLATES) {
      const put = await page.request.put(homeApi, { data: { widgets, template } });
      if (!put.ok()) throw new Error(`save failed ${put.status()} ${await put.text()}`);
      if (!(await page.request.post(`${homeApi}/publish`)).ok()) throw new Error("publish failed");
      for (const viewport of VIEWPORTS) for (const scheme of SCHEMES) {
        await anonPage.setViewportSize({ width: viewport.width, height: viewport.height });
        await anonPage.emulateMedia({ colorScheme: scheme });
        await anonPage.goto(`${baseURL}${homeUrl}`);
        await anonPage.waitForLoadState("networkidle");
        await anonPage.screenshot({ path: path.join(outDir!, `${template}-${viewport.name}-${scheme}.png`), fullPage: true });
      }
    }
  } finally {
    await anon.close();
    await page.request.put(homeApi, { data: { widgets: original.draft, template: original.draftTemplate } });
    if (original.published !== null) await page.request.post(`${homeApi}/publish`);
    await prisma.doc.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
    await prisma.roadmapItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    await prisma.workspace.update({ where: { id: workspace.id }, data: before });
  }
});
