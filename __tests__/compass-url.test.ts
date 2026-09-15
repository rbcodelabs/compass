import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { feedbackItemUrl, researchParticipantUrl, reviewRequestUrl } from "@/lib/compass-url"

const KEYS = [
  "VERCEL_ENV",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "NEXT_PUBLIC_APP_URL",
] as const

const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

beforeEach(() => KEYS.forEach((key) => delete process.env[key]))
afterEach(() => KEYS.forEach((key) => {
  const value = original[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}))

const url = () => feedbackItemUrl({ orgSlug: "Acme Org", workspaceSlug: "PM/Tools", feedbackId: "item:1" })

describe("feedbackItemUrl deployment origins", () => {
  it("prefers the preview branch URL over the production custom domain", () => {
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_BRANCH_URL = "compass-git-feature-rbcodelabs.vercel.app"
    process.env.VERCEL_URL = "compass-random.vercel.app"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    expect(url()).toMatch(/^https:\/\/compass-git-feature-rbcodelabs\.vercel\.app\//)
  })

  it("falls back to the preview deployment URL", () => {
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_URL = "compass-random.vercel.app"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    expect(url()).toMatch(/^https:\/\/compass-random\.vercel\.app\//)
  })

  it("uses the configured custom domain in production", () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass.vercel.app"
    expect(url()).toMatch(/^https:\/\/compass\.rbcodelabs\.com\//)
  })

  it("uses configured localhost locally and defaults to port 3000", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3001"
    expect(url()).toMatch(/^http:\/\/localhost:3001\//)
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(url()).toMatch(/^http:\/\/localhost:3000\//)
  })

  it("encodes slugs and the detail value", () => {
    expect(url()).toBe("http://localhost:3000/Acme%20Org/PM%2FTools/feedback?detail=feedback%3Aitem%3A1")
  })

  it("builds review links at the human decision surface and encodes every segment", () => {
    expect(reviewRequestUrl({ orgSlug: "Acme Org", workspaceSlug: "PM/Tools", requestId: "req/1" }))
      .toBe("http://localhost:3000/Acme%20Org/PM%2FTools/reviews/req%2F1")
  })

  it("builds review links from the preview origin", () => {
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_BRANCH_URL = "compass-git-feature-rbcodelabs.vercel.app"
    expect(reviewRequestUrl({ orgSlug: "rbcodelabs", workspaceSlug: "compass", requestId: "request-1" }))
      .toBe("https://compass-git-feature-rbcodelabs.vercel.app/rbcodelabs/compass/reviews/request-1")
  })

  it("rejects an unsafe origin for review links", () => {
    process.env.VERCEL_ENV = "production"
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.example.com"
    expect(() => reviewRequestUrl({ orgSlug: "rbcodelabs", workspaceSlug: "compass", requestId: "request-1" }))
      .toThrow(/HTTPS|invalid/i)
  })

  it("builds participant links from the trusted origin and encodes the token", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3001"
    expect(researchParticipantUrl("secret/token"))
      .toBe("http://localhost:3001/research/secret%2Ftoken")
  })

  it.each([
    ["preview branch", { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "http://evil.example.com" }],
    ["preview deployment", { VERCEL_ENV: "preview", VERCEL_URL: "javascript:alert(1)" }],
    ["configured production", { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://evil.example.com" }],
  ])("rejects an unsafe %s origin", (_name, values) => {
    Object.assign(process.env, values)
    expect(url).toThrow(/HTTPS|invalid/i)
  })

  // Proven-live production bug: NEXT_PUBLIC_APP_URL resolved empty in production
  // while VERCEL_PROJECT_PRODUCTION_URL (the .vercel.app deployment-protection
  // host) was set. The old code silently fell back to that host instead of
  // failing loud. A link built on that host routes a human into Vercel's SSO
  // wall instead of Compass's own /login.
  it.each([
    ["missing entirely", {}],
    ["set to an empty string", { NEXT_PUBLIC_APP_URL: "" }],
  ])("refuses to fall back to the Vercel deployment host in production when NEXT_PUBLIC_APP_URL is %s", (_name, values) => {
    process.env.VERCEL_ENV = "production"
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass-rbcodelabs-team.vercel.app"
    Object.assign(process.env, values)
    expect(url).toThrow(/NEXT_PUBLIC_APP_URL/i)
  })
})
