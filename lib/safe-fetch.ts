/**
 * Server-side HTTP(S) fetch that cannot be pointed at internal infrastructure.
 *
 * The caller hands over a URL an untrusted party may have influenced, so every property
 * that decides *where the connection goes* is checked here, on every hop, and the check
 * is bound to the connection itself:
 *
 *  - scheme is http or https, with no embedded credentials and only the standard ports;
 *  - the host is a dotted public name (no single-label or local-only names) or a public IP literal;
 *  - the name is resolved here, and EVERY returned address must be public. Loopback,
 *    RFC 1918, link-local (cloud metadata), CGNAT, multicast, reserved, documentation and
 *    benchmarking ranges are refused for IPv4, and the IPv6 equivalents are refused by an
 *    allow-list (only 2000::/3 outside a few registered special-use blocks);
 *  - the validated address is PINNED: the socket is opened to that IP, with the hostname
 *    only used for the Host header and TLS server name. The name is never resolved a second
 *    time, so a resolver that answers differently the second time (DNS rebinding) is moot;
 *  - redirects are followed by hand, at most MAX_REDIRECTS, each one re-validated from
 *    scratch; nothing (cookies, Authorization, Referer) is carried from one hop to the next;
 *  - the response is read as a stream with a hard byte cap that applies after decompression,
 *    a content-type allow-list, and a total deadline.
 *
 * It sends no credentials of its own: only a fixed header set and a User-Agent naming Compass.
 */
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import type { Readable } from "node:stream"
import zlib from "node:zlib"

export const MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
export const TOTAL_TIMEOUT_MS = 15_000
export const CONNECT_TIMEOUT_MS = 5_000
export const MAX_URL_LENGTH = 2_048
export const ALLOWED_PORTS: readonly number[] = [80, 443]
export const USER_AGENT = "CompassAgent/1.0 (+https://github.com/rbcodelabs/compass; automated page fetch on behalf of a user)"

export const ALLOWED_CONTENT_TYPES: readonly string[] = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/xml",
  "application/xml",
  "text/csv",
]

export type SafeFetchErrorCode =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_not_allowed"
  | "port_not_allowed"
  | "host_not_allowed"
  | "address_not_allowed"
  | "dns_failed"
  | "too_many_redirects"
  | "redirect_loop"
  | "bad_redirect"
  | "content_type_not_allowed"
  | "encoding_not_supported"
  | "body_invalid"
  | "too_large"
  | "timeout"
  | "network"

/** Codes that mean "the request was refused by policy", as opposed to a failed transfer. */
const POLICY_CODES: ReadonlySet<SafeFetchErrorCode> = new Set([
  "invalid_url",
  "scheme_not_allowed",
  "credentials_not_allowed",
  "port_not_allowed",
  "host_not_allowed",
  "address_not_allowed",
  "bad_redirect",
])

/** `message` is written for the model: it names the reason and never echoes internal addresses or resolver output. */
export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = "SafeFetchError"
    this.code = code
  }
  /** True when the URL was refused by policy rather than failing in transit. */
  get isPolicyRefusal(): boolean {
    return POLICY_CODES.has(this.code)
  }
}

// ── address classification ──────────────────────────────────────────────────

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** [network, prefix length]. Anything inside is not a public unicast address. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata services
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including the limited broadcast address
]

const BLOCKED_V4_RANGES = BLOCKED_V4.map(([network, bits]) => {
  const base = parseIPv4(network) as number
  return [base, base + 2 ** (32 - bits) - 1] as const
})

function isPublicIPv4(value: number): boolean {
  return !BLOCKED_V4_RANGES.some(([low, high]) => value >= low && value <= high)
}

/** Parses an IPv6 literal (no brackets, no zone) to eight 16-bit groups, or null. */
function parseIPv6(ip: string): number[] | null {
  if (!net.isIPv6(ip) || ip.includes("%")) return null
  let text = ip
  // An embedded dotted-quad tail becomes two hextets.
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail)
    if (v4 === null) return null
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    out.push(parseInt(group, 16))
  }
  return out
}

