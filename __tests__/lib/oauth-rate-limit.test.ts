/**
 * The `/register` per-IP limiter.
 *
 * Worth stating what these tests do *not* claim: this is a per-instance
 * in-memory window, so the effective global ceiling is the cap times however
 * many serverless instances are warm, and a cold start resets a caller's
 * window. That is the deliberate trade-off recorded in lib/oauth/rate-limit.ts
 * — a durable counter needs a table this phase's migration does not have, and
 * registration grants nothing until a human approves a consent screen. What
 * follows tests the speed bump that exists, not a distributed guarantee.
 */
import { beforeEach, describe, expect, it } from "vitest"
import {
  checkRegistrationRateLimit,
  clientAddress,
  resetRegistrationRateLimit,
} from "@/lib/oauth/rate-limit"

const HOUR = 60 * 60 * 1000

beforeEach(() => resetRegistrationRateLimit())

describe("checkRegistrationRateLimit", () => {
  it("allows a normal install — one registration, ever", () => {
    expect(checkRegistrationRateLimit("1.2.3.4").allowed).toBe(true)
  })

  it("allows up to the cap, then blocks", () => {
    for (let i = 0; i < 10; i += 1) {
      expect(checkRegistrationRateLimit("1.2.3.4", 1_000).allowed).toBe(true)
    }
    const blocked = checkRegistrationRateLimit("1.2.3.4", 1_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("keeps separate windows per address", () => {
    for (let i = 0; i < 10; i += 1) checkRegistrationRateLimit("1.2.3.4", 1_000)
    expect(checkRegistrationRateLimit("5.6.7.8", 1_000).allowed).toBe(true)
  })

  it("slides: a hit that ages out of the window frees a slot", () => {
    for (let i = 0; i < 10; i += 1) checkRegistrationRateLimit("1.2.3.4", 1_000)
    expect(checkRegistrationRateLimit("1.2.3.4", 1_000).allowed).toBe(false)
    expect(checkRegistrationRateLimit("1.2.3.4", 1_000 + HOUR + 1).allowed).toBe(true)
  })

  it("reports a retry-after inside the window length", () => {
    for (let i = 0; i < 10; i += 1) checkRegistrationRateLimit("1.2.3.4", 1_000)
    const blocked = checkRegistrationRateLimit("1.2.3.4", 1_000 + HOUR / 2)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(HOUR / 1000)
  })

  it("does not grow without bound under a flood of distinct addresses", () => {
    // The limiter must not become the thing that takes the instance down.
    for (let i = 0; i < 6_000; i += 1) checkRegistrationRateLimit(`10.0.${i >> 8}.${i & 255}`, 1_000)
    // A fresh address is still served, which is what "did not fall over" means
    // from the outside.
    expect(checkRegistrationRateLimit("203.0.113.1", 1_000).allowed).toBe(true)
  })
})

describe("clientAddress", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://compass.example.com/api/oauth/register", { headers })

  it("prefers x-real-ip, which the Vercel edge sets", () => {
    expect(clientAddress(request({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("falls back to the first x-forwarded-for entry", () => {
    // The first entry is the client; later ones are proxies. The last entry is
    // the one an attacker can append to.
    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9")
  })

  it("buckets everything unattributable together rather than throwing", () => {
    expect(clientAddress(request({}))).toBe("unknown")
  })
})
