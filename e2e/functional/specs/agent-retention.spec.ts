import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Agent-data retention cron (/api/cron/agent-retention) against the real database and the real route.
 * The functional webServer sets CRON_SECRET=e2e-cron-secret (playwright.config.ts).
 *
 * Seeds one stale and one fresh conversation (messages, a run and its events, a session pointer) plus an old message
 * inside a live conversation, calls the route, and checks exactly the over-a-year content is gone.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";
const AUTH = { authorization: "Bearer e2e-cron-secret" };

test("the retention cron deletes agent messages and run events older than a year and nothing newer", async ({ request }) => {
  test.setTimeout(120_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const id = () => randomUUID();
  const c = { stale: id(), live: id() };
  const runs = { stale: id(), live: id() };
  const hash = () => id().replaceAll("-", "").padEnd(64, "0");
  try {
    const { rows: [ws] } = await pool.query<{ id: string; user_id: string }>(
      `SELECT w.id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS user_id
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`, [ORG, WORKSPACE]);
    await pool.query(
      `INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at) VALUES
        ($1, $3, $4, 'Stale retention chat', NOW() - interval '500 days', NOW() - interval '500 days'),
        ($2, $3, $4, 'Live retention chat', NOW() - interval '500 days', NOW())`, [c.stale, c.live, ws.id, ws.user_id]);
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, created_at) VALUES
        ('00000000-0000-4000-8000-0000000000a1', $1, 'user', 'stale question', NOW() - interval '500 days'),
        ('00000000-0000-4000-8000-0000000000a2', $2, 'user', 'old message in a live chat', NOW() - interval '400 days'),
        ('00000000-0000-4000-8000-0000000000a3', $2, 'user', 'recent message in a live chat', NOW() - interval '3 days')`, [c.stale, c.live]);
    await pool.query(
      `INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at, created_at) VALUES
        ($1, $3, $5, $6, 'SUCCEEDED', $7, NOW(), NOW() - interval '500 days'),
        ($2, $4, $5, $6, 'SUCCEEDED', $8, NOW(), NOW() - interval '3 days')`, [runs.stale, runs.live, c.stale, c.live, ws.id, ws.user_id, hash(), hash()]);
    await pool.query(
      `INSERT INTO "${S}".agent_run_events (id, run_id, seq, type, payload_json, created_at) VALUES
        (gen_random_uuid(), $1, 1, 'agent', '{"drive":"old file contents"}', NOW() - interval '500 days'),
        (gen_random_uuid(), $2, 1, 'agent', '{"drive":"old file contents in live run"}', NOW() - interval '400 days'),
        (gen_random_uuid(), $2, 2, 'agent', '{"drive":"recent"}', NOW() - interval '3 days')`, [runs.stale, runs.live]);
    await pool.query(
      `INSERT INTO "${S}".agent_sessions (conversation_id, workspace_id, session_id, blob_key, through_message_id, updated_at) VALUES
        ($1, $3, 's1', $4, gen_random_uuid(), NOW() - interval '450 days'),
        ($2, $3, 's2', $5, gen_random_uuid(), NOW())`, [c.stale, c.live, ws.id, `agent-sessions/retention/${c.stale}.jsonl`, `agent-sessions/retention/${c.live}.jsonl`]);
    const n = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n);

    // Auth is enforced: the route is public to the middleware but not to anonymous callers.
    expect((await request.get("/api/cron/agent-retention")).status()).toBe(401);
    expect((await request.get("/api/cron/agent-retention", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [[c.stale, c.live]])).toBe(3);

    const response = await request.get("/api/cron/agent-retention", { headers: AUTH });
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ truncated: false });
    expect(result.messagesDeleted).toBeGreaterThanOrEqual(2);
    expect(result.runEventsDeleted).toBeGreaterThanOrEqual(2);

    const messages = (await pool.query<{ content: string }>(`SELECT content FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[]) ORDER BY content`, [[c.stale, c.live]])).rows.map((r) => r.content);
    expect(messages, "only the recent message survives").toEqual(["recent message in a live chat"]);
    const events = (await pool.query<{ payload_json: string }>(`SELECT payload_json FROM "${S}".agent_run_events WHERE run_id = ANY($1::uuid[])`, [[runs.stale, runs.live]])).rows.map((r) => r.payload_json);
    expect(events).toEqual(['{"drive":"recent"}']);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_sessions WHERE conversation_id = $1`, [c.live]), "live chat's transcript embedded pruned turns, so it goes").toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_conversations WHERE id = $1`, [c.stale]), "empty stale shell removed").toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_runs WHERE id = $1`, [runs.stale])).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_conversations WHERE id = $1`, [c.live]), "live conversation kept").toBe(1);
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_runs WHERE id = $1`, [runs.live]), "recent run kept").toBe(1);

    // Idempotent: running again finds nothing of ours to delete.
    const again = await (await request.get("/api/cron/agent-retention", { headers: AUTH })).json();
    expect(again).toMatchObject({ truncated: false });
    expect(await n(`SELECT count(*) AS n FROM "${S}".agent_messages WHERE conversation_id = $1`, [c.live])).toBe(1);
  } finally {
    await pool.query(`DELETE FROM "${S}".agent_run_events WHERE run_id = ANY($1::uuid[])`, [[runs.stale, runs.live]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_runs WHERE id = ANY($1::uuid[])`, [[runs.stale, runs.live]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_sessions WHERE conversation_id = ANY($1::uuid[])`, [[c.stale, c.live]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [[c.stale, c.live]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [[c.stale, c.live]]).catch(() => undefined);
    await pool.end();
  }
});
