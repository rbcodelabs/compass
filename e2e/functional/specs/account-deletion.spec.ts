import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";

/**
 * Self-service account deletion (Settings, Profile).
 *
 * Real users via dev-credentials logins, real database, real deletion code. Nothing is mocked except that Google's
 * revocation endpoint is reached with a deliberately fake token (best effort, never blocks, returns 400).
 *
 *   X  member of the shared e2e workspace with agent data, a comment and a task: deletes the account.
 *   Z  the only administrator of a workspace other people belong to: blocked.
 *   W  the only member of their own organization and workspace: must consent, then it is deleted too.
 *
 * The signed-in dev user (storageState) is the teammate whose data must survive.
 */
const S = "compass_dev";
const ORG = "e2e-test-org";
const WORKSPACE = "e2e-workspace";

test("a user deletes their account: personal data and session go, teammates and shared content stay", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const baseURL = test.info().project.use.baseURL as string;
  const suffix = randomUUID().slice(0, 8);
  const email = `del-member-${suffix}@localhost.dev`;
  const contexts: BrowserContext[] = [];
  const disposables: APIRequestContext[] = [];
  const ids = { x: "", a: "", workspace: "", org: "" };
  const own = { conv: randomUUID(), run: randomUUID(), theirConv: randomUUID(), comment: randomUUID(), task: randomUUID(), key: randomUUID() };

  async function signIn(address: string) {
    const login = await playwright.request.newContext({ baseURL });
    disposables.push(login);
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const response = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: address, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(response.status());
    const state = await login.storageState();
    const context = await browser.newContext({ storageState: state, baseURL });
    contexts.push(context);
    return { context, state };
  }
  const count = async (sql: string, params: unknown[]) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n);

  try {
    const { context, state } = await signIn(email);
    const x = await pool.query<{ id: string }>(`UPDATE "${S}".users SET name = 'Leaving Member' WHERE email = $1 RETURNING id`, [email]);
    ids.x = x.rows[0].id;
    const ws = await pool.query<{ workspace_id: string; org_id: string; a: string }>(
      `SELECT w.id AS workspace_id, o.id AS org_id, (SELECT id FROM "${S}".users WHERE email = 'dev@localhost.dev') AS a
         FROM "${S}".workspaces w JOIN "${S}".organizations o ON o.id = w.organization_id WHERE o.slug = $1 AND w.slug = $2`,
      [ORG, WORKSPACE],
    );
    ids.workspace = ws.rows[0].workspace_id;
    ids.org = ws.rows[0].org_id;
    ids.a = ws.rows[0].a;

    // X belongs to the shared org and workspace as an ordinary member (the dev user remains the administrator).
    await pool.query(`INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT DO NOTHING`, [ids.org, ids.x]);
    await pool.query(`INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'MEMBER', NOW()) ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ids.workspace, ids.x]);

    // Personal data of X, across the tables the deletion has to reach.
    await pool.query(`INSERT INTO "${S}".accounts (user_id, type, provider, provider_account_id, refresh_token, access_token, created_at) VALUES ($1, 'oidc', 'google', $2, 'fake-refresh-token', 'fake-access-token', NOW())`, [ids.x, `g-${suffix}`]);
    await pool.query(`INSERT INTO "${S}".agent_conversations (id, workspace_id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, 'X private chat', NOW(), NOW()), ($4, $2, $5, 'Teammate chat', NOW(), NOW())`, [own.conv, ids.workspace, ids.x, own.theirConv, ids.a]);
    await pool.query(
      `INSERT INTO "${S}".agent_messages (id, conversation_id, role, content, author_user_id, created_at) VALUES
        (gen_random_uuid(), $1, 'user', 'X asks about a Drive file', $2, NOW()),
        (gen_random_uuid(), $3, 'user', 'Teammate question', $4, NOW()),
        (gen_random_uuid(), $3, 'user', 'X chimes in on the teammate chat', $2, NOW())`,
      [own.conv, ids.x, own.theirConv, ids.a],
    );
    await pool.query(`INSERT INTO "${S}".agent_runs (id, conversation_id, workspace_id, user_id, status, worker_token_hash, deadline_at) VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, NOW())`, [own.run, own.conv, ids.workspace, ids.x, randomUUID().replaceAll("-", "").padEnd(64, "0")]);
    await pool.query(`INSERT INTO "${S}".agent_run_events (id, run_id, seq, type, payload_json) VALUES (gen_random_uuid(), $1, 1, 'agent', '{"drive":"file contents"}')`, [own.run]);
    await pool.query(`INSERT INTO "${S}".agent_sessions (conversation_id, workspace_id, session_id, blob_key, through_message_id) VALUES ($1, $2, 'sess', $3, gen_random_uuid())`, [own.conv, ids.workspace, `agent-sessions/${suffix}/transcript.jsonl`]);
    await pool.query(`INSERT INTO "${S}".api_keys (id, user_id, name, key_hash, key_prefix) VALUES ($1, $2, 'X key', $3, 'cmp_test')`, [own.key, ids.x, randomUUID().replaceAll("-", "").padEnd(64, "1")]);
    // Shared content authored by X: must stay, with attribution removed.
    await pool.query(`INSERT INTO "${S}".comments (id, workspace_id, target_type, target_id, body, author_id, author_name, author_type, created_at, updated_at) VALUES ($1, $2, 'ROADMAP_ITEM', gen_random_uuid(), 'A comment X left behind', $3, 'Leaving Member', 'HUMAN', NOW(), NOW())`, [own.comment, ids.workspace, ids.x]);
    await pool.query(`INSERT INTO "${S}".tasks (id, workspace_id, title, assignee_user_id, created_by_id, created_at, updated_at) VALUES ($1, $2, 'Task X was assigned', $3, $3, NOW(), NOW())`, [own.task, ids.workspace, ids.x]);

    // ── The Settings UI ─────────────────────────────────────────────────────────
    const xPage = await context.newPage();
    await xPage.setViewportSize({ width: 1280, height: 1000 });
    await xPage.goto("/settings/profile");
    await expect(xPage.getByRole("heading", { name: "Delete account" })).toBeVisible({ timeout: 45_000 });
    const confirm = xPage.getByLabel(/Type .* to confirm/);
    const submit = xPage.getByRole("button", { name: "Delete my account" });
    await expect(submit, "disabled until the email is typed").toBeDisabled();
    await expect(xPage.getByRole("alert"), "no blockers for an ordinary member").toHaveCount(0);
    await confirm.fill("someone-else@example.com");
    await expect(submit, "a wrong email keeps it disabled").toBeDisabled();
    await xPage.screenshot({ path: testInfo.outputPath("account-deletion-settings.png"), fullPage: true });
    await confirm.fill(email.toUpperCase());
    await expect(submit, "email match is case-insensitive").toBeEnabled();

    // Sign-in material is still there up to the click.
    expect(await count(`SELECT count(*) AS n FROM "${S}".sessions WHERE user_id = $1`, [ids.x]) + await count(`SELECT count(*) AS n FROM "${S}".accounts WHERE user_id = $1`, [ids.x])).toBeGreaterThan(0);

    await Promise.all([xPage.waitForURL((url) => url.pathname === "/", { timeout: 90_000 }), submit.click()]);

    // ── Personal data is gone ───────────────────────────────────────────────────
    expect(await count(`SELECT count(*) AS n FROM "${S}".users WHERE id = $1`, [ids.x])).toBe(0);
    for (const [table, column] of [["accounts", "user_id"], ["sessions", "user_id"], ["workspace_members", "user_id"], ["organization_members", "user_id"], ["api_keys", "user_id"], ["agent_conversations", "user_id"], ["agent_runs", "user_id"]] as const) {
      expect(await count(`SELECT count(*) AS n FROM "${S}".${table} WHERE ${column} = $1`, [ids.x]), table).toBe(0);
    }
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_messages WHERE conversation_id = $1`, [own.conv])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_run_events WHERE run_id = $1`, [own.run])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_sessions WHERE conversation_id = $1`, [own.conv])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_messages WHERE author_user_id = $1`, [ids.x]), "X's own messages inside someone else's chat").toBe(0);

    // ── Teammates and shared content are untouched ──────────────────────────────
    expect(await count(`SELECT count(*) AS n FROM "${S}".users WHERE id = $1`, [ids.a])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_conversations WHERE id = $1`, [own.theirConv])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM "${S}".agent_messages WHERE conversation_id = $1 AND author_user_id = $2`, [own.theirConv, ids.a])).toBe(1);
    const comment = (await pool.query<{ author_name: string; author_id: string }>(`SELECT author_name, author_id FROM "${S}".comments WHERE id = $1`, [own.comment])).rows[0];
    expect(comment.author_name, "name scrubbed, comment kept").toBe("Deleted user");
    const task = (await pool.query<{ assignee_user_id: string | null; created_by_id: string }>(`SELECT assignee_user_id, created_by_id FROM "${S}".tasks WHERE id = $1`, [own.task])).rows[0];
    expect(task.assignee_user_id, "assignment cleared").toBeNull();
    expect(task.created_by_id, "authorship id left dangling, not rewritten").toBe(ids.x);

    // ── The session is dead: the public home page renders, protected routes refuse ─
    await expect(xPage.getByRole("link", { name: /sign in|log in/i }).first()).toBeVisible({ timeout: 30_000 });
    await xPage.goto("/settings/profile");
    await expect(xPage).toHaveURL(/\/login/);
    // Replaying the old cookie from before the deletion cannot act on the account either.
    const replay = await playwright.request.newContext({ baseURL, storageState: state });
    disposables.push(replay);
    const replayed = await replay.get("/api/account", { maxRedirects: 0 });
    expect([302, 307, 401, 404]).toContain(replayed.status());
    const replayedDelete = await replay.delete("/api/account", { data: { confirmEmail: email }, maxRedirects: 0 });
    expect([302, 307, 401, 404]).toContain(replayedDelete.status());
  } finally {
    await pool.query(`DELETE FROM "${S}".tasks WHERE id = $1`, [own.task]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".comments WHERE id = $1`, [own.comment]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_messages WHERE conversation_id = ANY($1::uuid[])`, [[own.conv, own.theirConv]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".agent_conversations WHERE id = ANY($1::uuid[])`, [[own.conv, own.theirConv]]).catch(() => undefined);
    await pool.query(`DELETE FROM "${S}".users WHERE email = $1`, [email]).catch(() => undefined);
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const api of disposables) await api.dispose().catch(() => undefined);
    await pool.end();
  }
});

