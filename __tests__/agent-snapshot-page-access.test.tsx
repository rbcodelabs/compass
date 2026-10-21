// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_REDIRECT") }))
const getStatus = vi.hoisted(() => vi.fn())

vi.mock("@/auth", () => ({ auth }))
vi.mock("next/navigation", () => ({ notFound, redirect }))
vi.mock("@/lib/agent-snapshot-admin", () => ({ getAgentSnapshotStatus: getStatus }))

import AgentSnapshotPage from "@/app/settings/admin/agent-snapshot/page"

const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS

describe("/settings/admin/agent-snapshot gating", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PLATFORM_ADMIN_EMAILS = "admin@example.com"
    auth.mockResolvedValue({ user: { id: "u1", email: "admin@example.com" } })
    getStatus.mockResolvedValue({
      goldenSnapshotId: "snap_1",
      depsFingerprint: "fp-a",
      snapshotBuiltAt: new Date("2026-01-01T00:00:00Z"),
      currentDepsFingerprint: "fp-b",
      stale: true,
    })
  })
  afterEach(() => {
    cleanup()
    if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
    else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL
  })

  it("redirects signed-out visitors to login without reading status", async () => {
    auth.mockResolvedValue(null)
    await expect(AgentSnapshotPage()).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/login")
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("404s signed-in non-admins without reading status", async () => {
    auth.mockResolvedValue({ user: { id: "u2", email: "other@example.com" } })
    await expect(AgentSnapshotPage()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(getStatus).not.toHaveBeenCalled()
  })

  it("404s everyone when PLATFORM_ADMIN_EMAILS is unset", async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS
    await expect(AgentSnapshotPage()).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("renders status and the rebuild control for an admin", async () => {
    render(await AgentSnapshotPage())
    expect(screen.getByText("snap_1")).toBeVisible()
    expect(screen.getByText("fp-a")).toBeVisible()
    expect(screen.getByText("fp-b")).toBeVisible()
    expect(screen.getByText("Stale")).toBeVisible()
    expect(screen.getByRole("button", { name: "Rebuild snapshot" })).toBeVisible()
  })
})
