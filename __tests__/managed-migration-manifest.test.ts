import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
const m = vi.hoisted(() => ({ changed: "", suffix: "", connect: vi.fn() }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (file: string, ...args: unknown[]) => {
    const value = Reflect.apply(actual.readFileSync, actual, [file, ...args]);
    if (!m.changed || !String(file).includes(`/${m.changed}/`)) return value;
    return typeof value === "string" ? value + m.suffix : Buffer.concat([value as Buffer, Buffer.from(m.suffix)]);
  } };
});
import { applyMigrations, partitionPendingMigrations } from "@/lib/migrations/runner";
import { assertReviewedManagedManifest } from "@/lib/preview-automation/managed-manifest";
import { initializeManagedPilot, applyManagedMigration } from "@/lib/preview-automation/managed-migrations";
const context = { schema: "compass_pr_276_aaaaaaaaaaaa", pr: "276", sha: "a".repeat(40), deploymentId: "dpl_Test", origin: "https://test.vercel.app", runId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const pool = { connect: m.connect } as unknown as Pool;
beforeEach(() => {
  m.connect.mockReset().mockRejectedValue(new Error("Database must not be reached"));
  m.changed = ""; m.suffix = "";
});
describe("reviewed whole-manifest gate", () => {
  it("accepts only the reviewed ordered manifest and paths", () => {
    const entries = partitionPendingMigrations(context.schema, new Set()).pending;
    expect(() => assertReviewedManagedManifest(entries)).not.toThrow();
    expect(() => assertReviewedManagedManifest(entries.slice(1))).toThrow(/manifest/);
    expect(() => assertReviewedManagedManifest([...entries].reverse())).toThrow(/manifest/);
    expect(() => assertReviewedManagedManifest([...entries, { name: "999_unreviewed", filePath: "unreviewed.sql" }])).toThrow(/manifest/);
    expect(() => assertReviewedManagedManifest(entries.map((entry, i) => i ? entry : { ...entry, filePath: "/tmp/unreviewed.sql" }))).toThrow(/manifest path/);
  });
  const payloads = [
    '\nALTER TABLE compass_prod.docs ADD COLUMN unexpected TEXT;\n',
    '\nUPDATE public.oauth_tokens SET revoked_at=now();\n',
    '\nSET search_path TO public;\n',
    "\nDO $$ BEGIN EXECUTE 'DELETE FROM compass_preview.docs'; END $$;\n",
  ];
  for (const migration of ["001_init", "039_native_decision_gates", "057_oauth_forced_reconsent"]) {
    it.each(payloads)(`rejects ${migration} later statement before initialization: %s`, async suffix => {
      m.changed = migration; m.suffix = suffix;
      await expect(initializeManagedPilot(pool, context)).rejects.toThrow(/reviewed.*manifest/i);
      expect(m.connect).not.toHaveBeenCalled();
    });
  }
  it("rejects changed late migration before claiming earlier migration", async () => {
    m.changed = "057_oauth_forced_reconsent"; m.suffix = "\nDELETE FROM public.docs;\n";
    await expect(applyManagedMigration(pool, context, "001_init")).rejects.toThrow(/reviewed.*manifest/i);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("guards direct managed runner before039 durable state mutations", async () => {
    m.changed = "039_native_decision_gates"; m.suffix = "\nSET search_path TO public;\n";
    await expect(applyMigrations(pool, context.schema, "039_native_decision_gates", { preProvisionedSchema: true, managedPilot: true })).rejects.toThrow(/reviewed.*manifest/i);
    expect(m.connect).not.toHaveBeenCalled();
  });
});
