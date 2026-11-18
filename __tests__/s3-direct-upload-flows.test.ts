import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { mockClient } from "aws-sdk-client-mock"

// Vercel Blob must stay untouched on the S3 backend: any call is a failure.
const { blobPut, blobDel, blobHead, blobToken } = vi.hoisted(() => {
  const used = () => { throw new Error("Vercel Blob was used") }
  return { blobPut: vi.fn(used), blobDel: vi.fn(used), blobHead: vi.fn(used), blobToken: vi.fn(used) }
})
vi.mock("@vercel/blob", () => ({ put: blobPut, del: blobDel, head: blobHead }))
vi.mock("@vercel/blob/client", () => ({ generateClientTokenFromReadWriteToken: blobToken }))

import { prepareArtifactUpload, verifyArtifactUploadReceipt, loadStagedArtifactUpload } from "@/lib/artifact-upload"
import { prepareDocImageUpload, resolveDocImage } from "@/lib/doc-images"
import {
  decodeInlineFeedbackAttachments, deleteFeedbackBlobs, prepareFeedbackAttachmentUpload, uploadInlineFeedbackAttachments,
  validateFeedbackAttachmentMetadata, verifyCompletedFeedbackUpload, verifyFeedbackUploadOwnership, verifyFeedbackUploadReceipt,
} from "@/lib/feedback-attachments"
import { EMBED_SCREENSHOT_PREFIX, isEmbedScreenshotUrl, storeEmbedScreenshot } from "@/lib/embed-screenshots"
import { createS3Storage } from "@/lib/storage/s3"

const s3 = mockClient(S3Client)
const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const decode = (fields: Record<string, string>) => JSON.parse(Buffer.from(fields.Policy!, "base64").toString("utf8")).conditions as unknown[]

beforeEach(() => {
  s3.reset()
  vi.clearAllMocks()
  vi.stubEnv("COMPASS_STORAGE_BACKEND", "s3")
  vi.stubEnv("COMPASS_S3_BUCKET", "compass-test-files")
  vi.stubEnv("COMPASS_S3_REGION", "us-east-1")
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-only-not-a-real-secret")
  // No Blob tokens at all: the S3 backend must not need them.
  for (const name of ["ARTIFACT_BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN", "ARTIFACT_UPLOAD_RECEIPT_SECRET", "FEEDBACK_UPLOAD_RECEIPT_SECRET"]) vi.stubEnv(name, "")
  vi.stubEnv("ARTIFACT_UPLOAD_RECEIPT_SECRET", "artifact-receipt-secret-for-tests")
  vi.stubEnv("FEEDBACK_UPLOAD_RECEIPT_SECRET", "feedback-receipt-secret-for-tests")
})
afterEach(() => vi.unstubAllEnvs())

