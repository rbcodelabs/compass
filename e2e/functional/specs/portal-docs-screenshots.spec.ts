/**
 * Design-review screenshots for Publish Docs, regenerated only on request:
 *   pnpm build:e2e && PORTAL_DOCS_SCREENSHOTS=<output dir> pnpm test:e2e:functional -- e2e/functional/specs/portal-docs-screenshots.spec.ts
 * Captures the editor publish control (published / not), the Docs widget (populated / empty-state surfaces) and the public
 * doc page at 1440 and 390 wide, light and dark. Skipped in normal runs.
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "../fixtures/index";
import getPrisma from "../../../lib/db";

const outDir = process.env.PORTAL_DOCS_SCREENSHOTS;
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }] as const;
const SCHEMES = ["light", "dark"] as const;

const BODY = `Welcome to the guide. This page walks you from a blank account to your first vote in about five minutes.

## 1. Create your account

Open the portal and choose **Sign in**. Use your work email; we send a one-time link so there is no password to remember. Links expire after \`15 minutes\`.

## 2. Subscribe to boards

Each product area has its own board. Subscribe to the ones you care about and we will send a weekly digest of what moved.

- Pick up to five boards on your profile page.
- Switch digests between weekly and instant at any time.
- Unsubscribe from the footer of any email.

> Tip: boards you subscribe to are pinned to the top of the roadmap.

## 3. Vote and comment

| Action | Where |
| --- | --- |
| Vote | Any roadmap card |
| Comment | The card detail |

\`\`\`
GET /api/portal/votes
\`\`\`
`;

test.skip(!outDir, "set PORTAL_DOCS_SCREENSHOTS=<dir> to capture");

test("portal docs screenshots", async ({ page, base, orgSlug, workspaceSlug, browser, baseURL }) => {
  test.setTimeout(300_000);
  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } });
  fs.mkdirSync(outDir!, { recursive: true });
  const ts = Date.now();
  const homeUrl = `/portal/${orgSlug}/${workspaceSlug}`;
  const homeApi = `/api/portal-home/${orgSlug}/${workspaceSlug}`;
  const titles = [`Getting started with Acme Roadmap ${ts}`, `Voting and comments ${ts}`, `Release notes and changelog ${ts}`, `Integrations overview ${ts}`];
  const docs = [];
  for (const [index, title] of titles.entries()) {
    docs.push(await prisma.doc.create({ data: { workspaceId: workspace.id, title, content: index === 0 ? BODY : `${titles[index]} explains how the feature works, who can use it, and the common questions we hear. ${BODY.slice(0, 160)}` } }));
  }
  const shot = async (p: import("@playwright/test").Page, name: string, viewport: (typeof VIEWPORTS)[number], scheme: string, opts: { full?: boolean } = {}) => {
    await p.screenshot({ path: path.join(outDir!, `${name}-${viewport.name}-${scheme}.png`), fullPage: opts.full ?? false });
  };
  const publish = async (docId: string, published: boolean) => {
    const res = await page.request.post(`/api/docs/${docId}/publish`, { data: { published } });
    if (!res.ok()) throw new Error(`publish failed ${res.status()}`);
  };
  const anon = await browser.newContext({ storageState: undefined });
  const anonPage = await anon.newPage();
  const current = await (await page.request.get(homeApi)).json();
  const originalDraft = current.draft;
  try {
    // Editor publish control: unpublished then published
    for (const state of ["unpublished", "published"] as const) {
      await publish(docs[0].id, state === "published");
      for (const viewport of VIEWPORTS) for (const scheme of SCHEMES) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${base}/docs/${docs[0].id}`);
        await page.waitForLoadState("networkidle");
        await page.getByTestId("doc-publish-control").waitFor();
        await shot(page, `editor-publish-${state}`, viewport, scheme);
      }
    }
    // Popover open (published, desktop light)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${base}/docs/${docs[0].id}`);
    await page.getByRole("button", { name: "About publishing" }).click();
    await page.waitForTimeout(300);
    await shot(page, "editor-publish-popover", VIEWPORTS[0], "light");

    // Docs widget populated: publish several, add a size-L docs widget
    for (const doc of docs.slice(1)) await publish(doc.id, true);
    const widget = { id: `shot-docs-${ts}`, type: "docs", size: "L", order: current.draft.length, visibility: "everyone", config: { heading: "Docs", maxItems: 6, mode: "all", docIds: [] } };
    await page.request.put(homeApi, { data: { widgets: [...current.draft, widget] } });
    await page.request.post(`${homeApi}/publish`);
    for (const viewport of VIEWPORTS) for (const scheme of SCHEMES) {
      await anonPage.setViewportSize({ width: viewport.width, height: viewport.height });
      await anonPage.emulateMedia({ colorScheme: scheme });
      await anonPage.goto(`${baseURL}${homeUrl}`);
      await anonPage.waitForLoadState("networkidle");
      await anonPage.locator('section[data-widget-type="docs"]').first().scrollIntoViewIfNeeded();
      await anonPage.locator('section[data-widget-type="docs"]').first().screenshot({ path: path.join(outDir!, `docs-widget-populated-${viewport.name}-${scheme}.png`) });
      await anonPage.goto(`${baseURL}${homeUrl}/docs`);
      await shot(anonPage, "docs-index", viewport, scheme);
      await anonPage.goto(`${baseURL}${homeUrl}/docs/${docs[0].id}`);
      await anonPage.waitForLoadState("networkidle");
      await shot(anonPage, "public-doc", viewport, scheme, { full: true });
    }

    // Empty: nothing published. The customer home omits the widget by design; the team home explains it, the index shows the empty state.
    for (const doc of docs) await publish(doc.id, false);
    for (const viewport of VIEWPORTS) for (const scheme of SCHEMES) {
      await anonPage.setViewportSize({ width: viewport.width, height: viewport.height });
      await anonPage.emulateMedia({ colorScheme: scheme });
      await anonPage.goto(`${baseURL}${homeUrl}/docs`);
      await shot(anonPage, "docs-index-empty", viewport, scheme);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${homeUrl}`);
      await page.waitForLoadState("networkidle");
      await shot(page, "docs-widget-empty-team-home", viewport, scheme, { full: true });
    }
  } finally {
    await anon.close();
    await page.request.put(homeApi, { data: { widgets: originalDraft } });
    await page.request.post(`${homeApi}/publish`);
    await prisma.doc.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  }
});
