import type { AppTransactionClient } from "@/lib/db"

/**
 * In-memory stand-in for the transaction client the inheritance service uses. It implements only the
 * delegates and the where-shapes (equality, `in`, `not`) the service is allowed to issue, and records
 * every query so tests can assert workspace scoping on all of them.
 */
type Row = Record<string, unknown>
type Where = Record<string, unknown>

export type RecordedQuery = { model: string; op: string; where: Where }

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]) => {
    const actual = row[key]
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown }
      if (c.in) return c.in.includes(actual)
      if ("not" in c) return actual !== c.not
    }
    return actual === cond
  })
}

export function createInheritanceFakeDb(options: { permissive?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    customFieldInheritanceRule: [],
    customFieldDefinition: [],
    customFieldValue: [],
    opportunity: [],
    solution: [],
    roadmapItem: [],
  }
  const queries: RecordedQuery[] = []
  let seq = 0

  const delegate = (model: string) => ({
    findMany: async (args: { where?: Where; take?: number } = {}) => {
      queries.push({ model, op: "findMany", where: args.where ?? {} })
      const rows = tables[model].filter((row) => matches(row, args.where))
      return (args.take ? rows.slice(0, args.take) : rows).map((row) => ({ ...row }))
    },
    findFirst: async (args: { where?: Where } = {}) => {
      queries.push({ model, op: "findFirst", where: args.where ?? {} })
      const row = tables[model].find((candidate) => matches(candidate, args.where))
      return row ? { ...row } : null
    },
    count: async (args: { where?: Where } = {}) => {
      queries.push({ model, op: "count", where: args.where ?? {} })
      return tables[model].filter((row) => matches(row, args.where)).length
    },
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      queries.push({ model, op: "createMany", where: {} })
      let created = 0
      for (const data of args.data) {
        const duplicate = tables[model].some((row) => row.fieldId === data.fieldId && row.objectId === data.objectId)
        if (duplicate) {
          if (args.skipDuplicates) continue
          throw new Error("unique violation")
        }
        tables[model].push({ id: `gen-${++seq}`, ...data })
        created++
      }
      return { count: created }
    },
    create: async (args: { data: Row }) => {
      queries.push({ model, op: "create", where: {} })
      const rows = tables[model]
      const data = args.data
      const duplicate =
        model === "customFieldInheritanceRule"
          ? rows.some((r) => r.workspaceId === data.workspaceId && r.targetFieldId === data.targetFieldId && (r.priority === data.priority || r.sourceFieldId === data.sourceFieldId))
          : rows.some((r) => r.fieldId === data.fieldId && r.objectId === data.objectId)
      if (duplicate) throw Object.assign(new Error("unique violation"), { code: "P2002" })
      const row = { id: `gen-${++seq}`, enabled: true, ...data }
      rows.push(row)
      return { ...row }
    },
    update: async (args: { where: Where; data: Row }) => {
      if (!options.permissive) throw new Error(`update on ${model} is forbidden: inheritance is insert-only`)
      queries.push({ model, op: "update", where: args.where })
      const row = tables[model].find((candidate) => matches(candidate, args.where))
      if (!row) throw Object.assign(new Error("not found"), { code: "P2025" })
      Object.assign(row, args.data)
      return { ...row }
    },
    updateMany: async (args: { where: Where; data: Row }) => {
      if (!options.permissive) throw new Error(`updateMany on ${model} is forbidden: inheritance is insert-only`)
      queries.push({ model, op: "updateMany", where: args.where })
      const rows = tables[model].filter((candidate) => matches(candidate, args.where))
      for (const row of rows) Object.assign(row, args.data)
      return { count: rows.length }
    },
    deleteMany: async (args: { where: Where }) => {
      if (!options.permissive) throw new Error(`deleteMany on ${model} is forbidden: inheritance never clears`)
      queries.push({ model, op: "deleteMany", where: args.where })
      const before = tables[model].length
      tables[model] = tables[model].filter((candidate) => !matches(candidate, args.where))
      return { count: before - tables[model].length }
    },
    upsert: async () => {
      throw new Error(`upsert on ${model} is forbidden: inheritance never overwrites`)
    },
  })

  const tx = Object.fromEntries(Object.keys(tables).map((model) => [model, delegate(model)])) as unknown as AppTransactionClient

  return {
    tx,
    queries,
    tables,
    values: () => tables.customFieldValue,
    valueOf: (fieldId: string, objectId: string) =>
      tables.customFieldValue.find((row) => row.fieldId === fieldId && row.objectId === objectId)?.value,
    addField(row: Partial<Row> & { id: string; workspaceId: string; objectType: string; fieldType: string; name: string }) {
      tables.customFieldDefinition.push({ options: null, sharedOptionSetId: null, sharedOptionSet: null, required: false, order: 0, ...row })
    },
    addRule(row: Partial<Row> & { id: string; workspaceId: string; targetFieldId: string; sourceFieldId: string; sourceObjectType: string }) {
      tables.customFieldInheritanceRule.push({ targetObjectType: "ROADMAP_ITEM", priority: 0, enabled: true, ...row })
    },
    addValue(fieldId: string, objectId: string, value: unknown) {
      tables.customFieldValue.push({ id: `seed-${++seq}`, fieldId, objectId, value })
    },
    addEntity(model: "opportunity" | "solution", id: string, workspaceId: string) {
      tables[model].push({ id, workspaceId })
    },
    addRoadmapItem(id: string, workspaceId: string, links: { opportunityId?: string | null; solutionId?: string | null } = {}) {
      tables.roadmapItem.push({ id, workspaceId, opportunityId: links.opportunityId ?? null, solutionId: links.solutionId ?? null })
    },
  }
}

export type InheritanceFakeDb = ReturnType<typeof createInheritanceFakeDb>
