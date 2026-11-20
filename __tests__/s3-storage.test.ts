import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { mockClient } from "aws-sdk-client-mock"
import { createS3Storage, createPresignedUpload, getPublicObject, headPublicObject, putPublicObject, s3ObjectKey } from "@/lib/storage/s3"
import { deleteS3PublicFilesByUrl, putS3PublicFile } from "@/lib/storage/public-files"

const s3 = mockClient(S3Client)
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

function body(bytes: Uint8Array) {
  return {
    transformToByteArray: async () => bytes,
    transformToWebStream: () => new Response(bytes as BodyInit).body!,
  }
}

beforeEach(() => {
  s3.reset()
  vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
  vi.stubEnv("COMPASS_S3_BUCKET", "compass-test-files")
  vi.stubEnv("COMPASS_S3_REGION", "us-east-1")
  // The default credential chain reads these; the code under test never does.
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-only-not-a-real-secret")
  // Keep the test hermetic: with AWS_PROFILE set (any developer machine with SSO), the SDK's chain prefers the profile
  // over the env keys above, so a real temporary credential and session token were signed into the presigned policy.
  // That made assertions over the policy depend on random credential bytes (and put a live token in test output).
  vi.stubEnv("AWS_PROFILE", "")
  vi.stubEnv("AWS_SESSION_TOKEN", "")
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
  vi.stubEnv("AWS_CONFIG_FILE", "/dev/null")
})
afterEach(() => vi.unstubAllEnvs())

describe("s3ObjectKey", () => {
  it("prefixes each store", () => {
    expect(s3ObjectKey("artifacts", "ws/a/1.html")).toBe("artifacts/ws/a/1.html")
    expect(s3ObjectKey("artifacts", "docs/ws/images/i.png")).toBe("artifacts/docs/ws/images/i.png")
    expect(s3ObjectKey("capability-packs", "p/1.json")).toBe("capability-packs/p/1.json")
    expect(s3ObjectKey("research", "r/1.webm")).toBe("research/r/1.webm")
    expect(s3ObjectKey("agent-sessions", "s/1.gz")).toBe("agent-sessions/s/1.gz")
    expect(s3ObjectKey("public", `feedback/ws/${UUID}-a.png`)).toBe(`public/feedback/ws/${UUID}-a.png`)
  })

  it("sends unconsumed direct-upload staging objects to the expiring tmp/ prefix", () => {
    expect(s3ObjectKey("artifacts", "artifact-staging/ws/u.html")).toBe("tmp/artifact-staging/ws/u.html")
    expect(s3ObjectKey("artifacts", "workspace-import-staging/org/bundle.zip")).toBe("tmp/workspace-import-staging/org/bundle.zip")
    // Only the artifacts store has staging; other stores never remap.
    expect(s3ObjectKey("research", "artifact-staging/ws/u.html")).toBe("research/artifact-staging/ws/u.html")
  })

  it.each(["", "/abs", "../x", "a/../b", "a/./b", "a//b", "a\\b", "a/\u0000b", "a/..", ".", "x".repeat(901)])(
    "refuses %j", (pathname) => { expect(() => s3ObjectKey("artifacts", pathname)).toThrow(/Invalid storage path/) },
  )
})

