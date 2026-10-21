import { describe, expect, it } from "vitest"
import { isPlatformAdminEmail, isPlatformAdminSession, platformAdminEmails } from "@/lib/platform-admin"

const env = (v?: string) => ({ PLATFORM_ADMIN_EMAILS: v }) as unknown as NodeJS.ProcessEnv

describe("platform admin allowlist", () => {
  it("fails closed when unset, empty, or only separators", () => {
    for (const v of [undefined, "", "  ", " , ,"]) {
      expect(platformAdminEmails(env(v))).toEqual([])
      expect(isPlatformAdminEmail("a@x.com", env(v))).toBe(false)
    }
  })

  it("matches case-insensitively and trims whitespace in the list and the email", () => {
    const e = env(" Rick@Example.com , ops@example.com ")
    expect(isPlatformAdminEmail("rick@example.com", e)).toBe(true)
    expect(isPlatformAdminEmail("  OPS@EXAMPLE.COM ", e)).toBe(true)
    expect(isPlatformAdminEmail("other@example.com", e)).toBe(false)
  })

  it("rejects missing emails and does not do substring matching", () => {
    const e = env("rick@example.com")
    expect(isPlatformAdminEmail(null, e)).toBe(false)
    expect(isPlatformAdminEmail(undefined, e)).toBe(false)
    expect(isPlatformAdminEmail("", e)).toBe(false)
    expect(isPlatformAdminEmail("rick@example.com.evil.io", e)).toBe(false)
  })

  it("checks the session user's email against process.env", () => {
    const prev = process.env.PLATFORM_ADMIN_EMAILS
    try {
      process.env.PLATFORM_ADMIN_EMAILS = "rick@example.com"
      expect(isPlatformAdminSession({ user: { email: "RICK@example.com" } })).toBe(true)
      expect(isPlatformAdminSession({ user: { email: "x@example.com" } })).toBe(false)
      expect(isPlatformAdminSession(null)).toBe(false)
      expect(isPlatformAdminSession({ user: null })).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
      else process.env.PLATFORM_ADMIN_EMAILS = prev
    }
  })
})
