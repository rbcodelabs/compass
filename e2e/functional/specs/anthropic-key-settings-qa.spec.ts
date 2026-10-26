import { test, expect } from "../fixtures/index";
import type { Page } from "@playwright/test";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { decrypt, encrypt } from "../../../lib/crypto-secrets";

/**
 * Adversarial QA for Settings > Anthropic API key (TASK-89). Complements anthropic-key-settings.spec.ts (admin happy path).
 * Every test restores the two key columns, and the role-demotion test restores the exact membership roles it changed.
 */
const ENC_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="; // matches SSO_SECRET_ENCRYPTION_KEY in playwright.config.ts
const SHOT_DIR = process.env.TASK89_SHOT_DIR;
const HEADING = { name: "Anthropic API key", exact: true } as const;

function connect() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e");
  const pool = new pg.Pool({ connectionString: url.toString() });
  const schema = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";
  const readColumns = async (slug: string) => {
    const r = await pool.query(`SELECT anthropic_api_key_encrypted AS enc, anthropic_api_key_last4 AS last4 FROM "${schema}".workspaces WHERE slug = $1`, [slug]);
    return r.rows[0] as { enc: string | null; last4: string | null };
  };
  const clear = (slug: string) =>
    pool.query(`UPDATE "${schema}".workspaces SET anthropic_api_key_encrypted = NULL, anthropic_api_key_last4 = NULL WHERE slug = $1`, [slug]);
  return { pool, schema, readColumns, clear };
}

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

const noOverflow = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="anthropic-key-input"]')?.closest("div");
    const r = panel?.getBoundingClientRect();
    return {
      docFits: document.documentElement.scrollWidth <= window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      panelFits: r ? r.left >= 0 && r.right <= window.innerWidth + 0.5 : false,
    };
  });

test("whitespace is trimmed, Save is disabled for blank input, subscription tokens are rejected, and the key never leaks back", async ({ page, base, workspaceSlug }) => {
  test.setTimeout(150_000);
  const { pool, readColumns, clear } = connect();
  const KEY = "sk-ant-api03-qa-leak-probe-WXYZ";
  const OAT = "sk-ant-oat01-qa-subscription-probe-9999";

  const responseBodies: string[] = [];
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("pageerror", (e) => consoleLines.push(String(e)));
  page.on("response", async (res) => {
    try {
      responseBodies.push(`${res.request().method()} ${res.url()}\n${await res.text()}`);
    } catch {
      /* body unavailable (redirect, aborted): nothing to leak */
    }
  });

  try {
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", HEADING)).toBeVisible();
    const input = page.getByTestId("anthropic-key-input");
    const save = page.getByTestId("anthropic-key-save");

    // Save disabled for empty and whitespace-only input.
    await expect(save, "empty input").toBeDisabled();
    await input.fill("   \t  ");
    await expect(save, "whitespace-only input").toBeDisabled();
    await input.fill("");
    await expect(save).toBeDisabled();

    // Subscription token: explicit message, nothing stored, and the token is not echoed.
    await input.fill(OAT);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText(/subscription tokens .* not supported/i);
    await expect(page.getByTestId("anthropic-key-error")).not.toContainText(OAT);
    expect((await readColumns(workspaceSlug)).enc, "oat token must store nothing").toBeNull();
    expect((await readColumns(workspaceSlug)).last4).toBeNull();

    // Padded oat token still gets the oat message (trim happens before the prefix check).
    await input.fill(`   ${OAT}  `);
    await save.click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText(/subscription tokens/i);
    expect((await readColumns(workspaceSlug)).enc).toBeNull();

    // Whitespace inside the key is rejected, not silently mangled.
    await input.fill("sk-ant-api03-has space-ABCD");
    await save.click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText(/does not look like a valid/i);
    expect((await readColumns(workspaceSlug)).enc).toBeNull();

    // Bare prefix is rejected.
    await input.fill("sk-ant-api");
    await save.click();
    await expect(page.getByTestId("anthropic-key-error")).toContainText(/does not look like a valid/i);

    // Whitespace-padded valid key: trimmed, last4 is from the trimmed value, decrypted value has no padding.
    await input.fill(`  \t${KEY}   `);
    await save.click();
    await expect(page.getByTestId("anthropic-key-notice")).toContainText("Saved");
    await expect(page.getByTestId("anthropic-key-status")).toContainText("WXYZ");
    await expect(input).toHaveValue("");
    const row = await readColumns(workspaceSlug);
    expect(row.last4).toBe("WXYZ");
    expect(row.enc).toBeTruthy();
    expect(row.enc).not.toContain(KEY);
    expect(decrypt(row.enc!, ENC_KEY), "stored plaintext must be the trimmed key").toBe(KEY);

    // Leak sweep: DOM, storage, cookies, console, every response body (server-action replies included), and after a reload.
    await page.reload();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("WXYZ");
    const html = await page.content();
    expect(html).not.toContain(KEY);
    expect(html).not.toContain(KEY.slice(0, -4));
    expect(html).not.toContain(row.enc!);
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    expect(stored).not.toContain("sk-ant");
    expect((await page.context().cookies()).map((c) => c.value).join("|")).not.toContain("sk-ant");
    expect(consoleLines.join("\n"), "console output").not.toContain("sk-ant-api03-qa-leak");
    const leaked = responseBodies.filter((b) => b.includes(KEY) || b.includes(row.enc!));
    expect(leaked.map((b) => b.split("\n")[0]), "responses containing the key or ciphertext").toEqual([]);
    expect(responseBodies.some((b) => b.includes("WXYZ")), "sanity: the server-action reply was captured and carries last4").toBe(true);
    // The OAT probe also must not appear in any response (error messages must not echo input).
    expect(responseBodies.filter((b) => b.includes(OAT)).map((b) => b.split("\n")[0])).toEqual([]);
  } finally {
    await clear(workspaceSlug);
    await pool.end();
  }
});

