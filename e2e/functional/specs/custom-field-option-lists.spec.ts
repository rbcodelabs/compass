/**
 * Option-list editor functional spec (Settings → Custom Fields and
 * Settings → Shared option sets).
 *
 * The editor replaces an "Options (comma-separated)" text box that re-derived
 * every option's value from its label on save — renaming "Billing" changed its
 * stored value and orphaned every CustomFieldValue holding "billing" — and
 * silently dropped option colours. The readbacks here go to the database, not
 * just the UI, because a re-slugged value looks identical on screen.
 *
 * Journey:
 *   1. Create a Task SELECT field with three options entered one by one with
 *      Enter; the stored options carry derived slugs in entry order.
 *   2. Create a shared set by pasting a multi-line list into "Add option".
 *   3. Edit it: colour one option, move one up, rename another, save.
 *   4. Reload: the renamed option kept its original value, the colour and the
 *      new order persisted, and the reopened editor shows the same state.
 *
 * Global teardown removes the field and the set with the rest of the e2e
 * workspace.
 */
import pg from "pg";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

type StoredOption = { label: string; value: string; color?: string };

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional readback");
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.end();
  }
}

async function fieldOptions(name: string): Promise<StoredOption[] | null> {
  const rows = await query<{ options: StoredOption[] }>(
    `SELECT options FROM "${S}".custom_field_definitions WHERE name = $1`,
    [name],
  );
  return rows[0]?.options ?? null;
}

async function setOptions(name: string): Promise<StoredOption[] | null> {
  const rows = await query<{ options: StoredOption[] }>(
    `SELECT options FROM "${S}".shared_field_option_sets WHERE name = $1`,
    [name],
  );
  return rows[0]?.options ?? null;
}

async function pasteInto(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/** The innermost <section> headed by `title` (object-type sections nest inside "Custom Fields"). */
const section = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).last();

test.describe.serial("Option-list editor", () => {
  const stamp = Date.now();

  test("creates a SELECT field from options entered one at a time", async ({ page, base }) => {
    const fieldName = `E2E Priority ${stamp}`;
    await page.goto(`${base}/settings`);
    const tasks = section(page, "Task");
    await tasks.getByRole("button", { name: "Add field" }).click();
    await tasks.getByLabel("Name").fill(fieldName);
    await tasks.getByLabel("Type").click();
    await page.getByRole("option", { name: "Select", exact: true }).click();

    const add = tasks.getByLabel("Add option", { exact: true });
    for (const label of ["Low", "Medium", "High"]) {
      await add.fill(label);
      await add.press("Enter");
      // Enter adds the option and keeps the caret here; it never submits.
      await expect(add).toBeFocused();
      await expect(add).toHaveValue("");
    }
    await expect(tasks.getByLabel("Option 3 label")).toHaveValue("High");
    expect(await fieldOptions(fieldName)).toBeNull();

    await tasks.getByRole("button", { name: "Add Field" }).click();
    await expect(tasks.getByText(fieldName)).toBeVisible();
    await expect
      .poll(() => fieldOptions(fieldName))
      .toEqual([
        { label: "Low", value: "low" },
        { label: "Medium", value: "medium" },
        { label: "High", value: "high" },
      ]);
  });

  test("renaming, recolouring and reordering a shared set keeps stored values", async ({ page, base }) => {
    const setName = `E2E Product Area ${stamp}`;
    await page.goto(`${base}/settings`);
    const sets = section(page, "Shared option sets");

    await sets.getByRole("button", { name: "Add shared option set" }).click();
    await sets.getByLabel("Name").fill(setName);
    await pasteInto(page, "Add option", "Payments\nBilling\nGrowth");
    await expect(sets.getByLabel("Option 3 label")).toHaveValue("Growth");
    await sets.getByRole("button", { name: "Create set" }).click();
    await expect
      .poll(() => setOptions(setName))
      .toEqual([
        { label: "Payments", value: "payments" },
        { label: "Billing", value: "billing" },
        { label: "Growth", value: "growth" },
      ]);

    await sets.getByRole("button", { name: `Edit ${setName}` }).click();
    await sets.getByRole("button", { name: "Color for Payments" }).click();
    await sets.getByRole("button", { name: "Blue", exact: true }).click();
    await sets.getByRole("button", { name: "Move Growth up" }).click();
    await sets.getByLabel("Option 3 label").fill("Invoicing");
    await sets.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(() => setOptions(setName))
      .toEqual([
        { label: "Payments", value: "payments", color: "#2563eb" },
        { label: "Growth", value: "growth" },
        // Renamed, but still the value stored CustomFieldValues point at.
        { label: "Invoicing", value: "billing" },
      ]);

    await page.reload();
    const reloaded = section(page, "Shared option sets");
    await expect(reloaded.getByText("Invoicing", { exact: true })).toBeVisible();
    await reloaded.getByRole("button", { name: `Edit ${setName}` }).click();
    await expect(reloaded.getByLabel("Option 1 label")).toHaveValue("Payments");
    await expect(reloaded.getByLabel("Option 2 label")).toHaveValue("Growth");
    await expect(reloaded.getByLabel("Option 3 label")).toHaveValue("Invoicing");
    await reloaded.getByRole("button", { name: "Color for Payments" }).click();
    await expect(reloaded.getByRole("button", { name: "Blue", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});
