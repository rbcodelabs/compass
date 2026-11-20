import { Prisma } from "@prisma/client";
import getPrisma from "../../../lib/db";
import { test, expect } from "../fixtures/index";

test("Portal Home publishes and removes team-only widgets without exposing them to customers", async ({
  page, base, browser, baseURL, workspaceSlug, orgSlug,
}, testInfo) => {
  const prisma = getPrisma();
  const { id: workspaceId } = await prisma.workspace.findFirstOrThrow({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  const original = await prisma.portalHomeLayout.findUnique({ where: { workspaceId } });
  const artifactTitles = ["Portal widget test prototype", "Portal widget test reference"];
  const objectiveTitle = "Portal widget test objective";
  const publicTitle = "Portal widget test welcome";
  const pendingTitle = "Portal widget test pending welcome";
  const email = `portal-widgets-${Date.now()}@example.com`;
  const api = `/api/portal-home/${orgSlug}/${workspaceSlug}`;
  const home = `${base}/home`;
  const customer = await browser.newContext({ storageState: undefined });
  const customerPage = await customer.newPage();

  try {
    await prisma.artifact.createMany({
      data: artifactTitles.map((title) => ({ workspaceId, title, sourceType: "EXTERNAL_LINK" })),
    });
    await prisma.objective.create({
      data: { workspaceId, title: objectiveTitle, keyResults: { create: { workspaceId, title: "Reduce churn", target: -10, current: -5 } } },
    });
    const control = {
      id: "internal-widgets-public-control", type: "rich_text", size: "M", order: 0,
      visibility: "everyone", config: { title: publicTitle, body: "Welcome to the customer portal." },
    };
    expect((await page.request.put(api, { data: { widgets: [control], template: "editorial" } })).ok()).toBe(true);
    expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);
    const pending = { ...control, config: { ...control.config, title: pendingTitle } };
    expect((await page.request.put(api, { data: { widgets: [pending], template: "bento" } })).ok()).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(home);
    await page.route(
      (url) => url.pathname === `${api}/options` && url.searchParams.get("audience") === "team",
      (route) => route.fulfill({ status: 503, json: { error: "Try again" } }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Edit home" }).click();
    const settings = page.getByRole("complementary", { name: "Widget settings" });
    const chooseWidget = async (name: RegExp) => {
      await page.getByRole("button", { name: "Add widget", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name }).click();
      await expect(settings.getByText("Visible to: Team only")).toBeVisible();
      await expect(settings.getByRole("radio")).toHaveCount(0);
    };

    await chooseWidget(/^Artifact gallery/);
    await expect(settings.getByText("Could not load widget options.")).toBeVisible();
    await expect(settings.getByRole("textbox", { name: "Title" })).toBeEditable();
    await settings.getByRole("button", { name: "Retry" }).click();
    await settings.getByRole("combobox", { name: "Which artifacts" }).click();
    await page.getByRole("option", { name: "Selected artifacts" }).click();
    for (const title of artifactTitles) {
      await settings.getByRole("checkbox", { name: new RegExp(title) }).click();
    }
    const selectedArtifacts = settings.getByRole("list", { name: "Selected artifacts, in display order" });
    const move = selectedArtifacts.getByRole("button", { name: `Move ${artifactTitles[1]} up` });
    await move.focus();
    await expect(move).toBeFocused();
    await move.press("Enter");
    await expect(selectedArtifacts.getByRole("listitem").first()).toContainText(artifactTitles[1]);

    await chooseWidget(/^OKRs /);
    await settings.getByRole("combobox", { name: "Which objectives" }).click();
    await page.getByRole("option", { name: "Selected objectives" }).click();
    await settings.getByRole("checkbox", { name: new RegExp(objectiveTitle) }).click();

    await expect(page.getByText(/Publish applies the entire draft/)).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit home" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("artifact-gallery-list")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit home" }).click();
    await page.getByRole("button", { name: "Preview as customer" }).click();
    const board = page.getByTestId("portal-home-board");
    await expect(board.getByText(pendingTitle)).toBeVisible();
    await expect(board.getByTestId("artifact-gallery-list")).toHaveCount(0);
    await expect(board.getByTestId("okr-summary-list")).toHaveCount(0);

    const customerHome = `${baseURL}/portal/${orgSlug}/${workspaceSlug}`;
    await customerPage.goto(customerHome);
    await expect(customerPage.getByText(publicTitle)).toBeVisible();
    await expect(customerPage.getByTestId("portal-home-board")).toHaveAttribute("data-tpl", "editorial");
    await expect(customerPage.getByText(pendingTitle)).toHaveCount(0);

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("portal-home-state")).toHaveText("Published");
    await page.goto(home);
    const gallery = page.getByTestId("artifact-gallery-list");
    await expect(gallery.getByRole("link").first()).toContainText(artifactTitles[1]);
    await expect(page.getByRole("progressbar", { name: `${objectiveTitle} progress` })).toHaveAttribute("aria-valuenow", "50");
    await testInfo.attach("team-home-1280x800", { body: await page.screenshot(), contentType: "image/png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(gallery.getByText(artifactTitles[1])).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await gallery.scrollIntoViewIfNeeded();
    await testInfo.attach("team-home-390x844", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByTestId("okr-summary-list").scrollIntoViewIfNeeded();
    await testInfo.attach("team-home-okr-390x844", { body: await page.screenshot(), contentType: "image/png" });

    const publishedState = await (await page.request.get(api)).json() as {
      published: { id: string; type: string; config: { artifactIds?: string[]; objectiveIds?: string[] } }[];
    };
    const internalMarkers = publishedState.published
      .filter((widget) => widget.type === "artifact_gallery" || widget.type === "okr_summary")
      .flatMap((widget) => [widget.id, ...(widget.config.artifactIds ?? []), ...(widget.config.objectiveIds ?? [])]);
    expect(internalMarkers).toHaveLength(5);
    const checkCustomerHome = async () => {
      const response = await customerPage.goto(customerHome);
      if (!response) throw new Error("Customer home returned no response");
      expect(response.status()).toBe(200);
      await expect(customerPage.getByText(pendingTitle)).toBeVisible();
      await expect(customerPage.getByTestId("portal-home-board")).toHaveAttribute("data-tpl", "bento");
      await expect(customerPage.getByTestId("artifact-gallery-list")).toHaveCount(0);
      await expect(customerPage.getByTestId("okr-summary-list")).toHaveCount(0);
      const html = await response.text();
      for (const marker of [...internalMarkers, ...artifactTitles, objectiveTitle]) expect(html).not.toContain(marker);
    };
    await checkCustomerHome();

    const send = await customer.request.post(`${baseURL}/api/portal/auth/send`, {
      data: { email, returnTo: `/portal/${orgSlug}/${workspaceSlug}` },
    });
    expect(send.ok()).toBe(true);
    const { devVerifyUrl } = await send.json();
    expect(devVerifyUrl).toBeTruthy();
    const verification = new URL(devVerifyUrl);
    await customerPage.goto(`${baseURL}${verification.pathname}${verification.search}`);
    expect((await customer.cookies()).some(({ name }) => name === "compass_portal_session")).toBe(true);
    await checkCustomerHome();

    expect((await page.request.put(api, { data: { widgets: [pending] } })).ok()).toBe(true);
    expect((await page.request.post(`${api}/publish`)).ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId("artifact-gallery-list")).toHaveCount(0);
    await expect(page.getByTestId("okr-summary-list")).toHaveCount(0);
    await expect(page.getByText(pendingTitle)).toBeVisible();
  } finally {
    const account = await prisma.portalAccount.findUnique({ where: { email }, select: { id: true } });
    if (account) {
      await prisma.portalSession.deleteMany({ where: { portalAccountId: account.id } });
      await prisma.portalAccount.delete({ where: { id: account.id } });
    }
    await customer.close();
    if (original) {
      await prisma.portalHomeLayout.update({
        where: { workspaceId },
        data: {
          draftWidgets: original.draftWidgets ?? Prisma.JsonNull,
          publishedWidgets: original.publishedWidgets ?? Prisma.DbNull,
          draftTemplate: original.draftTemplate,
          publishedTemplate: original.publishedTemplate,
          publishedAt: original.publishedAt,
          publishedById: original.publishedById,
          updatedAt: original.updatedAt,
        },
      });
    } else {
      await prisma.portalHomeLayout.deleteMany({ where: { workspaceId } });
    }
    await prisma.artifact.deleteMany({ where: { workspaceId, title: { in: artifactTitles } } });
    const objectives = await prisma.objective.findMany({ where: { workspaceId, title: objectiveTitle }, select: { id: true } });
    const objectiveIds = objectives.map(({ id }) => id);
    await prisma.keyResult.deleteMany({ where: { objectiveId: { in: objectiveIds } } });
    await prisma.objective.deleteMany({ where: { id: { in: objectiveIds } } });
  }
});
