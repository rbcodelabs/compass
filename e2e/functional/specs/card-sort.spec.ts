/**
 * Card Sort functional spec.
 *
 * Seeds a single-select OPPORTUNITY field (Must / Should) and two opportunities
 * directly into the functional harness database — same approach as
 * discovery-field-board.spec.ts — so this stays on the card sort journey rather
 * than on Settings UI coverage. Global teardown removes the rounds, proposals,
 * field, values and opportunities with the rest of the e2e workspace.
 *
 * Journey:
 *   1. Start a round from /card-sort by choosing the seeded factor.
 *   2. Propose moving an opportunity from the card's menu. A proposal row exists
 *      and the OFFICIAL custom field value is unchanged — proposals never write
 *      back.
 *   3. Reveal (confirm dialog): the round is REVEALED in the DB and the tally
 *      page shows the proposal.
 *   4. Close (confirm dialog): the round is CLOSED in the DB.
 */
import pg from "pg";
import { test, expect } from "../fixtures/index";

const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

function pool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for functional seeding");
  return new pg.Pool({ connectionString: process.env.DATABASE_URL });
}

type Seeded = {
  fieldId: string;
  fieldName: string;
  /** Officially "should"; the test proposes moving it to "must". */
  moved: { id: string; title: string };
  /** Officially unset; never touched. */
  untouched: { id: string; title: string };
};

async function seed(stamp: number): Promise<Seeded> {
  const db = pool();
  try {
    const { rows: [workspace] } = await db.query<{ id: string }>(`
      SELECT w.id FROM "${S}".workspaces w
      JOIN "${S}".organizations o ON o.id = w.organization_id
      WHERE o.slug = 'e2e-test-org' AND w.slug = 'e2e-workspace' LIMIT 1
    `);
    if (!workspace) throw new Error("E2E workspace has not been seeded");

    const fieldName = `Sort Priority ${stamp}`;
    const { rows: [field] } = await db.query<{ id: string }>(`
      INSERT INTO "${S}".custom_field_definitions
        (id, workspace_id, object_type, name, field_type, options, required, "order", created_at)
      VALUES (gen_random_uuid(), $1, 'OPPORTUNITY', $2, 'SELECT', $3::jsonb, false, 0, NOW())
      RETURNING id
    `, [workspace.id, fieldName, JSON.stringify([
      { label: "Must", value: "must" },
      { label: "Should", value: "should" },
    ])]);

    async function opportunity(title: string, value?: string) {
      const { rows: [row] } = await db.query<{ id: string }>(`
        INSERT INTO "${S}".opportunities (id, workspace_id, title, status, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, 'VALIDATING', 7, NOW(), NOW()) RETURNING id
      `, [workspace.id, title]);
      if (value !== undefined) {
        await db.query(`
          INSERT INTO "${S}".custom_field_values (id, field_id, object_id, value, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3::jsonb, NOW(), NOW())
        `, [field.id, row.id, JSON.stringify(value)]);
      }
      return { id: row.id, title };
    }

    return {
      fieldId: field.id,
      fieldName,
      moved: await opportunity(`E2E Sort Moved ${stamp}`, "should"),
      untouched: await opportunity(`E2E Sort Untouched ${stamp}`),
    };
  } finally {
    await db.end();
  }
}

async function readRound(name: string) {
  const db = pool();
  try {
    const { rows } = await db.query<{ id: string; state: string; field_definition_id: string; revealed_at: Date | null; closed_at: Date | null }>(
      `SELECT id, state, field_definition_id, revealed_at, closed_at FROM "${S}".card_sort_rounds WHERE name = $1`,
      [name],
    );
    return rows;
  } finally {
    await db.end();
  }
}

async function readProposals(roundId: string) {
  const db = pool();
  try {
    const { rows } = await db.query<{ object_id: string; proposed_value: string; from_value: string | null }>(
      `SELECT object_id, proposed_value, from_value FROM "${S}".card_sort_proposals WHERE round_id = $1`,
      [roundId],
    );
    return rows;
  } finally {
    await db.end();
  }
}

