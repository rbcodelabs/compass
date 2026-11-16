// @vitest-environment node
/**
 * lib/safe-fetch.ts: the SSRF controls behind the agent's `web_fetch`.
 *
 * No test here touches the public internet. Names are resolved by a fake resolver, and a
 * local server on 127.0.0.1 stands in for "the target" only through the `dial` seam, which is
 * applied AFTER validation and pinning. Everything the module must refuse is refused before
 * any connection, which the server's request counter proves.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import zlib from "node:zlib"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ALLOWED_CONTENT_TYPES,
  SafeFetchError,
  USER_AGENT,
  isPublicAddress,
  resolvePublicAddress,
  safeFetch,
  validateUrl,
  type PinnedTarget,
  type Resolver,
} from "@/lib/safe-fetch"

const PUBLIC_A = "93.184.216.34"
const PUBLIC_B = "8.8.4.4"

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof SafeFetchError) return error.code
    throw error
  }
  return "no error"
}
const urlCode = (url: string) => {
  try {
    validateUrl(url)
  } catch (error) {
    if (error instanceof SafeFetchError) return error.code
    throw error
  }
  return "no error"
}

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.88.99.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  ])("refuses IPv4 %s", (ip) => expect(isPublicAddress(ip)).toBe(false))

  it.each(["8.8.8.8", "1.1.1.1", PUBLIC_A, "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "169.255.0.1", "198.17.255.255", "198.20.0.1", "11.0.0.1", "126.255.255.255", "128.0.0.1"])(
    "allows IPv4 %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  )

  it.each([
    "::", "::1", "::2", "fc00::1", "fd12:3456::1", "fdff:ffff::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "ff00::",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:169.254.169.254", "::ffff:192.168.1.1", "::ffff:0.0.0.0",
    "64:ff9b::7f00:1", "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "::127.0.0.1", "::8.8.8.8",
    "2001:db8::1", "2001::1", "2001:2::1", "2001:10::1", "2001:1ff::1", "2002:7f00:1::1", "2002:808:808::1", "3fff::1", "fd00:ec2::254",
  ])("refuses IPv6 %s", (ip) => expect(isPublicAddress(ip)).toBe(false))

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "::ffff:808:808"])("allows IPv6 %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(true),
  )

  it.each(["", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4", "fe80::1%eth0", "[::1]", "::ffff:1.2.3", "1::2::3", "gggg::1"])(
    "treats %j as not public",
    (value) => expect(isPublicAddress(value)).toBe(false),
  )
})

describe("validateUrl", () => {
  it.each([
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["ftp://example.com/", "scheme_not_allowed"],
    ["gopher://example.com/", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
    ["data:text/html,hi", "scheme_not_allowed"],
    ["ws://example.com/", "scheme_not_allowed"],
    ["http://user:pass@example.com/", "credentials_not_allowed"],
    ["https://user@example.com/", "credentials_not_allowed"],
    ["http://good.com@127.0.0.1/", "credentials_not_allowed"],
    ["http://good.com:pw@169.254.169.254/", "credentials_not_allowed"],
    ["http://example.com@evil.com/", "credentials_not_allowed"],
    ["http://example.com:8080/", "port_not_allowed"],
    ["http://example.com:22/", "port_not_allowed"],
    ["https://example.com:8443/", "port_not_allowed"],
    ["http://example.com:3306/", "port_not_allowed"],
    ["http://localhost/", "host_not_allowed"],
    ["http://LOCALHOST/", "host_not_allowed"],
    ["http://localhost./", "host_not_allowed"],
    ["http://foo.localhost/", "host_not_allowed"],
    ["http://intranet/", "host_not_allowed"],
    ["http://example/", "host_not_allowed"],
    ["http://printer.local/", "host_not_allowed"],
    ["http://svc.internal/", "host_not_allowed"],
    ["http://metadata.google.internal/", "host_not_allowed"],
    ["http://router.lan/", "host_not_allowed"],
    ["http://nas.home.arpa/", "host_not_allowed"],
    ["http://2130706433/", "address_not_allowed"],
    ["http://0x7f.1/", "address_not_allowed"],
    ["http://0x7f000001/", "address_not_allowed"],
    ["http://0177.0.0.1/", "address_not_allowed"],
    ["http://127.1/", "address_not_allowed"],
    ["http://127.0.0.1/", "address_not_allowed"],
    ["http://0/", "address_not_allowed"],
    ["http://0.0.0.0/", "address_not_allowed"],
    ["http://017700000001/", "address_not_allowed"],
    ["http://3232235777/", "address_not_allowed"],
    ["http://2852039166/latest/meta-data/", "address_not_allowed"],
    ["http://169.254.169.254/latest/meta-data/", "address_not_allowed"],
    ["http://10.0.0.1/", "address_not_allowed"],
    ["http://100.64.0.1/", "address_not_allowed"],
    ["http://172.16.0.1/", "address_not_allowed"],
    ["http://192.168.0.1/", "address_not_allowed"],
    ["http://[::1]/", "address_not_allowed"],
    ["http://[::ffff:127.0.0.1]/", "address_not_allowed"],
    ["http://[::ffff:7f00:1]/", "address_not_allowed"],
    ["http://[::ffff:169.254.169.254]/", "address_not_allowed"],
    ["http://[fe80::1]/", "address_not_allowed"],
    ["http://[fd00::1]/", "address_not_allowed"],
    ["http://[fd00:ec2::254]/", "address_not_allowed"],
    ["http://[64:ff9b::7f00:1]/", "address_not_allowed"],
    ["http://[2002:7f00:1::]/", "address_not_allowed"],
    ["http://[::]/", "address_not_allowed"],
    ["", "invalid_url"],
    ["   ", "invalid_url"],
    ["http://", "invalid_url"],
    ["not a url", "invalid_url"],
    ["example.com", "invalid_url"],
    [" http://example.com/", "invalid_url"],
    ["http://example.com/\nHost: evil", "invalid_url"],
    ["http://exa mple.com/", "invalid_url"],
    ["http://example.com/\u0000", "invalid_url"],
    [`https://example.com/${"a".repeat(2100)}`, "invalid_url"],
  ])("refuses %j (%s)", (url, code) => expect(urlCode(url)).toBe(code))

  it.each([
    ["https://example.com/", "example.com", 443],
    ["http://EXAMPLE.com:80/x", "example.com", 80],
    ["https://example.com:443/", "example.com", 443],
    ["https://example.com./path", "example.com", 443],
    ["http://example.com:443/", "example.com", 443],
    ["https://sub.example.co.uk/a/b?c=d#frag", "sub.example.co.uk", 443],
    ["http://8.8.8.8/", "8.8.8.8", 80],
    ["https://[2606:4700:4700::1111]/", "2606:4700:4700::1111", 443],
    ["https://xn--bcher-kva.example/", "xn--bcher-kva.example", 443],
  ])("accepts %j", (url, hostname, port) => {
    const target = validateUrl(url)
    expect(target.hostname).toBe(hostname)
    expect(target.port).toBe(port)
  })

  it("marks IP-literal targets so they are never resolved", () => {
    expect(validateUrl("http://8.8.8.8/").literalAddress).toBe("8.8.8.8")
    expect(validateUrl("https://example.com/").literalAddress).toBeUndefined()
  })
})

describe("resolvePublicAddress", () => {
  it("returns the first address when every answer is public", async () => {
    const resolver: Resolver = async () => [
      { address: PUBLIC_A, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]
    expect(await resolvePublicAddress("example.com", resolver)).toEqual({ address: PUBLIC_A, family: 4 })
  })

  it("refuses the name if ANY answer is not public, whatever order they come in", async () => {
    for (const records of [
      [{ address: PUBLIC_A, family: 4 }, { address: "10.0.0.5", family: 4 }],
      [{ address: "10.0.0.5", family: 4 }, { address: PUBLIC_A, family: 4 }],
      [{ address: PUBLIC_A, family: 4 }, { address: "::1", family: 6 }],
      [{ address: PUBLIC_A, family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }],
      [{ address: "169.254.169.254", family: 4 }],
    ]) {
      expect(await codeOf(resolvePublicAddress("example.com", async () => records))).toBe("address_not_allowed")
    }
  })

  it("maps an empty answer, a failure or a malformed answer to dns_failed / a refusal", async () => {
    expect(await codeOf(resolvePublicAddress("example.com", async () => []))).toBe("dns_failed")
    expect(await codeOf(resolvePublicAddress("example.com", async () => Promise.reject(new Error("ENOTFOUND"))))).toBe("dns_failed")
    expect(await codeOf(resolvePublicAddress("example.com", async () => [{ address: undefined as unknown as string, family: 4 }]))).toBe("address_not_allowed")
  })

  it("never echoes the resolved address in the message the model sees", async () => {
    const error = await resolvePublicAddress("example.com", async () => [{ address: "10.1.2.3", family: 4 }]).catch((e) => e as SafeFetchError)
    expect((error as SafeFetchError).message).not.toContain("10.1.2.3")
  })
})

// ── against a local server ──────────────────────────────────────────────────

interface Seen {
  url: string
  headers: IncomingMessage["headers"]
}
type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let serverPort = 0
let seen: Seen[] = []
let handlers: Record<string, Handler> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers })
    const path = (req.url ?? "").split("?")[0]
    const handler = handlers[path] ?? (/^\/hop\/\d+$/.test(path) ? handlers["/hop/*"] : undefined)
    if (handler) return handler(req, res)
    res.writeHead(404, { "content-type": "text/plain" }).end("not found")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  serverPort = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
beforeEach(() => {
  seen = []
  handlers = {}
})

/** Resolver that answers a fixed table and counts how often it was asked. */
function resolverFor(table: Record<string, string>) {
  const calls: string[] = []
  const resolver: Resolver = async (hostname) => {
    calls.push(hostname)
    const address = table[hostname]
    if (!address) throw new Error("ENOTFOUND")
    return [{ address, family: address.includes(":") ? 6 : 4 }]
  }
  return { resolver, calls }
}

