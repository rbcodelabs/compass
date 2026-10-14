import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ create: vi.fn(), add: vi.fn(), redirect: vi.fn() }))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "member" } }) }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => true }))
vi.mock("next/navigation", () => ({ redirect: (url: string) => { m.redirect(url); throw new Error(`NEXT_REDIRECT:${url}`) } }))
vi.mock("@/lib/research-study-service", async () => {
  class ResearchStudyError extends Error {}
  return { ResearchStudyError, createExternalResearchStudy: m.create, addExternalResearchSession: m.add }
})

import { addExternalResearchSession, createExternalResearchStudy } from "@/app/[orgSlug]/[workspaceSlug]/capture/actions"
import { ExternalResearchInputError } from "@/lib/research-external"
import * as studies from "@/lib/research-study-service"

const form = (fields: Record<string, string>) => Object.entries(fields).reduce((data, [k, v]) => (data.set(k, v), data), new FormData())

beforeEach(() => vi.clearAllMocks())

describe("external study actions return member-correctable rejections inline instead of throwing", () => {
  it("returns the message and the typed values when the study input is invalid", async () => {
    m.create.mockRejectedValue(new ExternalResearchInputError("Study link: link must use HTTPS"))
    const fields = { name: "UT round", goal: "Learn", externalProvider: "MAZE", externalUrl: "http://x.example.com" }
    await expect(createExternalResearchStudy("org", "ws", {}, form(fields))).resolves.toEqual({ error: "Study link: link must use HTTPS", values: fields, attempt: expect.any(Number) })
    expect(m.redirect).not.toHaveBeenCalled()
  })

  it("redirects to the new study on success", async () => {
    m.create.mockResolvedValue({ id: "study-1" })
    await expect(createExternalResearchStudy("org", "ws", {}, form({ name: "n", goal: "g", externalProvider: "MAZE" }))).rejects.toThrow("NEXT_REDIRECT:/org/ws/capture/studies/study-1")
  })

  it("keeps the pasted transcript when a session is rejected", async () => {
    m.add.mockRejectedValue(new ExternalResearchInputError("The session date cannot be in the future"))
    const result = await addExternalResearchSession("org", "ws", "study-1", {}, form({ idempotencyKey: "k", transcript: "Participant: keep me", sessionDate: "2999-01-01" }))
    expect(result).toMatchObject({ error: "The session date cannot be in the future", values: { transcript: "Participant: keep me", sessionDate: "2999-01-01", notes: "" } })
    expect(m.redirect).not.toHaveBeenCalled()
  })

  it("treats a service refusal (for example an archived study) as an inline error too", async () => {
    m.add.mockRejectedValue(new studies.ResearchStudyError("Archived studies cannot be changed"))
    const result = await addExternalResearchSession("org", "ws", "study-1", {}, form({ idempotencyKey: "k", notes: "n" }))
    expect(result.error).toBe("Archived studies cannot be changed")
  })

  it("does not swallow unexpected failures", async () => {
    m.add.mockRejectedValue(new Error("connection reset"))
    await expect(addExternalResearchSession("org", "ws", "study-1", {}, form({ idempotencyKey: "k", notes: "n" }))).rejects.toThrow("connection reset")
  })

  it("redirects back to the study after a saved session", async () => {
    m.add.mockResolvedValue({ id: "s", replayed: false })
    await expect(addExternalResearchSession("org", "ws", "study-1", {}, form({ idempotencyKey: "k", notes: "n" }))).rejects.toThrow("NEXT_REDIRECT:/org/ws/capture/studies/study-1")
  })
})

describe("client form modules", () => {
  it("never import the node:crypto-backed research-external module into a client bundle", () => {
    for (const file of ["components/research/external-study-form.tsx", "components/research/external-session-form.tsx", "lib/research-external-constants.ts"]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf-8")
      expect(source, file).not.toMatch(/from "@\/lib\/research-external"/)
      expect(source, file).not.toMatch(/node:crypto/)
    }
  })
})
