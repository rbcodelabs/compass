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

### Controlled feasibility probe checkpoint — 2026-09-07

The approved probe is deliberately separate from application behavior: scripts
under `scripts/research-voice`, no database, callback, schema, participant route,
flag change, or production write. Live execution still requires independent
review and explicit operator go-ahead; local verification is not live evidence.

The architect accepted exact development pins `undici@7.28.0` and
`esbuild@0.28.2`, already present transitively. Options considered were native
WebSocket (no supported authorization-header option), a new `ws` dependency
(additional transport), and bundled Undici (existing pinned implementation with
headers). The latter is packaged locally as a Node22 CommonJS artifact with only
Node built-ins external. No runtime package installation or additional Sandbox
egress is allowed. The complete artifact is loaded under Node22 before allocation.

One fixed exclusive journal claim is fsynced before any allocation at
`~/.geode/probes/compass-research-voice-feasibility-v1.jsonl`. Do not remove or reset
it to rerun: failure consumes the attempt, including ambiguous creation. The
actual SDK fetch dispatch is guarded because SDK2.9.2 retries otherwise; create
and detached-command POST each dispatch at most once, without redirects. Only
the original Sandbox Session is used, never auto-resume. Existing explicit
project/team CLI credentials are read in memory, without scope inference.

The absolute 120-second budget starts before provider allocation, reserves
30 seconds for cleanup, and permits one nonpersistent one-vCPU/two-GB Sandbox
with only `api.openai.com` egress. The provider model is explicitly
`gpt-realtime-2.1`, with automatic response creation disabled from allocation and
only one explicit response capped at 128 tokens. A conservative estimate of
$1.383 includes 120 seconds of audio input, 8192 text-input tokens, worst-case
audio/text output, separate transcription and Sandbox reserves, and a $1
contingency. It must remain below $5 before allocation. This is not an account
spend limit or a guaranteed invoice cap. Sources checked: [pricing](https://developers.openai.com/api/docs/pricing),
[Realtime token accounting](https://developers.openai.com/api/docs/guides/realtime-costs),
and [Sandbox pricing](https://vercel.com/docs/sandbox/pricing).

The browser holds its SDP answer until the authenticated sideband observes the
full configured policy for the matching session/nonce AND the sole assistant
greeting yields a genuine explicit-null provider root and a completed canonical
interviewer event. An empty parser or missing predecessor never proves root.
Only then does an audio-only headless peer play locally generated synthetic
speech (maximum 15 seconds, no microphone). A linked final participant transcript
must pass the existing parser; there is no second assistant response. Failure
dominates readiness/completion; final proof waits for the complete worker log
stream and its independent provider-stop receipt. A pre-media timeout means
initialization was **not demonstrated**, not that the provider cannot support it.

The worker has its own absolute deadline and bounded provider hangup in finally;
the controller independently hangs up and stops the Sandbox. Numeric HTTP status
and redacted hashes/order metadata are recorded, never SDP, tokens, raw audio,
full provider errors, tracing, HAR, or video. Known identities are retained before
body reads/journal failures, and cleanup passes are bounded and independent.
Arbitrary 404 is not stop proof. Missing identity after ambiguous creation, late
results beyond the cleanup reserve, or failed browser closure remain unresolved
and require operator investigation using the journal; no automatic new allocation
or inferred absence is permitted.

Local-only entry point (macOS offline `say`/`afconvert`, Node22):
`fnm exec --using=v22.23.2 node scripts/research-voice/run.mjs --check`.
This packages/loads the worker and prepares real Chromium audio SDP without
credentials, a journal claim, or live resources. The explicit browser regression
gate is `RUN_RESEARCH_VOICE_PROBE_BROWSER=1 pnpm vitest run __tests__/research-voice-probe-browser.test.ts`;
it additionally connects two local peers, plays the fixture through source-ended,
and rejects repeat SDP release. Default unit CI does not claim that opt-in browser
coverage. The separate `--live-approved` mode is reserved for the reviewed operator
invocation. Temporary generated speech/bundles are removed by the wrapper.

Even a successful probe does not demonstrate that the participant heard the
pre-media greeting, Function-return survival, durable READY, 40-minute sessions,
normal completion, attachment ordering, or production readiness. These remain
separate rollout gates; authoritative participant voice stays disabled.

#### Single approved live attempt — observed outcome

On 2026-09-07 at 16:51:50 UTC, the reviewed probe consumed its one attempt
(`c344d6b2-602c-4942-8ba2-fc0e0a46a8fc`). Provider allocation returned HTTP201;
the nonpersistent Sandbox and detached worker started. The worker then failed
closed with `POLICY_MISMATCH` during `PREMEDIA_INITIALIZATION`. Total elapsed
time through cleanup was 8,540 ms. No successful policy/root acknowledgement,
canonical exchange, browser SDP release, participant audio, or assistant response
was observed. This is **not demonstrated**, not a successful feasibility result
and not evidence that pre-media initialization is impossible.

The redacted journal did not capture the mismatched field or source event kind.
The current comparator checks both session policy and session identity; therefore
the exact mismatch cannot be determined from retained evidence. No policy field
was relaxed and no guessed fix was applied. Any future diagnostic improvement or
new live attempt requires separate approval; the existing claim must never be
deleted/reset to enable a retry.

Cleanup evidence was positive for all three resources: the worker recorded a
successful provider hangup, the controller recorded provider/Sandbox/browser
stopped, and the operator independently inspected the original Sandbox with
`resume:false`, confirming `status:stopped` and `persistent:false`. This verifies
cleanup for this attempt, not every possible crash or ambiguous-creation path.

Audit identifiers (not credentials): provider
`rtc_u2_ELWrPal4wad2DQIaMMwQZ`; Sandbox
`compass-voice-probe-c344d6b2-602c-4942-8ba2-fc0e0a46a8fc`; command
`cmd_fe511d5e7bee4b618aa5c6b254df`; packaged worker SHA256
`1c103f4432c6aca9126cf315841bf56ee6bbd15ecaf6abd7567d20eb8df6721b`.
The durable local journal remains at the fixed claim path above. The $1.383
preflight figure is an estimate, not measured billed cost. No application,
database, production flag, or participant runtime was changed by the probe.

#### Separately authorized v2 diagnostic attempt — observed outcome

After reviewing that inconclusive failure, the user explicitly authorized safe
field-level diagnostics and **one additional** controlled live attempt. The
current `--live-approved` entry point therefore claims only
`~/.geode/probes/compass-research-voice-feasibility-v2.jsonl` with exclusive creation.
There is no attempt-number/path override or reset mechanism. The consumed v1
journal, its worker hash, and the observed v1 outcome above remain unchanged.
The v2 claim is now also consumed; neither claim may be reset or deleted, and no
further live attempt is authorized.

The policy comparator, configured policy, pre-media root requirements, deadlines,
allocation limits, and conservative sub-$5 preflight ceiling are unchanged.
Diagnostics run only on a rejected policy/session identity and cannot acknowledge
readiness. They use a fixed schema-owned path allowlist and only `missing`,
`type`, or `value` mismatch kinds. Known harmless enums, bounded numeric limits,
and boolean flags can be compared directly; unknown strings become `REDACTED`.
Tools emit counts only. Instructions and session identifiers emit equality/type
information, never their text. Provider-owned extra keys are not traversed or
logged. Diagnostic records are validated again when the controller persists the
worker's bounded stdout stream; no raw provider payload/error, audio, SDP, or
credentials enter the journal. The existing 64-KiB log and 128-record journal
bounds remain in force.

Local regression coverage includes strict failure on each diagnosed mismatch,
nested voice/automatic-response fields, redaction and forged journal records,
split worker stdout through the real controller collector into a temporary
journal, and distinct non-reusable v1/v2 claims. This diagnostic change is not a
policy fix or a successful live proof. Voice remains disabled and PR167 remains
unmerged pending the separately controlled review workflow.

The operator executed the sole v2 attempt on 2026-09-07 at 17:30:10 UTC using
reviewed commit `ed18d69a6bde142fa42f0aea56db5c9687c1a3d3`, run
`8b1df5ae-2868-47c2-a4e8-8fe1bd8ca87f`. Provider allocation returned HTTP201 and
the Sandbox/worker started. The only field diagnostic was
`session.updated` → `session.id`, mismatch `value`, `equal:false`; the probe
failed closed with `POLICY_MISMATCH` during `PREMEDIA_INITIALIZATION`. Total
elapsed time through cleanup was 8,949 ms. No policy/root acknowledgement,
canonical exchange, browser SDP release, participant audio, or assistant response
was observed. The worker reported provider stop success, the controller reported
provider/Sandbox/browser stopped, and the operator independently inspected the
exact Sandbox with `resume:false`, confirming stopped and nonpersistent.

This evidence does **not** establish that the provider changed session IDs.
The same diagnostic occurs if `session.updated` arrives before a matching
`session.created` has established the parser's local identity (still `null`),
or if a prior identity exists and differs. Its `expectedType:string` describes
the required identity contract, not the observed type of that local baseline.
The journal did not retain event history or baseline-presence evidence, so those
cases cannot be distinguished. This is another inconclusive pre-media result,
not provider infeasibility or a demonstrated voice exchange. No implementation
or acceptance rule was changed in response.

V2 audit identifiers: provider `rtc_u1_ELXSVVRcKvp3AEXYGGIZ6`; Sandbox
`compass-voice-probe-8b1df5ae-2868-47c2-a4e8-8fe1bd8ca87f`; command
`cmd_c7fe3a72eb3e435cae0cc5a01d35`; worker SHA256
`79e526c35520f89ea32cb13d94a16b4918ee3b4a6161297dcf7a3d6cdcf40400`.
The unchanged $1.383 preflight estimate is not measured billed cost.

The next investigation should remain offline/read-only: compare fixtures for
update-before-created versus a genuinely different known identity, and verify
the documented sideband-attachment initialization contract before proposing any
handshake change. If separately approved later, safe diagnostics could include
`createdObserved`/`identityBaselinePresent` booleans and bounded event-kind
sequence counters, never session identifiers. Do not infer or accept an identity
merely to pass the current gate; any contract adjustment needs evidence and review.

- Provider realtime event shapes and completion semantics may evolve; the sideband parser, event allowlist, response-status correlation, and provider-item ordering must remain versioned and tested.
- Vercel Sandbox duration, detached-process, egress-policy, or outbound-WebSocket behavior may differ by plan or change over time. Production enablement is blocked on the live Compass-plan spike; failure of that prerequisite requires a small managed container service rather than weakening the provider-authoritative boundary.
- A Sandbox or sideband connection can fail before all finalized events are persisted. Bounded retry, heartbeat reconciliation, explicit provider hangup, and a visible degraded-integrity state prevent such a gap from being mistaken for a complete canonical transcript.
- Per-call Sandbox wall-time cost grows with voice concurrency and must be observed during canary rollout.
- A target product can block both framing and automated login state; participants must use the external product window.
- Multimodal payload size and document processing require conservative limits and bounded model context.
- Database leases cannot depend on browser disconnect discipline; server deadlines and reconciliation must expire them safely and stop orphaned provider calls and Sandboxes.