/** Whether the first `bits` bits of `groups` equal those of `prefix` (given as leading hextets). */
function hasPrefix(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff
    if ((groups[i] & mask) !== ((prefix[i] ?? 0) & mask)) return false
  }
  return true
}

function isPublicIPv6(groups: readonly number[]): boolean {
  // ::ffff:0:0/96 -- an IPv4 address in IPv6 clothing; judged as the IPv4 address it carries.
  if (hasPrefix(groups, [0, 0, 0, 0, 0, 0xffff], 96)) return isPublicIPv4(groups[6] * 65536 + groups[7])
  // Allow-list: global unicast only. This refuses ::, ::1, ::/96, 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64),
  // 100::/64, fc00::/7, fe80::/10, fec0::/10 and ff00::/8 without having to enumerate them.
  if (!hasPrefix(groups, [0x2000], 3)) return false
  // Registered special-use blocks inside 2000::/3.
  if (hasPrefix(groups, [0x2001], 23)) return false // 2001::/23: IETF protocol assignments, Teredo, benchmarking, ORCHID
  if (hasPrefix(groups, [0x2001, 0x0db8], 32)) return false // documentation
  if (hasPrefix(groups, [0x2002], 16)) return false // 6to4 (embeds an arbitrary IPv4 address)
  if (hasPrefix(groups, [0x3fff], 20)) return false // documentation
  return true
}

/** Whether `ip` (a bare IPv4/IPv6 literal, no brackets) is a public unicast address. Unparseable input is not. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const value = parseIPv4(ip)
    return value !== null && isPublicIPv4(value)
  }
  if (net.isIPv6(ip)) {
    const value = parseIPv6(ip)
    return value !== null && isPublicIPv6(value)
  }
  return false
}

// ── URL validation ──────────────────────────────────────────────────────────

/** Names that never leave the local network, refused before any lookup is made. */
const LOCAL_ONLY_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".home"]

export interface ValidatedTarget {
  url: URL
  /** Lower-case hostname without a trailing dot; for an IP literal, the bare address without brackets. */
  hostname: string
  port: number
  secure: boolean
  /** Set when the hostname is itself an IP literal (already known to be public). */
  literalAddress?: string
}

/** Everything that can be decided from the URL text alone. Throws SafeFetchError. */
export function validateUrl(input: string): ValidatedTarget {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH || /[\u0000- \u007f]/.test(input)) {
    throw new SafeFetchError("invalid_url", "The URL is not valid.")
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("invalid_url", "The URL is not valid.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("scheme_not_allowed", "Only http and https URLs can be fetched.")
  }
  if (url.username || url.password) {
    throw new SafeFetchError("credentials_not_allowed", "URLs with embedded credentials are not allowed.")
  }
  const secure = url.protocol === "https:"
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  if (!ALLOWED_PORTS.includes(port)) {
    throw new SafeFetchError("port_not_allowed", "Only the standard web ports (80 and 443) can be fetched.")
  }

  // WHATWG parsing has already normalised decimal, octal and hex IPv4 forms (2130706433, 0x7f.1, 0177.0.0.1)
  // to dotted decimal, so the checks below see the address that would really be dialled.
  let hostname = url.hostname.toLowerCase()
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1)
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new SafeFetchError("address_not_allowed", "That address is not a public internet address, so it will not be fetched.")
    }
    return { url, hostname, port, secure, literalAddress: hostname }
  }
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1)
  if (!hostname || hostname.endsWith(".")) throw new SafeFetchError("host_not_allowed", "That host name is not allowed.")
  // Single-label names resolve through search domains and local resolvers, never the public DNS.
  if (!hostname.includes(".") || hostname === "localhost" || LOCAL_ONLY_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new SafeFetchError("host_not_allowed", "That host name is not a public internet name, so it will not be fetched.")
  }
  return { url, hostname, port, secure }
}

export interface ResolvedAddress {
  address: string
  family: number
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export const systemResolver: Resolver = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => ({ address: record.address, family: record.family }))
}

