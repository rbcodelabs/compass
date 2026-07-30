/**
 * In-App Feedback Submission functional spec.
 *
 * Part A: workspace-scoped "New Feedback" creation directly on a workspace's
 *         own Feedback board (components/feedback/internal-feedback-board.tsx)
 *         — previously this board was triage-only (view/status-change
 *         existing items), with no way to create a new item in-app.
 *
 * Part B: the global "Send Feedback about Compass" entry point (sidebar),
 *         reachable from ANY org/workspace the user is in, which always
 *         routes the submission into the rbcodelabs/compass workspace
 *         (COMPASS_META_ORG_SLUG/COMPASS_META_WORKSPACE_SLUG) regardless of
 *         current context — the in-app replacement for the prior workaround
 *         of an external agent skill hardcoding a curl to rbcodelabs/compass.
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

    await page.getByRole("button", { name: "New Feedback" }).click();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Description (optional)").fill("Created via the New Feedback dialog.");
    await page.getByRole("button", { name: "Submit" }).click();

    // The dialog closes (no full page reload — the board updates from the
    // server action's response) and the new item appears in the board.
    await expect(page.getByRole("button", { name: "Submit" })).not.toBeVisible();
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
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

    await page.getByRole("button", { name: "Send Feedback about Compass" }).click();
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(
      page.getByText("Thanks — your feedback was sent to the Compass team.")
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Close" }).click();

    // Confirm it landed in rbcodelabs/compass, not the current workspace —
    // the whole point of this entry point being workspace-independent.
    await page.goto(`/${COMPASS_META_ORG_SLUG}/${COMPASS_META_WORKSPACE_SLUG}/feedback`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
  });
});
