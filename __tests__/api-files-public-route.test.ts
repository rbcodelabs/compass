import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { mockClient } from "aws-sdk-client-mock"
import { NextRequest } from "next/server"

// The route must never ask who the caller is. If anything under it reached for a
// session this mock would throw and fail the test.
const authSpy = vi.fn(() => { throw new Error("route consulted the session") })
vi.mock("@/auth", () => ({ auth: authSpy }))

import { GET, HEAD } from "@/app/api/files/public/[...key]/route"
import { isPublicPath } from "@/lib/route-access"

const s3 = mockClient(S3Client)
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const FEEDBACK = `feedback/ws_1/${UUID}-shot.png`

function bodyOf(text: string) {
  const bytes = new TextEncoder().encode(text)
  return { transformToWebStream: () => new Response(bytes).body!, transformToByteArray: async () => bytes }
}

function call(segments: string[], init: { method?: string; headers?: Record<string, string> } = {}) {
  const url = `http://localhost/api/files/public/${segments.join("/")}`
  const request = new NextRequest(url, { method: init.method ?? "GET", headers: init.headers })
  const handler = init.method === "HEAD" ? HEAD : GET
  return handler(request, { params: Promise.resolve({ key: segments }) })
}

beforeEach(() => {
  s3.reset()
  authSpy.mockClear()
  vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
  vi.stubEnv("COMPASS_S3_BUCKET", "compass-test-files")
  vi.stubEnv("COMPASS_S3_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-only-not-a-real-secret")
})
afterEach(() => vi.unstubAllEnvs())

describe("GET /api/files/public/<key>: what is served", () => {
  it("serves a public-shaped key with no session, reading exactly public/<key>", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("PNGDATA") as never, ContentType: "image/png", ContentLength: 7, ETag: '"e1"' })
    const response = await call(FEEDBACK.split("/"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("PNGDATA")
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: "compass-test-files", Key: `public/${FEEDBACK}` })
    expect(authSpy).not.toHaveBeenCalled()
  })

  it("serves the full 255-character feedback filename after its UUID prefix", async () => {
    const key = `feedback/ws_1/${UUID}-${"a".repeat(251)}.png`
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("IMAGE") as never, ContentType: "image/png" })
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png" })
    expect((await call(key.split("/"))).status).toBe(200)
    expect((await call(key.split("/"), { method: "HEAD" })).status).toBe(200)
  })

  it("sets type, length, validators, non-cacheable responses and the active-content defences", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("PNGDATA") as never, ContentType: "image/png", ContentLength: 7, ETag: '"e1"' })
    const response = await call(FEEDBACK.split("/"))
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("content-length")).toBe("7")
    expect(response.headers.get("etag")).toBe('"e1"')
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox;/)
    expect(response.headers.get("content-disposition")).toBe(`inline; filename="${UUID}-shot.png"`)
  })

  it("serves all three public shapes", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("x") as never, ContentType: "image/jpeg", ContentLength: 1 })
    for (const key of [
      `embed-feedback/ws_1/src_1/capture-${UUID}.jpg`,
      `branding/${UUID}-logo.png`,
      FEEDBACK,
    ]) expect((await call(key.split("/"))).status).toBe(200)
  })

  it("downloads rather than renders anything that is not a plain image", async () => {
    for (const type of ["application/pdf", "text/html", "text/plain", "text/csv", "application/xml", ""]) {
      s3.reset()
      s3.on(GetObjectCommand).resolves({ Body: bodyOf("x") as never, ContentType: type, ContentLength: 1 })
      const response = await call(`feedback/ws_1/${UUID}-doc.pdf`.split("/"))
      expect(response.headers.get("content-type"), type).toBe("application/octet-stream")
      expect(response.headers.get("content-disposition"), type).toMatch(/^attachment;/)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("serves an SVG logo inline but sandboxed, so script in it has no origin", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("<svg/>") as never, ContentType: "image/svg+xml; charset=utf-8", ContentLength: 6 })
    const response = await call(`branding/${UUID}-logo.svg`.split("/"))
    expect(response.headers.get("content-type")).toBe("image/svg+xml")
    expect(response.headers.get("content-security-policy")).toContain("sandbox")
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
  })
})

