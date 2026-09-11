/**
 * In-App Feedback Submission functional spec.
 *
 * Part A: workspace-scoped "New Feedback" creation directly on a workspace's
 *         own Feedback board (components/feedback/feedback-grid.tsx)
 *         — previously this board was triage-only (view/status-change
 *         existing items), with no way to create a new item in-app.
 *
 * Part B: the global "Send Feedback about Compass" entry point, reachable
 *         from ANY org/workspace the user is in, which always routes the
 *         submission into the rbcodelabs/compass workspace
 *         (COMPASS_META_ORG_SLUG/COMPASS_META_WORKSPACE_SLUG) regardless of
 *         current context — the in-app replacement for the prior workaround
 *         of an external agent skill hardcoding a curl to rbcodelabs/compass.
 *         Lives inside the sidebar's avatar "Account menu" dropdown
 *         alongside Settings/Org Settings/Help, not as a standalone link.
 */
import { test, expect } from "../fixtures/index";
import {
  COMPASS_META_ORG_SLUG,
  COMPASS_META_WORKSPACE_SLUG,
} from "../fixtures/seed-e2e";

test.describe("In-App Feedback Submission", () => {
  test("create feedback directly on the current workspace's Feedback board", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const title = `E2E In-App Idea ${ts}`;

    await page.goto(`${base}/feedback`);
    await page.waitForLoadState("networkidle");

    await page
      .locator('[data-slot="workspace-header"]')
      .getByRole("button", { name: "New Feedback" })
      .click();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description (optional)").fill("Created via the New Feedback dialog.");
    // `exact: true` matters here: Playwright's `name` option is a
    // case-insensitive SUBSTRING match by default, and the DataGrid's
    // "Submitted" column header renders a sort button named "Sort by
    // Submitted" — which contains "Submit". Without `exact`, this locator
    // resolves to both the dialog's submit button and a column header.
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    // The dialog closes (no full page reload — the board updates from the
    // server action's response) and the new item appears in the board.
    await expect(
      page.getByRole("button", { name: "Submit", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByTestId("grid-row").filter({ hasText: title })
    ).toHaveCount(1, { timeout: 10_000 });
  });

  test("send feedback about Compass from a different workspace lands in rbcodelabs/compass", async ({
    page,
    base,
  }) => {
    const ts = Date.now();
    const title = `E2E Global Feedback ${ts}`;

    // Start on the e2e workspace's OKRs page — anywhere but the target
    // workspace — to prove the destination is independent of current context.
    await page.goto(`${base}/okrs`);
    await page.waitForLoadState("networkidle");

    // "Send Feedback about Compass" lives inside the avatar dropdown menu,
    // not as a standalone sidebar link — open it first.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Send Feedback about Compass" }).click();
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(
      page.getByText("Thanks — your feedback was sent to the Compass team.")
    ).toBeVisible({ timeout: 10_000 });
    // Two elements match role=button/name=Close here: the dialog's built-in
    // top-right X close button (DialogContent showCloseButton) and our
    // explicit footer "Close" button, which renders later in the DOM — take
    // the last match to target ours specifically rather than the X icon.
    await page.getByRole("button", { name: "Close" }).last().click();

    // Confirm it landed in rbcodelabs/compass, not the current workspace —
    // the whole point of this entry point being workspace-independent.
    await page.goto(`/${COMPASS_META_ORG_SLUG}/${COMPASS_META_WORKSPACE_SLUG}/feedback`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
  });
});
