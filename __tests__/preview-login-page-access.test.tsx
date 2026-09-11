// @vitest-environment jsdom
/**
 * Confirms app/preview-login/page.tsx's first line of logic: a real
 * Next.js notFound() before any persona-related rendering when the feature
 * isn't explicitly opted in. Mirrors __tests__/capture-page-access.test.tsx's
 * "mock next/navigation's notFound, assert it throws" pattern.
 */
import { cleanup, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))

vi.mock("next/navigation", () => ({ notFound }))

import PreviewLoginPage from "@/app/preview-login/page"

describe("Preview login page access", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it.each(["production", "development", ""])("calls notFound before rendering anything when disabled (VERCEL_ENV=%s)", (env) => {
    vi.stubEnv("VERCEL_ENV", env)
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "1")
    expect(() => PreviewLoginPage()).toThrow("NEXT_NOT_FOUND")
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it("calls notFound when PREVIEW_LOGIN_ENABLED is unset even on a preview deployment", () => {
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "")
    expect(() => PreviewLoginPage()).toThrow("NEXT_NOT_FOUND")
  })

  it("renders the persona form when explicitly enabled", () => {
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("PREVIEW_LOGIN_ENABLED", "1")
    render(PreviewLoginPage())
    expect(notFound).not.toHaveBeenCalled()
    expect(screen.getByRole("heading", { name: "Explore this preview" })).toBeVisible()
    expect(screen.getByLabelText(/Access code/)).toBeVisible()
    expect(screen.getByRole("button", { name: /Workspace Admin/ })).toBeVisible()
    expect(screen.getByRole("button", { name: /Team Member/ })).toBeVisible()
  })
})
