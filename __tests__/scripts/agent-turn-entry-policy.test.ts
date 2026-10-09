/**
 * The sandbox entry script runs inside a microVM and executes on import, so it is
 * asserted as source text rather than called. What is pinned here is the tool
 * policy: every capability the agent gets must be declared, and nothing may be
 * inherited from the machine it happens to be running on.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync("scripts/agent/turn-entry.ts", "utf8")

/**
 * Assertions about the tool policy run against the CODE, not the comments.
 *
 * This is not fussiness. ADR 0019 added comments explaining the move away from
 * `tools: []`, and those comments quote the old literal — which silently satisfied
 * a `toMatch(/tools:\s*\[\]/)` assertion against the whole file and left this guard
 * green while the actual posture had changed underneath it. A policy test that can
 * be satisfied by prose is not a policy test.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\/.*$/gm, "")

/**
 * The built-ins the agent must NOT hold. Filesystem writes and network fetches are
 * the two categories that would turn a sandbox escape into a real problem, and
 * `Skill` would let a pack's prose select its own capabilities.
 */
const FORBIDDEN_BUILTINS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Glob", "Grep", "Task", "Skill"]

describe("agent entry capability-pack policy", () => {
  it("keeps plugins declarative while Compass owns MCP", () => {
    expect(code).toContain("skipMcpDiscovery: true")
    expect(code).toContain("strictMcpConfig: true")
    expect(code).toMatch(/settingSources:\s*\[\]/)
  })

  it("exposes exactly the two built-ins ADR 0019 authorized, and no others", () => {
    // Bash drives Playwright; Read is what lets the model actually SEE the PNG it
    // just took (Bash returns text only). The pair is pinned as a literal because
    // the failure mode is additive drift — one more "harmless" built-in at a time,
    // each individually arguable, none of them reviewed as a boundary change.
    expect(code).toContain('tools: ["Bash", "Read"],')
    const declared = code.match(/\n\s*tools:\s*\[([^\]]*)\]/)
    expect(declared).not.toBeNull()
    for (const forbidden of FORBIDDEN_BUILTINS) {
      expect(declared![1]).not.toContain(forbidden)
    }
  })

  it("admits Compass, the two built-ins, and per-turn connector prefixes — nothing wider", () => {
    // The literal is pinned rather than matched loosely because the failure mode
    // is a silent widening: `allowedTools: ["mcp__*"]`, or dropping the option
    // entirely, both leave a headless agent running in bypassPermissions mode with
    // no allowlist at all. `connectorToolPrefixes` is the only sanctioned way for
    // this list to grow, and it grows per turn from the grants that user holds.
    expect(code).toContain('allowedTools: ["mcp__compass", "Bash", "Read", ...connectorToolPrefixes]')
    expect(code).not.toMatch(/allowedTools:\s*\[[^\]]*\*/)
  })

  it("scrubs host-only secrets from the environment before the model can run a shell", () => {
    // Bash makes the process environment readable by anything the model chooses to
    // run, which it was not before. These three are the host's own credentials and
    // have no business being reachable from inside a turn.
    for (const secret of ["MCP_TOKEN", "MCP_BYPASS_SECRET", "AGENT_RUN_TOKEN"]) {
      expect(code).toContain(secret)
    }
    expect(code).toMatch(/delete process\.env\[/)
  })

  it("derives each connector tool prefix from a slug it has re-validated", () => {
    // The slug is interpolated into both a URL path and an `mcp__<slug>` prefix.
    // A stray `*` or `_` in it would widen the allowlist past the one server it
    // was meant to name, so the charset check is part of the policy, not a
    // formatting nicety.
    expect(source).toContain("/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)")
    expect(source).toContain("connectorToolPrefixes.push(`mcp__${connector.slug}`)")
  })

  it("never lets a connector shadow Compass's own MCP entry", () => {
    // Registering a connector under the name `compass` would silently route the
    // agent's entire tool catalog through the gateway.
    expect(source).toContain("hasOwnProperty.call(mcpServers, connector.slug)")
  })
})

/**
 * Per-connector guidance reaches the model through the system prompt, which makes
 * it the one host-supplied string in this script that the model reads as
 * instructions. Pinned as source text for the same reason as the tool policy: the
 * failure modes are silent. Guidance that stops being passed reverts the v0
 * timeout fix with every test still green, and guidance that is not capped lets
 * the host spend the turn's context budget.
 */
describe("agent entry connector guidance", () => {
  it("passes the prompt that carries the guidance, not the bare host prompt", () => {
    // The whole seam is inert if `query()` is handed `systemPrompt` instead.
    expect(source).toContain("systemPrompt: effectiveSystemPrompt")
    expect(source).not.toMatch(/systemPrompt:\s*systemPrompt\b/)
  })

  it("appends guidance after the host prompt rather than merging into it", () => {
    // Scoped to *this* turn's grants: the host prompt is identical for every user,
    // while this paragraph exists only while the connector it describes is
    // reachable. Appending keeps that distinction legible in the transcript.
    expect(source).toContain("`${systemPrompt}\\n\\n## Connected third-party tools\\n\\n${connectorGuidance.join(\"\\n\\n\")}`")
    // Falls back to the unmodified prompt when no connector had anything to say,
    // so a user with no grants pays no context for an empty section header.
    expect(source).toMatch(/connectorGuidance\.length\s*\n?\s*\?/)
  })

  it("only emits guidance for connectors the turn actually enabled", () => {
    // Collected inside the same loop that registers the MCP server, so a connector
    // the user has not granted can never contribute advice about tools the agent
    // cannot call.
    expect(source).toContain("if (connector.guidance) connectorGuidance.push(")
  })

  it("caps guidance instead of trusting the host's string wholesale", () => {
    expect(source).toContain("MAX_CONNECTOR_GUIDANCE_CHARS")
    expect(source).toContain("guidance.trim().slice(0, MAX_CONNECTOR_GUIDANCE_CHARS)")
    // A bound in the low thousands: room for a paragraph of advice, far short of a
    // budget worth injecting into.
    const cap = source.match(/const MAX_CONNECTOR_GUIDANCE_CHARS = (\d+)/)
    expect(cap).not.toBeNull()
    expect(Number(cap![1])).toBeLessThanOrEqual(4000)
  })

  it("ignores a non-string or blank guidance value", () => {
    // The host is the only writer today, but the parser is the trust boundary for
    // everything arriving as JSON in an env var.
    expect(source).toContain('typeof guidance === "string" && guidance.trim()')
  })
})