test("keyboard-only: Tab reaches the input and Save; Enter in the input is harmless; Save and Remove work via keyboard", async ({ page, base, workspaceSlug }) => {
  test.setTimeout(150_000);
  const { pool, readColumns, clear } = connect();
  const KEY = "sk-ant-api03-qa-keyboard-KBD1";
  try {
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", HEADING)).toBeVisible();
    const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

    // Start from the top of the document and Tab until the key input is focused (proves it is in the tab order).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reached = false;
    for (let i = 0; i < 400 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = (await activeTestId()) === "anthropic-key-input";
    }
    expect(reached, "key input reachable by Tab").toBe(true);
    await expect(page.getByTestId("anthropic-key-input")).toBeFocused();

    // Save is disabled while empty, so Tab skips it; typing enables it and the next Tab lands on it.
    await page.keyboard.type("sk-live-wrong-prefix-1234");
    // Enter inside the input must not submit, navigate or throw.
    const urlBefore = page.url();
    await page.keyboard.press("Enter");
    expect(page.url()).toBe(urlBefore);
    expect((await readColumns(workspaceSlug)).enc).toBeNull();
    await expect(page.getByTestId("anthropic-key-error")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("anthropic-key-save")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("anthropic-key-error")).toContainText("starts with sk-ant-api");

    // Valid key via keyboard only. (The input is disabled while the action is pending, so wait for it before focusing.)
    await expect(page.getByTestId("anthropic-key-input")).toBeEnabled();
    await page.getByTestId("anthropic-key-input").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(KEY);
    await expect(page.getByTestId("anthropic-key-save")).toBeEnabled();
    await page.keyboard.press("Tab");
    const landed = await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.getAttribute("data-testid")}:${document.activeElement?.textContent?.slice(0, 30)}`);
    test.info().annotations.push({ type: "tab-landing", description: landed });
    await expect(page.getByTestId("anthropic-key-save"), `Tab landed on ${landed}`).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("anthropic-key-status")).toContainText("KBD1");
    expect((await readColumns(workspaceSlug)).last4).toBe("KBD1");

    // Remove is keyboard reachable (input -> Remove; the Replace button is disabled while the input is empty).
    await expect(page.getByTestId("anthropic-key-input")).toBeEnabled();
    await page.getByTestId("anthropic-key-input").focus();
    await expect(page.getByTestId("anthropic-key-input")).toBeFocused();
    await page.keyboard.press("Tab"); // Replace key is disabled while empty, so this goes straight to Remove
    const landed2 = await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.getAttribute("data-testid")}:${document.activeElement?.textContent?.slice(0, 30)}`);
    await expect(page.getByTestId("anthropic-key-remove"), `Tab landed on ${landed2}`).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("anthropic-key-status")).toContainText("Compass platform key");
    const row = await readColumns(workspaceSlug);
    expect(row.enc).toBeNull();
    expect(row.last4).toBeNull();
  } finally {
    await clear(workspaceSlug);
    await pool.end();
  }
});

