import { describe, expect, it } from "vitest"
import { assertCompassEnvConfigured, compassEnv } from "@/lib/runtime-env"

// Plain objects, not process.env: the helper takes its environment as a parameter.
describe("compassEnv", () => {
  describe("on Vercel (VERCEL_ENV set, COMPASS_ENV unset)", () => {
    it.each([
      ["production", "production"],
      ["preview", "preview"],
      ["development", "development"],
    ])("VERCEL_ENV=%s resolves to %s", (vercel, expected) => {
      expect(compassEnv({ NODE_ENV: "production", VERCEL_ENV: vercel })).toBe(expected)
    })

    it("treats an unrecognised VERCEL_ENV as development, as lib/schema.ts always did", () => {
      expect(compassEnv({ NODE_ENV: "production", VERCEL_ENV: "staging" })).toBe("development")
    })
  })

  describe("COMPASS_ENV", () => {
    it.each(["production", "preview", "development"] as const)("%s is accepted with nothing else set", (value) => {
      expect(compassEnv({ NODE_ENV: "production", COMPASS_ENV: value })).toBe(value)
    })

    it("wins over VERCEL_ENV", () => {
      expect(compassEnv({ COMPASS_ENV: "preview", VERCEL_ENV: "production" })).toBe("preview")
    })

    it("ignores surrounding whitespace", () => {
      expect(compassEnv({ NODE_ENV: "production", COMPASS_ENV: " production " })).toBe("production")
    })

    it("rejects an unknown value instead of guessing", () => {
      expect(() => compassEnv({ NODE_ENV: "production", COMPASS_ENV: "prod" })).toThrow(/COMPASS_ENV must be one of/)
      expect(() => compassEnv({ COMPASS_ENV: "staging", VERCEL_ENV: "production" })).toThrow(/staging/)
    })

    it("treats an empty value as unset", () => {
      expect(compassEnv({ COMPASS_ENV: "", VERCEL_ENV: "preview" })).toBe("preview")
    })
  })

  describe("when neither is set", () => {
    it("throws for a production process, naming the variable to set", () => {
      expect(() => compassEnv({ NODE_ENV: "production" })).toThrow(/COMPASS_ENV is not set/)
      expect(() => compassEnv({ NODE_ENV: "production", VERCEL_ENV: "" })).toThrow(/COMPASS_ENV is not set/)
    })

    it.each(["development", "test", undefined])("keeps local behaviour for NODE_ENV=%s", (nodeEnv) => {
      expect(compassEnv({ NODE_ENV: nodeEnv })).toBe("development")
    })

    it("does not throw while next build collects page data", () => {
      expect(compassEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe("development")
    })

    it("does throw once the built server is running", () => {
      expect(() => compassEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-server" })).toThrow()
    })
  })

  it("assertCompassEnvConfigured throws exactly when compassEnv does", () => {
    expect(() => assertCompassEnvConfigured({ NODE_ENV: "production" })).toThrow(/COMPASS_ENV is not set/)
    expect(assertCompassEnvConfigured({ NODE_ENV: "production", COMPASS_ENV: "production" })).toBe("production")
  })
})
