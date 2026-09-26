import { createHash, randomUUID } from "node:crypto";
import { realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import pg from "pg";
import { test, expect } from "../fixtures/index";
import { assertIsolatedE2EDatabase } from "../fixtures/isolated-database";
import { orgNameForToken, readRunToken } from "../fixtures/run-token";

test("Headless pilot: persisted body, history restore, lost save retry and conflict draft", async ({ page, base }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(!process.env.GEODE_DOCS_PILOT_WORKSPACE_ID, "Requires an explicitly enabled isolated document pilot");
  await assertIsolatedE2EDatabase();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let id: string | undefined;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${base}/docs`);
    await page.waitForLoadState("networkidle");
    const previous = page.url();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.waitForURL(url => url.href !== previous && /\/docs\/[0-9a-f-]+$/.test(url.pathname));
    id = page.url().split("/").pop()!;
    const editor = page.locator(".ProseMirror");
    await expect(editor).toBeEmpty();
    const body = "Headless original document — persists across requests.";
    await editor.fill(body);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const { rows: [stored] } = await pool.query('SELECT storage_provider,content,content_ref,revision FROM compass_dev.docs WHERE id=$1', [id]);
    expect(stored.storage_provider).toBe("GEODE");
    expect(stored.content).toBeNull();
    expect(JSON.parse(stored.content_ref).namespace).toBe(process.env.GEODE_DOCS_PILOT_WORKSPACE_ID);
    await page.reload();
    await expect(editor).toContainText(body);
    await page.getByTitle("Save named version").click();
    const label = page.getByPlaceholder("Label (optional)");
    await label.fill("Original pilot snapshot"); await label.press("Enter");
    await expect(label).not.toBeVisible();
    await editor.fill("Changed pilot document.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(editor).toContainText("Changed pilot document.");
    await page.getByTitle("Version history").click();
    await page.locator('[data-testid="doc-version-list"] button').filter({ hasText: "Original pilot snapshot" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Restore this version" }).click();
    await expect(editor).toContainText(body);
    await expect(page.getByRole("heading", { name: "Version History" })).not.toBeVisible();

    // Drop one server-action request; the queue must retain its payload/token.
    let dropped = false;
    await page.route(`**/docs/${id}`, async route => {
      if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) { dropped = true; await route.abort("connectionfailed"); }
      else await route.continue();
    });
    const retained = "My unsaved pilot draft remains visible.";
    await editor.fill(retained);
    await expect(page.getByRole("alert").filter({ hasText: "Your draft is still here" })).toBeVisible();
    await expect(editor).toContainText(retained);
    await page.getByRole("button", { name: "Retry save" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(editor).toContainText(retained);
    await page.unroute(`**/docs/${id}`);

    // Simulate an independently committed revision while this editor stays open.
    await pool.query('UPDATE compass_dev.docs SET revision=$2 WHERE id=$1', [id, randomUUID()]);
    await editor.fill("Conflict draft must never silently overwrite.");
    await expect(page.getByRole("alert").filter({ hasText: "copy your draft before reloading" })).toBeVisible();
    await expect(editor).toContainText("Conflict draft must never silently overwrite.");
    await page.screenshot({ path: testInfo.outputPath("headless-docs-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("headless-docs-mobile.png"), fullPage: true });
  } finally {
    try {
      if (id) {
        await assertIsolatedE2EDatabase();
        const token = readRunToken();
        const workspaceId = process.env.GEODE_DOCS_PILOT_WORKSPACE_ID!;
        const root = process.env.GEODE_DOCS_LOCAL_ROOT;
        if (!token || process.env.VERCEL_ENV || !root || !isAbsolute(root) || !basename(root).startsWith("compass-geode-docs-pilot.")) throw new Error("Refusing unowned/nonlocal pilot cleanup");
        const { rows: [owner] } = await pool.query('SELECT o.name FROM compass_dev.workspaces w JOIN compass_dev.organizations o ON o.id=w.organization_id WHERE w.id=$1 AND o.slug=\'e2e-test-org\' AND w.slug=\'e2e-workspace\'', [workspaceId]);
        if (owner?.name !== orgNameForToken(token)) throw new Error("Pilot cleanup run ownership changed");
        const { rows: refs } = await pool.query<{ content_ref: string }>('SELECT content_ref FROM compass_dev.docs WHERE id=$1 AND workspace_id=$2 UNION SELECT v.content_ref FROM compass_dev.doc_versions v JOIN compass_dev.docs d ON d.id=v.doc_id WHERE d.id=$1 AND d.workspace_id=$2', [id, workspaceId]);
        const { rows: inventory } = await pool.query('SELECT id FROM compass_dev.doc_storage_objects WHERE workspace_id=$1', [workspaceId]);
        if (inventory.length) throw new Error("Local pilot cleanup refuses cloud object inventory");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query('DELETE FROM compass_dev.doc_comments WHERE doc_id IN (SELECT id FROM compass_dev.docs WHERE id=$1 AND workspace_id=$2)', [id, workspaceId]);
          await client.query('DELETE FROM compass_dev.doc_versions WHERE doc_id IN (SELECT id FROM compass_dev.docs WHERE id=$1 AND workspace_id=$2)', [id, workspaceId]);
          await client.query('DELETE FROM compass_dev.doc_operations WHERE doc_id=$1 AND workspace_id=$2', [id, workspaceId]);
          await client.query('DELETE FROM compass_dev.docs WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
        const dir = join(await realpath(root), createHash("sha256").update(workspaceId).digest("hex"));
        if (await realpath(dir) !== dir) throw new Error("Refusing symlink cleanup");
        for (const row of refs) {
          if (!row.content_ref) continue;
          const ref = JSON.parse(row.content_ref);
          if (ref.namespace !== workspaceId || !/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error("Invalid cleanup reference");
          const { rows: stillUsed } = await pool.query('SELECT id FROM compass_dev.docs WHERE content_ref=$1 UNION SELECT id FROM compass_dev.doc_versions WHERE content_ref=$1', [row.content_ref]);
          if (stillUsed.length) continue;
          const key = `${workspaceId}/objects/${ref.digest}`;
          await unlink(join(dir, createHash("sha256").update(key).digest("hex"))).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
      }
    } finally { await pool.end(); }
  }
});
