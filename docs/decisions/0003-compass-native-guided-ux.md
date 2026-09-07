# ADR-0003: Compass-Native Guided UX with Chat and Realtime Voice

**Date:** 2026-08-30
**Amended:** 2026-09-04
**Status:** Accepted

## Context

Compass must replace Helio's guided usability-testing experience without creating a second research system or importing Helio's public blob URLs, client-authored prompts, replaceable transcripts, and weak tenant boundaries. The existing Capture domain already provides workspace-scoped studies, hashed participant and resume tokens, append-only turns, request idempotency, and a tool-free paid model runtime.

The migration must support a live product, realistic task guide, chat, realtime voice, screenshots and PDFs, reload/resume, and researcher review. Target products may deny iframe embedding through CSP or `X-Frame-Options`, and Compass cannot reliably detect that denial across origins.

## Decision

Guided UX uses the existing `ResearchStudy → ResearchSession → ResearchTurn` domain. A `USABILITY_TEST` study stores a server-validated public HTTPS app URL, duration, and ordered tasks. Chat and voice are transports over the same canonical append-only transcript.

Private uploads use a normalized `ResearchAttachment` record containing redundant workspace, study, session, and optional turn provenance. Blob pathnames are private and never returned directly; participant-session and workspace-member authorization protect delivery. Images and PDFs are signature-validated, bounded, and treated as untrusted participant evidence.

Failed blob compensation is owned by the same bounded context. A standalone `ResearchBlobCleanup` queue records workspace, study, session, attachment, and private-path provenance, then retries deletion only when every path segment matches that provenance. This deliberately does not reuse `ArtifactBlobCleanup`: guided research can be deployed and migrated without requiring the separate artifact subsystem, while cleanup remains durable rather than best-effort.

Deployed research attachments use a dedicated private Blob store credential via `RESEARCH_BLOB_READ_WRITE_TOKEN`. Research upload, authorized download, model retrieval, and cleanup pass that token explicitly; the existing `BLOB_READ_WRITE_TOKEN` remains the implicit credential for public documentation, branding, feedback, and artifact callers. Local database-backed development continues to use isolated filesystem storage.

Voice uses OpenAI Realtime WebRTC for browser audio and an application-owned sideband connection for policy, lifecycle, and transcript provenance. After participant-token and session-resume authorization, Compass creates the Realtime call from an audio-only browser SDP offer with its server credential and captures the provider call ID from the trusted provider response. The browser receives only the SDP answer and an opaque Compass call ID. It receives no provider credential or provider call ID, creates no provider data channel, and cannot submit provider-attributed transcript content, roles, event IDs, instructions, responses, or call-control events.

Compass runs one bounded, non-persistent Vercel Sandbox worker for each active voice call. The trusted worker holds the authenticated provider sideband connection and owns server-authored instructions, model, voice, transcription, tools-disabled policy, response creation, authorized attachment injection, interruption, and explicit hangup. The worker is a continuous execution host, not the durable source of truth: call, command, quota, lease, heartbeat, canonical-turn, and transcript-integrity state remain in DSQL. Before production voice is enabled, a live Compass deployment must prove that its Vercel plan supports the required 40-minute Sandbox session and that a detached worker can maintain the allowlisted outbound sideband WebSocket after the controller Function returns.

Only successfully finalized, allowlisted provider server events observed by the authenticated worker may create provider-attributed canonical turns. Participant roles derive from completed provider input-transcription events, and interviewer roles derive from completed provider responses; browser-supplied roles and content are never accepted. Provider conversation-item order, not callback arrival order, determines canonical sequence because input transcription completes asynchronously. Provider event and item IDs make delivery idempotent, while incomplete, cancelled, or failed responses retain diagnostic provenance without becoming canonical turns.

A short database lease permits one active voice call per session. The worker reports heartbeats and delivers events at least once within bounded queues; Compass persists them transactionally and enforces session turn, character, duration, attempt, and rate limits. Closing the sideband connection alone is not treated as hangup. Normal disconnect, failure, and deadline paths explicitly end the provider call and release the lease. If a worker is lost or misses events, Compass marks transcript integrity degraded, terminates the call, and preserves finalized turns. It never reattaches a replacement worker across an unobserved interval. Participant reconnect creates a new provider call from persisted finalized context. Raw audio flows directly between the browser and provider and is not retained by Compass or the Sandbox.