describe("prepare_artifact_upload on S3", () => {
  it("returns a presigned POST for the staging key, keeping the receipt contract", async () => {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "proto.html", fileSize: 4096 })
    expect(prepared.clientToken).toBe("")
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    expect(prepared.backend).toBe("s3")
    expect(prepared.access).toBe("private")
    expect(prepared.fileType).toBe("text/html")
    expect(prepared.pathname).toBe(`artifact-staging/${WS}/${prepared.uploadId}.html`)
    expect(prepared.upload!.fields.key).toBe(`tmp/artifact-staging/${WS}/${prepared.uploadId}.html`)
    expect(decode(prepared.upload!.fields)).toEqual(expect.arrayContaining([
      ["content-length-range", 4096, 4096], ["eq", "$Content-Type", "text/html"],
    ]))
    expect(blobToken).not.toHaveBeenCalled()
  })

  it("the receipt verifies exactly as on Blob: same workspace, same payload, expiry enforced", async () => {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "proto.html", fileSize: 10 }, 1_000)
    expect(verifyArtifactUploadReceipt(prepared.receipt, WS, 2_000)).toMatchObject({ workspaceId: WS, filename: "proto.html", fileSize: 10, pathname: prepared.pathname })
    expect(() => verifyArtifactUploadReceipt(prepared.receipt, OTHER_WS, 2_000)).toThrow(/does not belong/)
    expect(() => verifyArtifactUploadReceipt(prepared.receipt, WS, 1_000 + 10 * 60 * 1000 + 1)).toThrow(/expired/)
    expect(() => verifyArtifactUploadReceipt(`${prepared.receipt}x`, WS, 2_000)).toThrow(/Invalid upload receipt/)
  })

  it("enforces the same request limits as the Blob path before touching S3", async () => {
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 2 * 1024 * 1024 + 1 })).rejects.toThrow(/2 MB/)
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "a.txt", fileSize: 10 })).rejects.toThrow(/\.html/)
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "../a.html", fileSize: 10 })).rejects.toThrow(/safe single filename/)
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 0 })).rejects.toThrow(/empty/)
  })

  it("fails before signing when no receipt secret exists (Blob token fallback is gone on S3)", async () => {
    vi.stubEnv("ARTIFACT_UPLOAD_RECEIPT_SECRET", "")
    await expect(prepareArtifactUpload({ workspaceId: WS, filename: "a.html", fileSize: 10 })).rejects.toThrow("Artifact direct uploads are not configured")
  })

  it("consume path: the staged object is read from tmp/ and deleted from tmp/", async () => {
    const prepared = await prepareArtifactUpload({ workspaceId: WS, filename: "p.html", fileSize: 3 })
    const bytes = new Uint8Array([1, 2, 3])
    const store = new Map<string, Uint8Array>()
    s3.on(PutObjectCommand).callsFake(async (input: { Key: string; Body: Uint8Array }) => { store.set(input.Key, input.Body); return {} })
    s3.on(GetObjectCommand).callsFake(async (input: { Key: string }) => ({ Body: { transformToByteArray: async () => store.get(input.Key) } }))
    await createS3Storage("artifacts").put(prepared.pathname, bytes)
    expect([...store.keys()]).toEqual([`tmp/${prepared.pathname}`])
    const staged = await loadStagedArtifactUpload(prepared.receipt, WS, createS3Storage("artifacts"))
    expect(staged.bytes).toEqual(bytes)
    s3.on(DeleteObjectCommand).resolves({})
    await staged.discard()
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(`tmp/${prepared.pathname}`)
  })
})

describe("prepare_doc_image_upload on S3", () => {
  it("pins the image type and size, stores under artifacts/, and returns the same read URL as Blob", async () => {
    const prepared = await prepareDocImageUpload({ workspaceId: WS, filename: "shot.png", fileType: "image/png", fileSize: 5000 })
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    expect(prepared.url).toBe(`/api/docs/images/${WS}/${prepared.imageName}`)
    expect(prepared.markdown).toBe(`![shot.png](${prepared.url})`)
    expect(prepared.upload.fields.key).toBe(`artifacts/docs/${WS}/images/${prepared.imageName}`)
    expect(decode(prepared.upload.fields)).toEqual(expect.arrayContaining([["content-length-range", 5000, 5000], ["eq", "$Content-Type", "image/png"]]))
    expect(resolveDocImage(WS, prepared.imageName)?.pathname).toBe(prepared.pathname)
  })

  it("keeps the 10 MiB and MIME limits", async () => {
    await expect(prepareDocImageUpload({ workspaceId: WS, filename: "a.png", fileType: "image/png", fileSize: 10 * 1024 * 1024 + 1 })).rejects.toThrow(/10 MiB/)
    await expect(prepareDocImageUpload({ workspaceId: WS, filename: "a.svg", fileType: "image/svg+xml", fileSize: 10 })).rejects.toThrow(/Unsupported image type/)
  })
})

