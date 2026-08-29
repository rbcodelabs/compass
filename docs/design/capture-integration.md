# Compass Capture Integration

Status: accepted direction; implementation plan
Date: 2026-08-29

## Decision

Compass is the product. The separate Helio product and name will be retired.
Its useful capabilities become part of Compass's expanding system for collecting
feedback, ideas, observations, and research.

The product loop is:

> Capture → Organize → Understand → Act

"Capture" is a product surface and a shared entry point. It is not a single
database record that erases the differences between a short idea, an uploaded
artifact, and a multi-session research study.

## Why this direction fits the products

Compass already owns the downstream decision system:

- `FeedbackItem` collects ideas and bugs from internal users and the customer
  portal.
- `Evidence` connects source material to opportunities, solutions, and
  assumptions.
- Opportunities, solutions, assumptions, and experiments organize discovery.
- Roadmap items, tasks, docs, and OKRs turn understanding into action.

The separate application contributes a focused set of upstream capture tools:

- AI-generated discussion guides and usability tasks
- Shareable participant links
- Chat and voice interviews
- Guided usability sessions against a live product
- Transcripts, attachments, audio, and per-session summaries
- Cross-session themes, quotes, jobs-to-be-done, and recommendations

The product boundary between those tools and Compass is artificial. The
interview output is most valuable when it becomes traceable evidence inside
Compass rather than a report that must be exported and re-entered elsewhere.

## Target experience

The existing **Feedback** area evolves into **Capture**.

### Capture navigation

1. **Inbox** — direct ideas, bugs, requests, notes, imported messages, and other
   discrete submissions awaiting triage.
2. **Studies** — customer interviews and guided usability studies, including
   their participant links, sessions, transcripts, and synthesis.
3. **Sources** — a later extension for connected channels such as support,
   email, Slack, analytics, and file imports. This does not block the first
   integration.

The public customer portal continues to use customer-friendly labels such as
"Feedback". Renaming the internal product surface does not require exposing
the abstract term "Capture" to customers.

### End-to-end flow

1. A team member adds an idea or creates a research study in Capture.
2. Compass gathers one or more raw inputs: a submission, transcript, audio
   recording, attachment, or imported message.
3. Compass summarizes and clusters those inputs while retaining links back to
   the source material.
4. The user reviews proposed evidence and opportunity links. AI suggestions do
   not silently create or modify discovery objects.
5. Accepted evidence strengthens or challenges an opportunity, solution, or
   assumption.
6. The existing discovery, experiment, roadmap, task, and OKR workflows carry
   the decision forward.

## Domain model

Do not rename or generalize `FeedbackItem` in the first migration. It already
has working portal, voting, attachment, roadmap, MCP, and opportunity-linking
behavior. A broad rename would create risk without helping the interview
integration.

Add workspace-scoped research models alongside it. Suggested names:

### `ResearchStudy`

The Compass replacement for the separate app's `Project`.

- `workspaceId`
- `name`
- `goal`
- `studyType`: `CUSTOMER_INTERVIEW | USABILITY_TEST`
- `guide` JSON (versioned snapshot of ordered prompts/tasks)
- `targetMinutes`
- `appUrl` for usability studies
- `shareTokenHash` and optional expiry/revocation fields
- `status`: `DRAFT | ACTIVE | CLOSED | ARCHIVED`
- standard Compass audit fields: `createdById`, `updatedById`, `source`,
  `createdAt`, `updatedAt`

The participant-facing token should not be stored as plaintext. This should
follow Compass's existing portal-token pattern rather than porting the separate
application's plaintext `magicToken` design.

### `ResearchSession`

The replacement for `Interview`.

- `studyId`
- optional participant identity fields, with an anonymous path
- `modality`: `CHAT | VOICE`
- `status`: `PENDING | IN_PROGRESS | COMPLETED | ABANDONED`
- `summary`
- `audioUrl`
- `startedAt`, `completedAt`, `createdAt`, `updatedAt`

### `ResearchTurn`

The replacement for `TranscriptTurn`.

- `sessionId`
- `role`: `INTERVIEWER | PARTICIPANT`
- `content`
- attachment metadata or a relation to a dedicated attachment record
- `sequence`
- `createdAt`

Attachment data should not remain JSON encoded inside `content`; preserve text
and attachment provenance separately.

### `ResearchSynthesis`

The replacement for `Synthesis`.

- `studyId`
- `kind`: initially `CROSS_SESSION`; leave room for future focused syntheses
- structured `content` JSON
- `sessionCount`
- `model` and `promptVersion` for reproducibility
- `createdAt`, `updatedAt`

Syntheses are snapshots, not a single mutable truth. Re-running synthesis
creates a new version and leaves prior output inspectable.

### Evidence provenance

Extend `Evidence` with nullable source relations where useful:

- `feedbackItemId`
- `researchSessionId`
- optionally `researchSynthesisId` when evidence was proposed by a synthesis

An evidence excerpt should link to the exact originating session/submission.
The synthesis is how an excerpt was found; the transcript or feedback item is
the underlying source. Keep `sourceType` for filtering and backward
compatibility, but prefer relations over relying on `sourceUrl` alone.

## Capability mapping