test("no horizontal overflow at 1280x800, 390x844 and 320px; screenshots taken", async ({ page, base, workspaceSlug }) => {
  test.setTimeout(150_000);
  const { pool, clear } = connect();
  const longError = "sk-ant-api03-" + "x".repeat(300); // exercises long unbroken text in the error/notice paths
  try {
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", HEADING)).toBeVisible();
    const sizes = [
      { name: "desktop-1280", width: 1280, height: 800 },
      { name: "mobile-390", width: 390, height: 844 },
      { name: "narrow-320", width: 320, height: 640 },
    ];
    for (const phase of ["empty", "error", "saved"] as const) {
      if (phase === "error") {
        await page.getByTestId("anthropic-key-input").fill(`sk-live-${"y".repeat(200)}`);
        await page.getByTestId("anthropic-key-save").click();
        await expect(page.getByTestId("anthropic-key-error")).toBeVisible();
      }
      if (phase === "saved") {
        await page.getByTestId("anthropic-key-input").fill(longError);
        await page.getByTestId("anthropic-key-save").click();
        await expect(page.getByTestId("anthropic-key-status")).toContainText("xxxx");
      }
      for (const s of sizes) {
        await page.setViewportSize({ width: s.width, height: s.height });
        await page.getByRole("heading", HEADING).scrollIntoViewIfNeeded();
        await expect(page.getByTestId("anthropic-key-input")).toBeVisible();
        const fit = await noOverflow(page);
        expect(fit.docFits, `${phase} @${s.width}: document scrollWidth ${fit.scrollWidth} > viewport ${fit.innerWidth}`).toBe(true);
        expect(fit.panelFits, `${phase} @${s.width}: panel spills outside viewport`).toBe(true);
        await shot(page, `qa-${phase}-${s.name}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByTestId("anthropic-key-remove").click();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("Compass platform key");
  } finally {
    await clear(workspaceSlug);
    await pool.end();
  }
});

test("a non-admin member sees a read-only view, and replayed server actions are refused", async ({ page, base, workspaceSlug, orgSlug }) => {
  test.setTimeout(180_000);
  const { pool, schema, readColumns, clear } = connect();
  const wsRows = await pool.query(`SELECT id FROM "${schema}".workspaces WHERE slug = $1`, [workspaceSlug]);
  const workspaceId = wsRows.rows[0].id as string;
  const orgId = (await pool.query(`SELECT organization_id AS id FROM "${schema}".workspaces WHERE id = $1`, [workspaceId])).rows[0].id as string;
  const origWs = (await pool.query(`SELECT id, role FROM "${schema}".workspace_members WHERE workspace_id = $1`, [workspaceId])).rows as { id: string; role: string }[];
  const origOrg = (await pool.query(`SELECT id, role FROM "${schema}".organization_members WHERE organization_id = $1`, [orgId])).rows as { id: string; role: string }[];

  type Captured = { url: string; headers: Record<string, string>; kind: "set" | "remove" };
  const captured: Captured[] = [];
  page.on("request", (req) => {
    const h = req.headers();
    if (req.method() === "POST" && h["next-action"]) {
      captured.push({ url: req.url(), headers: h, kind: captured.length === 0 ? "set" : "remove" });
    }
  });

  try {
    // 1) As admin: save then remove once through the real UI to capture both server-action ids.
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", HEADING)).toBeVisible();
    await page.getByTestId("anthropic-key-input").fill("sk-ant-api03-qa-capture-CAP1");
    await page.getByTestId("anthropic-key-save").click();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("CAP1");
    await page.getByTestId("anthropic-key-remove").click();
    await expect(page.getByTestId("anthropic-key-status")).toContainText("Compass platform key");
    const setAction = captured.find((c) => c.kind === "set");
    const removeAction = captured.filter((c) => c.kind === "remove").pop();
    expect(setAction, "captured set-key server action request").toBeTruthy();
    expect(removeAction, "captured remove-key server action request").toBeTruthy();

    // 2) Seed an existing key straight in the DB (as if an admin had set it).
    const SEEDED = "sk-ant-api03-qa-seeded-ZZZZ";
    const seededEnc = encrypt(SEEDED, ENC_KEY);
    await pool.query(`UPDATE "${schema}".workspaces SET anthropic_api_key_encrypted = $2, anthropic_api_key_last4 = 'ZZZZ' WHERE id = $1`, [workspaceId, seededEnc]);

    // 3) Demote the signed-in user to MEMBER at both workspace and org level.
    await pool.query(`UPDATE "${schema}".workspace_members SET role = 'MEMBER' WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`UPDATE "${schema}".organization_members SET role = 'MEMBER' WHERE organization_id = $1`, [orgId]);

    await page.reload();
    await expect(page.getByRole("heading", HEADING)).toBeVisible();
    await expect(page.getByTestId("anthropic-key-readonly")).toBeVisible();
    await expect(page.getByTestId("anthropic-key-readonly")).toContainText("ZZZZ");
    await expect(page.getByTestId("anthropic-key-readonly")).toContainText("Only workspace admins can change this");
    await expect(page.getByTestId("anthropic-key-input")).toHaveCount(0);
    await expect(page.getByTestId("anthropic-key-save")).toHaveCount(0);
    await expect(page.getByTestId("anthropic-key-remove")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain(SEEDED);
    expect(html).not.toContain(seededEnc);
    await page.getByRole("heading", HEADING).scrollIntoViewIfNeeded();
    await shot(page, "qa-nonadmin-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("heading", HEADING).scrollIntoViewIfNeeded();
    await shot(page, "qa-nonadmin-mobile");
    await page.setViewportSize({ width: 1280, height: 800 });

    // 4) Bypass the UI: replay the captured admin server actions as the demoted user.
    const replay = async (c: Captured, body: string) => {
      const headers = { ...c.headers };
      delete headers["content-length"];
      delete headers["host"];
      return page.request.post(c.url, { headers, data: body, failOnStatusCode: false });
    };
    const replaySet = await replay(setAction!, JSON.stringify([orgSlug, workspaceSlug, { apiKey: "sk-ant-api03-qa-attacker-EVIL" }]));
    const replayRemove = await replay(removeAction!, JSON.stringify([orgSlug, workspaceSlug]));
    const after = await readColumns(workspaceSlug);
    const setBody = await replaySet.text();
    const removeBody = await replayRemove.text();
    console.log(`[qa replay] set=${replaySet.status()} remove=${replayRemove.status()} setBody=${setBody.slice(0, 160).replace(/\s+/g, " ")}`);
    test.info().annotations.push({ type: "replay", description: `set=${replaySet.status()} remove=${replayRemove.status()}` });
    expect(after.last4, `non-admin set replay must not change the key (status ${replaySet.status()}, body ${setBody.slice(0, 200)})`).toBe("ZZZZ");
    expect(after.enc, `non-admin remove replay must not clear the key (status ${replayRemove.status()}, body ${removeBody.slice(0, 200)})`).toBe(seededEnc);
  } finally {
    for (const r of origWs) await pool.query(`UPDATE "${schema}".workspace_members SET role = $2 WHERE id = $1`, [r.id, r.role]);
    for (const r of origOrg) await pool.query(`UPDATE "${schema}".organization_members SET role = $2 WHERE id = $1`, [r.id, r.role]);
    await clear(workspaceSlug);
    await pool.end();
  }
});