async function readOfficialValues(fieldId: string) {
  const db = pool();
  try {
    const { rows } = await db.query<{ object_id: string; value: unknown }>(
      `SELECT object_id, value FROM "${S}".custom_field_values WHERE field_id = $1 ORDER BY object_id`,
      [fieldId],
    );
    return rows;
  } finally {
    await db.end();
  }
}

test.describe("Card sort round", () => {
  test("creates a round, records a proposal without touching the official value, reveals the tally, then closes", async ({ page, base }) => {
    const stamp = Date.now();
    const seeded = await seed(stamp);
    const roundName = `E2E Card Sort ${stamp}`;
    const officialBefore = await readOfficialValues(seeded.fieldId);
    expect(officialBefore).toHaveLength(1);
    expect(officialBefore[0]).toMatchObject({ object_id: seeded.moved.id, value: "should" });

    // ── 1. Create the round through the form ────────────────────────────────
    await page.goto(`${base}/card-sort`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Factor to judge").selectOption({ label: `${seeded.fieldName} (2 buckets)` });
    await page.getByLabel("Round name").fill(roundName);
    await page.getByRole("button", { name: "Start round" }).click();
    await page.waitForURL(/\/card-sort\/[0-9a-f-]{36}/);

    const [round] = await readRound(roundName);
    expect(round).toMatchObject({ state: "OPEN", field_definition_id: seeded.fieldId });
    expect(page.url()).toContain(round.id);
    await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();

    // ── 2. Propose a move from the card's menu ──────────────────────────────
    await page.getByRole("button", { name: `Propose a move for ${seeded.moved.title}` }).click();
    // The object is officially in Should, so Should is not offered as a target.
    await expect(page.getByRole("menuitem", { name: "Should" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Must" }).click();

    await expect(page.getByRole("button", { name: `Withdraw proposal for ${seeded.moved.title}` })).toBeVisible();
    await expect.poll(async () => (await readProposals(round.id)).length, { timeout: 10_000 }).toBe(1);
    const [proposal] = await readProposals(round.id);
    expect(proposal).toMatchObject({
      object_id: seeded.moved.id,
      proposed_value: "must",
      from_value: "should",
    });

    // A proposal is an opinion, not an edit: the official values are exactly as seeded.
    expect(await readOfficialValues(seeded.fieldId)).toEqual(officialBefore);

    // ── 3. Reveal ───────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Reveal to everyone" }).click();
    const revealDialog = page.getByRole("alertdialog");
    await expect(revealDialog.getByText("Reveal this round to everyone?")).toBeVisible();
    await revealDialog.getByRole("button", { name: "Reveal to everyone" }).click();

    await expect.poll(async () => (await readRound(roundName))[0]?.state, { timeout: 10_000 }).toBe("REVEALED");
    expect((await readRound(roundName))[0].revealed_at).not.toBeNull();

    // The tally defaults to the flow view; the per-object table is ?view=table.
    await page.goto(`${base}/card-sort/${round.id}/tally?view=table`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Proposed moves, by object" })).toBeVisible();
    await expect(page.getByText(seeded.moved.title).first()).toBeVisible();
    // Sparse by design: an object nobody proposed a move for is not in the tally.
    await expect(page.getByText(seeded.untouched.title)).toHaveCount(0);
    expect(await readOfficialValues(seeded.fieldId)).toEqual(officialBefore);

    // ── 4. Close ────────────────────────────────────────────────────────────
    await page.goto(`${base}/card-sort/${round.id}`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Close round" }).click();
    const closeDialog = page.getByRole("alertdialog");
    await expect(closeDialog.getByText("Close this round?")).toBeVisible();
    await closeDialog.getByRole("button", { name: "Close round" }).click();

    await expect.poll(async () => (await readRound(roundName))[0]?.state, { timeout: 10_000 }).toBe("CLOSED");
    expect((await readRound(roundName))[0].closed_at).not.toBeNull();
    // The proposal survives the close, and the official values are still untouched.
    expect(await readProposals(round.id)).toHaveLength(1);
    expect(await readOfficialValues(seeded.fieldId)).toEqual(officialBefore);
  });
});