/** The dial seam: the validated public-looking address is mapped onto the local server. */
const dialLocal = (dialled: PinnedTarget[] = []) => (target: PinnedTarget) => {
  dialled.push(target)
  return { host: "127.0.0.1", port: serverPort }
}

const text = (body: string, type = "text/plain"): Handler => (_req, res) => {
  res.writeHead(200, { "content-type": type }).end(body)
}
const redirect = (location: string, status = 302): Handler => (_req, res) => {
  res.writeHead(status, { location }).end()
}

describe("safeFetch: happy path and what it sends", () => {
  it("fetches a public-looking host through the pinned address, sending only a fixed header set", async () => {
    handlers["/page"] = text("hello world")
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    const dialled: PinnedTarget[] = []
    const result = await safeFetch("http://www.example.com/page?x=1", { resolver, dial: dialLocal(dialled) })
    expect(result).toEqual({ finalUrl: "http://www.example.com/page?x=1", status: 200, contentType: "text/plain", text: "hello world", bytes: 11, redirects: 0 })
    expect(dialled).toEqual([{ address: PUBLIC_A, port: 80, secure: false, hostname: "www.example.com" }])
    const headers = seen[0].headers
    expect(headers.host).toBe("www.example.com")
    expect(headers["user-agent"]).toBe(USER_AGENT)
    expect(USER_AGENT).toContain("Compass")
    expect(headers["accept-encoding"]).toContain("gzip")
    for (const forbidden of ["cookie", "authorization", "referer", "proxy-authorization", "x-api-key"]) expect(headers[forbidden]).toBeUndefined()
  })

  it("returns no response headers (no Set-Cookie) in its result", async () => {
    handlers["/page"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sid=secret; HttpOnly", "x-internal": "yes" }).end("ok")
    }
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    const result = await safeFetch("http://www.example.com/page", { resolver, dial: dialLocal() })
    expect(Object.keys(result).sort()).toEqual(["bytes", "contentType", "finalUrl", "redirects", "status", "text"])
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("decodes the declared charset", async () => {
    handlers["/latin"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    }
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    expect((await safeFetch("http://www.example.com/latin", { resolver, dial: dialLocal() })).text).toBe("café")
  })

  it("returns a non-2xx status without reading the body", async () => {
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    const result = await safeFetch("http://www.example.com/missing", { resolver, dial: dialLocal() })
    expect(result).toMatchObject({ status: 404, text: "", bytes: 0 })
  })
})

describe("safeFetch: refused before any connection", () => {
  it("never connects for a URL the policy refuses", async () => {
    const { resolver, calls } = resolverFor({})
    for (const url of ["http://127.0.0.1/", `http://127.0.0.1:${serverPort}/`, "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://2130706433/", "http://0x7f.1/", "ftp://example.com/", "http://a@127.0.0.1/"]) {
      await expect(safeFetch(url, { resolver, dial: dialLocal() }), url).rejects.toBeInstanceOf(SafeFetchError)
    }
    expect(seen).toEqual([])
    expect(calls).toEqual([])
  })

  it("refuses a public-looking name that resolves to an internal address, without connecting", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.1.1", "192.168.1.10", "::1", "fd00::5", "::ffff:127.0.0.1"]) {
      const { resolver } = resolverFor({ "evil.example.com": address })
      expect(await codeOf(safeFetch("http://evil.example.com/", { resolver, dial: dialLocal() })), address).toBe("address_not_allowed")
    }
    expect(seen).toEqual([])
  })

  it("refuses when ONE of several answers is internal", async () => {
    const resolver: Resolver = async () => [
      { address: PUBLIC_A, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]
    expect(await codeOf(safeFetch("http://mixed.example.com/", { resolver, dial: dialLocal() }))).toBe("address_not_allowed")
    expect(seen).toEqual([])
  })

  it("reports a name that does not resolve", async () => {
    const { resolver } = resolverFor({})
    expect(await codeOf(safeFetch("http://nope.example.com/", { resolver }))).toBe("dns_failed")
  })
})

describe("safeFetch: DNS rebinding", () => {
  it("resolves once per hop and connects to exactly the validated address", async () => {
    handlers["/page"] = text("ok")
    // First answer is public; every later answer is the loopback address a rebinding attacker wants.
    let answers = 0
    const resolver: Resolver = vi.fn(async () => {
      answers++
      return [{ address: answers === 1 ? PUBLIC_A : "127.0.0.1", family: 4 }]
    })
    const dialled: PinnedTarget[] = []
    const result = await safeFetch("http://rebind.example.com/page", { resolver, dial: dialLocal(dialled) })
    expect(result.status).toBe(200)
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(dialled).toHaveLength(1)
    expect(dialled[0].address).toBe(PUBLIC_A)
  })

  it("re-resolves and re-validates on a redirect, so a rebound second name is refused", async () => {
    handlers["/start"] = redirect("http://second.example.com/page")
    handlers["/page"] = text("should not be reached")
    const answers: Record<string, string[]> = { "first.example.com": [PUBLIC_A], "second.example.com": ["127.0.0.1"] }
    const resolver: Resolver = async (hostname) => answers[hostname].map((address) => ({ address, family: 4 }))
    expect(await codeOf(safeFetch("http://first.example.com/start", { resolver, dial: dialLocal() }))).toBe("address_not_allowed")
    expect(seen.map((s) => s.url)).toEqual(["/start"])
  })
})

describe("safeFetch: redirects", () => {
  it("follows a relative and an absolute redirect, validating each hop and forwarding nothing", async () => {
    handlers["/a"] = (_req, res) => {
      res.writeHead(301, { location: "/b", "set-cookie": "sid=abc" }).end()
    }
    handlers["/b"] = redirect("http://other.example.org/c", 307)
    handlers["/c"] = text("arrived")
    const { resolver, calls } = resolverFor({ "www.example.com": PUBLIC_A, "other.example.org": PUBLIC_B })
    const dialled: PinnedTarget[] = []
    const result = await safeFetch("http://www.example.com/a", { resolver, dial: dialLocal(dialled) })
    expect(result).toMatchObject({ finalUrl: "http://other.example.org/c", text: "arrived", redirects: 2 })
    expect(calls).toEqual(["www.example.com", "www.example.com", "other.example.org"])
    expect(dialled.map((d) => d.address)).toEqual([PUBLIC_A, PUBLIC_A, PUBLIC_B])
    expect(seen.map((s) => s.headers.host)).toEqual(["www.example.com", "www.example.com", "other.example.org"])
    for (const request of seen) expect(request.headers.cookie).toBeUndefined()
  })

  it.each([
    ["http://127.0.0.1/", "address_not_allowed"],
    ["http://169.254.169.254/latest/meta-data/iam/", "address_not_allowed"],
    ["http://[::1]/", "address_not_allowed"],
    ["http://2130706433/", "address_not_allowed"],
    ["http://localhost/", "host_not_allowed"],
    ["http://intranet/admin", "host_not_allowed"],
    ["http://internal.example.com/", "address_not_allowed"],
    ["http://user:pw@example.org/", "credentials_not_allowed"],
    ["http://example.org:8080/", "port_not_allowed"],
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["ftp://example.org/x", "scheme_not_allowed"],
    ["gopher://example.org/", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
  ])("refuses a redirect to %s", async (target, code) => {
    handlers["/start"] = redirect(target)
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A, "example.org": PUBLIC_B, "internal.example.com": "10.0.0.9" })
    expect(await codeOf(safeFetch("http://www.example.com/start", { resolver, dial: dialLocal() }))).toBe(code)
    expect(seen).toHaveLength(1)
  })

  it("refuses a redirect with no usable destination", async () => {
    handlers["/none"] = (_req, res) => res.writeHead(302).end()
    handlers["/bad"] = redirect("http://[bad/")
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    expect(await codeOf(safeFetch("http://www.example.com/none", { resolver, dial: dialLocal() }))).toBe("bad_redirect")
    expect(await codeOf(safeFetch("http://www.example.com/bad", { resolver, dial: dialLocal() }))).toBe("bad_redirect")
  })

  it("detects a redirect loop", async () => {
    handlers["/loop"] = redirect("/loop")
    handlers["/ping"] = redirect("/pong")
    handlers["/pong"] = redirect("/ping")
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    expect(await codeOf(safeFetch("http://www.example.com/loop", { resolver, dial: dialLocal() }))).toBe("redirect_loop")
    expect(await codeOf(safeFetch("http://www.example.com/ping", { resolver, dial: dialLocal() }))).toBe("redirect_loop")
  })

  it("follows exactly five redirects and refuses a sixth", async () => {
    handlers["/hop/*"] = (req, res) => {
      const n = Number((req.url ?? "").split("/").pop())
      if (n >= Number(process.env.WF_TEST_LAST_HOP)) return text("done")(req, res)
      redirect(`/hop/${n + 1}`)(req, res)
    }
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    process.env.WF_TEST_LAST_HOP = "5"
    const five = await safeFetch("http://www.example.com/hop/0", { resolver, dial: dialLocal() })
    expect(five).toMatchObject({ text: "done", redirects: 5 })
    seen = []
    process.env.WF_TEST_LAST_HOP = "6"
    expect(await codeOf(safeFetch("http://www.example.com/hop/0", { resolver, dial: dialLocal() }))).toBe("too_many_redirects")
    expect(seen).toHaveLength(6)
    delete process.env.WF_TEST_LAST_HOP
  })
})

