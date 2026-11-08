/**
 * Portal Home templates functional spec.
 *
 * Journey: an admin opens the home editor, switches through all four templates (editorial, bento, shell,
 * docs hub), publishes each, and an anonymous customer sees that template's chrome and board arrangement.
 * A draft template that has not been published never reaches customers. On a phone the shell template's
 * sidebar becomes a drawer.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

// Ordered so every step changes the template (the first one is published as editorial beforehand).
const TEMPLATES = [
  { id: "bento", radio: /Bento/, shell: "portal-shell-bento", tpl: "bento" },
  { id: "shell", radio: /^Shell/, shell: "portal-shell-sidebar", tpl: "shell" },
  { id: "docs_hub", radio: /Docs hub/, shell: "portal-shell-hub", tpl: "hub" },
  { id: "editorial", radio: /Editorial/, shell: "portal-shell-editorial", tpl: "editorial" },
] as const;
const EDITORIAL_SHELL = "portal-shell-editorial";

test.describe("Portal Home templates", () => {
  test("admin switches and publishes each template; customers see the published one", async ({
    page, orgSlug, workspaceSlug, browser, baseURL, base,
  }) => {
    // Four publishes, each re-rendering a cold dev-server route: well past the 90s default.
    test.setTimeout(240_000);
    const homeUrl = `/portal/${orgSlug}/${workspaceSlug}`;
    const api = `/api/portal-home/${orgSlug}/${workspaceSlug}`;

    await page.goto(`${base}/settings`);
    await page.waitForLoadState("networkidle");
    const authToggle = page.getByRole("switch", { name: "Require portal sign-in" });
    // The toggle only exists once the portal is public; absent means sign-in is not required.
    const authWasRequired = (await authToggle.count()) > 0 && (await authToggle.getAttribute("aria-checked")) === "true";
    if (authWasRequired) {
      await authToggle.click();
      await expect(authToggle).toHaveAttribute("aria-checked", "false");
    }

    const anon = await browser.newContext({ storageState: undefined });
    const anonPage: Page = await anon.newPage();
    const originalDraft = await (await page.request.get(api)).json();
    try {
      // Known starting point: one text widget, published as editorial.
      const note = { id: "e2e-template-note", type: "rich_text", size: "M", order: 0, visibility: "everyone", config: { title: "Template spec note", body: "Hello." } };
      expect((await page.request.put(api, { data: { widgets: [note], template: "editorial" } })).ok()).toBe(true);
      expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);

      await page.goto(homeUrl);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Edit home" }).click();
      await expect(page.getByTestId("portal-template-picker")).toBeVisible();

      let previousShell = EDITORIAL_SHELL;
      for (const template of TEMPLATES) {
        // Choosing a template alone is an unpublished change and re-arranges the editor canvas.
        await page.getByRole("radio", { name: template.radio }).check({ force: true });
        await expect(page.getByTestId("portal-home-edit-board")).toHaveAttribute("data-tpl", template.tpl);
        await expect(page.getByTestId("portal-home-state")).toHaveText(/Draft · unpublished changes/, { timeout: 10_000 });

        // Not published yet: customers do not see this template.
        await anonPage.goto(`${baseURL}${homeUrl}`);
        await anonPage.waitForLoadState("networkidle");
        await expect(anonPage.getByTestId(previousShell)).toBeVisible();
        await expect(anonPage.getByTestId(template.shell)).toHaveCount(0);

        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByText("Published. Customers now see this version.")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId("portal-home-state")).toHaveText("Published");
        expect((await (await page.request.get(api)).json()).publishedTemplate).toBe(template.id);

        await anonPage.reload();
        await anonPage.waitForLoadState("networkidle");
        await expect(anonPage.getByTestId(template.shell)).toBeVisible();
        await expect(anonPage.getByTestId("portal-home-board")).toHaveAttribute("data-tpl", template.tpl);
        await expect(anonPage.getByRole("link", { name: "Home" }).first()).toBeVisible();
        // The shared page chrome survives in every shell.
        await expect(anonPage.getByText("Powered by Compass").first()).toBeAttached();
        previousShell = template.shell;
      }

      // The docs hub hero is search-first.
      await page.getByRole("radio", { name: /Docs hub/ }).check({ force: true });
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("portal-home-state")).toHaveText("Published", { timeout: 10_000 });
      await anonPage.reload();
      await expect(anonPage.getByRole("search", { name: "Search docs" })).toBeVisible();

      // Phone: the shell template's sidebar is a drawer behind the menu button.
      await page.getByRole("radio", { name: /^Shell/ }).check({ force: true });
      await expect(page.getByTestId("portal-home-state")).toHaveText(/Draft · unpublished changes/, { timeout: 10_000 });
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByTestId("portal-home-state")).toHaveText("Published", { timeout: 10_000 });
      await anonPage.setViewportSize({ width: 390, height: 800 });
      await anonPage.reload();
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByTestId("portal-shell-sidebar")).toBeVisible();
      await expect(anonPage.getByRole("complementary", { name: "Portal sidebar" })).toBeHidden();
      await anonPage.getByRole("button", { name: "Open menu" }).click();
      await expect(anonPage.getByRole("complementary", { name: "Portal sidebar" })).toBeVisible();
    } finally {
      await anon.close();
      // Leave the shared workspace on the template it started with.
      await page.request.put(api, { data: { widgets: originalDraft.draft, template: originalDraft.draftTemplate } });
      if (originalDraft.published !== null) await page.request.post(`${api}/publish`);
      if (authWasRequired) {
        await page.goto(`${base}/settings`);
        await authToggle.click();
      }
    }
  });
});