/**
 * Resolves `hostname` once and returns the address to connect to. Every answer must be public:
 * a name with one internal record is refused outright rather than filtered, so a split-horizon or
 * rebinding-style record set cannot be steered toward the internal one by connection ordering.
 */
export async function resolvePublicAddress(hostname: string, resolver: Resolver): Promise<ResolvedAddress> {
  let records: ResolvedAddress[]
  try {
    records = await resolver(hostname)
  } catch {
    throw new SafeFetchError("dns_failed", "The host name could not be resolved.")
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new SafeFetchError("dns_failed", "The host name could not be resolved.")
  }
  for (const record of records) {
    if (typeof record?.address !== "string" || !isPublicAddress(record.address)) {
      throw new SafeFetchError("address_not_allowed", "That host resolves to a non-public address, so it will not be fetched.")
    }
  }
  return records[0]
}

// ── fetching ────────────────────────────────────────────────────────────────

export interface PinnedTarget {
  /** The validated, pinned address that the socket is opened to. */
  address: string
  port: number
  secure: boolean
  hostname: string
}

export interface SafeFetchOptions {
  resolver?: Resolver
  maxBytes?: number
  maxRedirects?: number
  totalTimeoutMs?: number
  connectTimeoutMs?: number
  /**
   * Test seam, applied AFTER validation and pinning: lets a test map a validated public-looking
   * address onto a local server. Production code never sets it.
   */
  dial?: (target: PinnedTarget) => { host: string; port: number }
}

export interface SafeFetchResult {
  finalUrl: string
  status: number
  /** Lower-case media type without parameters. */
  contentType: string
  /** The body, decoded to text, after decompression. */
  text: string
  /** Decompressed size in bytes. */
  bytes: number
  redirects: number
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function mediaTypeOf(header: string | undefined): { type: string; charset?: string } {
  if (!header) return { type: "" }
  const [rawType, ...params] = header.split(";")
  const charsetParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("charset="))
  const charset = charsetParam?.slice(8).trim().replace(/^["']|["']$/g, "").toLowerCase()
  return { type: rawType.trim().toLowerCase(), charset: charset || undefined }
}

function decoderFor(contentEncoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const encoding = (contentEncoding ?? "").trim().toLowerCase()
  if (encoding === "" || encoding === "identity") return null
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip()
  if (encoding === "deflate") return zlib.createInflate()
  if (encoding === "br") return zlib.createBrotliDecompress()
  throw new SafeFetchError("encoding_not_supported", "The page uses a content encoding that is not supported.")
}

interface HopResponse {
  status: number
  headers: http.IncomingHttpHeaders
  stream: http.IncomingMessage
}

function requestHop(
  target: ValidatedTarget,
  pinned: ResolvedAddress,
  options: { connectTimeoutMs: number; dial?: SafeFetchOptions["dial"] },
  signal: AbortSignal,
): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const dialled = options.dial?.({ address: pinned.address, port: target.port, secure: target.secure, hostname: target.hostname })
    const lib = target.secure ? https : http
    const request = lib.request({
      host: dialled?.host ?? pinned.address,
      port: dialled?.port ?? target.port,
      method: "GET",
      path: `${target.url.pathname}${target.url.search}`,
      // A fresh socket per hop, never pooled: nothing may be shared between hops or between callers.
      agent: false,
      // TLS server name and certificate identity come from the hostname, not from the pinned IP.
      ...(target.secure && !target.literalAddress ? { servername: target.hostname } : {}),
      headers: {
        Host: target.url.host,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/xml,text/xml,text/csv;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en",
        Connection: "close",
      },
      signal,
    })
    let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      request.destroy(new SafeFetchError("timeout", "Connecting to the host timed out."))
    }, options.connectTimeoutMs)
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = undefined
    }
    request.on("socket", (socket) => {
      socket.once(target.secure ? "secureConnect" : "connect", clearConnectTimer)
    })
    request.once("response", (response) => {
      clearConnectTimer()
      resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response })
    })
    request.once("error", (error) => {
      clearConnectTimer()
      if (error instanceof SafeFetchError) return reject(error)
      if (signal.aborted) return reject(new SafeFetchError("timeout", "The request timed out."))
      reject(new SafeFetchError("network", "The page could not be retrieved."))
    })
    request.end()
  })
}

