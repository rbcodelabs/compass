/**
 * Feedback DataGrid functional spec.
 *
 * The Feedback board moved from a client-side card list to the standardized
 * `components/data-grid` DataGrid, with sorting, filtering and pagination all
 * executed **in Postgres** and driven by the URL. Per `.claude/pr-guidelines.md`
 * a new user-facing flow needs its own spec — keeping the existing suite green
 * is not sufficient — so this file covers the five behaviours the migration
 * introduces:
 *
 *   1. clicking a column header sorts server-side and writes `?sort`/`?dir`;
 *   2. a status filter writes `?status` and changes the *server* row count;
 *   3. pagination is real (`skip`/`take`), and pages do not overlap even when
 *      the sort column is non-unique — the `{ id: "asc" }` tiebreak;
 *   4. hiding a column persists across a reload (localStorage preferences);
 *   5. **stay-and-mark**: an inline edit that pushes a row out of the active
 *      filter leaves the row in place, marked stale, with a "no longer matches
 *      your filters" strip — and only an explicit Refresh removes it.
 *
 * (5) is the reason this file exists. It had only ever been proven with an RTL
 * `rerender()` standing in for a server round trip; here it runs against a real
 * `revalidatePath` from a real server action, which is the case that can
 * actually race the optimistic overlay.
 *
 * Rows are seeded straight into Postgres rather than through the New Feedback
 * dialog: 27 rows is the smallest set that produces two pages at the default
 * page size, and 27 dialog submissions would dominate the runtime.
 *
 * NOTE ON `?per=5`: the original plan suggested `?per=5` to get multiple pages
 * cheaply. `lib/feedback-query.ts` allowlists `per` to `[25, 50, 100]`, so `5`
 * is silently rejected and falls back to 25 — by design, so a hostile `?per=`
 * cannot force an unbounded page. Pagination is therefore exercised at the real
 * default page size instead, and the rejection of `?per=5` is asserted directly.
 */
import path from "path";
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const SCHEMA = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

/** Distinctive prefix so every seeded row can be isolated with `?q=` and dropped in afterAll. */
const SEED_PREFIX = "GRIDSEED";
const SEED_COUNT = 27;
/** Rows given UNDER_REVIEW; everything else stays OPEN. */
const UNDER_REVIEW_INDEXES = [1, 5, 9];

function label(index: number): string {
  return `${SEED_PREFIX} ${String(index).padStart(2, "0")}`;
}

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  } catch {
    // CI supplies DATABASE_URL directly.
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function deleteSeedRows(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM "${SCHEMA}".feedback WHERE title LIKE $1`, [
    `${SEED_PREFIX} %`,
  ]);
}

async function seedRows(orgSlug: string, workspaceSlug: string): Promise<void> {
  await withPool(async (pool) => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT w.id FROM "${SCHEMA}".workspaces w
       JOIN "${SCHEMA}".organizations o ON o.id = w.organization_id
       WHERE o.slug = $1 AND w.slug = $2`,
      [orgSlug, workspaceSlug],
    );
    const workspaceId = rows[0]?.id;
    if (!workspaceId) throw new Error("e2e workspace not found — did globalSetup run?");

    await deleteSeedRows(pool);

    for (let index = 0; index < SEED_COUNT; index += 1) {
      await pool.query(
        `INSERT INTO "${SCHEMA}".feedback
           (workspace_id, title, description, type, status, vote_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - ($7 || ' minutes')::interval, NOW())`,
        [
          workspaceId,
          // Vote count ASCENDS with the index, so the default ordering
          // (voteCount desc) puts the LAST index first while a title-ascending
          // sort puts the FIRST index first. That difference is what makes the
          // sort assertion meaningful rather than a coincidence.
          `${label(index)} seeded feedback`,
          `Seeded row ${index} for the DataGrid spec.`,
          index % 3 === 0 ? "BUG" : "IDEA",
          UNDER_REVIEW_INDEXES.includes(index) ? "UNDER_REVIEW" : "OPEN",
          index,
          String(SEED_COUNT - index),
        ],
      );
    }
  });
}

/** Only the seeded rows, isolated from anything other specs left behind. */
function seededUrl(base: string, extra = ""): string {
  return `${base}/feedback?q=${SEED_PREFIX}${extra}`;
}

function rows(page: Page) {
  return page.getByTestId("grid-row");
}

function rowFor(page: Page, title: string) {
  return page.getByTestId("grid-row").filter({ hasText: title });
}

