/**
 * Native Building-investment decision functional spec.
 *
 * Exercises the complete human boundary rather than starting from seeded
 * authority: create a Solution, request its immutable review from the Solution
 * panel, approve it as the signed-in admin, and prove the guarded continuation
 * left one durable APPLIED authorization receipt.
 */
import path from "path";
import pg from "pg";
import { test, expect } from "../fixtures/index";

const SCHEMA = process.env.PGSCHEMA
  ? `${process.env.PGSCHEMA}_dev`
  : "compass_dev";

async function readAuthorizationReceipt(solutionTitle: string) {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  } catch {
    // CI supplies DATABASE_URL directly.
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for functional verification");
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{
      application_id: string;
      application_status: string;
      continuation_key: string;
      outcome_class: string;
      actor_role: string;
      request_state: string;
    }>(`
      SELECT
        a.id AS application_id,
        a.status AS application_status,
        a.continuation_key,
        o.outcome_class,
        d.actor_role,
        r.state AS request_state
      FROM "${SCHEMA}".solutions s
      JOIN "${SCHEMA}".review_requests r
        ON r.subject_type = 'SOLUTION'
       AND r.subject_id = s.id
       AND r.gate_type = 'BUILDING_INVESTMENT'
      JOIN "${SCHEMA}".decision_records d
        ON d.request_id = r.id
       AND d.revision_id = r.current_revision_id
      JOIN "${SCHEMA}".review_options o ON o.id = d.option_id
      JOIN "${SCHEMA}".decision_applications a ON a.decision_id = d.id
      WHERE s.title = $1
        AND a.target_type = 'SOLUTION'
        AND a.target_id = s.id
      ORDER BY a.created_at
    `, [solutionTitle]);
    return rows;
  } finally {
    await pool.end();
  }
}

test.describe("Native Building-investment decision", () => {
  test("admin requests and approves a Solution with one durable authorization receipt", async ({
    page,
    base,
  }) => {
    const stamp = Date.now();
    const opportunityTitle = `E2E Investment Opportunity ${stamp}`;
    const solutionTitle = `E2E Investment Solution ${stamp}`;

    // Arrange: create a fresh Solution through the ordinary Discovery UI.
    await page.goto(`${base}/discovery`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Add opportunity/i }).first().click();
    await page.getByLabel("Title").fill(opportunityTitle);
    await page.getByRole("button", { name: "Create Opportunity" }).click();
    await expect(page.getByText(opportunityTitle)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: opportunityTitle, exact: true }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Add Solution" }).click();
    await panel.getByLabel("Title").fill(solutionTitle);
    await panel.getByRole("button", { name: "Add Solution" }).click();
    await expect(panel.getByText(solutionTitle)).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: new RegExp(solutionTitle) }).click();

    // Act: request the immutable packet from the Solution panel and take the
    // human-only admin decision on the generic review page.
    await expect(page).toHaveURL(/detail=solution/, { timeout: 10_000 });
    await panel
      .getByRole("button", { name: "Request Building investment review" })
      .click();
    await expect(page).toHaveURL(/\/reviews\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Building investment review")).toBeVisible();
    await expect(page.getByRole("heading", {
      name: `Authorize Building investment in ${solutionTitle}`,
    })).toBeVisible();
    await page.getByRole("button", { name: "Approve Building investment" }).click();
    await expect(page.getByText(/Decision recorded:.*Approve Building investment/))
      .toBeVisible({ timeout: 15_000 });

    // Assert: the decision's guarded continuation completed exactly once and
    // retained the human authority and terminal review state.
    await expect.poll(async () => readAuthorizationReceipt(solutionTitle), {
      timeout: 15_000,
      message: "Building approval should create exactly one APPLIED receipt",
    }).toEqual([expect.objectContaining({
      application_id: expect.any(String),
      application_status: "APPLIED",
      continuation_key: "AUTHORIZE_BUILDING_INVESTMENT",
      outcome_class: "APPROVE",
      actor_role: "ADMIN",
      request_state: "DECIDED",
    })]);
  });
});
