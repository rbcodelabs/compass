/**
 * Creates an opportunity the way a user does on the Discovery board: a
 * column's "Add opportunity" opens the docked composer, the title is typed and
 * submitted, and the composer hands its slot to the new opportunity's panel.
 *
 * Specs that only need an opportunity to exist (and then continue on the
 * board) call this with the default `closePanel: true`, which leaves the page
 * as the old inline form did: board visible, no panel open.
 * The composer itself is covered by specs/opportunity-composer.spec.ts.
 */
import type { Page } from "@playwright/test";
import { expect } from "./index";

export async function createOpportunityFromBoard(
  page: Page,
  title: string,
  { column = 0, closePanel = true }: { column?: number | string; closePanel?: boolean } = {},
) {
  // A string selects the column by its title, so callers do not depend on the board's default column order.
  const add =
    typeof column === "number"
      ? page.getByRole("button", { name: /Add opportunity/i }).nth(column)
      : page
          .getByRole("heading", { level: 3, name: new RegExp(`^${column}`) })
          .locator("xpath=ancestor::section[1]")
          .getByRole("button", { name: /Add opportunity/i });
  await add.click();
  const composer = page.locator('[data-slot="opportunity-composer"]');
  await expect(composer).toBeVisible();
  await composer.getByLabel("Title").fill(title);
  await composer.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page).toHaveURL(/detail=opportunity%3A[0-9a-f-]{36}/, { timeout: 30_000 });
  const id = decodeURIComponent(new URL(page.url()).searchParams.get("detail") ?? "").split(":")[1];
  if (closePanel) {
    await page.getByRole("button", { name: "Close panel" }).first().click();
    await expect(page).not.toHaveURL(/detail=/);
  }
  return id;
}
