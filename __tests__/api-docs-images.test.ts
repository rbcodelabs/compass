import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findWorkspace: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: mocks.findWorkspace } }) }))
vi.mock("@/lib/artifact-storage", () => ({
  getArtifactStorage: () => ({ get: mocks.get, put: mocks.put, del: vi.fn() }),
}))

import { POST } from "@/app/api/docs/upload/route"
import { GET } from "@/app/api/docs/images/[workspaceId]/[imageName]/route"

const workspaceId = "11111111-1111-4111-8111-111111111111"

function uploadRequest(file: File, declaredWorkspaceId = workspaceId) {
  const form = new FormData()
  form.append("workspaceId", declaredWorkspaceId)
  form.append("file", file)
  return new NextRequest("http://localhost/api/docs/upload", { method: "POST", body: form })
}

const readParams = Promise.resolve({ workspaceId, imageName: "123e4567-e89b-42d3-a456-426614174000.png" })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.findWorkspace.mockResolvedValue({ id: workspaceId })
})

describe("POST /api/docs/upload", () => {
  it("requires membership in the declared workspace before storing", async () => {
    mocks.findWorkspace.mockResolvedValue(null)
    const response = await POST(uploadRequest(new File(["image"], "shot.png", { type: "image/png" })))
    expect(response.status).toBe(404)
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it("stores a private image and returns its same-origin authorized read URL", async () => {
    mocks.put.mockImplementation(async (pathname: string) => ({ pathname }))
    const response = await POST(uploadRequest(new File(["image"], "shot.png", { type: "image/png" })))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.url).toMatch(new RegExp(`^/api/docs/images/${workspaceId}/[0-9a-f-]{36}\\.png$`))
    expect(mocks.put).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^docs/${workspaceId}/images/`)), expect.any(Uint8Array), "image/png")
  })
})

describe("GET /api/docs/images/[workspaceId]/[imageName]", () => {
  it("returns a workspace-private image with non-sniffing private cache headers", async () => {
    mocks.get.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const response = await GET(new NextRequest("http://localhost/private-image"), { params: readParams })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(mocks.get).toHaveBeenCalledWith(`docs/${workspaceId}/images/123e4567-e89b-42d3-a456-426614174000.png`)
  })

  it("does not reveal an image to a non-member", async () => {
    mocks.findWorkspace.mockResolvedValue(null)
    const response = await GET(new NextRequest("http://localhost/private-image"), { params: readParams })
    expect(response.status).toBe(404)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it("rejects caller-controlled path traversal before storage", async () => {
    const response = await GET(new NextRequest("http://localhost/private-image"), { params: Promise.resolve({ workspaceId, imageName: "..%2Fsecret.png" }) })
    expect(response.status).toBe(404)
    expect(mocks.get).not.toHaveBeenCalled()
  })
})
