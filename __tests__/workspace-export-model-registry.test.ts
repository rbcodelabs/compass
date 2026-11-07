import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  MODEL_BUCKETS,
  SECRET_COLUMNS,
  IMPORT_OVERRIDES,
} from "@/lib/workspace-export/model-registry";

const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));

describe("workspace export model registry", () => {
  it("classifies every Prisma model", () => {
    const missing = models.map((m) => m.name).filter((n) => !(n in MODEL_BUCKETS));
    expect(
      missing,
      `Unclassified models — add to lib/workspace-export/model-registry.ts: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("has no stale entries for models that no longer exist", () => {
    const stale = Object.keys(MODEL_BUCKETS).filter((n) => !byName.has(n));
    expect(stale).toEqual([]);
  });

  it("only declares secret/override columns that exist", () => {
    for (const map of [SECRET_COLUMNS, IMPORT_OVERRIDES]) {
      for (const [model, cols] of Object.entries(map)) {
        const fields = new Set(byName.get(model)?.fields.map((f) => f.name));
        for (const col of Array.isArray(cols) ? cols : Object.keys(cols)) {
          expect(fields.has(col), `${model}.${col}`).toBe(true);
        }
      }
    }
  });

  it("never exports a model with secret-looking columns that are not stripped", () => {
    const suspicious = /(secret|tokenhash|apikey|encrypted)/i;
    const exported = Object.entries(MODEL_BUCKETS)
      .filter(([, b]) => b === "CONTENT" || b === "TIERED")
      .map(([n]) => n);
    for (const name of exported) {
      const stripped = new Set(SECRET_COLUMNS[name] ?? []);
      const bad = (byName.get(name)?.fields ?? [])
        .filter((f) => suspicious.test(f.name) && !stripped.has(f.name))
        .map((f) => f.name);
      expect(bad, `${name} has unstripped secret-like columns`).toEqual([]);
    }
  });
});
