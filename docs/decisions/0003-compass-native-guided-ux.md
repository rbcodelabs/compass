# ADR-0003: Compass-Native Guided UX with Chat and Realtime Voice

**Date:** 2026-08-30
**Status:** Accepted

## Context

Compass must replace Helio's guided usability-testing experience without creating a second research system or importing Helio's public blob URLs, client-authored prompts, replaceable transcripts, and weak tenant boundaries. The existing Capture domain already provides workspace-scoped studies, hashed participant and resume tokens, append-only turns, request idempotency, and a tool-free paid model runtime.

The migration must support a live product, realistic task guide, chat, realtime voice, screenshots and PDFs, reload/resume, and researcher review. Target products may deny iframe embedding through CSP or `X-Frame-Options`, and Compass cannot reliably detect that denial across origins.

## Decision

Guided UX uses the existing `ResearchStudy → ResearchSession → ResearchTurn` domain. A `USABILITY_TEST` study stores a server-validated public HTTPS app URL, duration, and ordered tasks. Chat and voice are transports over the same canonical append-only transcript.

Private uploads use a normalized `ResearchAttachment` record containing redundant workspace, study, session, and optional turn provenance. Blob pathnames are private and never returned directly; participant-session and workspace-member authorization protect delivery. Images and PDFs are signature-validated, bounded, and treated as untrusted participant evidence.

Failed blob compensation is owned by the same bounded context. A standalone `ResearchBlobCleanup` queue records workspace, study, session, attachment, and private-path provenance, then retries deletion only when every path segment matches that provenance. This deliberately does not reuse `ArtifactBlobCleanup`: guided research can be deployed and migrated without requiring the separate artifact subsystem, while cleanup remains durable rather than best-effort.

Deployed research attachments use a dedicated private Blob store credential via `RESEARCH_BLOB_READ_WRITE_TOKEN`. Research upload, authorized download, model retrieval, and cleanup pass that token explicitly; the existing `BLOB_READ_WRITE_TOKEN` remains the implicit credential for public documentation, branding, feedback, and artifact callers. Local database-backed development continues to use isolated filesystem storage.

Voice uses a short-lived OpenAI Realtime client secret minted only after participant-token and session-resume authorization. Server-authored, tool-free instructions select the study, task guide, app URL, model, and voice. Only finalized provider events enter the canonical transcript, keyed idempotently by provider event/item ID. A short database lease permits one active voice connection per session. Disconnects preserve the session for reconnection; raw audio is not retained.

The participant experience uses a restrictive iframe (`allow-scripts allow-forms allow-popups`, `referrerPolicy="no-referrer"`) and a persistent external link with `noopener,noreferrer`. The external action is the guaranteed fallback when embedding is blocked.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Copy Helio directly | Lowest initial UI effort | Preserves unsafe public URLs, client authority, and a parallel data model |
| Compass-native shared domain | Strong tenancy, one transcript, preserves existing Capture invariants | Requires migration and provider event persistence |
| Remote browser observation | Rich telemetry and direct observation | Much larger privacy, security, and infrastructure surface |

## Consequences

Guided studies reuse Capture lifecycle, rate limits, revocation, completion, and researcher review. Chat and voice can reconnect without transcript replacement. Attachments have auditable tenant provenance and can be deleted independently of turns. Failed private-blob deletion is retried from a research-owned tenant queue, adding a small amount of persistent operational state in exchange for keeping Capture deployable independently of Artifacts.

Voice requires an OpenAI API key and a browser WebRTC connection. Cross-origin embed success remains unknowable, so the external link is first-class rather than an error-only escape hatch. Browser control, click telemetry, screen recording, and raw-audio retention are deliberately excluded.

## Risks

- Provider realtime event shapes may evolve; the client reducer and server event allowlist must remain versioned and tested.
- A target product can block both framing and automated login state; participants must use the external product window.
- Multimodal payload size and document processing require conservative limits and bounded model context.
- Database leases depend on client disconnect/reconnect discipline and must expire safely.
