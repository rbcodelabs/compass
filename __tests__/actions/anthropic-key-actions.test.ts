import { beforeEach, describe, expect, it, vi } from "vitest"
import { decrypt } from "@/lib/crypto-secrets"

const ENC_KEY = Buffer.alloc(32, 7).toString("base64")
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ"

const mockWorkspace = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: vi.fn(() => ({ workspace: mockWorkspace })) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/auth", () => ({ auth: vi.fn() }))

import { auth } from "@/auth"
import { removeWorkspaceAnthropicApiKey, setWorkspaceAnthropicApiKey } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions"

const mockAuth = vi.mocked(auth)

function asRole(workspaceRole: string, orgRole = "MEMBER") {
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1", members: [{ role: workspaceRole }], organization: { members: [{ role: orgRole }] } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("SSO_SECRET_ENCRYPTION_KEY", ENC_KEY)
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never)
  mockWorkspace.update.mockResolvedValue({ id: "ws-1" })
  asRole("ADMIN")
})

describe("setWorkspaceAnthropicApiKey", () => {
  it("stores only ciphertext that decrypts back to the key, plus the last four characters", async () => {
    const result = await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: `  ${SECRET}  ` })
    expect(result).toEqual({ ok: true, last4: "WXYZ" })
    const { data, where } = mockWorkspace.update.mock.calls[0][0]
    expect(where).toEqual({ id: "ws-1" })
    expect(data.anthropicApiKeyLast4).toBe("WXYZ")
    expect(data.anthropicApiKeyEncrypted).not.toContain(SECRET)
    expect(decrypt(data.anthropicApiKeyEncrypted, ENC_KEY)).toBe(SECRET)
  })

  it("never returns the key to the caller", async () => {
    const result = await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it("rejects a key without the sk-ant- prefix and writes nothing; the error does not echo the input", async () => {
    const result = await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: "sk-live-notanthropic1234" }) // gitleaks:allow -- fake non-Anthropic fixture
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("notanthropic")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("rejects an empty key", async () => {
    expect((await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: "   " })).ok).toBe(false)
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("refuses to store when the server has no encryption key, rather than storing plaintext", async () => {
    vi.stubEnv("SSO_SECRET_ENCRYPTION_KEY", "")
    const result = await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })
    expect(result.ok).toBe(false)
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("rejects a plain workspace member", async () => {
    asRole("MEMBER")
    await expect(setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })).rejects.toThrow("Forbidden: workspace admin required")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("rejects a viewer", async () => {
    asRole("VIEWER")
    await expect(setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })).rejects.toThrow("Forbidden")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("rejects a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null as never)
    await expect(setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })).rejects.toThrow("Unauthorized")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("rejects a non-member (workspace not found)", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null)
    await expect(setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })).rejects.toThrow("Workspace not found")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })

  it("allows an organization admin who is only a plain workspace member", async () => {
    asRole("MEMBER", "ADMIN")
    expect((await setWorkspaceAnthropicApiKey("org", "ws", { apiKey: SECRET })).ok).toBe(true)
  })
})

describe("removeWorkspaceAnthropicApiKey", () => {
  it("clears both columns", async () => {
    await expect(removeWorkspaceAnthropicApiKey("org", "ws")).resolves.toEqual({ ok: true })
    expect(mockWorkspace.update.mock.calls[0][0].data).toEqual({ anthropicApiKeyEncrypted: null, anthropicApiKeyLast4: null })
  })

  it("rejects a non-admin and writes nothing", async () => {
    asRole("MEMBER")
    await expect(removeWorkspaceAnthropicApiKey("org", "ws")).rejects.toThrow("Forbidden: workspace admin required")
    expect(mockWorkspace.update).not.toHaveBeenCalled()
  })
})
