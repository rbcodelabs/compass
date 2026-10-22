import { describe, it, expect } from "vitest"
import { secretMatches } from "@/lib/secret-compare"

describe("secretMatches", () => {
  it("accepts an identical secret", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true)
  })

  it("rejects a different secret of the same length", () => {
    expect(secretMatches("s3cret-valuf", "s3cret-value")).toBe(false)
  })

  it("rejects a secret of a different length (shorter and longer)", () => {
    expect(secretMatches("s3cret", "s3cret-value")).toBe(false)
    expect(secretMatches("s3cret-value-extra", "s3cret-value")).toBe(false)
  })

  it("rejects when the configured secret is empty, even if the presented one is empty too", () => {
    expect(secretMatches("", "")).toBe(false)
    expect(secretMatches("anything", "")).toBe(false)
  })

  it("rejects when the configured secret is missing", () => {
    expect(secretMatches("anything", undefined)).toBe(false)
    expect(secretMatches(undefined, undefined)).toBe(false)
    expect(secretMatches(null, null)).toBe(false)
  })

  it("rejects when nothing is presented", () => {
    expect(secretMatches(undefined, "s3cret-value")).toBe(false)
    expect(secretMatches(null, "s3cret-value")).toBe(false)
    expect(secretMatches("", "s3cret-value")).toBe(false)
  })

  it("handles multi-byte secrets without throwing", () => {
    expect(secretMatches("sécrét-✓", "sécrét-✓")).toBe(true)
    expect(secretMatches("secret-x", "sécrét-✓")).toBe(false)
  })
})