test.describe("Feedback DataGrid", () => {
  test.beforeAll(async ({}, testInfo) => {
    // orgSlug/workspaceSlug are per-test fixtures; they are constants, so the
    // literal values are safe to use in a beforeAll hook.
    void testInfo;
    await seedRows("e2e-test-org", "e2e-workspace");
  });

  test.afterAll(async () => {
    // Later specs (in-app-feedback) assert a freshly created, zero-vote item is
    // visible on page 1. Leaving 27 higher-voted rows behind would push it onto
    // page 2 under the default `voteCount desc` ordering.
    await withPool(deleteSeedRows);
  });

  test("clicking a column header sorts server-side and records it in the URL", async ({
    page,
    base,
  }) => {
    await page.goto(seededUrl(base));
    await page.waitForLoadState("networkidle");

    // Default ordering is voteCount desc — the highest-index seed row.
    await expect(rows(page).first()).toContainText(label(SEED_COUNT - 1));

    // Sort by the Feedback (title) column.
    await page.getByTestId("grid-head-feedback").getByRole("button").click();

    await expect(page).toHaveURL(/sort=title/);
    await expect(page).toHaveURL(/dir=asc/);
    // The search filter survives a sort — a shared URL keeps meaning the same
    // thing after the recipient clicks a header.
    await expect(page).toHaveURL(new RegExp(`q=${SEED_PREFIX}`));

    await expect(rows(page).first()).toContainText(label(0));
    await expect(page.getByTestId("grid-head-feedback")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    // Clicking the active column flips direction rather than re-applying it.
    await page.getByTestId("grid-head-feedback").getByRole("button").click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect(rows(page).first()).toContainText(label(SEED_COUNT - 1));
  });

  test("a status filter narrows the server-side result set and shows in the URL", async ({
    page,
    base,
  }) => {
    await page.goto(seededUrl(base));
    await page.waitForLoadState("networkidle");

    // Page 1 of 27 at the default page size of 25.
    await expect(rows(page)).toHaveCount(25);

    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByRole("menuitemradio", { name: "Under review" }).click();

    await expect(page).toHaveURL(/status=UNDER_REVIEW/);
    await expect(rows(page)).toHaveCount(UNDER_REVIEW_INDEXES.length);
    await expect(page.getByTestId("grid-pagination-summary")).toContainText(
      `of ${UNDER_REVIEW_INDEXES.length} results`,
    );

    // Every remaining row really is UNDER_REVIEW — the filter ran in SQL, not
    // just in the URL.
    for (const index of UNDER_REVIEW_INDEXES) {
      await expect(rowFor(page, label(index))).toHaveCount(1);
    }
    await expect(rowFor(page, label(0))).toHaveCount(0);
  });

  test("pagination is server-side and pages never overlap", async ({ page, base }) => {
    // Sort by `status`, which is deliberately non-unique across the seeded
    // rows: without the mandatory `{ id: "asc" }` tiebreak in
    // buildFeedbackOrderBy, `skip`/`take` would silently repeat and drop rows
    // between page 1 and page 2, and this assertion is what catches it.
    await page.goto(seededUrl(base, "&sort=status&dir=asc"));
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("grid-page-indicator")).toHaveText("Page 1 of 2");
    await expect(rows(page)).toHaveCount(25);

    const firstPageIds = await rows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-row-id")),
    );

    await page.getByTestId("grid-page-next").click();

    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByTestId("grid-page-indicator")).toHaveText("Page 2 of 2");
    await expect(rows(page)).toHaveCount(SEED_COUNT - 25);

    const secondPageIds = await rows(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-row-id")),
    );

    const overlap = secondPageIds.filter((id) => firstPageIds.includes(id));
    expect(overlap).toEqual([]);
    expect(new Set([...firstPageIds, ...secondPageIds]).size).toBe(SEED_COUNT);
  });

  test("a page past the end of the result set redirects to the last real page", async ({
    page,
    base,
  }) => {
    // Bookmarked page 9 of a 2-page result set. Rendering an empty table that
    // still claims 27 results would be a lie, so the server redirects instead.
    await page.goto(seededUrl(base, "&page=9"));
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByTestId("grid-page-indicator")).toHaveText("Page 2 of 2");
    await expect(rows(page)).toHaveCount(SEED_COUNT - 25);
  });

  test("an out-of-range `per` falls back to the default page size", async ({
    page,
    base,
  }) => {
    // `per` is allowlisted to [25, 50, 100]; anything else is silently ignored
    // rather than 400-ing or reaching Prisma.
    await page.goto(seededUrl(base, "&per=5"));
    await page.waitForLoadState("networkidle");

    await expect(rows(page)).toHaveCount(25);
    await expect(page.getByTestId("grid-page-indicator")).toHaveText("Page 1 of 2");
  });

  test("hiding a column persists across a reload", async ({ page, base }) => {
    await page.goto(seededUrl(base));
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("grid-head-votes")).toBeVisible();

    await page.getByRole("button", { name: "Columns" }).click();
    await page.getByTestId("grid-column-toggle-votes").click();
    await page.keyboard.press("Escape");

    // Absence is asserted with toHaveCount(0): not.toBeVisible() passes
    // vacuously when nothing matches, which is exactly the failure mode here.
    await expect(page.getByTestId("grid-head-votes")).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("grid-head-feedback")).toBeVisible();
    await expect(page.getByTestId("grid-head-votes")).toHaveCount(0);
  });

  test("an inline edit out of the active filter marks the row stale and keeps it until Refresh", async ({
    page,
    base,
  }) => {
    const title = label(0);

    await page.goto(seededUrl(base, "&status=OPEN"));
    await page.waitForLoadState("networkidle");

    const row = rowFor(page, title);
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("grid-stale-strip")).toHaveCount(0);

    // Inline-edit the status to COMPLETED, which the active `status=OPEN`
    // filter excludes.
    await row.getByTestId("grid-cell-status").getByTestId("grid-cell-edit").click();
    await page.getByRole("option", { name: "Completed" }).click();

    // THE POINT OF THIS SPEC: the row stays put. Removing it locally would
    // leave a 24-of-25 page and desync the total and every later page's offset;
    // refetching would swap the page out from under the cursor.
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-stale", "true");
    await expect(page.getByTestId("grid-stale-strip")).toContainText(
      /no longer match/i,
    );
    await expect(row).toContainText("Completed");

    // Only an explicit Refresh reconciles with the server.
    await page.getByTestId("grid-refresh").click();

    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("grid-stale-strip")).toHaveCount(0);

    // And the write really landed: the row is there under the new status.
    await page.goto(seededUrl(base, "&status=COMPLETED"));
    await page.waitForLoadState("networkidle");
    await expect(rowFor(page, title)).toHaveCount(1);
  });
});