describe("one prefix rule for every store", () => {
  it.each(["artifacts", "capability-packs", "research", "agent-sessions", "public"] as const)(
    "%s: a pathname that already starts with the prefix is not doubled", (store) => {
      expect(s3ObjectKey(store, `${store}/ws/x`)).toBe(`${store}/ws/x`)
      expect(s3ObjectKey(store, "ws/x")).toBe(`${store}/ws/x`)
      // Only a whole leading segment counts.
      expect(s3ObjectKey(store, `${store}x/ws`)).toBe(`${store}/${store}x/ws`)
      expect(s3ObjectKey(store, `ws/${store}/x`)).toBe(`${store}/ws/${store}/x`)
    })

  it("cannot cross stores through traversal or prefix confusion", () => {
    expect(() => s3ObjectKey("artifacts", "artifacts/../public/feedback/x")).toThrow(/Invalid storage path/)
    expect(() => s3ObjectKey("public", "public/../artifacts/x")).toThrow(/Invalid storage path/)
    expect(() => s3ObjectKey("research", "artifacts/%2e%2e/x")).not.toThrow() // literal segment, stays inside research/
    expect(s3ObjectKey("research", "artifacts/%2e%2e/x")).toBe("research/artifacts/%2e%2e/x")
    expect(s3ObjectKey("artifacts", "public/artifacts/x")).toBe("artifacts/public/artifacts/x")
    expect(s3ObjectKey("public", `artifacts/x`)).toBe("public/artifacts/x")
    expect(() => s3ObjectKey("artifacts", "artifacts//x")).toThrow(/Invalid storage path/)
  })
})

describe("createS3Storage", () => {
  it("put with overwrite:false sends If-None-Match: * and reports created", async () => {
    s3.on(PutObjectCommand).resolves({})
    const result = await createS3Storage("artifacts").put("ws/a.html", new Uint8Array([1]), "text/html", { overwrite: false })
    expect(result).toEqual({ pathname: "ws/a.html", created: true })
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.IfNoneMatch).toBe("*")
  })

  it("put with overwrite:false leaves an existing object alone (412) and reports created:false", async () => {
    s3.on(PutObjectCommand).rejects(Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }))
    const result = await createS3Storage("artifacts").put("ws/a.html", new Uint8Array([1]), "text/html", { overwrite: false })
    expect(result).toEqual({ pathname: "ws/a.html", created: false })
  })

  it("retries a conditional conflict before reporting a private object was created", async () => {
    const conflict = Object.assign(new Error("conditional write conflict"), {
      name: "ConditionalRequestConflict",
      $metadata: { httpStatusCode: 409 },
    })
    s3.on(PutObjectCommand).rejectsOnce(conflict).resolves({})
    const storage = createS3Storage("artifacts")
    await expect(storage.put("ws/a.html", new Uint8Array([1]), "text/html", { overwrite: false }))
      .resolves.toEqual({ pathname: "ws/a.html", created: true })
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(2)
  })

  it("surfaces a persistent conditional conflict after a bounded number of attempts", async () => {
    const conflict = Object.assign(new Error("conditional write conflict"), {
      name: "ConditionalRequestConflict",
      $metadata: { httpStatusCode: 409 },
    })
    s3.on(PutObjectCommand).rejects(conflict)
    const storage = createS3Storage("artifacts")
    await expect(storage.put("ws/a.html", new Uint8Array([1]), "text/html", { overwrite: false }))
      .rejects.toThrow("conditional write conflict")
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(3)
  })

  it("a default put sends no If-None-Match and still surfaces real errors", async () => {
    s3.on(PutObjectCommand).resolves({})
    await createS3Storage("artifacts").put("ws/a.html", new Uint8Array([1]))
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).not.toHaveProperty("IfNoneMatch")
    s3.on(PutObjectCommand).rejects(Object.assign(new Error("boom"), { name: "InternalError" }))
    await expect(createS3Storage("artifacts").put("ws/a.html", new Uint8Array([1]), "text/html", { overwrite: false })).rejects.toThrow("boom")
  })

  it("put writes a private, non-cacheable, download-only object under the store prefix with no ACL", async () => {
    s3.on(PutObjectCommand).resolves({})
    const result = await createS3Storage("artifacts").put("ws/a.html", new TextEncoder().encode("<p>"), "text/html")
    expect(result).toEqual({ pathname: "ws/a.html" })
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input
    expect(input).toMatchObject({
      Bucket: "compass-test-files", Key: "artifacts/ws/a.html", ContentType: "text/html",
      CacheControl: "private, no-store", ContentDisposition: "attachment",
    })
    expect(input).not.toHaveProperty("ACL")
    expect(input).not.toHaveProperty("ServerSideEncryption")
  })

  it("put defaults the content type like the Blob store does", async () => {
    s3.on(PutObjectCommand).resolves({})
    await createS3Storage("research").put("r/1", new Uint8Array([1]))
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.ContentType).toBe("text/html; charset=utf-8")
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.Key).toBe("research/r/1")
  })

  it("get returns the bytes, and null for a missing key", async () => {
    s3.on(GetObjectCommand).resolves({ Body: body(new Uint8Array([1, 2, 3])) as never })
    expect(await createS3Storage("artifacts").get("ws/a.html")).toEqual(new Uint8Array([1, 2, 3]))
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: "compass-test-files", Key: "artifacts/ws/a.html" })

    s3.reset()
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }))
    expect(await createS3Storage("artifacts").get("ws/missing.html")).toBeNull()
  })

  it("get maps 403 (what S3 returns for an absent key when the role cannot list the prefix) to not-found, like Blob", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))
    expect(await createS3Storage("artifacts").get("ws/a.html")).toBeNull()
    warn.mockRestore()
  })

  it("get does not swallow other failures", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }))
    await expect(createS3Storage("artifacts").get("ws/a.html")).rejects.toThrow("slow down")
  })

  it("del removes exactly the mapped key", async () => {
    s3.on(DeleteObjectCommand).resolves({})
    await createS3Storage("agent-sessions").del("s/1.gz")
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: "compass-test-files", Key: "agent-sessions/s/1.gz" })
  })

  it("every private store reaches only its own prefix, so one store cannot read another's keys", async () => {
    s3.on(GetObjectCommand).resolves({ Body: body(new Uint8Array([9])) as never })
    await createS3Storage("capability-packs").get("x/1")
    await createS3Storage("research").get("x/1")
    await createS3Storage("agent-sessions").get("x/1")
    expect(s3.commandCalls(GetObjectCommand).map((c) => c.args[0].input.Key)).toEqual([
      "capability-packs/x/1", "research/x/1", "agent-sessions/x/1",
    ])
  })

  it("refuses a traversal path before any request is made", async () => {
    await expect(createS3Storage("artifacts").get("../public/feedback/x")).rejects.toThrow(/Invalid storage path/)
    expect(s3.calls()).toHaveLength(0)
  })

  it("fails loudly at first use when the bucket is not configured", async () => {
    vi.stubEnv("COMPASS_S3_BUCKET", "")
    await expect(createS3Storage("artifacts").get("ws/a.html")).rejects.toThrow(/COMPASS_S3_BUCKET/)
    expect(s3.calls()).toHaveLength(0)
  })
})

