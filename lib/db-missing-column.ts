/**
 * True when a Prisma error means "a column or table this code reads is not in the database yet" (P2021/P2022).
 * Additive migrations here may apply after the code that reads them ships; reads of the NEW columns use this to
 * fall back to the pre-migration meaning (no published docs, editorial template) instead of failing the page.
 * Writes must NOT use it: a write that cannot persist has to fail loudly.
 */
export function isMissingColumnError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")
}
