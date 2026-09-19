/**
 * Create Workspace functional spec.
 *
 * Journey: Organization Settings → expand the inline "Create workspace" form
 *          → typing a Name derives the URL slug live → submit → land on the
 *          new workspace's OKRs page → the new workspace is present in the
 *          sidebar workspace switcher → re-submitting the same slug surfaces
 *          the duplicate error inline instead of throwing.
 *
 * Before this flow existed there was no browser path to add a workspace to an
 * existing organization at all: the MCP `create_workspace` tool is denied to
 * agent identities, and the onboarding wizard is unreachable once the user
 * already holds a membership.
 *
 * The seeded e2e user (dev@localhost.dev) is an organization ADMIN — see
 * e2e/functional/fixtures/seed-e2e.ts — which is exactly the role
 * `resolveOrgAdmin` requires, so no extra fixture user is needed.
 *
 * Timestamped names keep parallel runs and retries from colliding on the
 * `@@unique([organizationId, slug])` index.
 *
 * Pending-state note: the transition from click to redirect is fast (~55ms
 * against local Postgres), so every assertion below is a Playwright
 * auto-retrying matcher. There is deliberately no waitForTimeout anywhere in
 * this file — a timing-based assertion on that window is guaranteed flake.
 */
import { test, expect } from "../fixtures/index";

test.describe("Create Workspace", () => {
  test("create from Organization Settings → redirected into it → appears in the switcher", async ({
    page,
    orgSlug,
  }) => {
    const ts = Date.now();
    const workspaceName = `E2E New Workspace ${ts}`;
    const expectedSlug = `e2e-new-workspace-${ts}`;

    // ── 1. Open Organization Settings ──────────────────────────────────────
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    // ── 2. Expand the inline form ──────────────────────────────────────────
    // Collapsed state is a dashed "add" button, not a modal.
    const createButton = page.getByRole("button", { name: "Create workspace" });
    await expect(createButton).toBeVisible();
    await createButton.click();

    await expect(page.getByText("New Workspace", { exact: true })).toBeVisible();

    // ── 3. Typing the Name derives the slug live ───────────────────────────
    const nameInput = page.getByLabel("Name", { exact: true });
    const slugInput = page.getByLabel("URL slug", { exact: true });

    await expect(slugInput).toHaveValue("");
    await nameInput.fill(workspaceName);
    // Auto-retrying: asserts the derived value, not how long derivation took.
    await expect(slugInput).toHaveValue(expectedSlug);

    // The preview line under the field shows the resulting path.
    await expect(page.locator("#new-workspace-slug-hint")).toContainText(
      `/${orgSlug}/${expectedSlug}`
    );

    await page
      .getByLabel("Description")
      .fill("Created by the create-workspace functional spec.");

    // ── 4. Submit → redirected into the new workspace's OKRs page ──────────
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();

    // The landing route must match the workspace links on /dashboard.
    await page.waitForURL(`**/${orgSlug}/${expectedSlug}/okrs`, { timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/${expectedSlug}/okrs$`));

    // ── 5. The new workspace is in the sidebar switcher ────────────────────
    // This is what revalidatePath("/", "layout") exists for: without it the
    // switcher keeps serving the pre-creation payload from the client router
    // cache and the workspace looks missing until a hard reload.
    const switcher = page.getByRole("button", {
      name: `Switch workspace. Current workspace: ${workspaceName}`,
    });
    await expect(switcher).toBeVisible({ timeout: 15_000 });
    await switcher.click();
    await expect(page.getByRole("menuitem", { name: workspaceName })).toBeVisible();
    // The seeded workspace is still there — this added one, it didn't replace.
    await expect(page.getByRole("menuitem", { name: "E2E Workspace" })).toBeVisible();
    await page.keyboard.press("Escape");

    // ── 6. Persisted server-side, not just client state ────────────────────
    await page.reload();
    await page.waitForLoadState("load");
    await expect(
      page.getByRole("button", {
        name: `Switch workspace. Current workspace: ${workspaceName}`,
      })
    ).toBeVisible({ timeout: 15_000 });

    // ── 7. Re-using the slug reports the conflict inline ───────────────────
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Create workspace" }).click();

    await page.getByLabel("Name", { exact: true }).fill(`${workspaceName} Again`);
    // Clear the derived slug and retype the one already taken.
    await page.getByLabel("URL slug", { exact: true }).fill(expectedSlug);
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();

    await expect(
      page.getByText(`A workspace with slug "${expectedSlug}" already exists`)
    ).toBeVisible({ timeout: 15_000 });
    // Returned as data, never thrown — a thrown Server Action error loses its
    // message in a production build and surfaces as Next's generic mask.
    await expect(
      page.getByText(/An error occurred in the Server Components render/)
    ).toHaveCount(0);
    // Still on Settings; no navigation happened.
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings$`));
  });

  test("whitespace-only name reports why instead of doing nothing", async ({
    page,
    orgSlug,
  }) => {
    // Regression test. `required` is satisfied by whitespace, so native
    // validation passes and the click reached the client handler, which then
    // returned silently — the button looked broken and no request was made.
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Create workspace" }).click();

    await page.getByLabel("Name", { exact: true }).fill("   ");
    await page.getByLabel("URL slug", { exact: true }).fill("whitespace-name-probe");
    await page.getByRole("button", { name: "Create Workspace", exact: true }).click();

    await expect(page.getByText("Workspace name is required.")).toBeVisible({
      timeout: 10_000,
    });
    // Nothing was created and the form stayed open.
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings$`));
    await expect(page.getByText("New Workspace", { exact: true })).toBeVisible();
  });

  test("a name with no derivable slug explains itself rather than tooltipping an untouched field", async ({
    page,
    orgSlug,
  }) => {
    await page.goto(`/${orgSlug}/settings`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Create workspace" }).click();

    // Nothing in this name survives deriveSlug, so the slug field stays empty.
    await page.getByLabel("Name", { exact: true }).fill("日本語");

    await expect(page.getByLabel("URL slug", { exact: true })).toHaveValue("");
    await expect(page.locator("#new-workspace-slug-hint")).toContainText(
      /slug can't be derived/i
    );
  });
});
