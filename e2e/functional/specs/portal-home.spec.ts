/**
 * Portal Home functional spec (widgetable customer home).
 *
 * Journey:
 *   1. Seed a private and a public roadmap item, make the roadmap public.
 *   2. Admin opens /portal/<org>/<ws>, enters Edit home, adds two text widgets
 *      (one Everyone, one Signed-in only), resizes one, and sees Draft state.
 *   3. An anonymous visitor sees NEITHER widget (drafts are never public).
 *   4. Admin publishes. Anonymous now sees the Everyone widget but never the
 *      signed-in widget (enforced on the server, not just hidden).
 *   5. Leakage: the admin API pins the PRIVATE item in a spotlight and
 *      publishes; the anonymous home shows the public item and never the
 *      private title.
 *   5b. A "Team only" widget shows on the team home (/<org>/<ws>/home) and never
 *       on the public page; a signed-out visitor cannot open the team home.
 *   6. On a phone-width viewport the board is a single column.
 */
import { test, expect } from "../fixtures/index";

test.describe("Portal Home", () => {
  test("admin edits and publishes; customers only see published, public, visible content", async ({
    page, base, orgSlug, workspaceSlug, browser, baseURL,
  }) => {
    const ts = Date.now();
    const privateTitle = `E2E Home Private ${ts}`;
    const publicTitle = `E2E Home Public ${ts}`;
    const everyoneNote = `E2E Everyone Note ${ts}`;
    const signedInNote = `E2E SignedIn Note ${ts}`;
    const homeUrl = `/portal/${orgSlug}/${workspaceSlug}`;
    const api = `/api/portal-home/${orgSlug}/${workspaceSlug}`;

    // ── 1. Roadmap items + public roadmap ───────────────────────────────────
    await page.goto(`${base}/roadmap`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add item" }).nth(1).click();
    await page.getByLabel("Title").fill(privateTitle);
    await page.getByRole("checkbox", { name: "Private (hidden from public roadmap)" }).click();
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    const privateCard = page.locator('[data-slot="card"]').filter({ hasText: privateTitle });
    await expect(privateCard).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Add item" }).nth(1).click();
    await page.getByLabel("Title").fill(publicTitle);
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await expect(page.locator('[data-slot="card"]').filter({ hasText: publicTitle })).toBeVisible({ timeout: 10_000 });

    await privateCard.hover();
    await privateCard.getByLabel("Card actions").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const inputId = await page.locator('input[id^="edit-title-"]').getAttribute("id");
    const privateItemId = inputId!.replace("edit-title-", "");
    await page.keyboard.press("Escape");

    await page.goto(`${base}/settings`);
    await page.waitForLoadState("networkidle");
    const roadmapToggle = page.getByTestId("portal-toggle-roadmap");
    const roadmapWasPublic = (await roadmapToggle.getAttribute("aria-checked")) === "true";
    if (!roadmapWasPublic) {
      await roadmapToggle.click();
      await page.waitForLoadState("networkidle");
    }
    const authToggle = page.getByRole("switch", { name: "Require portal sign-in" });
    const authWasRequired = (await authToggle.getAttribute("aria-checked")) === "true";
    if (authWasRequired) {
      await authToggle.click();
      await expect(authToggle).toHaveAttribute("aria-checked", "false");
    }

    const anon = await browser.newContext({ storageState: undefined });
    const anonPage = await anon.newPage();
    try {
      // ── 2. Admin edits the home ───────────────────────────────────────────
      await page.goto(homeUrl);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("portal-home-admin-bar")).toBeVisible();
      await page.getByRole("button", { name: "Edit home" }).click();
      await expect(page.getByText("Editing home.")).toBeVisible();

      const addTextBlock = async (title: string) => {
        await page.getByRole("button", { name: "Add widget" }).click();
        await page.getByRole("button", { name: /Text block/ }).click();
        await page.getByLabel("Title (optional)").fill(title);
        await page.getByLabel("Text", { exact: true }).fill("Hello from the e2e suite.");
      };

      await addTextBlock(everyoneNote);
      await addTextBlock(signedInNote);
      await page.getByRole("radio", { name: "Signed-in customers" }).check();
      // The most recent widget is selected; make it Large.
      await page
        .locator('section[data-widget-type="rich_text"]')
        .filter({ hasText: signedInNote })
        .getByRole("button", { name: "Size L" })
        .click();
      await expect(
        page.locator('section[data-widget-type="rich_text"]').filter({ hasText: signedInNote }).getByRole("button", { name: "Size L" }),
      ).toHaveAttribute("aria-pressed", "true");

      await expect(page.getByTestId("portal-home-state")).toContainText(/Draft/);
      // Autosave settles.
      await expect(page.getByTestId("portal-home-state")).toHaveText(/Draft · unpublished changes/, { timeout: 10_000 });

      // ── 3. Drafts are never public ────────────────────────────────────────
      await anonPage.goto(`${baseURL}${homeUrl}`);
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(everyoneNote)).toHaveCount(0);
      await expect(anonPage.getByText(signedInNote)).toHaveCount(0);

      // Preview as customer hides the signed-in widget.
      await page.getByRole("button", { name: "Preview as customer" }).click();
      await expect(page.getByText(/Previewing as a signed-out customer/)).toBeVisible();
      await expect(page.getByText(everyoneNote)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(signedInNote)).toHaveCount(0);
      await page.getByRole("button", { name: "Back to editing" }).click();

      // ── 4. Publish ────────────────────────────────────────────────────────
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByText("Published. Customers now see this version.")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("portal-home-state")).toHaveText("Published");

      await anonPage.reload();
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(everyoneNote)).toBeVisible();
      await expect(anonPage.getByText(signedInNote)).toHaveCount(0);
      await expect(anonPage.getByRole("link", { name: "Home" })).toBeVisible();

      // ── 5. Leakage: pinning a private item never exposes it ───────────────
      const current = await (await page.request.get(api)).json();
      const spotlight = {
        id: "e2e-spotlight",
        type: "roadmap_spotlight",
        size: "M",
        order: current.draft.length,
        visibility: "everyone",
        config: { title: "E2E Spotlight", show: "status", itemIds: [privateItemId] },
      };
      const putRes = await page.request.put(api, { data: { widgets: [...current.draft, spotlight] } });
      expect(putRes.ok()).toBe(true);
      expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);

      await anonPage.reload();
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(privateTitle)).toHaveCount(0);
      // Only a private item pinned: the whole spotlight is omitted for customers.
      await expect(anonPage.getByRole("heading", { name: "E2E Spotlight" })).toHaveCount(0);
      expect(await anonPage.content()).not.toContain(privateTitle);

      // The admin pickers offer private items too (the team home shows them), flagged
      // isPrivate; customers still never receive one. Pin the public one next to the private id.
      const options = await (await page.request.get(`${api}/options`)).json();
      expect(options.roadmapItems.find((i: { title: string }) => i.title === privateTitle)?.isPrivate).toBe(true);
      const publicItem = options.roadmapItems.find((i: { title: string }) => i.title === publicTitle);
      expect(publicItem).toBeTruthy();
      const refreshed = await (await page.request.get(api)).json();
      const widgets = refreshed.draft.map((w: { id: string; config: object }) =>
        w.id === "e2e-spotlight" ? { ...w, config: { ...w.config, itemIds: [privateItemId, publicItem.id] } } : w,
      );
      expect((await page.request.put(api, { data: { widgets } })).ok()).toBe(true);
      expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);
      await anonPage.reload();
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(publicTitle)).toBeVisible();
      await expect(anonPage.getByText(privateTitle)).toHaveCount(0);
      expect(await anonPage.content()).not.toContain(privateTitle);

      // ── 5b. Team view: a "Team only" widget shows on /home, never to customers ──
      const teamNote = `E2E Team Only Note ${ts}`;
      const beforeTeam = await (await page.request.get(api)).json();
      const teamWidget = {
        id: "e2e-team-note",
        type: "rich_text",
        size: "M",
        order: beforeTeam.draft.length,
        visibility: "team",
        config: { title: teamNote, body: "Visible to the team only." },
      };
      expect((await page.request.put(api, { data: { widgets: [...beforeTeam.draft, teamWidget] } })).ok()).toBe(true);
      expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);

      await page.goto(`${base}/home`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(teamNote)).toBeVisible();
      await expect(page.getByText(everyoneNote)).toBeVisible();
      // The same widget is absent from the public page, markup included.
      await anonPage.goto(`${baseURL}${homeUrl}`);
      await anonPage.waitForLoadState("networkidle");
      await expect(anonPage.getByText(teamNote)).toHaveCount(0);
      expect(await anonPage.content()).not.toContain(teamNote);
      // And a signed-out visitor cannot open the team home.
      await anonPage.goto(`${baseURL}${base}/home`);
      await expect(anonPage.getByText(teamNote)).toHaveCount(0);

      // ── 6. Mobile: single column ──────────────────────────────────────────
      await anonPage.setViewportSize({ width: 390, height: 800 });
      await anonPage.reload();
      await anonPage.waitForLoadState("networkidle");
      const lefts = await anonPage.locator('[data-testid="portal-home-board"] > section').evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().left)),
      );
      expect(lefts.length).toBeGreaterThan(0);
      expect(new Set(lefts).size).toBe(1);
    } finally {
      await anon.close();
      if (!roadmapWasPublic) {
        await page.goto(`${base}/settings`);
        const checkedAfter = await roadmapToggle.getAttribute("aria-checked");
        if (checkedAfter === "true") {
          await roadmapToggle.click();
          await page.waitForLoadState("networkidle");
        }
      }
      if (authWasRequired) {
        await authToggle.click();
      }
    }
  });
});