test("deletion is blocked for the sole administrator of a shared workspace, and needs consent for resources only the user belongs to", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(240_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const baseURL = test.info().project.use.baseURL as string;
  const suffix = randomUUID().slice(0, 8);
  const zEmail = `del-admin-${suffix}@localhost.dev`;
  const wEmail = `del-solo-${suffix}@localhost.dev`;
  const sharedOrg = { id: randomUUID(), slug: `del-shared-${suffix}`, ws: randomUUID() };
  const soloOrg = { id: randomUUID(), slug: `del-solo-${suffix}`, ws: randomUUID() };
  const contexts: BrowserContext[] = [];
  const disposables: APIRequestContext[] = [];

  async function signIn(address: string) {
    const login = await playwright.request.newContext({ baseURL });
    disposables.push(login);
    const csrf = (await (await login.get("/api/auth/csrf")).json()) as { csrfToken: string };
    const response = await login.post("/api/auth/callback/dev-credentials", {
      form: { csrfToken: csrf.csrfToken, email: address, callbackUrl: `${baseURL}/dashboard` },
      maxRedirects: 0,
    });
    expect([200, 302]).toContain(response.status());
    const context = await browser.newContext({ storageState: await login.storageState(), baseURL });
    contexts.push(context);
    return context;
  }
  const userId = async (address: string) => (await pool.query<{ id: string }>(`SELECT id FROM "${S}".users WHERE email = $1`, [address])).rows[0].id;
  const count = async (sql: string, params: unknown[]) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n);
  async function team(org: typeof sharedOrg, name: string, members: { user: string; orgRole: string; wsRole: string }[]) {
    await pool.query(`INSERT INTO "${S}".organizations (id, slug, name) VALUES ($1, $2, $3)`, [org.id, org.slug, name]);
    await pool.query(`INSERT INTO "${S}".workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'main', $3)`, [org.ws, org.id, `${name} Workspace`]);
    for (const m of members) {
      await pool.query(`INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW())`, [org.id, m.user, m.orgRole]);
      await pool.query(`INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW())`, [org.ws, m.user, m.wsRole]);
    }
  }

  try {
    const zContext = await signIn(zEmail);
    const wContext = await signIn(wEmail);
    const z = await userId(zEmail);
    const w = await userId(wEmail);
    const a = await userId("dev@localhost.dev");
    await team(sharedOrg, "Shared Team", [{ user: z, orgRole: "OWNER", wsRole: "ADMIN" }, { user: a, orgRole: "MEMBER", wsRole: "MEMBER" }]);
    await team(soloOrg, "Solo Team", [{ user: w, orgRole: "OWNER", wsRole: "ADMIN" }]);

    // ── Z: blocked ──────────────────────────────────────────────────────────────
    const zPage = await zContext.newPage();
    await zPage.setViewportSize({ width: 1280, height: 1000 });
    await zPage.goto("/settings/profile");
    const blockers = zPage.getByRole("alert").filter({ hasText: "Before you can delete your account" });
    await expect(blockers).toBeVisible({ timeout: 45_000 });
    await expect(blockers).toContainText("Shared Team");
    await expect(zPage.getByRole("button", { name: "Delete my account" })).toBeDisabled();
    await expect(zPage.getByLabel(/Type .* to confirm/)).toBeDisabled();
    await zPage.screenshot({ path: testInfo.outputPath("account-deletion-blocked.png"), fullPage: true });
    const refused = await zContext.request.delete("/api/account", { data: { confirmEmail: zEmail } });
    expect(refused.status(), "the API refuses even if the UI is bypassed").toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody.blockers.map((b: { kind: string }) => b.kind)).toContain("ORGANIZATION_SOLE_OWNER");
    expect(await count(`SELECT count(*) AS n FROM "${S}".users WHERE id = $1`, [z])).toBe(1);
    expect((await zContext.request.delete("/api/account", { data: { confirmEmail: "wrong@example.com" } })).status()).toBe(400);
    expect((await zContext.request.delete("/api/account", { headers: { "content-type": "text/plain" }, data: "x" })).status()).toBe(415);

    // ── W: consent required, then the solo organization and workspace go with the account ─
    const wPage = await wContext.newPage();
    await wPage.setViewportSize({ width: 1280, height: 1000 });
    await wPage.goto("/settings/profile");
    await expect(wPage.getByText("Only you belong to these, so they would be deleted too")).toBeVisible({ timeout: 45_000 });
    await expect(wPage.getByText("Solo Team", { exact: true }).first()).toBeVisible();
    const submit = wPage.getByRole("button", { name: "Delete my account" });
    await wPage.getByLabel(/Type .* to confirm/).fill(wEmail);
    await expect(submit, "typing the email is not enough without consent").toBeDisabled();
    expect((await wContext.request.delete("/api/account", { data: { confirmEmail: wEmail } })).status(), "the API demands consent too").toBe(409);
    expect(await count(`SELECT count(*) AS n FROM "${S}".organizations WHERE id = $1`, [soloOrg.id])).toBe(1);
    await wPage.getByLabel(/I understand these will be permanently deleted/).check();
    await wPage.screenshot({ path: testInfo.outputPath("account-deletion-sole-owned.png"), fullPage: true });
    await expect(submit).toBeEnabled();
    await Promise.all([wPage.waitForURL((url) => url.pathname === "/", { timeout: 120_000 }), submit.click()]);
    expect(await count(`SELECT count(*) AS n FROM "${S}".users WHERE id = $1`, [w])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".organizations WHERE id = $1`, [soloOrg.id]), "solo organization deleted").toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".workspaces WHERE id = $1`, [soloOrg.ws]), "solo workspace deleted").toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${S}".organizations WHERE id = $1`, [sharedOrg.id]), "other teams untouched").toBe(1);
  } finally {
    for (const org of [sharedOrg, soloOrg]) {
      await pool.query(`DELETE FROM "${S}".workspace_members WHERE workspace_id = $1`, [org.ws]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".organization_members WHERE organization_id = $1`, [org.id]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".workspaces WHERE id = $1`, [org.ws]).catch(() => undefined);
      await pool.query(`DELETE FROM "${S}".organizations WHERE id = $1`, [org.id]).catch(() => undefined);
    }
    await pool.query(`DELETE FROM "${S}".users WHERE email = ANY($1::text[])`, [[zEmail, wEmail]]).catch(() => undefined);
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const api of disposables) await api.dispose().catch(() => undefined);
    await pool.end();
  }
});
