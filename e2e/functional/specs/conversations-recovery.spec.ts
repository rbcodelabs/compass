import { randomUUID } from "node:crypto";
import pg from "pg";
import { test, expect } from "../fixtures/index";
import { isolatedE2EConnectionString } from "../fixtures/isolated-database";

async function seed(pool: pg.Pool) {
  const fixture = { task: randomUUID(), conversation: randomUUID(), privateConversation: randomUUID(), foreignConversation: randomUUID(), foreignWorkspace: randomUUID(), otherUser: randomUUID(), createdLink: randomUUID(), privateLink: randomUUID(), otherTask: randomUUID(), mentionedLink: randomUUID() };
  const { rows: [scope] } = await pool.query<{ workspace: string; organization: string; owner: string }>(`SELECT w.id AS workspace, w.organization_id AS organization, (SELECT id FROM compass_dev.users WHERE email='dev@localhost.dev') AS owner FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE w.slug='e2e-workspace' AND o.slug='e2e-test-org'`);
  const owner = (await pool.query<{ name: string; email: string }>(`SELECT COALESCE(name,email) AS name, email FROM compass_dev.users WHERE id=$1`, [scope.owner])).rows[0];
  await pool.query(`INSERT INTO compass_dev.users (id,email,name) VALUES ($1,$2,'Other fixture user')`, [fixture.otherUser, `recovery-${fixture.otherUser}@localhost.dev`]);
  await pool.query(`INSERT INTO compass_dev.workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,'Foreign workspace')`, [fixture.foreignWorkspace, scope.organization, `recovery-${fixture.foreignWorkspace}`]);
  await pool.query(`INSERT INTO compass_dev.tasks (id,workspace_id,title) VALUES ($1,$2,'Conversation recovery fixture'),($3,$2,'Another linked task')`, [fixture.task, scope.workspace, fixture.otherTask]);
  await pool.query(`INSERT INTO compass_dev.agent_conversations (id,workspace_id,user_id,title,target_type,target_id,visibility,status,agent_mode) VALUES ($1,$2,$3,'Shared anchored thread','TASK',$4,'WORKSPACE','OPEN','MENTION_ONLY'),($5,$2,$6,'Hidden private anchored thread','TASK',$4,'PRIVATE','OPEN','MENTION_ONLY'),($7,$8,$3,'Hidden foreign anchored thread','TASK',$4,'WORKSPACE','OPEN','MENTION_ONLY')`, [fixture.conversation, scope.workspace, scope.owner, fixture.task, fixture.privateConversation, fixture.otherUser, fixture.foreignConversation, fixture.foreignWorkspace]);
  await pool.query(`INSERT INTO compass_dev.entity_links (id,workspace_id,link_type,from_type,from_id,to_type,to_id,origin,source,created_at,updated_at) VALUES ($1,$2,'CONVERSATION_CREATED','AGENT_CONVERSATION',$3,'TASK',$4,'DIRECT','AGENT',NOW(),NOW()),($5,$2,'CONVERSATION_CREATED','AGENT_CONVERSATION',$6,'TASK',$4,'DIRECT','AGENT',NOW(),NOW()),($7,$2,'CONVERSATION_MENTIONS','AGENT_CONVERSATION',$3,'TASK',$8,'DIRECT','AGENT',NOW(),NOW())`, [fixture.createdLink, scope.workspace, fixture.conversation, fixture.task, fixture.privateLink, fixture.privateConversation, fixture.mentionedLink, fixture.otherTask]);
  return { ...fixture, ...scope, ownerName: owner.name, ownerEmail: owner.email };
}