The participant experience uses a restrictive iframe (`allow-scripts allow-forms allow-popups`, `referrerPolicy="no-referrer"`) and a persistent external link with `noopener,noreferrer`. The external action is the guaranteed fallback when embedding is blocked.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Copy Helio directly | Lowest initial UI effort | Preserves unsafe public URLs, client authority, and a parallel data model |
| Compass-native shared domain | Strong tenancy, one transcript, preserves existing Capture invariants | Requires migration and provider event persistence |
| Browser WebRTC with client secret and client-forwarded events | Smallest initial Realtime integration; no long-running application worker | Makes the browser authoritative for session policy and canonical transcript provenance; provider events cannot be authenticated by Compass |
| Server-created WebRTC with a bounded Vercel Sandbox sideband worker | Keeps raw audio on the direct media path while making provider policy, events, and lifecycle application-authoritative; reuses Compass's existing Sandbox control-plane pattern | Adds one metered worker per active call and requires explicit reconciliation and transcript-integrity handling |
| Server-created WebRTC with a continuously hosted container or VM | Conventional long-lived WebSocket host with broad runtime control | Adds deployment, scaling, health, and operational ownership that a bounded call does not currently justify |
| Remote browser observation | Rich telemetry and direct observation | Much larger privacy, security, and infrastructure surface |

## Consequences

Guided studies reuse Capture lifecycle, rate limits, revocation, completion, and researcher review. Chat and voice can reconnect without transcript replacement. Attachments have auditable tenant provenance and can be deleted independently of turns. Failed private-blob deletion is retried from a research-owned tenant queue, adding a small amount of persistent operational state in exchange for keeping Capture deployable independently of Artifacts.

Voice requires an OpenAI API key, a browser WebRTC connection, a dedicated pinned sideband runner, and durable call-state reconciliation. A live call consumes provisioned Sandbox memory for its wall-clock duration even while waiting on network I/O. Sideband failure ends the affected call instead of silently accepting an unverifiable transcript; participants can reconnect and continue from finalized canonical turns. This deliberately favors provenance and tenant safety over seamless recovery through an interval Compass did not observe.

The audio-only browser boundary removes the provider data channel and ephemeral client credential from the public trust surface. It also means participant-facing status, canonical captions, attachment commands, and disconnect acknowledgement travel through authenticated Compass endpoints rather than browser-authored provider events. A future need for continuously available calls, calls longer than the Sandbox plan limit, or transparent worker failover would require revisiting the execution host and provider-event recovery model.

Cross-origin embed success remains unknowable, so the external link is first-class rather than an error-only escape hatch. Browser control, click telemetry, screen recording, and raw-audio retention are deliberately excluded.

## Authoritative voice implementation gates

The persistence and runtime-service foundation is an intermediate, non-routable
slice. It does not enable participant voice: participant endpoints, authenticated
internal callbacks, the actual provider sideband loop, and the termination saga
must ship together before the authoritative flag can expose a call. The current
heartbeat bootstrap alone cannot establish `READY`. Only an authenticated,
configured sideband with event capture may do that; the SDP answer must remain
withheld until that acknowledgement is durable.

Provider creation is a one-shot operation. A retry during `PROVIDER_CREATED`
reports provisioning in progress without stopping the original request. A known
provider call ID must survive response-body or SDP validation failures so cleanup
can still hang up that call. Cleanup records the provider and Sandbox identities
and each confirmed stop before releasing the matching session lease. An ambiguous
cleanup remains `UNKNOWN` with retryable provenance, not a successful completion.
Controller-side provider requests use bounded abort deadlines (15 seconds for
creation, 10 seconds for hangup). The termination saga must test a provider creation result that
arrives after reconciliation has terminalized the attempt: preserve the newly
discovered provider ID for cleanup without disturbing a concurrently advanced
owner or a subsequent call.

OpenAI does not provide a stateless call-status retrieval operation. Reconciliation
uses durable sideband observations and Sandbox/command evidence, then explicitly
attempts provider hangup and Sandbox termination. A stale heartbeat alone cannot
prove that a call ended or justify releasing its lease. The production reconciler
must implement that termination saga before the foundation's timing helpers are
wired to any endpoint.

Sandbox inspection must not start another execution session. With the pinned
`@vercel/sandbox` 2.9.2 SDK, `get({ resume: false })` suppresses resumption only
during lookup; subsequent Sandbox command methods can still auto-resume. Inspect
the original `currentSession()` directly and preserve the distinction between a
missing Sandbox, a missing command, and an uncertain inspection result. Network
egress allows only OpenAI and the exact Compass callback hostname derived from
trusted deployment configuration.

### Sideband parser and callback checkpoint

Protocol v1 consumes authenticated provider server events and orders transcript
items using `previous_item_id`, never transcription completion time. Ordering
treats an omitted predecessor as unknown, distinct from an explicit
`null` root. The runtime must establish a trustworthy root and predecessor chain
before readiness; it must not infer missing order from event arrival.
Participant
text waits for `conversation.item.input_audio_transcription.completed`; interviewer
text waits for correlated `response.done`. Cancelled, failed, and incomplete
interviewer items retain provenance without canonical text. Failed participant
transcription, conflicting replay, unresolved ordering gaps, unsupported tools,
or overflow poison the parser and require the later termination saga.

