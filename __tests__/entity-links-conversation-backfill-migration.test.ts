import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  CONVERSATION_CREATED_KEY,
  ENTITY_LINKS_CONVERSATION_BACKFILL_BATCH_SIZE,
  ENTITY_LINKS_CONVERSATION_BACKFILL_MIGRATION,
  assertEntityLinksConversationBackfill,
  assertEntityLinksConversationPreconditions,
  backfillEntityLinksConversation,
} from "@/lib/migrations/entity-links-conversation-backfill";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { CONVERSATION_CREATED_LINK_TYPE } from "@/lib/links/registry";

const ROOT = process.cwd();
const NAME = "113_entity_links_backfill_conversation";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("113 registration", () => {
  const runner = read("lib/migrations/runner.ts");

  it("uses its number, registers last, and its SQL file has no executable statement", () => {
    expect(ENTITY_LINKS_CONVERSATION_BACKFILL_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "112_agent_conversation_archive"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("writes the same link-type key the registry defines", () => {
    expect(CONVERSATION_CREATED_KEY).toBe(CONVERSATION_CREATED_LINK_TYPE);
  });

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "114_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["114_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
  });

  it("runs the backfill and its postconditions before the receipt, and is in the replay skip list", () => {
    const hook = runner.indexOf("await backfillEntityLinksConversation(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksConversationBackfill(client, schema)");
    expect(hook).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(runner).toContain("entityLinksConversationBackfill: await getEntityLinksConversationStatus(client, schema)");
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"lib/migrations/entity-links-conversation-backfill.ts": "${digest("lib/migrations/entity-links-conversation-backfill.ts")}"`);
  });

  it("copies the legacy link faithfully: origin MIGRATION, source AGENT, created_at copied, no ON CONFLICT, keyset-paged", () => {
    const hook = read("lib/migrations/entity-links-conversation-backfill.ts");
    expect(hook).toContain("'MIGRATION', 'AGENT', NULL, l.created_at");
    expect(hook).not.toMatch(/ON CONFLICT\s*(\(|DO)/i);
    expect(hook).toContain("l.id > $1::uuid");
    expect(ENTITY_LINKS_CONVERSATION_BACKFILL_BATCH_SIZE).toBe(500);
  });
});

/** A client whose queries are answered by the first matching rule; every statement is recorded. */
function fakeClient(rules: [RegExp, { rows: unknown[]; rowCount?: number }][]) {
  const seen: string[] = [];
  const query = vi.fn(async (sql: string) => {
    seen.push(sql);
    const rule = rules.find(([pattern]) => pattern.test(sql));
    return rule ? rule[1] : { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, seen };
}

describe("113 hook", () => {
  it("refuses before changing anything when 091 is not applied", async () => {
    const { client, seen } = fakeClient([[/_prisma_migrations/, { rows: [{ n: "0" }] }]]);
    await expect(assertEntityLinksConversationPreconditions(client, "s")).rejects.toThrow(/091_entity_links is not applied/);
    expect(seen.every((sql) => !/INSERT|DELETE|UPDATE/.test(sql))).toBe(true);
  });

  it("an empty database inserts nothing, removes nothing and reports no quarantine", async () => {
    const { client, seen } = fakeClient([
      [/_prisma_migrations/, { rows: [{ n: "1" }] }],
      [/information_schema\.columns/, { rows: [{ table_name: "a" }, { table_name: "b" }, { table_name: "c" }, { table_name: "d" }] }],
      [/count\(\*\)/, { rows: [{ n: "0" }] }],
    ]);
    const log: string[] = [];
    const result = await backfillEntityLinksConversation(client, "s", log);
    expect(result).toMatchObject({ inserted: 0, mentionsRemoved: 0, quarantined: { dangling: { count: 0 }, crossWorkspace: { count: 0 } } });
    expect(log[0]).toContain("inserted 0");
    expect(seen.filter((sql) => /^\s*(INSERT|DELETE)/.test(sql))).toEqual([]);
  });

  it("a batch of consistent legacy rows is inserted once per page, from the legacy columns", async () => {
    const pages = [[{ id: "00000000-0000-4000-8000-000000000001" }], []];
    const inserts: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/_prisma_migrations/.test(sql)) return { rows: [{ n: "1" }] };
        if (/information_schema\.columns/.test(sql)) return { rows: [1, 2, 3, 4].map((n) => ({ table_name: String(n) })) };
        if (/^\s*INSERT INTO/.test(sql)) { inserts.push(sql); return { rows: [], rowCount: 1 }; }
        if (/SELECT l\.id AS id/.test(sql) && /e\.id IS NULL/.test(sql)) return { rows: pages.shift() ?? [] };
        if (/count\(\*\)/.test(sql)) return { rows: [{ n: "0" }] };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;
    const result = await backfillEntityLinksConversation(client, "s", []);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("c.workspace_id");
    expect(inserts[0]).toContain("l.linked_type = 'AGENT_CONVERSATION'");
  });

  it("postconditions throw (so no receipt is written) while a consistent legacy row has no link", async () => {
    const { client } = fakeClient([[/count\(\*\)/, { rows: [{ n: "2" }] }]]);
    await expect(assertEntityLinksConversationBackfill(client, "s")).rejects.toThrow(/coverage postcondition failed: 2/);
  });
});
