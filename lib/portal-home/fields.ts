import { z } from "zod"

/**
 * Shared Zod fragments for widget config. Everything here is client-safe (no
 * database or server imports) so the admin forms and the API routes validate
 * with the very same schemas.
 */

/** Plain text with a hard cap. Never rendered as HTML. */
export const text = (max: number) => z.string().trim().max(max)
export const requiredText = (max: number) => z.string().trim().min(1).max(max)

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const uuidLike = z.string().regex(UUID_LIKE, "Expected a UUID")

/**
 * A URL a customer may be sent to: an absolute http(s) URL or a same-site path
 * ("/portal/..."). Rejects javascript:, data:, protocol-relative ("//host") and
 * anything else, since this value ends up in an href on the public portal.
 */
export function isSafeLinkUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return false
  if (value.startsWith("/")) return !value.startsWith("//") && !value.includes("\\")
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export const safeLinkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(isSafeLinkUrl, "Use an http(s) URL or a path starting with /")

export const cta = z.object({ label: requiredText(40), url: safeLinkUrl })
export type Cta = z.infer<typeof cta>
