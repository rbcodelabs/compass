import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Which model credential an agent run used (TASK-89 follow-up).
 *
 * No LLM turn is needed. A conversation and a RUNNING run row carrying a credential source are seeded straight into the database;
 * the real page, the real active-run route and the real run serializer are driven, so the label shown is the one that travelled
 * database column -> server -> client. Asserts every label, the unknown case (no line), that the API never returns anything but
 * the closed label, and captures desktop and mobile screenshots.
 */
const S = "compass_dev";

const CASES = [
  ["platform-api-key", "Platform API key"],
  ["workspace-api-key", "Workspace API key"],
  ["claude-subscription", "Claude subscription"],
  ["bedrock", "Bedrock"],
  ["gateway", "AI Gateway"],
] as const;

test("a live agent run shows which model credential it used, and nothing secret", async ({ page, base }) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const conversationId = randomUUID();
  const runId = randomUUID();
  const secretLike = "sk-ant-api03-must-never-be-displayed-0000";
  try {
    const { rows: [ids] } = await pool.query<{ workspace_id: string; owner_id: string }>(
      `SELECT w.id AS workspace_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS owner_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id
        WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace'`,
    );
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, 'Credential source run', NOW(), NOW())`,
      [conversationId, ids.workspace_id, ids.owner_id],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at) VALUES (gen_random_uuid(), $1, 'user', 'Summarize the roadmap', $2, NOW())`,
      [conversationId, ids.owner_id],
    );
    await pool.query(
      `INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, status_changed_at, started_at, last_heartbeat_at, model, credential_source)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5, NOW() + interval '1 hour', NOW(), NOW(), NOW(), 'claude-sonnet-5', 'workspace-api-key')`,
      [runId, conversationId, ids.workspace_id, ids.owner_id, randomUUID().replaceAll("-", "").padEnd(64, "0")],
    );

    const line = page.getByTestId("run-credential-line");

    for (const [source, label] of CASES) {
      await pool.query(`UPDATE "${S}".agent_runs SET credential_source = $2 WHERE id = $1`, [runId, source]);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${base}/agent?c=${conversationId}`);
      await expect(line).toHaveText(`Model credential: ${label}`, { timeout: 30_000 });
      if (source === "workspace-api-key") {
        await page.screenshot({ path: test.info().outputPath("credential-source-desktop.png") });
        await test.info().attach("credential-source-desktop", { path: test.info().outputPath("credential-source-desktop.png"), contentType: "image/png" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(line).toHaveText(`Model credential: ${label}`, { timeout: 30_000 });
        await expect(line).toBeVisible();
        // The line must not make the phone layout scroll sideways.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath("credential-source-mobile.png") });
        await test.info().attach("credential-source-mobile", { path: test.info().outputPath("credential-source-mobile.png"), contentType: "image/png" });
      }
    }

    // Unknown (a run that predates the column, or any value outside the closed set) shows no credential line and echoes nothing.
    await pool.query(`UPDATE "${S}".agent_runs SET credential_source = NULL WHERE id = $1`, [runId]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/agent?c=${conversationId}`);
    await expect(page.getByText(/Answering on|is answering/).first()).toBeVisible({ timeout: 30_000 });
    await expect(line).toHaveCount(0);

    await pool.query(`UPDATE "${S}".agent_runs SET credential_source = $2 WHERE id = $1`, [runId, secretLike.slice(0, 30)]);
    const body = await (await page.request.get(`/api/agent/runs/${runId}`)).text();
    expect(body).not.toContain("sk-ant");
    expect(JSON.parse(body).run.credentialSource).toBeNull();

    await pool.query(`UPDATE "${S}".agent_runs SET credential_source = 'bedrock' WHERE id = $1`, [runId]);
    const api = await (await page.request.get(`/api/agent/runs/${runId}`)).json();
    expect(api.run.credentialSource).toBe("bedrock");
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE id = $1`, [runId]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = $1`, [conversationId]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = $1`, [conversationId]).catch(() => undefined);
    await pool.end();
  }
});
