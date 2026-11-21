import { getActiveSchema } from "@/lib/schema"

/** Prisma's pg adapter qualifies generated SQL. Raw coordinator SQL must use the same namespace. */
export function importSchema(schema = getActiveSchema()): string {
  return '"' + schema.replaceAll('"', '""') + '"'
}
