import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const findFirst = vi.hoisted(() => vi.fn())
const get = vi.hoisted(() => vi.fn())

vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ researchAttachment: { findFirst } }) }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({ get }) }))

import { GET } from "@/app/api/research/member-attachments/[attachmentId]/route"

describe("member research attachment download", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
  })

  it("serves ready private bytes only through a member-scoped lookup", async () => {
    findFirst.mockResolvedValue({
      blobPathname: "research/private-secret/file.png",
      originalName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 4,
    })
    get.mockResolvedValue(new Uint8Array([137, 80, 78, 71]))

    const response = await GET(new Request("http://localhost/api/research/member-attachments/attachment-1"), {
      params: Promise.resolve({ attachmentId: "attachment-1" }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(findFirst).toHaveBeenCalledWith({ where: {
      id: "attachment-1",
      status: "READY",
      workspace: { members: { some: { userId: "user-1" } } },
    } })
    expect(await response.arrayBuffer()).toEqual(new Uint8Array([137, 80, 78, 71]).buffer)
  })

  it("does not reveal whether another workspace owns an attachment", async () => {
    findFirst.mockResolvedValue(null)
    const response = await GET(new Request("http://localhost/api/research/member-attachments/other"), {
      params: Promise.resolve({ attachmentId: "other" }),
    })
    expect(response.status).toBe(404)
    expect(get).not.toHaveBeenCalled()
  })
})
