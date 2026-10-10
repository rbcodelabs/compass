import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Cross-workspace roadmap + saved roadmap views (migration 079).
 *
 * Journey, as a user meets it:
 *   1. "All roadmaps" in the sidebar opens /<org>/roadmap, which lists items from
 *      more than one workspace.
 *   2. On one workspace's roadmap, save the current view, reload, and it is still there.
 *   3. Empty / whitespace names cannot be saved.
 *   4. Share the view with the workspace. A second workspace member sees it under
 *      "Shared", but the cross-workspace roadmap still only shows items from
 *      workspaces that member can read (sharing never widens item access), even
 *      when a URL names a workspace they cannot read.
 *   5. A built-in path segment ("roadmap") cannot become a workspace slug.
 *
 * Fixtures: the seeded dev user is ADMIN of `e2e-workspace` and `e2e-planning`.
 * The second user is a real dev-credentials login added to `e2e-workspace` only, so
 * `e2e-planning` is the workspace they cannot access. Everything this spec inserts
 * (roadmap items, views, the second user and memberships) is removed in `finally`,
 * because global teardown does not know about roadmap_views.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const PLANNING = "e2e-planning";
const B_EMAIL = "roadmap-views-member@localhost.dev";

function requireLocalE2eDatabase(): pg.Pool {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
    throw new Error("Roadmap view tests require the dedicated local compass_e2e database");
  }
  return new pg.Pool({ connectionString: url.toString() });
}

async function workspaceId(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT w.id FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
    [ORG, slug],
  );
  if (!rows[0]) throw new Error(`Seeded workspace ${slug} not found`);
  return rows[0].id;
}

async function insertRoadmapItem(pool: pg.Pool, wsId: string, title: string): Promise<void> {
  await pool.query(
    `INSERT INTO "${S}".roadmap_items (id, workspace_id, title, horizon, status, sort_order, now_commitment_provenance, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'NEXT', 'ACTIVE', 0, 'LEGACY_UNGATED', NOW(), NOW())`,
    [wsId, title],
  );
}

/** Open the Views picker, choose "Save current filters as new view…" and return the dialog. */
async function openSaveDialog(page: Page) {
  await page.getByTestId("saved-views-trigger").click();
  await page.getByTestId("save-view-new").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Save view" })).toBeVisible();
  return dialog;
}

