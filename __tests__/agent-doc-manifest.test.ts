/**
 * Host-signed baseline manifest (lib/agent-doc-manifest.ts). The sandbox runs
 * agent-controlled code, so everything it hands back must be tamper-evident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/doc-fs", () => ({}))

import { signDocManifest, verifyDocManifest } from "@/lib/agent-doc-manifest"

const RUN = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const baseline = [
  { path: "Product", docId: "doc-1", revision: "rev-1", content: "hello" },
  { path: "Product/Plan", docId: "doc-2", revision: null, content: "plan" },
]

beforeEach(() => {
  process.env.AUTH_SECRET = "test-auth-secret"
})

describe("doc manifest", () => {
  it("round-trips: verifies and returns hash-only baseline entries, never content", () => {
    const signed = signDocManifest(RUN, WS, baseline)
    const verified = verifyDocManifest(JSON.parse(JSON.stringify(signed)), { runId: RUN, workspaceId: WS })
    expect(verified).toHaveLength(2)
    expect(verified![0]).toEqual({
      path: "Product",
      docId: "doc-1",
      revision: "rev-1",
      contentSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    })
    expect(JSON.stringify(signed)).not.toContain("hello")
  })

  it("rejects a manifest whose revision was altered", () => {
    const signed = JSON.parse(JSON.stringify(signDocManifest(RUN, WS, baseline)))
    signed.entries[0].revision = "forged"
    expect(verifyDocManifest(signed, { runId: RUN, workspaceId: WS })).toBeNull()
  })

  it("rejects an added entry (a forged docId)", () => {
    const signed = JSON.parse(JSON.stringify(signDocManifest(RUN, WS, baseline)))
    signed.entries.push({ path: "Other", docId: "foreign", revision: null, contentSha256: "0".repeat(64) })
    expect(verifyDocManifest(signed, { runId: RUN, workspaceId: WS })).toBeNull()
  })

  it("rejects a manifest minted for another run or workspace", () => {
    const signed = JSON.parse(JSON.stringify(signDocManifest(RUN, WS, baseline)))
    expect(verifyDocManifest(signed, { runId: "33333333-3333-4333-8333-333333333333", workspaceId: WS })).toBeNull()
    expect(verifyDocManifest(signed, { runId: RUN, workspaceId: "44444444-4444-4444-8444-444444444444" })).toBeNull()
  })

  it("rejects a re-labelled run id even when the signature is copied along", () => {
    const signed = JSON.parse(JSON.stringify(signDocManifest(RUN, WS, baseline)))
    signed.runId = "33333333-3333-4333-8333-333333333333"
    expect(verifyDocManifest(signed, { runId: signed.runId, workspaceId: WS })).toBeNull()
  })

  it("rejects malformed input and a different secret", () => {
    expect(verifyDocManifest(null, { runId: RUN, workspaceId: WS })).toBeNull()
    expect(verifyDocManifest({ runId: RUN, workspaceId: WS, entries: "x", signature: "ab" }, { runId: RUN, workspaceId: WS })).toBeNull()
    const signed = JSON.parse(JSON.stringify(signDocManifest(RUN, WS, baseline)))
    process.env.AUTH_SECRET = "a-different-secret"
    expect(verifyDocManifest(signed, { runId: RUN, workspaceId: WS })).toBeNull()
  })

  it("refuses to sign without a server secret", () => {
    delete process.env.AUTH_SECRET
    expect(() => signDocManifest(RUN, WS, baseline)).toThrow(/AUTH_SECRET/)
  })
})
