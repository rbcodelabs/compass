# Guided/chat participant parity implementation

Approved scope: the guided/chat portion of full Helio participant parity. This
slice is not completion of voice, authoring, synthesis, or MCP parity.

## Implementation contract

1. Show the restrictive product frame and external fallback for usability studies
   independently of voice availability; never enable the legacy voice harness.
2. Support multiline answers, image/PDF-only answers, drag/drop, pending previews,
   and saved previews retrieved through participant-authorized private delivery.
   Persist only attachment IDs/metadata in public turns, never storage paths.
3. Stream provisional interviewer text from the existing tool-free runtime. A
   separate committed-final event is the only authoritative reply. Preserve
   request idempotency, retry/reload behavior, and canonical server-owned context.
4. Complete the missing neutral task-facilitation prompt criteria without adding
   tools or trusting participant-provided instructions.

## Verification plan

Write and observe failing component/service/transport regressions first. Cover
production-shaped voice-off guided rendering, attachment-only authorization and
replay conflicts, private preview cleanup, partial-stream failure, committed
reply/replay, and final-save failure. Run focused and full unit suites, types,
lint, build and UI guards. Exercise the changed participant journey against an
owned isolated local database, with no paid model calls, and inspect desktop and
mobile screenshots. Independent review follows a frozen diff. No production
flags, migrations, cloud resources, push or merge are authorized in this slice.

## Deliberate boundaries

An unconfirmed chat request is retained in this browser's local storage with its
session binding and original idempotency key, then removed after confirmation or
completion. Provisional interviewer text is never retained there or promoted to
the canonical transcript. Loss of the streaming consumer must not cancel the
server's final save; the functional regression observes that save through resume
before issuing a replay request.
The same already-started save promise is registered with Next `after`, extending
the serverless invocation through display disconnect within the existing
300-second route limit. This is not durability across process crash or platform
timeout; such interruption retains the existing safe retry contract.
This follows the [Next `after` lifetime contract](https://nextjs.org/docs/app/api-reference/functions/after),
verified against the installed Next 16.2.6 implementation before integration.

This slice preserves signature-validated PNG, JPEG, WebP and PDF support. Helio's
broader image picker and GIF/HEIC renderer do not establish that those formats
are decodable or model-readable. GIF/HEIC compatibility remains a separate
adaptation requiring signature validation and an honest fallback or validated
conversion path. No attachment format parity beyond the documented formats is
claimed here.