describe("prepare_feedback_attachment_upload on S3", () => {
  const input = { workspaceId: WS, filename: "my shot.png", fileType: "image/png", fileSize: 2048 }

  it("returns a presigned POST into public/ plus the app-route URL, and a receipt that verifies as before", async () => {
    const prepared = await prepareFeedbackAttachmentUpload(input)
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    expect(prepared.url).toBe(`/api/files/public/${prepared.pathname}`)
    expect(prepared.pathname).toMatch(new RegExp(`^feedback/${WS}/[0-9a-f-]{36}-my_shot\\.png$`))
    expect(prepared.upload.fields.key).toBe(`public/${prepared.pathname}`)
    expect(decode(prepared.upload.fields)).toEqual(expect.arrayContaining([["content-length-range", 2048, 2048], ["eq", "$Content-Type", "image/png"]]))
    expect(verifyFeedbackUploadReceipt(prepared.receipt)).toMatchObject({ workspaceId: WS, pathname: prepared.pathname, fileType: "image/png", fileSize: 2048 })
    expect(blobToken).not.toHaveBeenCalled()
  })

  it("applies the same type and size validation", async () => {
    await expect(prepareFeedbackAttachmentUpload({ ...input, fileType: "text/html" })).rejects.toThrow(/Invalid attachment metadata/)
    await expect(prepareFeedbackAttachmentUpload({ ...input, fileSize: 10 * 1024 * 1024 + 1 })).rejects.toThrow(/Invalid attachment metadata/)
  })

  it("verifyCompletedFeedbackUpload accepts the matching object (HEAD on public/<pathname>) and nothing else", async () => {
    const prepared = await prepareFeedbackAttachmentUpload(input)
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 2048 })
    const done = await verifyCompletedFeedbackUpload({ workspaceId: WS, url: prepared.url, receipt: prepared.receipt })
    expect(done).toEqual({ attachmentId: prepared.attachmentId, url: prepared.url, filename: "my shot.png", fileType: "image/png", fileSize: 2048 })
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.Key).toBe(`public/${prepared.pathname}`)

    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 2049 })
    await expect(verifyCompletedFeedbackUpload({ workspaceId: WS, url: prepared.url, receipt: prepared.receipt })).rejects.toThrow(/does not match its receipt/)
    s3.on(HeadObjectCommand).resolves({ ContentType: "text/html", ContentLength: 2048 })
    await expect(verifyCompletedFeedbackUpload({ workspaceId: WS, url: prepared.url, receipt: prepared.receipt })).rejects.toThrow(/does not match its receipt/)
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }))
    await expect(verifyCompletedFeedbackUpload({ workspaceId: WS, url: prepared.url, receipt: prepared.receipt })).rejects.toThrow(/does not match its receipt/)
  })

  it("rejects another workspace's receipt and a URL that is not the receipt's own", async () => {
    const prepared = await prepareFeedbackAttachmentUpload(input)
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    s3.on(HeadObjectCommand).resolves({ ContentType: "image/png", ContentLength: 2048 })
    await expect(verifyCompletedFeedbackUpload({ workspaceId: OTHER_WS, url: prepared.url, receipt: prepared.receipt })).rejects.toThrow(/does not belong/)
    const other = `/api/files/public/feedback/${WS}/0f8fad5b-d9cb-469f-a165-70867728950e-other.png`
    await expect(verifyCompletedFeedbackUpload({ workspaceId: WS, url: other, receipt: prepared.receipt })).rejects.toThrow(/does not match its receipt/)
  })

  it("ownership check (used before deleting on the user's behalf) is exact", async () => {
    const prepared = await prepareFeedbackAttachmentUpload(input)
    if (!("upload" in prepared)) throw new Error("expected an S3 upload target")
    expect(verifyFeedbackUploadOwnership({ workspaceId: WS, url: prepared.url, receipt: prepared.receipt }).pathname).toBe(prepared.pathname)
    expect(() => verifyFeedbackUploadOwnership({ workspaceId: OTHER_WS, url: prepared.url, receipt: prepared.receipt })).toThrow(/does not belong/)
    expect(() => verifyFeedbackUploadOwnership({ workspaceId: WS, url: `${prepared.url}?x=1`, receipt: prepared.receipt })).toThrow()
    expect(() => verifyFeedbackUploadOwnership({ workspaceId: WS, url: `https://evil.example${prepared.url}`, receipt: prepared.receipt })).toThrow()
  })
})

