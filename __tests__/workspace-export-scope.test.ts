import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MODEL_BUCKETS } from "@/lib/workspace-export/model-registry"
import { PARENT, dmmfModels, exportOrder, modelHasWorkspaceId } from "@/lib/workspace-export/scope"
import { OPTIONAL_FIELDS, OPTIONAL_STRING_FIELDS, UNIQUE_KEYS } from "@/lib/workspace-export/schema-meta.generated"
import { OUTPUT_PATH, SCHEMA_PATH, parseUniqueKeys, render } from "../scripts/gen-workspace-export-meta.ts"

describe("workspace export scope", () => {
  it("every exported model is reachable: it has workspaceId, a declared parent, or is a special case", () => {
    for (const model of exportOrder()) {
      const ok = model === "Agent" || modelHasWorkspaceId(model) || PARENT[model]
      expect(ok, `${model} has no workspace scope`).toBeTruthy()
    }
  })

  it("parent declarations point at exported models and real columns", () => {
    for (const [model, p] of Object.entries(PARENT)) {
      expect(MODEL_BUCKETS[p.model], `${model} parent ${p.model}`).toBe("CONTENT")
      expect(dmmfModels.get(model)?.fields.some((f) => f.name === p.fk), `${model}.${p.fk}`).toBe(true)
    }
  })

  it("parents come before children in the export order", () => {
    const order = exportOrder()
    for (const [model, p] of Object.entries(PARENT)) {
      if (!order.includes(model) || !order.includes(p.model)) continue
      expect(order.indexOf(p.model), `${p.model} before ${model}`).toBeLessThan(order.indexOf(model))
    }
  })

  it("generated schema metadata is current (run: node scripts/gen-workspace-export-meta.ts)", () => {
    const expected = render(readFileSync(SCHEMA_PATH, "utf8"))
    expect(readFileSync(OUTPUT_PATH, "utf8")).toBe(expected)
    expect(Object.keys(OPTIONAL_STRING_FIELDS).length).toBeGreaterThan(20)
    // Non-String optional columns are covered too, and required columns are not.
    expect(OPTIONAL_FIELDS.Assumption).toContain("createdById")
    expect(OPTIONAL_FIELDS.Assumption).not.toContain("source")
    expect(OPTIONAL_FIELDS.Workspace).toContain("ssoSecretUpdatedAt")
  })

  it("generated UNIQUE_KEYS match real models and scalar/enum columns without including @id", () => {
    const rawSchema = readFileSync(SCHEMA_PATH, "utf8")
    const idFieldsByModel = new Map<string, Set<string>>()
    let currentModel: string | null = null
    for (const line of rawSchema.split("\n")) {
      const open = /^model\s+(\w+)\s*\{/.exec(line)
      if (open) {
        currentModel = open[1]
        continue
      }
      if (currentModel && /^\}/.test(line)) {
        currentModel = null
        continue
      }
      if (currentModel && /(?:^|\s)@id(?:\s|\(|$)/.test(line)) {
        const f = /^\s+(\w+)\s+/.exec(line)
        if (f) {
          const set = idFieldsByModel.get(currentModel) ?? new Set<string>()
          set.add(f[1])
          idFieldsByModel.set(currentModel, set)
        }
      }
    }

    expect(Object.keys(UNIQUE_KEYS).length).toBeGreaterThan(50)
    for (const [model, constraints] of Object.entries(UNIQUE_KEYS)) {
      const dmmf = dmmfModels.get(model)
      expect(dmmf, `UNIQUE_KEYS references unknown model ${model}`).toBeDefined()
      const scalarFields = new Set(
        dmmf!.fields.filter((f) => f.kind === "scalar" || f.kind === "enum").map((f) => f.name),
      )
      const idFields = idFieldsByModel.get(model) ?? new Set<string>()
      for (const cols of constraints) {
        expect(cols.length, `${model} has empty unique constraint`).toBeGreaterThan(0)
        for (const col of cols) {
          expect(scalarFields.has(col), `${model}.${col} is not a scalar/enum field`).toBe(true)
        }
        if (cols.length === 1) {
          expect(idFields.has(cols[0]), `${model}.${cols[0]} is @id and should not be in UNIQUE_KEYS`).toBe(false)
        }
      }
    }
    expect(UNIQUE_KEYS.CardSortProposal).toEqual([["roundId", "userId", "objectId"]])
    expect(UNIQUE_KEYS.Follow).toEqual([["userId", "subjectType", "subjectId"]])
    expect(UNIQUE_KEYS.Doc).toEqual([
      ["roadmapItemId"],
      ["workspaceId", "seqPrefix", "seqNumber"],
    ])
    expect(UNIQUE_KEYS.WorkspaceScoringConfig).toEqual([["workspaceId"]])
  })

  it("parseUniqueKeys captures @unique and @@unique forms while ignoring @id, @@id, relations, and comments", () => {
    const sample = `
enum Kind {
  ALPHA
  BETA
}

model Sample {
  id          String  @id @default(dbgenerated("gen_random_uuid()"))
  slug        String  @unique
  tokenHash   String? @unique(map: "idx_sample_token") @map("token_hash")
  kind        Kind    @unique
  url         String  @default("https://example.com/a//b") @unique
  /// Mentions @unique and @@unique([fakeCol]) in a doc comment
  parent      Other?  @relation(fields: [parentId], references: [id])
  parentId    String?
  roundId     String
  userId      String
  seq         Int

  @@id([id, roundId])
  @@unique([roundId, userId])
  @@unique([roundId, seq(sort: Desc)], map: "idx_sample_round_seq")
  @@unique([userId, slug], name: "sample_user_slug")
  @@unique([
    parentId,
    kind
  ], map: "idx_multiline")
  @@unique([slug]) // duplicate of field-level @unique should be deduplicated
  // @@unique([ignoredCommentCol])
}
`
    expect(parseUniqueKeys(sample)).toEqual({
      Sample: [
        ["slug"],
        ["tokenHash"],
        ["kind"],
        ["url"],
        ["roundId", "userId"],
        ["roundId", "seq"],
        ["userId", "slug"],
        ["parentId", "kind"],
      ],
    })
  })
})