describe("GET /api/files/public/<key>: what is refused", () => {
  const refused: Array<[string, string[]]> = [
    ["a private artifact key", ["artifacts", "ws", "rev", "page.html"]],
    ["a staging key", ["tmp", "artifact-staging", "ws", "u.html"]],
    ["another store's prefix", ["research", "ws", "recording.webm"]],
    ["a doc image key", ["docs", "ws", "images", `${UUID}.png`]],
    ["the public/ prefix repeated", ["public", ...FEEDBACK.split("/")]],
    ["a feedback key without the random component", ["feedback", "ws_1", "guessable.png"]],
    ["a feedback key with a timestamp instead of a UUID", ["feedback", "ws_1", "1730000000000-shot.png"]],
    ["a branding key without the random component", ["branding", "logo.png"]],
    ["an embed key with the wrong file name", ["embed-feedback", "ws_1", "src_1", "capture.jpg"]],
    ["an extra path segment", [...FEEDBACK.split("/"), "extra"]],
    ["traversal to a private prefix", ["feedback", "ws_1", "..", "..", "artifacts", "ws", "a.html"]],
    ["a bare dot-dot", [".."]],
    ["a single dot", ["."]],
    ["percent-encoded dot-dot", ["%2e%2e", "artifacts", "x"]],
    ["double-encoded dot-dot", ["%252e%252e", "artifacts", "x"]],
    ["double-encoded slash", ["feedback%252Fws_1%252F" + UUID + "-a.png"]],
    ["an encoded slash inside one segment", [`feedback%2Fws_1%2F${UUID}-a.png`]],
    ["a decoded slash inside one segment", [`feedback/ws_1/${UUID}-a.png`]],
    ["a backslash", ["feedback", "ws_1", `${UUID}-..\\..\\a.png`]],
    ["a NUL byte", ["feedback", "ws_1", `${UUID}-a\u0000.png`]],
    ["an empty segment", ["feedback", "", `${UUID}-a.png`]],
    ["no segments", []],
    ["a very long key", ["feedback", "ws_1", `${UUID}-${"a".repeat(300)}`]],
    ["a query-ish name", ["feedback", "ws_1", `${UUID}-a.png?x=1`]],
  ]
  it.each(refused)("404s %s without ever calling S3", async (_label, segments) => {
    const response = await call(segments)
    expect(response.status).toBe(404)
    expect(s3.calls()).toHaveLength(0)
    expect(authSpy).not.toHaveBeenCalled()
  })

  it("a missing object is a 404, indistinguishable from a refused key", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("nf"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }))
    const missing = await call(FEEDBACK.split("/"))
    const refusedResponse = await call(["artifacts", "x"])
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe(await refusedResponse.text())
  })

  it("a 403 from S3 (absent key, role cannot list) is the same 404 as a missing object", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))
    const denied = await call(FEEDBACK.split("/"))
    const refusedResponse = await call(["artifacts", "x"])
    expect(denied.status).toBe(404)
    expect(await denied.text()).toBe(await refusedResponse.text())
    warn.mockRestore()
  })

  it("keeps existing S3 public URLs readable after the default write backend changes", async () => {
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "blob")
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("PNGDATA") as never, ContentType: "image/png" })
    expect((await call(FEEDBACK.split("/"))).status).toBe(200)
  })

  it("does not look up public S3 URLs without a configured bucket", async () => {
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "blob")
    vi.stubEnv("COMPASS_S3_BUCKET", "")
    expect((await call(FEEDBACK.split("/"))).status).toBe(404)
    expect(s3.calls()).toHaveLength(0)
  })

  it("allows a linked embed screenshot to render on a separate site", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("IMAGE") as never, ContentType: "image/png" })
    const response = await call(`embed-feedback/ws_1/source_1/capture-${UUID}.png`.split("/"))
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
  })

  it("reports an unexpected storage failure as a generic 502 without leaking detail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("secret-bucket-detail"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }))
    const response = await call(FEEDBACK.split("/"))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("secret-bucket-detail")
    error.mockRestore()
  })
})