| Separate capability | Compass destination | Treatment |
| --- | --- | --- |
| Project creation wizard | Capture → Studies → New study | Adapt to workspace scope and Compass UI |
| AI guide builder | Study setup | Port prompt logic; remove product-name coupling |
| Customer discovery mode | `CUSTOMER_INTERVIEW` study | Port |
| Guided UX mode | `USABILITY_TEST` study | Port |
| Shareable `/i/[token]` link | Compass participant study route | Rebuild using hashed, revocable tokens |
| Chat interviewer | Participant study experience | Port and re-theme |
| Voice interviewer | Participant study experience | Port after chat path is stable |
| File/image upload | Research-turn attachment | Reuse Compass Blob conventions where possible |
| Per-interview summary | Research session detail | Port as background/failure-tolerant processing |
| Cross-interview synthesis | Study synthesis | Port with version metadata and review step |
| Themes and quotes | Suggested evidence and grouped findings | Link every claim to source sessions |
| JTBD and recommendations | Synthesis output | Keep as findings, not new top-level Compass entities |
| Existing Feedback board | Capture → Inbox | Preserve behavior; rename internal navigation |
| Feedback → Opportunity link | Inbox triage | Preserve |
| Manual Evidence entry | Discovery evidence | Preserve and add Capture-origin provenance |
| Separate auth, API keys, DB, landing page | None | Do not port |
| Separate product name and positioning | None | Retire |

## Architecture boundaries

### Reuse from Compass

- Organization/workspace tenancy and permissions
- Auth and workspace membership
- Database connection and migration conventions
- Portal branding and participant-safe layouts
- Vercel Blob integration patterns
- Evidence, discovery, roadmap, tasks, docs, and MCP tools
- UI primitives and navigation

### Port selectively

- Interview and usability-test prompt builders
- Guide generation
- Chat streaming behavior
- Realtime voice-session behavior
- Pacing logic
- Completion and summarization logic
- Cross-session synthesis schema and prompts
- Participant UI interactions that have already been tested

Port these as domain modules with thin routes. Do not copy route handlers
unchanged: the current handlers trust public identifiers too broadly, are not
workspace-aware, and mix prompting, authorization, persistence, and transport.

### Do not carry forward

- Separate authentication or user/project ownership
- Separate API-key management
- Separate marketing or dashboard shell
- Plaintext long-lived participant tokens
- The generic `Project` name
- `Helio` in UI copy or system prompts
- Automatic synthesis as an unreviewed write into Compass discovery objects

## Migration sequence

### Phase 1 — Foundation and first vertical slice

1. Rename the internal Feedback navigation item and page heading to Capture.
2. Keep the existing route working and add a canonical Capture route or a
   compatibility redirect; avoid breaking saved links and tests.
3. Add the four workspace-scoped research models and migrations.
4. Add a Studies tab and study list/create flow inside Capture.
5. Port guide generation for chat-based customer interview studies.
6. Add hashed, revocable participant links and a branded Compass participant
   route.

**Exit condition:** a workspace member can create a chat study, share a link,
and receive a completed transcript in Compass.

### Phase 2 — Synthesis into understanding

1. Add per-session summary and cross-session synthesis.
2. Store synthesis versions with model/prompt metadata.
3. Show source-linked quotes and findings.
4. Let users promote selected findings into `Evidence` and link them to an
   opportunity, solution, or assumption.
5. Add tests proving workspace isolation and participant-token scoping.

**Exit condition:** interview results can become reviewed, traceable Compass
evidence without copy/paste.

### Phase 3 — Richer capture

1. Port voice interviews and their audio lifecycle.
2. Port guided usability studies and screenshot/file attachments.
3. Add abandonment, expiration, revocation, and rate-limit controls.
4. Add inbox ingestion paths only when a concrete source is selected.

**Exit condition:** all valuable separate-product capture modes operate inside
Compass with production-grade controls.

### Phase 4 — Consolidation and retirement

1. Inventory any real production projects, interviews, blobs, and syntheses.
2. Migrate retained data into workspace-scoped Compass records with a migration
   manifest and count checks.
3. Redirect active participant links where safe, or explicitly expire them.
4. Remove the separate deployment only after data and link verification.
5. Archive the repository as historical source; do not delete it during the
   migration.

The separate product notes describe it as pre-launch with no real users as of
2026-06-23. That suggests a code transplant may be sufficient, but production
data must still be checked before treating migration as unnecessary.

## First implementation slice

Start with **chat-based customer interviews inside a workspace**.

It exercises the full product thesis with the least infrastructure:

- Capture surface and study creation
- workspace tenancy
- participant link security
- guided conversation
- transcript persistence
- a visible bridge from raw research to Compass evidence

Voice, live-product embedding, cross-session synthesis, and automated finding
promotion can layer on after this path is stable. The first slice should still
use the final model names and route boundaries so it is not disposable work.

## Non-negotiable acceptance criteria

- Every study belongs to exactly one Compass workspace.
- Workspace permissions apply to all researcher-facing study data.
- Participant tokens are hashed, revocable, expirable, and scoped to one study.
- Public routes reveal no unrelated workspace or participant data.
- Raw transcripts and attachments remain available as provenance.
- Every promoted evidence item identifies its underlying source.
- AI-created opportunity/evidence suggestions require human review.
- Existing feedback portal, feedback voting, roadmap links, and saved feedback
  URLs continue to work through the transition.
- No user-facing or prompt copy refers to the retired product name.

## Product language

Use these terms consistently:

- **Capture** — the Compass capability and internal navigation area
- **Inbox** — discrete submissions awaiting triage
- **Study** — a planned set of interviews or usability sessions
- **Session** — one participant interaction
- **Finding** — a synthesized observation that has not yet been accepted as
  Compass evidence
- **Evidence** — a reviewed, source-linked excerpt used in discovery

Avoid using "project" for studies; Compass workspaces already provide the
project/product context.