test.describe("Cross-workspace roadmap and saved views", () => {
  test("All roadmaps lists several workspaces; a saved view persists, shares with the workspace, and never widens item access", async ({ page, base, browser }) => {
    test.setTimeout(240_000);
    const pool = requireLocalE2eDatabase();
    const baseURL = test.info().project.use.baseURL as string;
    const tag = randomUUID().slice(0, 8);
    const alphaTitle = `E2E Views Alpha ${tag}`;
    const planningTitle = `E2E Views Planning Only ${tag}`;
    const viewName = `E2E Shared Roadmap ${tag}`;
    const personalName = `E2E Personal Roadmap ${tag}`;
    let bContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let bUserId = "";

    try {
      const wsId = await workspaceId(pool, WORKSPACE);
      const planningId = await workspaceId(pool, PLANNING);
      await insertRoadmapItem(pool, wsId, alphaTitle);
      await insertRoadmapItem(pool, planningId, planningTitle);

      // ── 1. Sidebar "All roadmaps" opens the org-wide roadmap ─────────────────
      await page.goto(`${base}/roadmap`);
      const allRoadmaps = page.getByTestId("nav-org-roadmap");
      await expect(allRoadmaps, "a user with two workspaces gets the All roadmaps link").toBeVisible({ timeout: 30_000 });
      await allRoadmaps.click();
      await page.waitForURL(`**/${ORG}/roadmap`);
      await expect(page.getByRole("link", { name: new RegExp(alphaTitle) })).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole("link", { name: new RegExp(planningTitle) }),
        "items from a second workspace render on the same page",
      ).toBeVisible();
      // Each card names its workspace, so the two are distinguishable.
      const workspaceChips = page.getByTestId("cross-roadmap-card").filter({ hasText: /E2E (Workspace|Planning)/ });
      await expect(workspaceChips.first()).toBeVisible();

      // ── 2. Save a view on the workspace roadmap; it survives a reload ────────
      await page.goto(`${base}/roadmap`);
      await expect(page.getByTestId("saved-views-trigger")).toHaveText(/Views/, { timeout: 30_000 });

      // Edge: a name that is empty, or only spaces, cannot be submitted.
      const emptyDialog = await openSaveDialog(page);
      const save = emptyDialog.getByRole("button", { name: "Save", exact: true });
      await expect(save, "Save is disabled while the name is empty").toBeDisabled();
      await emptyDialog.getByLabel("Name").fill("   ");
      await expect(save, "Save is disabled for a whitespace-only name").toBeDisabled();
      await emptyDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(emptyDialog).toBeHidden();

      const createDialog = await openSaveDialog(page);
      await createDialog.getByLabel("Name").fill(personalName);
      await createDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(createDialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByTestId("saved-views-trigger")).toContainText(personalName);
      await expect(page).toHaveURL(/[?&]saved=[0-9a-f-]{36}/);

      await page.reload();
      await expect(page.getByTestId("saved-views-trigger"), "the saved view is still selected after a reload").toContainText(personalName, { timeout: 30_000 });
      await page.goto(`${base}/roadmap`);
      await page.getByTestId("saved-views-trigger").click();
      await expect(page.getByTestId("saved-view-option").filter({ hasText: personalName }), "and it is listed on a fresh visit").toBeVisible();
      await page.keyboard.press("Escape");

      // ── 3. Second user, member of e2e-workspace only ─────────────────────────
      // Locally the dev-credentials provider reads a plain session cookie (the
      // next-auth callback route is a 404 shim in this fork), so a users row plus
      // that cookie is a real login as far as the app can tell.
      const { rows: [bUser] } = await pool.query<{ id: string }>(
        `INSERT INTO "${S}".users (id, name, email, email_verified, created_at)
         VALUES (gen_random_uuid(), 'Roadmap Views Member', $1, NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [B_EMAIL],
      );
      bUserId = bUser.id;
      bContext = await browser.newContext({ baseURL });
      await bContext.addCookies([{
        name: "compass_dev_session",
        value: encodeURIComponent(JSON.stringify({ user: { id: bUserId, email: B_EMAIL, name: "Roadmap Views Member", image: null } })),
        url: baseURL,
      }]);
      const bPage = await bContext.newPage();
      await pool.query(
        `INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [wsId, bUserId],
      );

      // Before sharing, the personal view is invisible to them.
      await bPage.goto(`${base}/roadmap`);
      await bPage.getByTestId("saved-views-trigger").click({ timeout: 30_000 });
      await expect(bPage.getByTestId("saved-view-option").filter({ hasText: personalName })).toHaveCount(0);
      await bPage.keyboard.press("Escape");

      // ── 4. Owner shares the view with the workspace ──────────────────────────
      await page.goto(`${base}/roadmap`);
      await page.getByTestId("saved-views-trigger").click();
      await page.getByTestId("saved-view-option").filter({ hasText: personalName }).click();
      await expect(page.getByTestId("saved-views-trigger")).toContainText(personalName);
      await page.getByRole("button", { name: `Edit view ${personalName}` }).click();
      const editDialog = page.getByRole("dialog");
      await expect(editDialog.getByRole("heading", { name: "Edit view" })).toBeVisible();
      await editDialog.getByLabel("Name").fill(viewName);
      await editDialog.getByRole("switch", { name: /Share with everyone/ }).click();
      await editDialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editDialog).toBeHidden({ timeout: 15_000 });
      await page.reload();
      await page.getByTestId("saved-views-trigger").click();
      const sharedGroup = page.getByRole("group").filter({ has: page.getByText("Shared", { exact: true }) });
      await expect(sharedGroup.getByTestId("saved-view-option").filter({ hasText: viewName }), "owner sees it under Shared after reload").toBeVisible();
      await page.keyboard.press("Escape");

      // ── 5. The other member now sees it, and can select it ───────────────────
      await bPage.goto(`${base}/roadmap`);
      await bPage.getByTestId("saved-views-trigger").click({ timeout: 30_000 });
      const bShared = bPage.getByRole("group").filter({ has: bPage.getByText("Shared", { exact: true }) });
      await expect(bShared.getByTestId("saved-view-option").filter({ hasText: viewName }), "a workspace member sees the shared view").toBeVisible();
      await bShared.getByTestId("saved-view-option").filter({ hasText: viewName }).click();
      await expect(bPage.getByTestId("saved-views-trigger")).toContainText(viewName);
      await expect(bPage.getByRole("button", { name: `Edit view ${viewName}` }), "only the owner can edit").toHaveCount(0);

      // ── 6. Sharing never widens item access ──────────────────────────────────
      await bPage.goto(`/${ORG}/roadmap`);
      await expect(bPage.getByRole("link", { name: new RegExp(alphaTitle) }), "they do see the workspace they belong to").toBeVisible({ timeout: 30_000 });
      await expect(bPage.getByRole("link", { name: new RegExp(planningTitle) }), "but not an item in a workspace they cannot access").toHaveCount(0);
      // Naming the inaccessible workspace in the URL must not reveal it either.
      await bPage.goto(`/${ORG}/roadmap?workspaces=${planningId}`);
      await expect(bPage.getByRole("link", { name: new RegExp(planningTitle) })).toHaveCount(0);
      await expect(bPage.getByText(planningTitle)).toHaveCount(0);
      // Nor can they reach the inaccessible workspace's own roadmap.
      const direct = await bPage.goto(`/${ORG}/${PLANNING}/roadmap`);
      expect(direct?.status(), "the inaccessible workspace's roadmap is not served to them").not.toBe(200);
    } finally {
      await bContext?.close();
      if (bUserId) {
        await pool.query(`DELETE FROM "${S}".roadmap_views WHERE owner_id = $1 OR name = ANY($2)`, [bUserId, [viewName, personalName]]);
        await pool.query(`DELETE FROM "${S}".workspace_members WHERE user_id = $1`, [bUserId]);
        await pool.query(`DELETE FROM "${S}".users WHERE id = $1`, [bUserId]);
      }
      await pool.query(`DELETE FROM "${S}".roadmap_views WHERE name = ANY($1)`, [[viewName, personalName]]);
      await pool.query(`DELETE FROM "${S}".roadmap_items WHERE title = ANY($1)`, [[alphaTitle, planningTitle]]);
      await pool.end();
    }
  });

  test("'roadmap' is reserved: it cannot be used as a workspace slug", async ({ page, orgSlug }) => {
    const pool = requireLocalE2eDatabase();
    try {
      await page.goto(`/${orgSlug}/settings`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Create workspace" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Roadmap");
      await expect(page.getByLabel("URL slug", { exact: true })).toHaveValue("roadmap");
      await page.getByRole("button", { name: "Create Workspace", exact: true }).click();

      await expect(page.getByText(/"roadmap" is reserved for a built-in page/)).toBeVisible({ timeout: 15_000 });
      await expect(page, "no navigation happened").toHaveURL(new RegExp(`/${orgSlug}/settings$`));
      const { rows } = await pool.query(
        `SELECT 1 FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = 'roadmap'`,
        [orgSlug],
      );
      expect(rows, "no workspace with the reserved slug was created").toHaveLength(0);
    } finally {
      await pool.end();
    }
  });
});
