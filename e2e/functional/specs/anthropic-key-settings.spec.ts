import { test, expect } from "../fixtures/index";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

/**
 * Bring-your-own Anthropic API key (TASK-89): Settings > Anthropic API key. Admin sets, replaces and removes a key; only the last four
 * characters are ever shown; the database holds ciphertext, never the key.
 */
const SECRET = "sk-ant-api03-e2e-secret-value-AAAA";
const REPLACEMENT = "sk-ant-api03-e2e-second-value-BBBB";
const SHOT_DIR = process.env.TASK89_SHOT_DIR;

test("workspace admin sets, replaces and removes an Anthropic API key; the key is never shown or stored in plaintext", async ({ page, base, workspaceSlug }) => {
  test.setTimeout(120_000);
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const schema = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";
  const readColumns = async () => {
    const result = await pool.query(
      `SELECT anthropic_api_key_encrypted AS enc, anthropic_api_key_last4 AS last4 FROM "${schema}".workspaces WHERE slug = $1`,
      [workspaceSlug],
    );
    return result.rows[0] as { enc: string | null; last4: string | null };
  };
  const shot = async (name: string) => {
    if (!SHOT_DIR) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
  };

  try {
    await page.goto(`${base}/settings`);
    const heading = page.getByRole("heading", { name: "Anthropic API key", exact: true });
    await expect(heading).toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("Compass platform key");
    await shot("desktop-1-empty");

    // Validation: wrong prefix, and a subscription token with its own explicit message. Nothing is stored.
    const input = page.getByTestId("anthropic-key-input");
    await input.fill("sk-live-not-anthropic-1234");
    await page.getByTestId("anthropic-key-save").click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText("starts with sk-ant-api");
    await input.fill("sk-ant-oat01-subscription-token-1234");
    await page.getByTestId("anthropic-key-save").click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText(/subscription tokens .* not supported/i);
    expect((await readColumns()).enc).toBeNull();
    await shot("desktop-2-rejected-subscription-token");

    // Set: only the last four are shown, the input is cleared, and the database holds ciphertext.
    await input.fill(SECRET);
    await page.getByTestId("anthropic-key-save").click();
    await expect(page.getByTestId("anthropic-key-notice")).toContainText("Saved");
    await expect(page.getByTestId("anthropic-key-status")).toContainText("AAAA");
    await expect(input).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(SECRET);
    let row = await readColumns();
    expect(row.last4).toBe("AAAA");
    expect(row.enc).toBeTruthy();
    expect(row.enc).not.toContain(SECRET);
    await shot("desktop-3-saved");

    // Survives a reload without ever sending the key to the client.
    await page.reload();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("AAAA");
    expect(await page.content()).not.toContain(SECRET);
    expect(await page.content()).not.toContain(row.enc!);

    // Replace.
    await page.getByTestId("anthropic-key-input").fill(REPLACEMENT);
    await page.getByTestId("anthropic-key-save").click();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("BBBB");
    row = await readColumns();
    expect(row.last4).toBe("BBBB");

    // Mobile: no horizontal overflow, controls reachable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "Anthropic API key", exact: true }).scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByTestId("anthropic-key-remove")).toBeVisible();
    await shot("mobile-1-saved");
    await page.setViewportSize({ width: 1280, height: 800 });

    // Remove: back to the platform key, both columns cleared.
    await page.getByTestId("anthropic-key-remove").click();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("Compass platform key");
    row = await readColumns();
    expect(row.enc).toBeNull();
    expect(row.last4).toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", { name: "Anthropic API key", exact: true }).scrollIntoViewIfNeeded();
    await shot("mobile-2-removed");
  } finally {
    await pool.query(`UPDATE "${schema}".workspaces SET anthropic_api_key_encrypted = NULL, anthropic_api_key_last4 = NULL WHERE slug = $1`, [workspaceSlug]);
    await pool.end();
  }
});