describe("proxy layer: which paths are reachable without a session", () => {
  it("lets exactly the public key shapes through", () => {
    expect(isPublicPath(`/api/files/public/${FEEDBACK}`)).toBe(true)
    expect(isPublicPath(`/api/files/public/branding/${UUID}-logo.png`)).toBe(true)
    expect(isPublicPath(`/api/files/public/embed-feedback/ws_1/src_1/capture-${UUID}.webp`)).toBe(true)
  })
  it("keeps every other /api/files path behind login", () => {
    for (const path of [
      "/api/files", "/api/files/", "/api/files/public", "/api/files/public/",
      "/api/files/artifacts/ws/a.html", "/api/files/tmp/x", "/api/files/research/x",
      "/api/files/public/artifacts/ws/a.html",
      "/api/files/public/feedback/ws_1/guessable.png",
      `/api/files/public/feedback/ws_1/${UUID}-a.png/extra`,
      `/api/files/public/../artifacts/x`,
      `/api/files/public/%2e%2e/artifacts/x`,
      `/api/files/public/feedback/ws_1/${UUID}-a%2Fb.png`,
      `/api/filesx/public/${FEEDBACK}`,
      `/api/files/PUBLIC/${FEEDBACK}`,
    ]) expect(isPublicPath(path), path).toBe(false)
  })
})

describe("conditional and ranged requests", () => {
  it("passes If-None-Match to S3 and answers 304 with the validator and caching headers", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("nm"), { name: "NotModified", $metadata: { httpStatusCode: 304 } }))
    const response = await call(FEEDBACK.split("/"), { headers: { "if-none-match": '"e1"' } })
    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe('"e1"')
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.IfNoneMatch).toBe('"e1"')
    expect(await response.text()).toBe("")
  })

  it("passes a single range through and returns 206 with Content-Range", async () => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("PNGDA") as never, ContentType: "image/png", ContentLength: 5, ContentRange: "bytes 0-4/100" })
    const response = await call(FEEDBACK.split("/"), { headers: { range: "bytes=0-4" } })
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 0-4/100")
    expect(response.headers.get("content-length")).toBe("5")
    expect(await response.text()).toBe("PNGDA")
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Range).toBe("bytes=0-4")
  })

  it.each(["bytes=0-4", "bytes=5-", "bytes=-10"])("forwards %s", async (range) => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("x") as never, ContentType: "image/png", ContentLength: 1, ContentRange: "bytes 0-0/1" })
    await call(FEEDBACK.split("/"), { headers: { range } })
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Range).toBe(range)
  })

  it.each(["bytes=0-4,10-20", "items=0-4", "bytes=a-b", "bytes=--1", "bytes=0-4;evil"])("ignores %s and serves the whole object", async (range) => {
    s3.on(GetObjectCommand).resolves({ Body: bodyOf("whole") as never, ContentType: "image/png", ContentLength: 5 })
    const response = await call(FEEDBACK.split("/"), { headers: { range } })
    expect(response.status).toBe(200)
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Range).toBeUndefined()
  })

  it("answers 416 when S3 rejects the range", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("ir"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } }))
    const response = await call(FEEDBACK.split("/"), { headers: { range: "bytes=999-" } })
    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */*")
  })
})

describe("HEAD", () => {
  it("returns headers only", async () => {
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 7, ETag: '"e1"' })
    const response = await call(FEEDBACK.split("/"), { method: "HEAD" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-length")).toBe("7")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response.text()).toBe("")
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.Key).toBe(`public/${FEEDBACK}`)
  })
  it("304s on a matching ETag and 404s on a refused key without calling S3", async () => {
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 7, ETag: '"e1"' })
    expect((await call(FEEDBACK.split("/"), { method: "HEAD", headers: { "if-none-match": '"e1"' } })).status).toBe(304)
    s3.reset()
    expect((await call(["artifacts", "x"], { method: "HEAD" })).status).toBe(404)
    expect(s3.calls()).toHaveLength(0)
  })
})
