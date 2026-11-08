/**
 * Publish Docs to the customer portal (functional journey).
 *
 *   1. A member opens a doc, sees the Publish control in its unpublished state, publishes it (green badge,
 *      "Copy public link" appears) and the copied link is the absolute portal URL.
 *   2. An anonymous customer opens /portal/<org>/<ws>/docs/<id> and sees the title and body; the docs index
 *      lists it; a Docs widget on the published home lists it and links to the doc.
 *   3. A second, never-published doc and a canvas doc are 404 for the customer and absent from index + widget.
 *   4. The member unpublishes: the customer immediately gets a 404, the index and widget drop it.
 *   5. A non-member session cannot publish through the API (404, nothing changes).
 */
import { test, expect } from "../fixtures/index";
import getPrisma from "../../../lib/db";

test.describe("Portal docs publishing", () => {
  test("member publishes and unpublishes; customers only ever see the published doc", async ({ page, base, orgSlug, workspaceSlug, browser, baseURL, context }) => {
    const prisma = getPrisma();
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { slug: workspaceSlug, organization: { slug: orgSlug } } });
    const ts = Date.now();
    const title = `E2E Published Guide ${ts}`;
    const secretTitle = `E2E Draft Secret ${ts}`;
    const body = `E2E body marker ${ts}`;
    const publicPath = (id: string) => `/portal/${orgSlug}/${workspaceSlug}/docs/${id}`;
    const homeUrl = `/portal/${orgSlug}/${workspaceSlug}`;
    const homeApi = `/api/portal-home/${orgSlug}/${workspaceSlug}`;

    const doc = await prisma.doc.create({ data: { workspaceId: workspace.id, title, content: `# ${title}\n\n${body}\n\n<script>window.__xss=1</script>` } });
    const secret = await prisma.doc.create({ data: { workspaceId: workspace.id, title: secretTitle, content: "never public" } });
    const canvas = await prisma.doc.create({ data: { workspaceId: workspace.id, title: `E2E Canvas ${ts}`, docType: "CANVAS", content: '{"nodes":[],"edges":[]}' } });
    const anon = await browser.newContext({ storageState: undefined });
    const anonPage = await anon.newPage();
    const widgetId = `e2e-docs-${ts}`;
    let originalDraft: unknown[] | null = null;

    try {
      // 1. Member publishes from the editor header
      await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
      await page.goto(`${base}/docs/${doc.id}`);
      await page.waitForLoadState("networkidle");
      const control = page.getByTestId("doc-publish-control");
      await expect(control).toBeVisible();
      await expect(page.getByTestId("doc-publish-badge")).toContainText("Not published");
      await expect(page.getByRole("button", { name: /copy public link/i })).toHaveCount(0);

      // Customer: 404 while unpublished
      expect((await anonPage.goto(`${baseURL}${publicPath(doc.id)}`))?.status()).toBe(404);

      // The switch is optimistic; wait for the server to confirm before anything that could abort the request.
      const toggleSwitch = async () => {
        const saved = page.waitForResponse((r) => r.url().includes(`/api/docs/${doc.id}/publish`) && r.request().method() === "POST");
        await page.getByRole("switch", { name: "Publish to portal" }).click();
        expect((await saved).status()).toBe(200);
      };
      await toggleSwitch();
      await expect(page.getByTestId("doc-publish-badge")).toContainText("Published to portal");
      await expect(page.getByRole("button", { name: /copy public link/i })).toBeVisible();
      await page.getByRole("button", { name: "About publishing" }).click();
      await expect(page.getByText("Visible to anyone with the portal link. Unpublishing removes it immediately.")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /copy public link/i }).click();
      await expect(page.getByText("Public link copied")).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      if (copied !== null) expect(copied).toBe(`${baseURL}${publicPath(doc.id)}`);
      // Survives a reload (server truth, not just optimistic state)
      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("doc-publish-badge")).toContainText("Published to portal");

      // 2. Customer sees it: page, index, widget
      const res = await anonPage.goto(`${baseURL}${publicPath(doc.id)}`);
      expect(res?.status()).toBe(200);
      await expect(anonPage.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(anonPage.getByText(body)).toBeVisible();
      await expect(anonPage.getByText(/^Published /)).toBeVisible();
      expect(await anonPage.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
      expect(await anonPage.content()).not.toContain("<script>window.__xss");
      await expect(anonPage.getByRole("link", { name: workspace.name, exact: true }).first()).toBeVisible();

      await anonPage.goto(`${baseURL}${homeUrl}/docs`);
      await expect(anonPage.getByRole("link", { name: new RegExp(title) })).toBeVisible();
      await expect(anonPage.getByText(secretTitle)).toHaveCount(0);

      const current = await (await page.request.get(homeApi)).json();
      originalDraft = current.draft;
      const docsWidget = { id: widgetId, type: "docs", size: "L", order: current.draft.length, visibility: "everyone", config: { heading: "E2E Docs", maxItems: 12, mode: "all", docIds: [] } };
      expect((await page.request.put(homeApi, { data: { widgets: [...current.draft, docsWidget] } })).ok()).toBe(true);
      expect((await page.request.post(`${homeApi}/publish`)).ok()).toBe(true);

      await anonPage.goto(`${baseURL}${homeUrl}`);
      const widget = anonPage.locator('section[data-widget-type="docs"]').filter({ hasText: "E2E Docs" });
      await expect(widget.getByRole("link", { name: new RegExp(title) })).toBeVisible();
      await widget.getByRole("link", { name: new RegExp(title) }).click();
      await expect(anonPage).toHaveURL(new RegExp(`${publicPath(doc.id)}$`));

      // The admin picker offers publishable docs only (no canvas), with published state
      const options = await (await page.request.get(`${homeApi}/options`)).json();
      expect(options.docs.find((d: { id: string }) => d.id === doc.id)?.isPublished).toBe(true);
      expect(options.docs.find((d: { id: string }) => d.id === secret.id)?.isPublished).toBe(false);
      expect(options.docs.find((d: { id: string }) => d.id === canvas.id)).toBeUndefined();

      // 3. Unpublished and canvas docs are 404 for customers
      expect((await anonPage.goto(`${baseURL}${publicPath(secret.id)}`))?.status()).toBe(404);
      expect((await anonPage.goto(`${baseURL}${publicPath(canvas.id)}`))?.status()).toBe(404);
      expect((await anonPage.goto(`${baseURL}${publicPath("00000000-0000-4000-8000-000000000000")}`))?.status()).toBe(404);
      // Canvas docs cannot be published, even through the API
      expect((await page.request.post(`/api/docs/${canvas.id}/publish`, { data: { published: true } })).status()).toBe(409);

      // 4. Unpublish is immediate
      await page.goto(`${base}/docs/${doc.id}`);
      await page.waitForLoadState("networkidle");
      await toggleSwitch();
      await expect(page.getByTestId("doc-publish-badge")).toContainText("Not published");
      expect((await anonPage.goto(`${baseURL}${publicPath(doc.id)}`))?.status()).toBe(404);
      await expect(anonPage.getByText(body)).toHaveCount(0);
      await anonPage.goto(`${baseURL}${homeUrl}/docs`);
      await expect(anonPage.getByText(title)).toHaveCount(0);
      await anonPage.goto(`${baseURL}${homeUrl}`);
      await expect(anonPage.getByText(title)).toHaveCount(0);
      expect(await anonPage.content()).not.toContain(title);

      // 5. Anonymous (no session) cannot publish through the API
      const anonPublish = await anon.request.post(`${baseURL}/api/docs/${doc.id}/publish`, { data: { published: true } });
      expect(anonPublish.status()).toBe(401);
      expect((await anonPage.goto(`${baseURL}${publicPath(doc.id)}`))?.status()).toBe(404);
    } finally {
      await anon.close();
      if (originalDraft) {
        await page.request.put(homeApi, { data: { widgets: originalDraft } });
        await page.request.post(`${homeApi}/publish`);
      }
      await prisma.doc.deleteMany({ where: { id: { in: [doc.id, secret.id, canvas.id] } } });
    }
  });
});
