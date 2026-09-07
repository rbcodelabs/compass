// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => vi.fn())
const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_REDIRECT") }))
const workspace = { findFirst: vi.fn() }
const researchStudy = { findMany: vi.fn() }

vi.mock("@/auth", () => ({ auth }))
vi.mock("next/navigation", () => ({ notFound, redirect }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace, researchStudy }) }))

import CapturePage from "@/app/[orgSlug]/[workspaceSlug]/capture/page"

describe("Capture study list access", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    workspace.findFirst.mockResolvedValue({ id: "workspace-1", name: "Product" })
    researchStudy.findMany.mockResolvedValue([])
  })
  afterEach(cleanup)

  it("scopes membership and bounds the researcher study query", async () => {
    render(await CapturePage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }) }))

    expect(screen.getByText(/No studies on this page/)).toBeVisible()
    expect(workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ members: { some: { userId: "user-1" } } }),
    }))
    expect(researchStudy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-1", status: { not: "ARCHIVED" } },
      skip: 0,
      take: 21,
    }))
  })
  it("paginates retained archived records without losing membership scoping", async () => {
    render(await CapturePage({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "product" }), searchParams: Promise.resolve({ page: "2", archived: "1" }) }))
    expect(researchStudy.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "workspace-1", status: "ARCHIVED" }, skip: 20, take: 21 }))
    expect(screen.getByRole("link", { name: "Previous studies" })).toHaveAttribute("href", "/acme/product/capture?page=1&archived=1")
  })
})
