# ADR 0008: Declarative agent capability packs

**Date:** 2026-09-05
**Status:** Accepted

## Context

Compass runs each in-app agent turn in a disposable Vercel Sandbox and owns its authenticated MCP connection. Teams need reusable methodology such as the Agentic PM Playbook without giving third-party instructions access to shell, files, credentials, hooks, or arbitrary MCP servers.

## Decision

Compass accepts immutable, declarative, skills-only packs from public GitHub repositories pinned to a full commit SHA. A pack contains `compass-pack.json`, declared `skills/<id>/SKILL.md` files, and referenced read-only assets. Compass validates and normalizes the pack, generates its Claude plugin wrapper, and stores it privately under its SHA-256 digest. Pack identities and selectable versions are scoped to one workspace; repository and pack path form part of the immutable source identity.

At turn time Compass verifies the digest and compiles only enabled skill Markdown bodies and directly referenced UTF-8 text assets into the host system prompt. It also materializes the normalized plugin and starts Agent SDK 0.3.224 with an explicit skill allowlist, `tools: []`, `skipMcpDiscovery: true`, `strictMcpConfig: true`, no filesystem settings, and only Compass's acting-user MCP connection. The assistant message records exact pack provenance.

## Options considered

| Option | Benefits | Tradeoffs |
|---|---|---|
| Vendor Playbook prompts into Compass | Smallest initial implementation | Creates a fork and cannot support other packs |
| Declarative immutable packs | Reusable, auditable, rollback-safe, preserves host authority | Requires validation, artifact storage, and admin configuration |
| Arbitrary executable plugins | Maximum flexibility | Allows code, hooks, credentials, and MCP supply-chain risk |

## Consequences

Pack authors can distribute cloud-compatible methodology independently, but packs cannot grant themselves capabilities. Updates create new immutable versions and require an explicit workspace selection. Private repositories, uploads, executable plugins, hooks, commands, agents, and pack-owned MCP are outside v1.

The real Vercel Sandbox proof on 2026-09-07 showed that SDK 0.3.224 lists skill metadata but does not supply Skill/Read tools or skill bodies with `tools: []`. This activates the previously accepted fallback to eager prompt compilation, without broadening tool access. Deterministic compilation sorts enabled skill IDs, removes frontmatter, deduplicates directly referenced text assets, and shares a fail-closed 64 KiB budget across all compiled pack instructions and appendices. The tradeoff is higher per-turn context usage than lazy discovery.

The compiled runtime supports `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, and `.svg` as UTF-8 text. Referenced binary assets, malformed UTF-8 assets, or links to disabled skill bodies fail closed. Installation checks the default enabled selection before persisting it; configuration checks the stored artifact before enabling a selection; turns repeat verification and enforce the aggregate budget. Disabling a pack remains available when an artifact is missing or unsupported. Nested asset references are not fetched or interpreted; compiled assets are provided as data, and host permissions remain authoritative. Live Sandbox body/asset canaries and hostile-pack checks verify the fallback before production enablement.

Workspace and organization deletion removes pack attachments, versions, and metadata but retains immutable content-addressed Blob artifacts. Reclaiming orphaned pack artifacts requires a future global garbage collector that is safe against concurrent installation; tenant deletion does not attempt Blob cleanup in v1.

Capability pack artifacts use a dedicated private Blob store via `CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN`. A preview installation verified that the pre-existing general Blob token pointed at a public document store, so pack consumers must never inherit that token. Configure this dedicated token separately before production enablement. General artifact and research storage routing remain unchanged. Missing pack storage fails closed only for pack operations, and storage errors are never treated as missing blobs.
