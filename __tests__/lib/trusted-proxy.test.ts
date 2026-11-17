import { describe, expect, it } from "vitest"
import {
  clientAddressFromHeaders,
  requestHostFromHeaders,
  requestProtoFromHeaders,
  trustedProxy,
} from "@/lib/trusted-proxy"

const h = (headers: Record<string, string>) => new Headers(headers)

describe("trustedProxy", () => {
  it("defaults to vercel so existing deployments keep their behaviour", () => {
    expect(trustedProxy({})).toBe("vercel")
    expect(trustedProxy({ COMPASS_TRUSTED_PROXY: "" })).toBe("vercel")
  })

  it.each(["vercel", "alb", "none"] as const)("accepts %s", (mode) => {
    expect(trustedProxy({ COMPASS_TRUSTED_PROXY: mode })).toBe(mode)
  })

  it("rejects an unknown value instead of falling back to the trusting mode", () => {
    expect(() => trustedProxy({ COMPASS_TRUSTED_PROXY: "cloudflare" })).toThrow(/COMPASS_TRUSTED_PROXY must be one of/)
  })
})

describe("clientAddressFromHeaders", () => {
  describe("vercel (default): unchanged", () => {
    it("prefers x-real-ip", () => {
      expect(clientAddressFromHeaders(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), {})).toBe("203.0.113.9")
    })
    it("else the first x-forwarded-for entry", () => {
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), {})).toBe("203.0.113.9")
    })
    it("else unknown", () => {
      expect(clientAddressFromHeaders(h({}), {})).toBe("unknown")
    })
  })

  describe("alb", () => {
    const env = { COMPASS_TRUSTED_PROXY: "alb" }

    it("takes the right-most entry, the one the ALB appended", () => {
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "203.0.113.9" }), env)).toBe("203.0.113.9")
    })

    it("ignores a spoofed left-hand entry", () => {
      // The client sent "1.1.1.1"; the ALB appended the real peer address.
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), env)).toBe("203.0.113.9")
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "1.1.1.1,  2.2.2.2 , 203.0.113.9" }), env)).toBe("203.0.113.9")
    })

    it("ignores x-real-ip, which an ALB does not set and a client can", () => {
      expect(clientAddressFromHeaders(h({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "203.0.113.9" }), env)).toBe("203.0.113.9")
      expect(clientAddressFromHeaders(h({ "x-real-ip": "1.1.1.1" }), env)).toBe("unknown")
    })

    it("counts hops from the right when COMPASS_TRUSTED_PROXY_HOPS says more proxies append", () => {
      const two = { ...env, COMPASS_TRUSTED_PROXY_HOPS: "2" }
      // client, CloudFront edge (appended by the ALB). Spoofed entry sits further left.
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "1.1.1.1, 203.0.113.9, 130.176.0.1" }), two)).toBe("203.0.113.9")
    })

    it("clamps to the left-most entry when fewer proxies appended than configured", () => {
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": "203.0.113.9" }), { ...env, COMPASS_TRUSTED_PROXY_HOPS: "3" })).toBe("203.0.113.9")
    })

    it("is unknown with no x-forwarded-for", () => {
      expect(clientAddressFromHeaders(h({}), env)).toBe("unknown")
      expect(clientAddressFromHeaders(h({ "x-forwarded-for": " , " }), env)).toBe("unknown")
    })

    it.each(["0", "-1", "abc", "1.5", "100"])("rejects COMPASS_TRUSTED_PROXY_HOPS=%s", (hops) => {
      expect(() => clientAddressFromHeaders(h({ "x-forwarded-for": "203.0.113.9" }), { ...env, COMPASS_TRUSTED_PROXY_HOPS: hops })).toThrow(/COMPASS_TRUSTED_PROXY_HOPS/)
    })
  })

  describe("none", () => {
    it("trusts nothing, so all callers share one bucket", () => {
      const env = { COMPASS_TRUSTED_PROXY: "none" }
      expect(clientAddressFromHeaders(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), env)).toBe("unknown")
    })
  })
})

describe("requestHostFromHeaders", () => {
  const headers = h({ "x-forwarded-host": "evil.example", host: "compass.example.com" })

  it("vercel: x-forwarded-host first, as before", () => {
    expect(requestHostFromHeaders(headers, {})).toBe("evil.example")
    expect(requestHostFromHeaders(h({ host: "compass.example.com" }), {})).toBe("compass.example.com")
  })

  it.each(["alb", "none"])("%s: only the host header, never a client-supplied x-forwarded-host", (mode) => {
    expect(requestHostFromHeaders(headers, { COMPASS_TRUSTED_PROXY: mode })).toBe("compass.example.com")
  })

  it("is null when there is no host at all", () => {
    expect(requestHostFromHeaders(h({}), { COMPASS_TRUSTED_PROXY: "alb" })).toBeNull()
  })
})

describe("requestProtoFromHeaders", () => {
  const headers = h({ "x-forwarded-proto": "https" })

  it.each(["vercel", "alb"])("%s: trusts x-forwarded-proto", (mode) => {
    expect(requestProtoFromHeaders(headers, { COMPASS_TRUSTED_PROXY: mode })).toBe("https")
  })

  it("none: ignores it", () => {
    expect(requestProtoFromHeaders(headers, { COMPASS_TRUSTED_PROXY: "none" })).toBeNull()
  })
})
