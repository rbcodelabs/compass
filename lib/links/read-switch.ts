/**
 * The one place a legacy reader consults its family's read mode (entity_links read flip, PR B onwards).
 *
 *   off     the legacy reader runs and nothing else happens: no entity_links query, no import of the compare module.
 *   shadow  the legacy reader runs, its result is RETURNED UNCHANGED, and afterwards the same scope is read from entity_links and
 *           compared (counts and ids only). A failure anywhere in the comparison is swallowed and counted; it never reaches the caller.
 *   on      the entity_links reader's result is returned (same shape, ordering and filtering as legacy; each reader proves it in tests).
 *           If that read throws, the legacy reader serves the request instead and the failure is counted, so turning the flag on can
 *           never make a page fail that the legacy tables could still serve. Writers keep dual-writing, so legacy stays current and the
 *           rollback is simply the flag set back to off.
 *
 * This module imports only read-mode (no registry, no typed-links): the compare module is loaded lazily and only in shadow / on, which
 * keeps the legacy reader modules free of an import cycle and the default (off) path byte-identical to before.
 */
import { getLinkReadMode, type LinkReadFamily } from "@/lib/links/read-mode"
import type { ComparableLink } from "@/lib/links/read-compare"

export type ShadowScope = { legacy: readonly ComparableLink[]; readEntityLinks: () => Promise<ComparableLink[]> }

export async function readByFamilyMode<T>(
  family: LinkReadFamily,
  readers: {
    legacy: () => Promise<T>
    /** The legacy result as comparable links plus the entity_links read of the same scope. May return null when there is nothing to compare. */
    shadowScope: (legacyResult: T) => Promise<ShadowScope | null> | ShadowScope | null
    entityLinks: () => Promise<T>
  },
): Promise<T> {
  const mode = getLinkReadMode(family)
  if (mode === "off") return readers.legacy()
  const compare = await import("@/lib/links/read-compare")
  if (mode === "shadow") {
    const legacyResult = await readers.legacy()
    try {
      const scope = await readers.shadowScope(legacyResult)
      if (scope) await compare.compareFamilyRead(family, { legacy: scope.legacy, readEntityLinks: scope.readEntityLinks })
    } catch (error) {
      compare.recordReadError(family, error)
    }
    return legacyResult
  }
  try {
    return await readers.entityLinks()
  } catch (error) {
    compare.recordReadError(family, error)
    return readers.legacy()
  }
}
