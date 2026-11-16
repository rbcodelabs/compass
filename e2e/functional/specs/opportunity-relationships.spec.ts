import pg from "pg";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

const title = "Teams need to choose which launch stages fit their discovery process";
const feedbackTitle = "Make marketing and launch stages optional for teams focused on continuous discovery";
const krTitle = "Increase the number of teams practicing continuous discovery";

// Rows each seedRelationships() call inserts, deleted in afterAll. The objective and Key Result are the ones that matter to other specs:
// a Key Result under a cycle-less or open-cycle Objective is an eligible parent Key Result for the OKR specs (lib/okr-hierarchy.ts).
const seeded = { objectives: [] as string[], keyResults: [] as string[], opportunities: [] as string[], workspaces: [] as string[], workspaceId: "" };

test.afterAll(async () => {
  if (seeded.objectives.length === 0) return;
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const subjects = [...seeded.objectives, ...seeded.keyResults, ...seeded.opportunities];
    await pool.query(`DELETE FROM compass_dev.entity_links WHERE workspace_id = $1 AND (from_id = ANY($2::uuid[]) OR to_id = ANY($2::uuid[]))`, [seeded.workspaceId, subjects]);
    await pool.query(`DELETE FROM compass_dev.feedback WHERE opportunity_id = ANY($1::uuid[])`, [seeded.opportunities]);
    await pool.query(`DELETE FROM compass_dev.opportunities WHERE id = ANY($1::uuid[])`, [seeded.opportunities]);
    await pool.query(`DELETE FROM compass_dev.check_ins WHERE key_result_id = ANY($1::uuid[])`, [seeded.keyResults]);
    await pool.query(`DELETE FROM compass_dev.key_results WHERE id = ANY($1::uuid[])`, [seeded.keyResults]);
    await pool.query(`DELETE FROM compass_dev.objectives WHERE id = ANY($1::uuid[])`, [seeded.objectives]);
    await pool.query(`DELETE FROM compass_dev.workspaces WHERE id = ANY($1::uuid[])`, [seeded.workspaces]);
  } finally { await pool.end(); }
});

async function seedRelationships() {
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  try {
    const { rows: [workspace] } = await pool.query(`SELECT w.id, w.organization_id, c.id AS cycle_id
      FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id
      JOIN compass_dev.okr_cycles c ON c.workspace_id=w.id
      WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace' LIMIT 1`);
    const { rows: [objective] } = await pool.query(`INSERT INTO compass_dev.objectives
      (id,workspace_id,cycle_id,title) VALUES (gen_random_uuid(),$1,$2,'Help teams adopt discovery') RETURNING id`, [workspace.id, workspace.cycle_id]);
    const { rows: [kr] } = await pool.query(`INSERT INTO compass_dev.key_results
      (id,objective_id,title,target,current) VALUES (gen_random_uuid(),$1,$2,50,12) RETURNING id`, [objective.id, krTitle]);
    const { rows: [opportunity] } = await pool.query(`INSERT INTO compass_dev.opportunities
      (id,workspace_id,title,status) VALUES (gen_random_uuid(),$1,$2,'EXPLORING') RETURNING id`, [workspace.id,title]);
    // The Key Result pointer: what lib/typed-links.ts setKeyResultPointer writes (the LEGACY pointer plus the LEGACY Objective link derived
    // from it). Seeded by SQL because Playwright's loader cannot resolve the "@/..." imports of the writer's lazy-loaded lib/links/service.ts.
    await pool.query(`INSERT INTO compass_dev.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
      VALUES ($1,'OPPORTUNITY_TARGETS_KEY_RESULT','OPPORTUNITY',$2,'KEY_RESULT',$3,'LEGACY','UI',NOW(),NOW()),
             ($1,'OPPORTUNITY_TARGETS_OBJECTIVE','OPPORTUNITY',$2,'OBJECTIVE',$4,'LEGACY','UI',NOW(),NOW())`, [workspace.id, opportunity.id, kr.id, objective.id]);
    const { rows: [empty] } = await pool.query(`INSERT INTO compass_dev.opportunities
      (id,workspace_id,title,status) VALUES (gen_random_uuid(),$1,'Unlinked discovery need','EXPLORING') RETURNING id`, [workspace.id]);
    const { rows: [feedback] } = await pool.query(`INSERT INTO compass_dev.feedback
      (id,workspace_id,opportunity_id,title,status,created_at) VALUES (gen_random_uuid(),$1,$2,$3,'PLANNED','2026-08-02') RETURNING id`, [workspace.id,opportunity.id,feedbackTitle]);
    await pool.query(`INSERT INTO compass_dev.feedback
      (id,workspace_id,opportunity_id,title,status,created_at) VALUES (gen_random_uuid(),$1,$2,'Earlier discovery signal','UNDER_REVIEW','2026-08-01')`, [workspace.id,opportunity.id]);
    const { rows: [other] } = await pool.query(`INSERT INTO compass_dev.workspaces
      (id,organization_id,name,slug) VALUES (gen_random_uuid(),$1,'Other workspace',$2) RETURNING id`, [workspace.organization_id,`other-links-${opportunity.id}`]);
    // Deliberately inconsistent legacy relation: the UI must still scope its children.
    await pool.query(`INSERT INTO compass_dev.feedback
      (id,workspace_id,opportunity_id,title,status) VALUES (gen_random_uuid(),$1,$2,'Private other-workspace feedback','OPEN')`, [other.id,opportunity.id]);
    seeded.workspaceId = workspace.id;
    seeded.objectives.push(objective.id);
    seeded.keyResults.push(kr.id);
    seeded.opportunities.push(opportunity.id, empty.id);
    seeded.workspaces.push(other.id);
    return { opportunity: opportunity.id as string, feedback: feedback.id as string, kr: kr.id as string, empty: empty.id as string };
  } finally { await pool.end(); }
}

