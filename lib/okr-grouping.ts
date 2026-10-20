/** Fields an OKR cycle can be grouped by: single-selects that have options. */
export function groupableObjectiveFields<T extends { fieldType: string; options?: unknown[] | null }>(
  fields: T[]
): T[] {
  return fields.filter((f) => f.fieldType === "SELECT" && (f.options?.length ?? 0) > 0);
}
