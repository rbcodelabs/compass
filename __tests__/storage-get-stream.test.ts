import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { mockClient } from "aws-sdk-client-mock"
import { randomUUID } from "node:crypto"
import { createS3Storage } from "@/lib/storage/s3"
import { localStorage } from "@/lib/storage/local-storage"

const blobGet = vi.fn()
vi.mock("@vercel/blob", () => ({ get: (...args: unknown[]) => blobGet(...args), put: vi.fn(), del: vi.fn() }))

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

describe("local storage getStream", () => {
  const path = `getstream-test/${randomUUID()}/big.bin`
  afterEach(async () => { await localStorage.del(path) })

  it("streams the exact bytes and reports the size, for a file larger than 4.5 MB", async () => {
    const data = bytes(4_543_422)
    await localStorage.put(path, data)
    const opened = await localStorage.getStream!(path)
    expect(opened?.size).toBe(4_543_422)
    expect(await drain(opened!.stream)).toEqual(data)
  })
  it("returns null for a missing object and for a directory", async () => {
    expect(await localStorage.getStream!(`getstream-test/${randomUUID()}/nope`)).toBeNull()
    await localStorage.put(path, bytes(3))
    expect(await localStorage.getStream!(path.split("/").slice(0, 2).join("/"))).toBeNull()
  })
  it("refuses a traversal path like get() does", async () => {
    await expect(localStorage.getStream!("../etc/passwd")).rejects.toThrow()
  })
})

describe("Vercel Blob getStream", () => {
  beforeEach(() => blobGet.mockReset())
  it("passes the Blob stream through unbuffered, with its size", async () => {
    const { createVercelBlobStorage } = await import("@/lib/storage/blob-storage")
    const stream = new Response(bytes(10)).body!
    blobGet.mockResolvedValue({ statusCode: 200, stream, blob: { size: 10 } })
    const opened = await createVercelBlobStorage("tok").getStream!("artifact-bundles/x/files/a.js")
    expect(opened?.stream).toBe(stream) // same object: nothing was read into memory
    expect(opened?.size).toBe(10)
    expect(blobGet).toHaveBeenCalledWith("artifact-bundles/x/files/a.js", expect.objectContaining({ access: "private", useCache: false, token: "tok" }))
  })
  it("returns null when the object is missing or not a 200", async () => {
    const { createVercelBlobStorage } = await import("@/lib/storage/blob-storage")
    blobGet.mockResolvedValueOnce(null)
    expect(await createVercelBlobStorage("tok").getStream!("a")).toBeNull()
    blobGet.mockResolvedValueOnce({ statusCode: 304, stream: null, blob: { size: 1 } })
    expect(await createVercelBlobStorage("tok").getStream!("a")).toBeNull()
  })
})

describe("S3 getStream", () => {
  const s3 = mockClient(S3Client)
  beforeEach(() => {
    s3.reset()
    vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
    vi.stubEnv("COMPASS_S3_BUCKET", "compass-test-files")
    vi.stubEnv("COMPASS_S3_REGION", "us-east-1")
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-only-not-a-real-secret")
    vi.stubEnv("AWS_PROFILE", "")
    vi.stubEnv("AWS_SESSION_TOKEN", "")
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
    vi.stubEnv("AWS_CONFIG_FILE", "/dev/null")
  })
  afterEach(() => vi.unstubAllEnvs())

  const body = (data: Uint8Array) => ({ transformToWebStream: () => new Response(data as BodyInit).body!, transformToByteArray: async () => data })

  it("streams the object at the prefixed key, with ContentLength as size", async () => {
    const data = bytes(4_543_422)
    s3.on(GetObjectCommand).resolves({ Body: body(data) as never, ContentLength: data.length })
    const opened = await createS3Storage("artifacts").getStream!("artifact-bundles/b1/files/_ds/bundle.js")
    expect(opened?.size).toBe(4_543_422)
    expect(await drain(opened!.stream)).toEqual(data)
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input).toMatchObject({ Bucket: "compass-test-files", Key: "artifacts/artifact-bundles/b1/files/_ds/bundle.js" })
  })
  it("reports an unknown size as null", async () => {
    s3.on(GetObjectCommand).resolves({ Body: body(bytes(2)) as never })
    expect((await createS3Storage("artifacts").getStream!("artifact-bundles/b/files/a"))?.size).toBeNull()
  })
  it.each([["NoSuchKey", 404], ["AccessDenied", 403]])("treats %s as not found, like get()", async (name, status) => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } }))
    expect(await createS3Storage("artifacts").getStream!("artifact-bundles/b/files/a")).toBeNull()
  })
  it("rethrows a real failure instead of hiding it as not found", async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }))
    await expect(createS3Storage("artifacts").getStream!("artifact-bundles/b/files/a")).rejects.toThrow("boom")
  })
  it("refuses an unsafe pathname before any request", async () => {
    await expect(createS3Storage("artifacts").getStream!("../x")).rejects.toThrow(/Invalid storage path/)
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0)
  })
})