function decodeText(buffer: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  }
}

async function readCapped(response: HopResponse, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers["content-length"])
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.stream.destroy()
    throw new SafeFetchError("too_large", "The page is larger than the size limit.")
  }
  let decoder: ReturnType<typeof decoderFor>
  try {
    decoder = decoderFor(response.headers["content-encoding"])
  } catch (error) {
    response.stream.destroy()
    throw error
  }
  const source: Readable = decoder ? response.stream.pipe(decoder) : response.stream
  if (decoder) {
    // The cap on the wire is the same number: a legitimate page that needs more than maxBytes compressed is too big anyway.
    let compressed = 0
    response.stream.on("data", (chunk: Buffer) => {
      compressed += chunk.length
      if (compressed > maxBytes) decoder.destroy(new SafeFetchError("too_large", "The page is larger than the size limit."))
    })
    response.stream.on("error", (error) => decoder.destroy(error))
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      // The count is of decompressed bytes, so a small body that expands enormously is cut off here.
      if (total > maxBytes) throw new SafeFetchError("too_large", "The page is larger than the size limit.")
      chunks.push(buffer)
    }
  } catch (error) {
    response.stream.destroy()
    decoder?.destroy()
    if (error instanceof SafeFetchError) throw error
    if (signal.aborted) throw new SafeFetchError("timeout", "The request timed out.")
    if (decoder) throw new SafeFetchError("body_invalid", "The page body could not be decoded.")
    throw new SafeFetchError("network", "The page could not be retrieved.")
  }
  return Buffer.concat(chunks)
}

/**
 * Fetches `rawUrl` with every SSRF control above applied. Resolves with the decoded text body of the
 * final response; throws SafeFetchError for a refusal or a failure. A non-2xx status is returned, not thrown.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const resolver = options.resolver ?? systemResolver
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const signal = AbortSignal.timeout(options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS)

  const visited = new Set<string>()
  let current = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = validateUrl(current)
    const normalized = target.url.href.split("#")[0]
    if (visited.has(normalized)) throw new SafeFetchError("redirect_loop", "The page redirects in a loop.")
    visited.add(normalized)

    const pinned = target.literalAddress
      ? { address: target.literalAddress, family: net.isIPv6(target.literalAddress) ? 6 : 4 }
      : await resolvePublicAddress(target.hostname, resolver)

    const response = await requestHop(target, pinned, { connectTimeoutMs, dial: options.dial }, signal)

    if (REDIRECT_STATUSES.has(response.status)) {
      response.stream.destroy()
      const location = response.headers.location
      if (typeof location !== "string" || !location) throw new SafeFetchError("bad_redirect", "The page redirected without a destination.")
      if (hop === maxRedirects) throw new SafeFetchError("too_many_redirects", "The page redirected too many times.")
      try {
        current = new URL(location, target.url).href
      } catch {
        throw new SafeFetchError("bad_redirect", "The page redirected to an invalid URL.")
      }
      continue
    }

    const contentType = mediaTypeOf(response.headers["content-type"])
    if (response.status < 200 || response.status >= 300) {
      // Error pages are not read: the status is the answer.
      response.stream.destroy()
      return { finalUrl: target.url.href, status: response.status, contentType: contentType.type, text: "", bytes: 0, redirects: hop }
    }
    if (!ALLOWED_CONTENT_TYPES.includes(contentType.type)) {
      response.stream.destroy()
      throw new SafeFetchError(
        "content_type_not_allowed",
        `This page is ${contentType.type || "of an unknown content type"}, which cannot be read. Only text, HTML, JSON, XML and CSV pages are supported (no PDFs, images or other binary files).`,
      )
    }
    const body = await readCapped(response, maxBytes, signal)
    return {
      finalUrl: target.url.href,
      status: response.status,
      contentType: contentType.type,
      text: decodeText(body, contentType.charset),
      bytes: body.length,
      redirects: hop,
    }
  }
  throw new SafeFetchError("too_many_redirects", "The page redirected too many times.")
}
