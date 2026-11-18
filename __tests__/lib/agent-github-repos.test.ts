import { describe, expect, it } from "vitest"
import { parseStoredConfig, serializeConfig } from "@/lib/agent-github-repos"

describe("agent github stored config", () => {
  it("reads the legacy array as write access", () => {
    expect(parseStoredConfig('["a/b","a/c"]')).toEqual({ repos: ["a/b", "a/c"], access: "write" })
  })
  it("reads the object shape and defaults an unknown access to write", () => {
    expect(parseStoredConfig('{"repos":["a/b"],"access":"read"}')).toEqual({ repos: ["a/b"], access: "read" })
    expect(parseStoredConfig('{"repos":["a/b"],"access":"admin"}')).toEqual({ repos: ["a/b"], access: "write" })
  })
  it("treats null and malformed values as no repos", () => {
    expect(parseStoredConfig(null).repos).toEqual([])
    expect(parseStoredConfig("{nope").repos).toEqual([])
    expect(parseStoredConfig("42").repos).toEqual([])
  })
  it("round-trips, keeping the legacy shape for write and null for empty", () => {
    expect(serializeConfig({ repos: ["a/b"], access: "write" })).toBe('["a/b"]')
    expect(parseStoredConfig(serializeConfig({ repos: ["a/b"], access: "read" }))).toEqual({ repos: ["a/b"], access: "read" })
    expect(parseStoredConfig(serializeConfig({ repos: ["a/b"], access: "code-read" }))).toEqual({ repos: ["a/b"], access: "code-read" })
    expect(serializeConfig({ repos: [], access: "read" })).toBeNull()
  })
})