async function dispose(pool: pg.Pool, fixture: Awaited<ReturnType<typeof seed>>) {
  // Includes the passive conversation created by the successful retry.
  const conversations = (await pool.query<{ id: string }>(`SELECT id FROM compass_dev.agent_conversations WHERE target_id=$1 OR id=ANY($2::uuid[])`, [fixture.task, [fixture.conversation, fixture.privateConversation, fixture.foreignConversation]])).rows.map(row => row.id);
  await pool.query(`DELETE FROM compass_dev.entity_links WHERE from_id=ANY($1::uuid[])`, [conversations]);
  await pool.query(`DELETE FROM compass_dev.agent_messages WHERE conversation_id=ANY($1::uuid[])`, [conversations]);
  await pool.query(`DELETE FROM compass_dev.agent_conversations WHERE id=ANY($1::uuid[])`, [conversations]);
  await pool.query(`DELETE FROM compass_dev.tasks WHERE id=ANY($1::uuid[])`, [[fixture.task, fixture.otherTask]]);
  await pool.query(`DELETE FROM compass_dev.workspaces WHERE id=$1`, [fixture.foreignWorkspace]);
  await pool.query(`DELETE FROM compass_dev.users WHERE id=$1`, [fixture.otherUser]);
}

for (const failure of ["503", "network"] as const) {
  test(`object conversations recover from ${failure} without false empty state or lost draft`, async ({ page, base }, testInfo) => {
    test.setTimeout(180_000);
    const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
    const fixture = await seed(pool);
    const listPath = `/api/agent/conversations/by-target?workspaceId=${fixture.workspace}&targetType=TASK&targetId=${fixture.task}`;
    let failList = true;
    let failSend = true;
    const sent: string[] = [];
    try {
      await page.route("**/api/agent/conversations/by-target?**", async route => {
        if (!failList) return route.continue();
        failList = false;
        return failure === "network" ? route.abort("failed") : route.fulfill({ status: 503, body: "unavailable" });
      });
      await page.route("**/api/agent/turn", async route => {
        sent.push((route.request().postDataJSON() as { message: string }).message);
        if (!failSend) return route.continue();
        failSend = false;
        return failure === "network" ? route.abort("failed") : route.fulfill({ status: 503, body: "unavailable" });
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${base}/tasks/${fixture.task}`);
      const section = page.getByTestId("object-conversations-section");
      await expect(section.getByRole("alert")).toContainText("Could not load conversations");
      await expect(section.getByText(/No conversations on this item yet/)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`load-${failure}-desktop.png`), fullPage: true });
      await section.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(section.getByRole("button", { name: /^Shared anchored thread/ })).toBeVisible();
      const editor = section.getByTestId("object-conversation-composer");
      const draft = `Keep the exact recovery draft ${fixture.task}.`;
      await editor.fill(`${draft} `);
      await editor.pressSequentially("@");
      await section.getByTestId("mention-option").filter({ has: page.getByText(fixture.ownerEmail, { exact: true }) }).click();
      await expect(editor.getByTestId("mention-chip")).toHaveAttribute("data-mention-id", fixture.owner);
      const visibleDraft = await editor.innerText();
      await section.getByRole("button", { name: "Send", exact: true }).click();
      await expect(section.getByRole("alert")).toContainText("We couldn’t confirm whether this was sent. Check conversations before retrying.");
      expect(await editor.innerText()).toBe(visibleDraft);
      expect(sent[0]).toContain(`](mention:user:${fixture.owner})`);
      failList = true;
      await section.getByRole("button", { name: "Refresh conversations" }).click();
      await expect(section.getByRole("alert").filter({ hasText: "Could not load conversations" })).toBeVisible();
      await expect(section.getByRole("button", { name: /^Shared anchored thread/ })).toBeVisible();
      expect(sent).toHaveLength(1);
      await expect(editor.getByTestId("mention-chip")).toHaveAttribute("data-mention-id", fixture.owner);
      await section.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(section.getByRole("alert")).toContainText("We couldn’t confirm whether this was sent.");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath(`uncertain-${failure}-mobile.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await section.getByRole("button", { name: "Retry send" }).click();
      await expect.poll(() => sent.length).toBe(2);
      expect(sent[1]).toBe(sent[0]);
      await expect.poll(async () => {
        const result = await page.request.get(listPath);
        expect(result.status()).toBe(200);
        return (await result.json()).items.filter((item: { title: string }) => item.title.startsWith("Keep the exact recovery draft")).length;
      }).toBe(1);
      expect(Number((await pool.query(`SELECT COUNT(*) AS n FROM compass_dev.agent_messages WHERE content=$1 AND conversation_id IN (SELECT id FROM compass_dev.agent_conversations WHERE target_id=$2)`, [sent[0].trim(), fixture.task])).rows[0].n)).toBe(1);
    } finally {
      await dispose(pool, fixture);
      await pool.end();
    }
  });
}

test("conversation provenance is private, relation-only removal recovers and persists, and anchored overlap remains", async ({ page, base }, testInfo) => {
  test.setTimeout(180_000);
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const fixture = await seed(pool);
  try {
    const listPath = `/api/agent/conversations/by-target?workspaceId=${fixture.workspace}&targetType=TASK&targetId=${fixture.task}`;
    const response = await page.request.get(listPath);
    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({ id: fixture.conversation, anchored: true, links: [{ linkId: fixture.createdLink, kind: "CREATED", auto: true }] });
    const serialized = JSON.stringify(json);
    for (const hidden of [fixture.privateConversation, fixture.foreignConversation, fixture.privateLink, "Hidden private anchored thread", "Hidden foreign anchored thread"]) expect(serialized).not.toContain(hidden);
    expect((await page.request.get(`/api/agent/conversations/${fixture.privateConversation}/links?workspaceId=${fixture.workspace}`)).status()).toBe(404);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/tasks/${fixture.task}`);
    const section = page.getByTestId("object-conversations-section");
    await expect(section.getByText("On this item", { exact: true })).toBeVisible();
    await expect(section.getByText("Created here", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: /^Shared anchored thread/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("provenance-desktop.png"), fullPage: true });
    const remove = section.getByRole("button", { name: "Remove Created here link to Shared anchored thread" });
    await remove.focus(); await page.keyboard.press("Enter");
    await expect(section.getByText("The conversation and this item will be kept.")).toBeVisible();
    await section.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await pool.query(`SELECT id FROM compass_dev.entity_links WHERE id=$1`, [fixture.createdLink])).rowCount).toBe(1);
    await remove.click();
    let failRemoval = true;
    await page.route("**/*", async route => {
      if (failRemoval && route.request().headers()["next-action"]) {
        failRemoval = false;
        return route.fulfill({ status: 503, body: "unavailable" });
      }
      return route.continue();
    });
    await section.getByRole("button", { name: "Remove link", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("Could not remove the link");
    await expect(section.getByText("Created here", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("removal-error-mobile.png"), fullPage: true });
    await section.getByRole("button", { name: "Retry removal" }).click();
    await expect(section.getByRole("status")).toContainText("Link removed. Conversation kept.");
    await expect(section.getByRole("heading", { name: "Conversations", exact: true })).toBeFocused();
    await expect(section.getByText("Created here", { exact: true })).toHaveCount(0);
    await expect(section.getByText("On this item", { exact: true })).toBeVisible();
    await page.reload();
    await expect(section.getByText("On this item", { exact: true })).toBeVisible();
    await expect(section.getByText("Created here", { exact: true })).toHaveCount(0);
    expect((await pool.query(`SELECT id FROM compass_dev.entity_links WHERE id=$1`, [fixture.createdLink])).rowCount).toBe(0);
    for (const id of [fixture.privateLink, fixture.mentionedLink]) expect((await pool.query(`SELECT id FROM compass_dev.entity_links WHERE id=$1`, [id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT id FROM compass_dev.agent_conversations WHERE id=$1`, [fixture.conversation])).rowCount).toBe(1);
    expect((await pool.query(`SELECT id FROM compass_dev.tasks WHERE id=$1`, [fixture.task])).rowCount).toBe(1);
    await page.evaluate(() => localStorage.setItem("compass-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(section.getByText("On this item", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("anchored-after-removal-dark-mobile.png"), fullPage: true });
    await page.goto(`${base}/tasks/${fixture.otherTask}`);
    await expect(section.getByText("Mentioned", { exact: true })).toBeVisible();
  } finally {
    await dispose(pool, fixture);
    await pool.end();
  }
});