describe("stored URLs: old Blob URLs and new app routes both validate", () => {
  const meta = (url: string) => ({ url, filename: "a.png", fileType: "image/png", fileSize: 10 })
  const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

  it("accepts a legacy Blob URL and a feedback app-route URL", () => {
    expect(validateFeedbackAttachmentMetadata(meta("https://abc123.public.blob.vercel-storage.com/feedback/ws/a.png"))).toBe(true)
    expect(validateFeedbackAttachmentMetadata(meta(`/api/files/public/feedback/ws_1/${UUID}-a.png`))).toBe(true)
  })

  it("rejects anything else, including other public-store shapes and non-route lookalikes", () => {
    for (const url of [
      `/api/files/public/branding/${UUID}-a.png`,
      `/api/files/public/embed-feedback/ws_1/s_1/capture-${UUID}.jpg`,
      `/api/files/public/feedback/ws_1/guessable.png`,
      `/api/files/public/artifacts/ws_1/a.html`,
      `https://evil.example/api/files/public/feedback/ws_1/${UUID}-a.png`,
      `/api/files/public/feedback/ws_1/${UUID}-a.png?x=1`,
      "/anything/else", "javascript:alert(1)", "http://abc123.public.blob.vercel-storage.com/a.png",
    ]) expect(validateFeedbackAttachmentMetadata(meta(url)), url).toBe(false)
  })

  it("embed screenshots: accepts only the embed route shape on S3, and no Blob token is needed", () => {
    expect(isEmbedScreenshotUrl(`/api/files/public/${EMBED_SCREENSHOT_PREFIX}/ws_1/src_1/capture-${UUID}.jpg`)).toBe(true)
    expect(isEmbedScreenshotUrl(`/api/files/public/feedback/ws_1/${UUID}-a.png`)).toBe(false)
    expect(isEmbedScreenshotUrl(`/api/files/public/branding/${UUID}-a.png`)).toBe(false)
    expect(isEmbedScreenshotUrl(`https://evil.example/api/files/public/${EMBED_SCREENSHOT_PREFIX}/ws_1/src_1/capture-${UUID}.jpg`)).toBe(false)
    expect(isEmbedScreenshotUrl("https://x.public.blob.vercel-storage.com/embed-feedback/a/b/capture.jpg")).toBe(false)
  })
})

describe("public-store writes on S3", () => {
  it("inline MCP attachments go to public/ and come back as app-route URLs, never touching Blob", async () => {
    s3.on(PutObjectCommand).resolves({})
    const data = Buffer.from("hello").toString("base64")
    const uploaded = await uploadInlineFeedbackAttachments(WS, [{ filename: "note.txt", data, fileType: "text/plain" }])
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]!.url).toMatch(new RegExp(`^/api/files/public/feedback/${WS}/[0-9a-f-]{36}-note\\.txt$`))
    expect(uploaded[0]).toMatchObject({ filename: "note.txt", fileType: "text/plain", fileSize: 5 })
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.Key).toBe(`public/${uploaded[0]!.url.replace("/api/files/public/", "")}`)
    expect(blobPut).not.toHaveBeenCalled()
    expect(decodeInlineFeedbackAttachments).toBeTypeOf("function")
  })

  it("embed screenshots get a random key and the app-route URL", async () => {
    s3.on(PutObjectCommand).resolves({})
    const first = await storeEmbedScreenshot({ workspaceId: "ws_1", feedbackSourceId: "src_1", bytes: Buffer.from([1]), fileType: "image/jpeg" })
    const second = await storeEmbedScreenshot({ workspaceId: "ws_1", feedbackSourceId: "src_1", bytes: Buffer.from([1]), fileType: "image/jpeg" })
    expect(first.url).toMatch(/^\/api\/files\/public\/embed-feedback\/ws_1\/src_1\/capture-[0-9a-f-]{36}\.jpg$/)
    expect(second.url).not.toBe(first.url)
    expect(isEmbedScreenshotUrl(first.url)).toBe(true)
  })

  it("cleanup deletes route-URL objects from S3 and leaves Blob URLs to Blob", async () => {
    s3.on(DeleteObjectCommand).resolves({})
    blobDel.mockImplementation(() => Promise.resolve() as never)
    const route = "/api/files/public/feedback/ws_1/0f8fad5b-d9cb-469f-a165-70867728950e-a.png"
    const legacy = "https://abc123.public.blob.vercel-storage.com/feedback/ws/a.png"
    await deleteFeedbackBlobs([route, legacy])
    expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key)).toEqual([`public/${route.replace("/api/files/public/", "")}`])
    expect(blobDel).toHaveBeenCalledWith([legacy])
  })

  it("cleanup is best-effort: a storage failure does not throw", async () => {
    s3.on(DeleteObjectCommand).rejects(new Error("boom"))
    await expect(deleteFeedbackBlobs(["/api/files/public/feedback/ws_1/0f8fad5b-d9cb-469f-a165-70867728950e-a.png"])).resolves.toBeUndefined()
  })
})
