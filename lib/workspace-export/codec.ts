import { dmmfModels } from "@/lib/workspace-export/scope"

/**
 * Lossless row <-> JSON codec, driven by the Prisma datamodel so every column
 * type round-trips (Date, BigInt, Decimal, Bytes). Json columns pass through.
 */

type Row = Record<string, unknown>

function scalarFields(model: string) {
  const m = dmmfModels.get(model)
  if (!m) throw new Error(`Unknown model ${model}`)
  return m.fields.filter((f) => f.kind === "scalar" || f.kind === "enum")
}

export function encodeRow(model: string, row: Row): Row {
  const out: Row = {}
  for (const f of scalarFields(model)) {
    const v = row[f.name]
    if (v === undefined) continue
    if (v === null) out[f.name] = null
    else if (f.type === "DateTime") out[f.name] = (v as Date).toISOString()
    else if (f.type === "BigInt") out[f.name] = (v as bigint).toString()
    else if (f.type === "Decimal") out[f.name] = String(v)
    else if (f.type === "Bytes") out[f.name] = Buffer.from(v as Uint8Array).toString("base64")
    else out[f.name] = v
  }
  return out
}

export function decodeRow(model: string, raw: Row): Row {
  const out: Row = {}
  const known = new Map(scalarFields(model).map((f) => [f.name, f]))
  for (const [name, v] of Object.entries(raw)) {
    const f = known.get(name)
    // Columns that no longer exist in this build are dropped (forward compatibility).
    if (!f) continue
    if (v === null) out[name] = null
    else if (f.type === "DateTime") out[name] = new Date(v as string)
    else if (f.type === "BigInt") out[name] = BigInt(v as string)
    else if (f.type === "Bytes") out[name] = Buffer.from(v as string, "base64")
    else out[name] = v
  }
  return out
}

export function fieldInfo(model: string, name: string) {
  return scalarFields(model).find((f) => f.name === name)
}

export function scalarFieldNames(model: string): string[] {
  return scalarFields(model).map((f) => f.name)
}
