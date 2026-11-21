import { describe, expect, it } from "vitest"
import { isPublicFileKey, isPublicFilePath, parsePublicFileUrl, publicFileUrl } from "@/lib/public-file-keys"

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("public file keys", () => {
  it("round-trips a valid key through its URL", () => {
    const key = `feedback/ws_1/${UUID}-a.png`
    expect(publicFileUrl(key)).toBe(`/api/files/public/${key}`)
    expect(parsePublicFileUrl(publicFileUrl(key))).toBe(key)
    expect(isPublicFilePath(publicFileUrl(key))).toBe(true)
  })

  it("refuses to build a URL for a key the route would not serve", () => {
    expect(() => publicFileUrl("artifacts/ws/a.html")).toThrow()
    expect(() => publicFileUrl(`feedback/ws_1/${UUID}`)).toThrow()
  })

  it.each([
    `/api/files/public/feedback/ws_1/${UUID}-a.png?x=1`,
    `/api/files/public/feedback/ws_1/${UUID}-a.png#frag`,
    `https://example.com/api/files/public/feedback/ws_1/${UUID}-a.png`,
    `//example.com/api/files/public/feedback/ws_1/${UUID}-a.png`,
    `/api/files/public/feedback/ws_1/${UUID}-a%2epng`,
    `/api/files/public/feedback/ws_1/${UUID}-a.png `,
    "", null, undefined, 42,
  ])("parsePublicFileUrl refuses %j", (value) => {
    expect(parsePublicFileUrl(value)).toBeNull()
  })

  it("accepts only lower-case UUIDs, bounded ids and bounded names", () => {
    expect(isPublicFileKey(`feedback/ws_1/${UUID.toUpperCase()}-a.png`)).toBe(false)
    expect(isPublicFileKey(`feedback/${"a".repeat(65)}/${UUID}-a.png`)).toBe(false)
    expect(isPublicFileKey(`feedback/ws_1/${UUID}-${"a".repeat(256)}`)).toBe(false)
    expect(isPublicFileKey(`feedback/ws_1/${UUID}-${"a".repeat(255)}`)).toBe(true)
    expect(isPublicFileKey(`embed-feedback/ws_1/src_1/capture-${UUID}.gif`)).toBe(false)
    expect(isPublicFileKey(`branding/${UUID}-logo.svg`)).toBe(true)
  })
})
