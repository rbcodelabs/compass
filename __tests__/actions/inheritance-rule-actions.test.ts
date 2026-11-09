import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Settings server actions for inheritance rules. The service is covered in
 * custom-field-inheritance-admin.test.ts; this file pins authorization (resolveWorkspace, exactly like
 * createFieldDefinition) and that the caller's workspace, never a client value, scopes every call.
 */
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  workspaceFindFirst: vi.fn(),
  revalidatePath: vi.fn(),
  create: vi.fn(),
  setEnabled: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  removeForField: vi.fn(),
}))

const mockPrisma = {
  workspace: { findFirst: m.workspaceFindFirst },
  customFieldDefinition: { findFirst: vi.fn(), deleteMany: vi.fn() },
  customFieldValue: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}
vi.mock("@/lib/db", () => ({ default: vi.fn(() => mockPrisma) }))
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("@/lib/product-action-auth", () => ({ requireProductEntity: vi.fn(), requireProductWorkspace: vi.fn() }))
vi.mock("@/lib/custom-field-inheritance-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-field-inheritance-admin")>()),
  createInheritanceRule: m.create,
  setInheritanceRuleEnabled: m.setEnabled,
  moveInheritanceRule: m.move,
  deleteInheritanceRule: m.remove,
  deleteInheritanceRulesForField: m.removeForField,
}))

import {
  createInheritanceRuleAction,
  deleteFieldDefinition,
  deleteInheritanceRuleAction,
  moveInheritanceRuleAction,
  setInheritanceRuleEnabledAction,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions"

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "user-1" } })
  m.workspaceFindFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1" })
  mockPrisma.customFieldDefinition.findFirst.mockResolvedValue({ id: "field-1" })
  mockPrisma.customFieldDefinition.deleteMany.mockResolvedValue({ count: 1 })
  mockPrisma.$transaction.mockImplementation((fn: (db: typeof mockPrisma) => unknown) => fn(mockPrisma))
  m.create.mockResolvedValue({ id: "rule-1" })
})

const calls: [string, () => Promise<unknown>][] = [
  ["create", () => createInheritanceRuleAction("org", "ws", { targetFieldId: "t", sourceFieldId: "s" })],
  ["enable/disable", () => setInheritanceRuleEnabledAction("org", "ws", "rule-1", false)],
  ["reorder", () => moveInheritanceRuleAction("org", "ws", "rule-1", "up")],
  ["delete", () => deleteInheritanceRuleAction("org", "ws", "rule-1")],
]

describe.each(calls)("inheritance rule action: %s", (_name, call) => {
  it("rejects an unauthenticated caller before any lookup or write", async () => {
    m.auth.mockResolvedValue(null)
    await expect(call()).rejects.toThrow("Unauthorized")
    expect(m.workspaceFindFirst).not.toHaveBeenCalled()
    for (const fn of [m.create, m.setEnabled, m.move, m.remove]) expect(fn).not.toHaveBeenCalled()
  })

  it("rejects a non-member of the workspace before any write", async () => {
    m.workspaceFindFirst.mockResolvedValue(null)
    await expect(call()).rejects.toThrow("Workspace not found")
    for (const fn of [m.create, m.setEnabled, m.move, m.remove]) expect(fn).not.toHaveBeenCalled()
  })

  it("resolves the workspace through the caller's membership", async () => {
    await call()
    expect(m.workspaceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ slug: "ws", organization: { slug: "org" }, members: { some: { userId: "user-1" } } }),
    }))
  })
})

describe("inheritance rule actions scope everything to the resolved workspace", () => {
  it("create passes the resolved workspace, the actor and the UI source; client-supplied workspace ids do not exist", async () => {
    await createInheritanceRuleAction("org", "ws", { targetFieldId: "t", sourceFieldId: "s", priority: 2 })
    expect(m.create).toHaveBeenCalledWith(expect.anything(), { workspaceId: "ws-1", targetFieldId: "t", sourceFieldId: "s", priority: 2, actorUserId: "user-1", source: "UI" })
    expect(m.revalidatePath).toHaveBeenCalledWith("/org/ws/settings")
  })

  it("enable/disable, reorder and delete are keyed by the resolved workspace", async () => {
    await setInheritanceRuleEnabledAction("org", "ws", "rule-1", false)
    await moveInheritanceRuleAction("org", "ws", "rule-1", "down")
    await deleteInheritanceRuleAction("org", "ws", "rule-1")
    expect(m.setEnabled).toHaveBeenCalledWith(expect.anything(), "ws-1", "rule-1", false)
    expect(m.move).toHaveBeenCalledWith(expect.anything(), "ws-1", "rule-1", "down")
    expect(m.remove).toHaveBeenCalledWith(expect.anything(), "ws-1", "rule-1")
  })

  it("surfaces a rejected rule (foreign field, mismatch) as an error, not a silent success", async () => {
    m.create.mockRejectedValue(new Error("Field not found"))
    await expect(createInheritanceRuleAction("org", "ws", { targetFieldId: "t", sourceFieldId: "s" })).rejects.toThrow("Field not found")
  })
})

describe("deleteFieldDefinition and inheritance rules", () => {
  it("removes every rule that names the field, in the caller's workspace, before the field goes", async () => {
    await deleteFieldDefinition("org", "ws", "field-1")

    expect(m.removeForField).toHaveBeenCalledWith(expect.anything(), "ws-1", "field-1")
    expect(m.removeForField.mock.invocationCallOrder[0]).toBeLessThan(mockPrisma.customFieldDefinition.deleteMany.mock.invocationCallOrder[0])
  })

  it("does not touch rules for a field outside the workspace", async () => {
    mockPrisma.customFieldDefinition.findFirst.mockResolvedValue(null)
    await expect(deleteFieldDefinition("org", "ws", "foreign")).rejects.toThrow("Field not found")
    expect(m.removeForField).not.toHaveBeenCalled()
  })
})
