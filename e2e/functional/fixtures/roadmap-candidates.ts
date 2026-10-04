/**
 * Fixtures for the "build the roadmap from Discovery" specs: create Discovery
 * solutions the way a user does, set their status from the detail panel, and
 * read the timeline's bars.
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "./index";
import { createOpportunityFromBoard } from "./opportunity-composer";
import { openFullPage } from "./full-page";

export type SolutionStatusLabel = "Idea" | "Validated" | "In delivery" | "Shipped";

/** Switch the open solution panel's status dropdown from one label to another. */
export async function setPanelStatus(page: Page, from: SolutionStatusLabel, to: SolutionStatusLabel) {
  const panel = page.locator('[data-slot="sheet-content"]');
  await expect(panel).toBeVisible();
  await panel.locator('[role="combobox"]').filter({ hasText: from }).click();
  await page.getByRole("option", { name: to, exact: true }).click();
  await expect(panel.locator('[role="combobox"]').filter({ hasText: to })).toBeVisible({ timeout: 10_000 });
}

/**
 * Create an opportunity with one solution at the given status. The opportunity
 * title is unrelated to the solution title on purpose (a substring of one inside
 * the other makes text locators ambiguous). Leaves the solution's detail panel
 * open on the Discovery full page.
 */
export async function createSolution(
  page: Page,
  base: string,
  title: string,
  status: SolutionStatusLabel = "Validated",
): Promise<{ opportunityTitle: string }> {
  const opportunityTitle = `E2E Sched Opportunity ${Math.random().toString(36).slice(2, 10)}`;
  await page.goto(`${base}/discovery`);
  await page.waitForLoadState("networkidle");
  await createOpportunityFromBoard(page, opportunityTitle);
  await expect(page.getByText(opportunityTitle)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
  await openFullPage(page);
  const detail = page.locator('[data-slot="opportunity-detail"][data-variant="page"]');
  await expect(detail.getByRole("heading", { name: opportunityTitle })).toBeVisible();
  await detail.getByRole("button", { name: "Add Solution" }).click();
  await detail.getByLabel("Title").fill(title);
  await detail.getByRole("button", { name: "Add Solution" }).click();
  await expect(detail.getByText(title)).toBeVisible({ timeout: 10_000 });
  await detail.getByRole("button", { name: title, exact: true }).click();
  if (status !== "Idea") await setPanelStatus(page, "Idea", status);
  return { opportunityTitle };
}

export function timelineBar(page: Page, title: string): Locator {
  return page.locator('[data-testid^="timeline-item-"][data-start]').filter({ hasText: title });
}

export function railCard(page: Page, title: string): Locator {
  return page.getByTestId("schedule-rail").locator('[data-testid^="unscheduled-item-solution:"]').filter({ hasText: title });
}

/** Whole days between two YYYY-MM-DD strings, end inclusive. */
export function inclusiveDays(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
}

export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Open the timeline. The "Ready to schedule" rail is collapsed by default below 1320px, so by
 * default this opens it when it is closed, for the many journeys that work from the rail.
 * Pass `{ rail: "as-is" }` to observe the default state instead.
 */
export async function openTimeline(page: Page, base: string, options: { rail?: "open" | "as-is" } = {}) {
  await page.goto(`${base}/roadmap?view=timeline`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("timeline-engine-native").filter({ visible: true })).toBeVisible();
  if ((options.rail ?? "open") === "open") {
    const toggle = page.getByRole("button", { name: /ready-to-schedule rail/ });
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("schedule-rail")).toBeVisible();
  }
}

/** Create a fresh, empty workspace through Organization Settings and return its base path. */
export async function createFreshWorkspace(page: Page, orgSlug: string, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await page.goto(`/${orgSlug}/settings`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await expect(page.getByLabel("URL slug", { exact: true })).toHaveValue(slug);
  await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
  await page.waitForURL(`**/${orgSlug}/${slug}/okrs`, { timeout: 20_000 });
  return `/${orgSlug}/${slug}`;
}

/**
 * The chart is virtualized horizontally, so a bar outside the visible dates is not in the DOM.
 * Scroll right from today until the bar renders, then return it. Fails if it never does.
 */
export async function revealBar(page: Page, title: string): Promise<Locator> {
  await page.getByRole("button", { name: "Go to today", exact: true }).click();
  const bar = timelineBar(page, title);
  const scroll = page.getByTestId("native-timeline-scroll");
  for (let step = 0; step < 40 && (await bar.count()) === 0; step += 1) {
    await scroll.evaluate((element) => { element.scrollLeft += 200; });
    await page.waitForTimeout(50);
  }
  await expect(bar).toBeVisible({ timeout: 5_000 });
  return bar;
}
