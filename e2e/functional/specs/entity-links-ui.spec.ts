/**
 * entity_links is the only link store: drive the four link families through the real UI at desktop and mobile widths.
 * (1) Task -> Opportunity / Roadmap item, (2) Artifact -> Solution, (3) Opportunity <-> Objective, (4) Solution <-> Key Result.
 * Each flow creates the link in the UI, sees it rendered, removes it, sees it gone, and reloads to confirm both states persisted.
 *
 * A synthetic TORRES_OST org/workspace is created and removed by id. Raw SQL inserts only ordinary rows and COUNTS / DELETES link
 * rows (never inserts or updates them), per the typed-link-access guard. Screenshots go to /tmp/qa-entity-links/.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";
import { E2E_SCHEMA, isolatedE2EConnectionString } from "../fixtures/isolated-database";

const S = `"${E2E_SCHEMA}"`;
const SHOTS = "/tmp/qa-entity-links";
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
];

for (const viewport of VIEWPORTS) {
  test.describe.serial(`Entity links UI (${viewport.label})`, () => {
    test.setTimeout(180_000);
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const suffix = randomUUID().slice(0, 8);
    const orgSlug = `elk-org-${viewport.label}-${suffix}`;
    const workspaceSlug = `elk-ws-${viewport.label}-${suffix}`;
    const base = `/${orgSlug}/${workspaceSlug}`;
    const tag = `ELK ${viewport.label} ${Date.now()}`;
    const ids = { org: randomUUID(), workspace: randomUUID(), cycle: randomUUID(), objective: randomUUID(), kr: randomUUID(), opp: randomUUID(), linkOpp: randomUUID(), roadmap: randomUUID(), solution: randomUUID(), task: randomUUID() };
    const titles = {
      task: `${tag} task`, linkOpp: `${tag} linkable need`, roadmap: `${tag} roadmap item`, opp: `${tag} need`, solution: `${tag} solution`,
      objective: `${tag} aim`, kr: `${tag} metric`, artifact: `${tag} artifact`,
    };
    let pool: pg.Pool;
    let artifactId = "";
    const problems: string[] = [];

    const count = async (linkType: string, where: string, params: unknown[]) =>
      (await pool.query(`SELECT count(*)::int AS n FROM ${S}.entity_links WHERE workspace_id = $1 AND link_type = '${linkType}' AND ${where}`, [ids.workspace, ...params])).rows[0].n as number;
    const shot = (page: Page, flow: string) => page.screenshot({ path: `${SHOTS}/${viewport.label}-${flow}.png`, animations: "disabled", style: "nextjs-portal { display: none }" });
    /** The Solution panel's Artifacts section is collapsed by default; expand it if it is. */
    const openArtifactsSection = async (page: Page) => {
      const header = page.locator('[data-slot="sheet-content"]').getByRole("button", { name: /^Artifacts/ });
      await expect(header).toBeVisible({ timeout: 30_000 });
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    };
    const noHorizontalOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    test.beforeAll(async () => {
      mkdirSync(SHOTS, { recursive: true });
      pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
      const userId = (await pool.query(`SELECT id FROM ${S}.users WHERE email = 'dev@localhost.dev'`)).rows[0].id;
      await pool.query(`INSERT INTO ${S}.organizations (id, slug, name) VALUES ($1, $2, $3)`, [ids.org, orgSlug, `${tag} org`]);
      await pool.query(`INSERT INTO ${S}.organization_members (organization_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [ids.org, userId]);
      await pool.query(`INSERT INTO ${S}.workspaces (id, organization_id, slug, name, thinking_model) VALUES ($1, $2, $3, $4, 'TORRES_OST')`, [ids.workspace, ids.org, workspaceSlug, `${tag} workspace`]);
      await pool.query(`INSERT INTO ${S}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'ADMIN')`, [ids.workspace, userId]);
      await pool.query(`INSERT INTO ${S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1, $2, $3, '2026-07-01', '2026-09-30')`, [ids.cycle, ids.workspace, `${tag} cycle`]);
      await pool.query(`INSERT INTO ${S}.objectives (id, workspace_id, cycle_id, title) VALUES ($1, $2, $3, $4)`, [ids.objective, ids.workspace, ids.cycle, titles.objective]);
      await pool.query(`INSERT INTO ${S}.key_results (id, objective_id, title, target) VALUES ($1, $2, $3, 10)`, [ids.kr, ids.objective, titles.kr]);
      await pool.query(`INSERT INTO ${S}.opportunities (id, workspace_id, title) VALUES ($1, $2, $3), ($4, $2, $5)`, [ids.opp, ids.workspace, titles.opp, ids.linkOpp, titles.linkOpp]);
      await pool.query(`INSERT INTO ${S}.solutions (id, workspace_id, opportunity_id, title) VALUES ($1, $2, $3, $4)`, [ids.solution, ids.workspace, ids.opp, titles.solution]);
      await pool.query(`INSERT INTO ${S}.roadmap_items (id, workspace_id, title) VALUES ($1, $2, $3)`, [ids.roadmap, ids.workspace, titles.roadmap]);
      await pool.query(`INSERT INTO ${S}.tasks (id, workspace_id, title, status, priority, sort_order, created_at, updated_at) VALUES ($1, $2, $3, 'TODO', 'MEDIUM', 1, NOW(), NOW())`, [ids.task, ids.workspace, titles.task]);
    });

    test.afterAll(async () => {
      if (!pool) return;
      try {
        await pool.query(`DELETE FROM ${S}.entity_links WHERE workspace_id = $1`, [ids.workspace]);
        await pool.query(`UPDATE ${S}.artifacts SET current_revision_id = NULL WHERE workspace_id = $1`, [ids.workspace]);
        await pool.query(`DELETE FROM ${S}.artifact_revisions WHERE artifact_id IN (SELECT id FROM ${S}.artifacts WHERE workspace_id = $1)`, [ids.workspace]);
        await pool.query(`DELETE FROM ${S}.artifacts WHERE workspace_id = $1`, [ids.workspace]);
        for (const table of ["tasks", "roadmap_items", "solutions", "opportunities"]) await pool.query(`DELETE FROM ${S}.${table} WHERE workspace_id = $1`, [ids.workspace]);
        await pool.query(`DELETE FROM ${S}.key_results WHERE id = $1`, [ids.kr]);
        await pool.query(`DELETE FROM ${S}.objectives WHERE id = $1`, [ids.objective]);
        await pool.query(`DELETE FROM ${S}.okr_cycles WHERE id = $1`, [ids.cycle]);
        await pool.query(`DELETE FROM ${S}.workspace_members WHERE workspace_id = $1`, [ids.workspace]);
        await pool.query(`DELETE FROM ${S}.workspaces WHERE id = $1`, [ids.workspace]);
        await pool.query(`DELETE FROM ${S}.organization_members WHERE organization_id = $1`, [ids.org]);
        await pool.query(`DELETE FROM ${S}.organizations WHERE id = $1`, [ids.org]);
      } finally {
        await pool.end();
      }
    });

    test.beforeEach(({ page }) => {
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        // A bare "Failed to load resource ... 404" carries no URL; the response listener below reports 404s with their URL.
        if (message.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 404/i.test(message.text())) problems.push(`console: ${message.text()}`);
      });
      page.on("response", (response) => {
        // /_vercel/insights/script.js is injected by the Vercel Analytics component and does not exist outside Vercel (environmental, not a link bug).
        if (response.status() === 404 && !response.url().includes("/_vercel/insights/")) problems.push(`HTTP 404 ${response.request().method()} ${response.url()}`);
        if (response.status() >= 500) problems.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
      });
    });

    test("task links: link to an opportunity and a roadmap item from the Tasks board detail, then unlink", async ({ page }) => {
      await page.goto(`${base}/tasks`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: titles.task, exact: true }).first().click();
      const panel = page.locator('[data-slot="sheet-content"]');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText("No links yet.")).toBeVisible({ timeout: 15_000 });

      for (const [title, kind] of [[titles.linkOpp, "Opportunity"], [titles.roadmap, "Roadmap"]] as const) {
        await panel.getByRole("button", { name: "Add link" }).click();
        const dialog = page.getByRole("dialog", { name: "Link to another item" });
        await dialog.getByRole("combobox", { name: "Search linkable items" }).fill(title);
        await dialog.getByRole("option", { name: new RegExp(`^${title} ${kind}`, "i") }).click();
        await dialog.getByRole("button", { name: "Link item" }).click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
      }
      await expect(panel.getByText(titles.linkOpp)).toBeVisible();
      await expect(panel.getByText(titles.roadmap)).toBeVisible();
      expect(await count("TASK_REFERENCES", "from_id = $2", [ids.task])).toBe(2);
      await shot(page, "task-linked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      const reloaded = page.locator('[data-slot="sheet-content"]');
      await expect(reloaded.getByText(titles.linkOpp)).toBeVisible({ timeout: 30_000 });
      await expect(reloaded.getByText(titles.roadmap)).toBeVisible();

      for (const title of [titles.linkOpp, titles.roadmap]) await reloaded.getByRole("button", { name: `Unlink ${title}` }).click();
      await expect(reloaded.getByText("No links yet.")).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => count("TASK_REFERENCES", "from_id = $2", [ids.task]), { timeout: 15_000 }).toBe(0);
      await shot(page, "task-unlinked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.locator('[data-slot="sheet-content"]').getByText("No links yet.")).toBeVisible({ timeout: 30_000 });
      await noHorizontalOverflow(page);
    });

    test("artifact links: attach an artifact to a solution and unlink it", async ({ page }) => {
      await page.goto(`${base}/docs/artifacts/new`);
      await page.getByLabel("Title").fill(titles.artifact);
      await page.getByLabel("Self-contained HTML file").setInputFiles({ name: "a.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><html><body><h1>ELK</h1></body></html>") });
      await page.getByRole("button", { name: "Create artifact", exact: true }).click();
      await page.waitForURL(/\/docs\/artifacts\/[0-9a-f-]+$/, { timeout: 30_000 });
      artifactId = page.url().split("/").at(-1)!;

      await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
      await page.waitForLoadState("networkidle");
      const panel = page.locator('[data-slot="sheet-content"]');
      await openArtifactsSection(page);
      await expect(panel.getByText("No linked artifacts.")).toBeVisible({ timeout: 30_000 });
      await panel.getByRole("combobox", { name: "Artifact to link" }).click();
      await page.getByRole("option", { name: titles.artifact }).click();
      await panel.getByRole("button", { name: "Link", exact: true }).click();
      await expect(panel.getByRole("link", { name: titles.artifact })).toBeVisible({ timeout: 15_000 });
      expect(await count("ARTIFACT_ATTACHED_TO_SOLUTION", "from_id = $2 AND to_id = $3", [artifactId, ids.solution])).toBe(1);
      await shot(page, "artifact-linked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      const reloaded = page.locator('[data-slot="sheet-content"]');
      await openArtifactsSection(page);
      await expect(reloaded.getByRole("link", { name: titles.artifact })).toBeVisible({ timeout: 30_000 });

      await reloaded.getByRole("button", { name: "Unlink", exact: true }).click();
      await expect(reloaded.getByText("No linked artifacts.")).toBeVisible({ timeout: 15_000 });
      expect(await count("ARTIFACT_ATTACHED_TO_SOLUTION", "from_id = $2", [artifactId])).toBe(0);
      await shot(page, "artifact-unlinked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      await openArtifactsSection(page);
      await expect(page.locator('[data-slot="sheet-content"]').getByText("No linked artifacts.")).toBeVisible({ timeout: 30_000 });
      await noHorizontalOverflow(page);
    });

    test("opportunity <-> objective: link through the opportunity picker and unlink", async ({ page }) => {
      await page.goto(`${base}/discovery?detail=opportunity:${ids.opp}`);
      await page.waitForLoadState("networkidle");
      const picker = page.getByTestId("opportunity-objective-picker");
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await picker.getByRole("button", { name: /^Choose/ }).click();
      await page.getByRole("menuitemcheckbox", { name: new RegExp(titles.objective) }).click();
      await expect(picker.getByRole("listitem")).toContainText(titles.objective, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      expect(await count("OPPORTUNITY_TARGETS_OBJECTIVE", "from_id = $2 AND to_id = $3", [ids.opp, ids.objective])).toBe(1);
      await shot(page, "objective-linked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      const reloadedPicker = page.getByTestId("opportunity-objective-picker");
      await expect(reloadedPicker.getByRole("listitem")).toContainText(titles.objective, { timeout: 30_000 });

      await reloadedPicker.getByRole("button", { name: /^Choose/ }).click();
      await page.getByRole("menuitemcheckbox", { name: new RegExp(titles.objective) }).click();
      await expect(reloadedPicker.getByRole("listitem")).toHaveCount(0, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      expect(await count("OPPORTUNITY_TARGETS_OBJECTIVE", "from_id = $2", [ids.opp])).toBe(0);
      await shot(page, "objective-unlinked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("opportunity-objective-picker").getByRole("listitem")).toHaveCount(0, { timeout: 30_000 });
      await noHorizontalOverflow(page);
    });

    test("solution <-> key result: link in the Solution panel and unlink", async ({ page }) => {
      await page.goto(`${base}/discovery?detail=solution:${ids.solution}`);
      await page.waitForLoadState("networkidle");
      const picker = page.getByTestId("solution-key-result-picker");
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await picker.getByRole("button", { name: /^Choose/ }).click();
      await page.getByRole("menuitemcheckbox", { name: new RegExp(titles.kr) }).click();
      await expect(picker.getByRole("listitem")).toContainText(titles.kr, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      expect(await count("SOLUTION_TARGETS_KEY_RESULT", "from_id = $2 AND to_id = $3", [ids.solution, ids.kr])).toBe(1);
      await shot(page, "keyresult-linked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      const reloadedPicker = page.getByTestId("solution-key-result-picker");
      await expect(reloadedPicker.getByRole("listitem")).toContainText(titles.kr, { timeout: 30_000 });

      await reloadedPicker.getByRole("button", { name: /^Choose/ }).click();
      await page.getByRole("menuitemcheckbox", { name: new RegExp(titles.kr) }).click();
      await expect(reloadedPicker).toContainText(/No .* linked/, { timeout: 15_000 });
      await page.keyboard.press("Escape");
      expect(await count("SOLUTION_TARGETS_KEY_RESULT", "from_id = $2", [ids.solution])).toBe(0);
      await shot(page, "keyresult-unlinked");

      await page.reload();
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("solution-key-result-picker")).toContainText(/No .* linked/, { timeout: 30_000 });
      await noHorizontalOverflow(page);
    });

    test("no console errors, page errors or HTTP 5xx across the four flows", () => {
      expect(problems).toEqual([]);
    });
  });
}