describe("public store helpers", () => {
  it("putS3PublicFile writes under public/ with immutable caching and returns the app route, not a bucket URL", async () => {
    s3.on(PutObjectCommand).resolves({})
    const key = `feedback/ws1/${UUID}-shot.png`
    const result = await putS3PublicFile({ key, body: new Uint8Array([1]), contentType: "image/png" })
    expect(result).toEqual({ url: `/api/files/public/${key}` })
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({
      Key: `public/${key}`, ContentType: "image/png", CacheControl: "public, max-age=31536000, immutable", ContentDisposition: "attachment", IfNoneMatch: "*",
    })
  })

  it("refuses to write a key the route would not serve", async () => {
    await expect(putS3PublicFile({ key: "feedback/ws1/guessable.png", body: new Uint8Array([1]) })).rejects.toThrow(/Not a public file key/)
    await expect(putS3PublicFile({ key: "artifacts/ws/a.html", body: new Uint8Array([1]) })).rejects.toThrow(/Not a public file key/)
    expect(s3.calls()).toHaveLength(0)
  })

  it("deletes only app-route URLs, skipping Blob URLs and foreign values", async () => {
    s3.on(DeleteObjectCommand).resolves({})
    const key = `feedback/ws1/${UUID}-shot.png`
    await deleteS3PublicFilesByUrl([`/api/files/public/${key}`, "https://x.public.blob.vercel-storage.com/feedback/a.png", "/api/files/public/artifacts/ws/a.html"])
    expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key)).toEqual([`public/${key}`])
  })

  it("head and get fold 403 into not-found, never leaking the difference", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const denied = Object.assign(new Error("denied"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } })
    s3.on(HeadObjectCommand).rejects(denied)
    s3.on(GetObjectCommand).rejects(denied)
    expect(await headPublicObject(`branding/${UUID}-logo.png`)).toBeNull()
    expect(await getPublicObject(`branding/${UUID}-logo.png`)).toEqual({ kind: "not-found" })
    warn.mockRestore()
  })

  it("head / get / put pin the public/ prefix", async () => {
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 3, ETag: '"abc"' })
    expect(await headPublicObject(`branding/${UUID}-logo.png`)).toEqual({ contentType: "image/png", contentLength: 3, etag: '"abc"' })
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.Key).toBe(`public/branding/${UUID}-logo.png`)

    s3.on(PutObjectCommand).resolves({})
    await putPublicObject(`branding/${UUID}-logo.png`, new Uint8Array([1]), undefined)
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.ContentType).toBe("application/octet-stream")

    s3.on(GetObjectCommand).rejects(Object.assign(new Error("x"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } }))
    expect(await getPublicObject(`branding/${UUID}-logo.png`, { range: "bytes=999-" })).toEqual({ kind: "invalid-range" })
  })
})