for (const [size, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } })) {
  test(`opportunity relationships: full page and panel at ${size}`, async ({ page, base }) => {
    const ids = await seedRelationships();
    await page.setViewportSize(viewport);
    await page.goto(`${base}/discovery/${ids.opportunity}?view=table`);
    await expect(page.getByText("Linked feedback (2)", { exact: true })).toBeVisible();
    await expect(page.getByText("Private other-workspace feedback")).toHaveCount(0);
    const rows = page.getByRole("button").filter({ hasText: /Make marketing and launch|Earlier discovery signal/ });
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(feedbackTitle);
    await page.screenshot({ path: `public/screenshots/docs/opportunity-links-page-${size}.png`, fullPage: true });

    await page.getByRole("button", { name: new RegExp(`Planned\\s*${feedbackTitle}`) }).click();
    const panel = page.locator('[data-slot="sheet-content"]');
    await expect(page).toHaveURL(new RegExp(`detail=feedback%3A${ids.feedback}`));
    expect(new URL(page.url()).searchParams.get("view")).toBe("table");
    await page.reload();
    await expect(panel.getByText(feedbackTitle, { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: title, exact: true }).click();
    await expect(panel.getByText("Linked feedback (2)", { exact: true })).toBeVisible();
    await expect(panel.getByText("Private other-workspace feedback")).toHaveCount(0);
    await page.screenshot({ path: `public/screenshots/docs/opportunity-links-panel-${size}.png`, fullPage: true });
    const krButton = panel.getByRole("button", { name: krTitle, exact: true });
    await krButton.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`detail=keyResult%3A${ids.kr}`));
    await expect(panel.getByText(krTitle, { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("view")).toBe("table");
    await page.goBack();
    await expect(panel.getByText("Linked feedback (2)", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: new RegExp(`Planned\\s*${feedbackTitle}`) }).click();
    await expect(page).toHaveURL(new RegExp(`detail=feedback%3A${ids.feedback}`));

    await page.goto(`${base}/discovery/${ids.opportunity}?view=table`);
    await page.getByRole("button", { name: krTitle, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`detail=keyResult%3A${ids.kr}`));
    await expect(panel.getByText(krTitle, { exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("view")).toBe("table");
    await page.goBack();
    await expect(panel).not.toBeVisible();
    await expect(page.getByText("Linked feedback (2)", { exact: true })).toBeVisible();
    await page.goto(`${base}/discovery/${ids.empty}`);
    await expect(page.getByText("No feedback linked.")).toBeVisible();
    await page.goto(`${base}/discovery?detail=opportunity:${ids.empty}`);
    await expect(panel.getByText("No feedback linked.")).toBeVisible();
    await expect(panel.getByText("No key result linked.")).toBeVisible();
  });
}