describe("safeFetch: size limits", () => {
  const fetchCapped = (path: string, maxBytes: number) => {
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    return safeFetch(`http://www.example.com${path}`, { resolver, dial: dialLocal(), maxBytes })
  }

  it("refuses on a declared Content-Length over the cap", async () => {
    handlers["/big"] = text("x".repeat(2000))
    expect(await codeOf(fetchCapped("/big", 1000))).toBe("too_large")
  })

  it("aborts a chunked stream with no Content-Length once it passes the cap", async () => {
    let written = 0
    handlers["/stream"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" })
      const chunk = "y".repeat(512)
      const timer = setInterval(() => {
        if (res.destroyed || written > 200_000) {
          clearInterval(timer)
          return
        }
        written += chunk.length
        res.write(chunk)
      }, 1)
      res.on("close", () => clearInterval(timer))
    }
    expect(await codeOf(fetchCapped("/stream", 4096))).toBe("too_large")
    expect(written).toBeLessThan(200_000)
  })

  it("accepts a body exactly at the cap", async () => {
    handlers["/exact"] = text("z".repeat(1000))
    expect((await fetchCapped("/exact", 1000)).bytes).toBe(1000)
  })

  it.each([
    ["gzip", (b: Buffer) => zlib.gzipSync(b)],
    ["deflate", (b: Buffer) => zlib.deflateSync(b)],
    ["br", (b: Buffer) => zlib.brotliCompressSync(b)],
  ])("applies the cap after %s decompression (a small body that expands is cut off)", async (encoding, compress) => {
    const bomb = compress(Buffer.alloc(32 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(100 * 1024)
    handlers["/bomb"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": encoding }).end(bomb)
    }
    expect(await codeOf(fetchCapped("/bomb", 1024 * 1024))).toBe("too_large")
  })

  it("decodes a legitimate compressed body and counts decompressed bytes", async () => {
    const original = "compressed page ".repeat(50)
    handlers["/gz"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(zlib.gzipSync(original))
    }
    const result = await fetchCapped("/gz", 1024 * 1024)
    expect(result.text).toBe(original)
    expect(result.bytes).toBe(original.length)
  })

  it("rejects a corrupt compressed body and an unsupported encoding", async () => {
    handlers["/corrupt"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(Buffer.from("this is not gzip data"))
    }
    handlers["/zstd"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" }).end("whatever")
    }
    expect(await codeOf(fetchCapped("/corrupt", 1024 * 1024))).toBe("body_invalid")
    expect(await codeOf(fetchCapped("/zstd", 1024 * 1024))).toBe("encoding_not_supported")
  })
})

describe("safeFetch: content types", () => {
  const fetchType = async (type: string | undefined) => {
    handlers["/t"] = (_req, res) => {
      res.writeHead(200, type ? { "content-type": type } : {}).end("body")
    }
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    return safeFetch("http://www.example.com/t", { resolver, dial: dialLocal() })
  }

  it.each(ALLOWED_CONTENT_TYPES.map((t) => [t]))("reads %s", async (type) => {
    expect((await fetchType(`${type}; charset=utf-8`)).contentType).toBe(type)
  })

  it("is case-insensitive about the type", async () => {
    expect((await fetchType("TEXT/HTML")).contentType).toBe("text/html")
  })

  it.each([["application/pdf"], ["image/png"], ["image/svg+xml"], ["application/octet-stream"], ["video/mp4"], ["application/zip"], ["application/javascript"], ["text/javascript"], [undefined]])(
    "refuses %s with a clear message",
    async (type) => {
      const error = (await fetchType(type).catch((e) => e)) as SafeFetchError
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe("content_type_not_allowed")
      expect(error.message).toMatch(/cannot be read/)
      expect(error.message).toMatch(/PDF/)
    },
  )
})

describe("safeFetch: time limits", () => {
  it("gives up on a server that never answers", async () => {
    handlers["/hang"] = () => {}
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    const started = Date.now()
    expect(await codeOf(safeFetch("http://www.example.com/hang", { resolver, dial: dialLocal(), totalTimeoutMs: 250 }))).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("gives up on a body that stalls after the headers", async () => {
    handlers["/stall"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("partial")
    }
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    expect(await codeOf(safeFetch("http://www.example.com/stall", { resolver, dial: dialLocal(), totalTimeoutMs: 250 }))).toBe("timeout")
  })

  it("applies one deadline across redirect hops", async () => {
    handlers["/slow1"] = (_req, res) => {
      setTimeout(() => redirect("/slow2")(_req, res), 200)
    }
    handlers["/slow2"] = () => {}
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    expect(await codeOf(safeFetch("http://www.example.com/slow1", { resolver, dial: dialLocal(), totalTimeoutMs: 400 }))).toBe("timeout")
  })

  it("reports a refused connection as a network failure", async () => {
    const { resolver } = resolverFor({ "www.example.com": PUBLIC_A })
    // A port with nothing listening on it.
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect(await codeOf(safeFetch("http://www.example.com/", { resolver, dial: () => ({ host: "127.0.0.1", port }) }))).toBe("network")
  })
})

describe("SafeFetchError", () => {
  it("separates policy refusals from transfer failures", () => {
    expect(new SafeFetchError("address_not_allowed", "x").isPolicyRefusal).toBe(true)
    expect(new SafeFetchError("scheme_not_allowed", "x").isPolicyRefusal).toBe(true)
    expect(new SafeFetchError("timeout", "x").isPolicyRefusal).toBe(false)
    expect(new SafeFetchError("too_large", "x").isPolicyRefusal).toBe(false)
  })
})
