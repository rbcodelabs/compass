# ADR 0008: Declarative agent capability packs

**Date:** 2026-09-05  
**Status:** Accepted

## Context

Compass runs each in-app agent turn in a disposable Vercel Sandbox and owns its authenticated MCP connection. Teams need reusable methodology such as the Agentic PM Playbook without giving third-party instructions access to shell, files, credentials, hooks, or arbitrary MCP servers.

## Decision

Compass accepts immutable, declarative, skills-only packs from public GitHub repositories pinned to a full commit SHA. A pack contains `compass-pack.json`, declared `skills/<id>/SKILL.md` files, and referenced read-only assets. Compass validates and normalizes the pack, generates its Claude plugin wrapper, and stores it privately under its SHA-256 digest. Pack identities and selectable versions are scoped to one workspace; repository and pack path form part of the immutable source identity.

At turn time Compass verifies the digest, materializes the normalized plugin, and starts Agent SDK 0.3.224 with an explicit skill allowlist, `tools: []`, `skipMcpDiscovery: true`, `strictMcpConfig: true`, no filesystem settings, and only Compass's acting-user MCP connection. The assistant message records exact pack provenance.

## Options considered

| Option | Benefits | Tradeoffs |
|---|---|---|
| Vendor Playbook prompts into Compass | Smallest initial implementation | Creates a fork and cannot support other packs |
| Declarative immutable packs | Reusable, auditable, rollback-safe, preserves host authority | Requires validation, artifact storage, and admin configuration |
| Arbitrary executable plugins | Maximum flexibility | Allows code, hooks, credentials, and MCP supply-chain risk |

## Consequences

Pack authors can distribute cloud-compatible methodology independently, but packs cannot grant themselves capabilities. Updates create new immutable versions and require an explicit workspace selection. Private repositories, uploads, executable plugins, hooks, commands, agents, and pack-owned MCP are outside v1.

The installed SDK types prove the configuration contract locally. A preview-deployed Vercel Sandbox smoke test is still required before production enablement to prove headless plugin discovery in the real runtime; failure must lead to prompt compilation, not broader tool access.