describe("createPresignedUpload", () => {
  it("signs a create-only PUT with the object metadata and exact byte length bound to the signature", async () => {
    const target = await createPresignedUpload({
      store: "artifacts", pathname: "artifact-staging/ws/u.html", contentType: "text/html", fileSize: 1234, expiresInSeconds: 600,
    })
    const url = new URL(target.url)
    expect(target).toMatchObject({ method: "PUT", headers: { "If-None-Match": "*", "Content-Type": "text/html" } })
    expect(url.hostname).toContain("compass-test-files")
    expect(url.pathname).toBe("/tmp/artifact-staging/ws/u.html")
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIAIOSFODNN7EXAMPLE\//)
    expect(url.searchParams.has("X-Amz-Security-Token")).toBe(false)
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600")
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining([
      "if-none-match", "content-length", "content-type", "cache-control", "content-disposition",
    ]))
  })

  it("public uploads carry immutable caching in the signed headers", async () => {
    const target = await createPresignedUpload({
      store: "public", pathname: `feedback/ws/${UUID}-a.png`, contentType: "image/png", fileSize: 10, expiresInSeconds: 600,
    })
    expect(new URL(target.url).pathname).toBe(`/public/feedback/ws/${UUID}-a.png`)
    expect(target.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable")
  })

  it("refuses an empty size and a traversal path", async () => {
    await expect(createPresignedUpload({ store: "artifacts", pathname: "a.html", contentType: "text/html", fileSize: 0, expiresInSeconds: 600 })).rejects.toThrow(/Invalid upload size/)
    await expect(createPresignedUpload({ store: "artifacts", pathname: "../a.html", contentType: "text/html", fileSize: 5, expiresInSeconds: 600 })).rejects.toThrow(/Invalid storage path/)
  })

  it("uses a custom S3-compatible endpoint only when AWS_ENDPOINT_URL_S3 is set, path-style when asked", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:9000")
    vi.stubEnv("COMPASS_S3_FORCE_PATH_STYLE", "1")
    const target = await createPresignedUpload({ store: "artifacts", pathname: "a.html", contentType: "text/html", fileSize: 5, expiresInSeconds: 600 })
    expect(new URL(target.url).origin).toBe("http://127.0.0.1:9000")
    expect(new URL(target.url).pathname).toBe("/compass-test-files/artifacts/a.html")
  })
})
