import { beforeEach, expect, it, vi } from "vitest"
const { auth, update, revalidatePath } = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn(), revalidatePath: vi.fn() }))
vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ user: { update } }) }))
vi.mock("next/cache", () => ({ revalidatePath }))
import { saveProfile } from "@/app/settings/profile/actions"
beforeEach(() => { vi.clearAllMocks(); auth.mockResolvedValue({ user: { id: "owner" } }); update.mockResolvedValue({}) })
it("updates only the signed-in account and trims the display name", async () => {
  expect(await saveProfile("  Alex Taylor  ")).toEqual({ ok: true })
  expect(update).toHaveBeenCalledWith({ where: { id: "owner" }, data: { name: "Alex Taylor" } })
  expect(revalidatePath).toHaveBeenCalledWith("/", "layout")
})
it("requires an authenticated account", async () => {
  auth.mockResolvedValue(null)
  expect(await saveProfile("Alex")).toEqual({ ok: false, error: "Sign in to update your profile." })
  expect(update).not.toHaveBeenCalled()
})
it.each(["", "   ", "a".repeat(121), null, { name: "Alex", userId: "other" }])("rejects invalid input %j", async (name) => {
  expect(await saveProfile(name)).toMatchObject({ ok: false })
  expect(update).not.toHaveBeenCalled()
})
it("accepts the maximum display name length", async () => {
  expect(await saveProfile("a".repeat(120))).toEqual({ ok: true })
})
it("returns a safe failure on storage errors", async () => {
  update.mockRejectedValue(new Error("private database details"))
  expect(await saveProfile("Alex")).toEqual({ ok: false, error: "Your profile could not be saved. Please try again." })
})