The pure parser holds at most 128 items, 1,024 relevant event fingerprints, and
256 KiB of item state. Raw audio deltas are discarded before buffering. Callback
batches contain at most 10 events / 64 KiB and remain immutable until an explicit
acknowledgement confirms the whole batch. Restart recovery is not implemented:
the future worker must fail closed rather than reconstruct unobserved history.

Only four worker-bearer callbacks exist: heartbeat, events, command claim, and
command result. They use fixed UUID paths, bounded streaming JSON, `no-store`
responses, and transactional credential/lease fences for writes. Heartbeat accepts
only `RUNNING` and cannot establish `READY`. No participant call allocation route,
WebSocket loop, readiness callback, or terminal-control callback is exposed by
this checkpoint.

Image/PDF context items can occupy positions in the provider item chain without
being spoken transcript turns. Parser v1 rejects them explicitly; the attachment
integration must represent those ordering positions before voice attachments can
be enabled. Existing instructions may be supplied through session configuration.

Checkpoint verification (2026-09-05): 2,184 tests passed across 185 files;
production build, TypeScript, changed-file lint, and both UI policy guards passed.
Independent review found no remaining blockers for this internal-only slice.
Against the built local app, all four callback paths returned `401`, `no-store`,
and no login redirect without a bearer credential. The temporary server was
stopped after the check. No live provider call, Sandbox allocation, database
migration, or participant E2E journey was exercised by this checkpoint; those
remain required at their corresponding rollout gates.

### Cleanup-first termination checkpoint

The internal termination service performs one bounded cleanup pass. It commits
an exact call-state, resource-identity, heartbeat, and timestamp fence before
external I/O, immediately withholds SDP and worker authorization, and records
provider and Sandbox stop receipts independently. A failed receipt write retains
the lease; a retry targets the same immutable resource and never transfers an
absence receipt to a newly discovered identity. Timestamp versions advance
monotonically, including multiple state changes in the same millisecond.

Only two durable stop/definite-not-created receipts allow the final transaction
to release the session lease, and that update always matches the original call
ID. A newer session lease remains untouched. Generic terminal transitions and
timing-only reconciliation no longer release a lease without those receipts.
`UNKNOWN` denies worker access but remains eligible for bounded cleanup retries.
Finalized transcript integrity and provider ordering are preserved.

A late provider or Sandbox result is attached to the original terminated attempt
before cleanup; it cannot reopen media or seize an advanced live owner. Missing
provider identity after ambiguous creation remains unresolved. Likewise, a
missing Sandbox command is not evidence that creation settled: a lookup returning
404 while creation may still be in flight cannot authorize release. Definite
not-created evidence comes only from the actual one-shot create outcome or a
known not-invoked path. If that outcome is lost in a process crash, schema 047
cannot prove absence; retain UNKNOWN and its lease for a future explicitly
designed operational reconciliation path, never clear it on elapsed time.

Sandbox cleanup uses `get({ resume: false })` and a shared 10-second abort
deadline for lookup/stop. A lookup 404 is distinct from a stop-endpoint 404;
the latter remains ambiguous. A stop acknowledgement still reporting `stopping`
is not a stop receipt. Provider hangup remains bounded and requires a successful
provider response; no arbitrary provider 404 is accepted as proof of termination.

This checkpoint adds no scheduler, endpoint, migration, dependency, or enabled
runtime. Actual provider sideband execution, readiness, normal successful
transcript completion, participant transport, and attachment ordering remain
separate rollout gates. Local verification uses mocked external adapters and
isolated PostgreSQL CAS/rollback/concurrency tests, not live provider resources.

Reference contracts checked on 2026-09-05: [server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls),
[conversation lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations),
[transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
and [OpenAI's generated server-event types](https://github.com/openai/openai-node/blob/master/src/resources/realtime/realtime.ts).

## Risks

- Provider realtime event shapes and completion semantics may evolve; the sideband parser, event allowlist, response-status correlation, and provider-item ordering must remain versioned and tested.
- Vercel Sandbox duration, detached-process, egress-policy, or outbound-WebSocket behavior may differ by plan or change over time. Production enablement is blocked on the live Compass-plan spike; failure of that prerequisite requires a small managed container service rather than weakening the provider-authoritative boundary.
- A Sandbox or sideband connection can fail before all finalized events are persisted. Bounded retry, heartbeat reconciliation, explicit provider hangup, and a visible degraded-integrity state prevent such a gap from being mistaken for a complete canonical transcript.
- Per-call Sandbox wall-time cost grows with voice concurrency and must be observed during canary rollout.
- A target product can block both framing and automated login state; participants must use the external product window.
- Multimodal payload size and document processing require conservative limits and bounded model context.
- Database leases cannot depend on browser disconnect discipline; server deadlines and reconciliation must expire them safely and stop orphaned provider calls and Sandboxes.
