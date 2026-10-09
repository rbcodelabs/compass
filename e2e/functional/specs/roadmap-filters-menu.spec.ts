import { test, expect } from "../fixtures/index";

/** All-roadmaps toolbar: every filter lives in one "Filters" pulldown; Clear resets all of them. */
test("filters live in one pulldown and Clear resets every filter", async ({ page, base }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/roadmap`);
  await page.getByTestId("nav-org-roadmap").click();
  await page.waitForURL("**/roadmap");
  const toolbar = page.getByTestId("cross-roadmap-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("filter-horizon")).toHaveCount(0);

  await page.getByTestId("filters-menu").click();
  await expect(page.getByTestId("filter-workspace")).toBeVisible();

  await page.getByTestId("filter-horizon").click();
  const next = page.getByRole("menuitemcheckbox", { name: /Next/ });
  await expect(next).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/horizons=NEXT/);
  await expect(page.getByTestId("filters-menu")).toContainText("1");
  // menu stays open for multi-select
  await expect(next).toBeVisible();

  await page.getByTestId("filter-dates").click();
  const from = page.getByTestId("filter-date-from");
  await expect(from).toBeVisible();
  await from.fill("2026-01-15");
  await expect(page).toHaveURL(/from=2026-01-15/);
  await expect(from, "date menu stays open after the URL updates").toBeVisible();

  const lb = (await page.getByTestId("filter-links").boundingBox())!;
  // A real pointer move, as a user would make, switches the open submenu.
  await page.mouse.move(lb.x + 20, lb.y + lb.height / 2, { steps: 5 });
  await page.getByRole("menuitemradio", { name: "Linked", exact: true }).first().click();
  await expect(page).toHaveURL(/kr=linked/);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("filters-menu")).toContainText("3");
  await page.getByTestId("clear-filters").click();
  await expect(page).not.toHaveURL(/horizons|from=|kr=/);
});

/** The sidebar is desktop-only, so phones reach "All roadmaps" from the Account menu. */
test("mobile Account menu links to All roadmaps", async ({ page, base }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/roadmap`);
  const href = await page.getByTestId("nav-org-roadmap").getAttribute("href");
  expect(href).toMatch(/^\/[^/]+\/roadmap$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(href!);
  await expect(page.getByTestId("cross-roadmap-toolbar")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Account" }).click();
  const link = page.getByTestId("mobile-nav-org-roadmap");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", href!);
});
