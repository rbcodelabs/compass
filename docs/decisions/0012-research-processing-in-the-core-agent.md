# ADR-0012: Research Processing in the Core Agent

**Date:** 2026-09-12
**Status:** Accepted
**Approval source:** Rick, synchronous instruction, 2026-09-12 — directed that the
handoff machinery be generalized rather than duplicated, that guide generation stay
as it is for now, that this decision be recorded as an ADR before any implementation
PR, and that Helio final retirement be queued as an explicit downstream gate.

## Context

ADR-0002 made Compass the sole system of record for research capture and defined a
staged retirement of Helio. Capture parity is now delivered: canonical ordered turns,
resumable sessions, participant tokens, private attachments, guided usability, and
Realtime voice are all merged and in production.

Invariant 6 of ADR-0002 — *"Syntheses are versioned. Findings and promoted Evidence
cite exact source turns or attachments, and promotion always requires human review"* —
is the one that was never delivered. Two things are wrong today.

**First, synthesis runs as a second, parallel LLM pipeline.** Clicking "Generate
synthesis" (`components/research/analysis-button.tsx`) posts to
`app/api/research/analysis/route.ts`, which calls `generateStudySynthesis()` in
`lib/research-analysis-service.ts`, which calls `runResearchAnalysisAgent()` in
`lib/research-analysis-agent.ts`. That runs `query()` inside its own isolated Sandbox
via `scripts/agent/research-analysis-entry.ts` with `tools: []`, no MCP connection, a
hand-rolled prompt in `lib/research-analysis.ts`, and its own zod output contract. It
never creates an `AgentConversation` and never reaches the core agent. Compass
therefore maintains two separate research-analysis reasoning stacks, and the better
one — the core agent, which can read the rest of the workspace and act through gated
tools — cannot see research at all.

This duplication is now plainly redundant. The curated "Agentic PM for Compass"
capability pack (`lib/capability-pack-curated.ts` → `rbcodelabs/agent-pm-playbook`,
`packs/compass`) already ships `pm-signal-synthesis` as an enabled-by-default skill,
compiled into the core agent's system prompt under ADR-0008. Its clustering,
confidence-tagging, contradiction-detection, and bias-detection rules are a superset
of what the bespoke prompt in `lib/research-analysis.ts` encodes — and unlike that
prompt, they are versioned, auditable, and updatable without a Compass deploy. The
methodology is already in the agent's context for any workspace that installed the
pack. What is missing is the agent's ability to *reach the transcripts* and *write
back a linked result*.

**Second, there is no research-to-Evidence bridge at all.** The `Evidence` model
carries `opportunityId`, `solutionId`, `assumptionId`, a free-text `sourceType`, and a
free-text `sourceUrl` — and nothing else. There is no `researchSynthesisId`, no
session reference, no turn reference, and no join table. Promoting a synthesis finding
into Evidence today means a human reading the synthesis and re-typing a URL into
`add_evidence` by hand. The provenance chain ADR-0002 was written to create does not
exist in the schema, so it could not be recorded even if the UI offered the action.

Separately, open PR #190 (ADR-0011) established a *handoff* pattern for a different
domain: completing a PM interview creates exactly one linked `AgentConversation`
carrying a claim/deadline processing state, mints an MCP credential scoped to that
conversation and claim, injects a fixed instruction, gates every tool call, and writes
an immutable receipt atomically with the mutation. That pattern is the right shape for
research processing too, and it should be reused rather than re-invented.

## Constraints

- Do not modify transcript capture. `ResearchStudy`, `ResearchSession`,
  `ResearchTurn`, `ResearchVoiceEvent`, `ResearchRequest`, `ResearchAttachment`, the
  voice control plane, and participant-token issuance/rotation/revocation are out of
  scope and must be behaviour-identical afterwards.
- Preserve existing public participant behaviour and Capture URLs.
- Promotion into discovery state requires human review (ADR-0002 invariant 6). An
  unattended agent turn must not be able to create Evidence on its own authority.
- Findings and promoted Evidence must cite exact saved `ResearchTurn` rows, not a
  pasted URL.
- Aurora DSQL: no foreign keys, no triggers, explicit `updatedAt`, one DDL per
  transaction, new indexes asynchronous, additive changes only.
- Re-running a synthesis or re-promoting a finding must converge, not duplicate.
- The existing `ResearchSynthesis` lease (`kind` of `PENDING` → `CROSS_SESSION` |
  `FAILED`) already provides retry-safe generation and must be preserved, not replaced.
- Generalizing the handoff machinery must not change PM-interview behaviour.

## Non-goals

- Changing guide generation. `generate_research_guide` → `lib/research-study-service.ts`
  → `runResearchInterviewAgent()` (`lib/research-agent.ts`) remains a standalone
  tool-free generation. It is a single bounded call with no permission complexity, no
  evidence linkage, and no orchestration need; folding it in would add churn without
  addressing either problem above. Revisit only if it needs workspace context.
- Automatic promotion of findings into opportunities, solutions, or assumptions.
- A participant-facing or public research-processing surface.
- Renaming the `interview_processing_json` column (see Decision — it is reused as-is).
- Retiring Helio. That remains a separate gate (see Downstream gates).

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Keep the standalone pipeline; bolt an "export to Evidence" button onto it | Smallest diff; no agent involvement | Preserves two reasoning stacks and two prompts forever; the agent still cannot see research; duplicates `pm-signal-synthesis` methodology in bespoke code that only changes by deploy |
| **Expose research as gated MCP tools, hand off through the generalized core-agent pattern, and promote Evidence in a normal user-directed turn** | One reasoning stack; methodology lives in versioned skill packs; reuses a reviewed handoff pattern; human review falls out of the authority model rather than needing a bespoke approval UI | Requires generalizing #190's machinery and an additive provenance schema; depends on #190 landing |
| Give the agent research tools but keep "Generate synthesis" as a direct pipeline | Incremental | Two entry points producing different results from the same transcripts; the inconsistency is worse than either pure option |
| Build a bespoke second handoff implementation for research | No dependency on #190 | A second copy of claim/deadline/receipt/scope logic that will drift from the first; explicitly rejected |

## Decision

Research processing becomes a core-agent capability reached through gated MCP tools
and the generalized handoff pattern. The standalone synthesis pipeline is retired.

### Generalized handoff, not a second copy

The claim/deadline lifecycle introduced by ADR-0011 is already domain-agnostic:
`processingStatus()`, `parseProcessingState()`, `claimInterviewProcessing()`,
`finishInterviewProcessing()`, and `failPendingInterviewProcessing()` operate purely
over a conversation's processing blob and never read `PMInterview`. The PM coupling is
confined to target resolution (`scopedInterview()`), the allowlist
(`assertInterviewToolInput()`, `PM_INTERVIEW_ALLOWED_FIELDS`), the receipt diff
(`withInterviewMutation()`), and a single `turnMessage` template literal in
`app/api/agent/turn/route.ts`.

We therefore add a `kind` discriminator to the processing state
(`PM_INTERVIEW` | `RESEARCH_SYNTHESIS`; absence means `PM_INTERVIEW`) and replace the
hardcoded instruction and tool-gate leaves with a per-kind policy lookup of the form
`{ instruction(state), assertToolInput(state, tool, args), failureMessage }`.

**This requires no migration.** `interview_processing_json` is a nullable, unindexed
`TEXT` column; `parseProcessingState()` is a cast rather than a strict schema, so an
added field passes through; and the `ApiKey` scope columns (`scope_conversation_id`,
`scope_claim_id`) are already domain-neutral. The column keeps its current name — a
rename would cost a DSQL DDL migration for cosmetic benefit. Its reuse by a second
domain is documented at the type instead.

Because the generalization is a pure refactor with no schema forcing function, it
lands as its own no-behaviour-change PR **after** #190 merges, with #190's existing
PM-handoff tests left green and unmodified as the correctness argument. Generalizing
inside #190 would ask reviewers to evaluate an abstraction against a second consumer
not present in a 115-file diff.

### Authority boundary: generate under a claim, promote under the user

ADR-0011 deliberately let Finish authorize an immediate write, because a PM editing
their own item is the PM's own judgement. Research is different: a synthesis is a
model's reading of other people's words, and ADR-0002 requires human review before it
becomes Evidence. The two phases therefore carry different authority.

**Phase 1 — scoped.** The claimed turn may read the study and its sessions and may
generate a synthesis. It may write its own research artifact — the `ResearchSynthesis`
row, which is already leased and idempotent — because that is a record of analysis,
not a discovery claim. It must not write **discovery state**: no Evidence, opportunity,
solution, assumption, experiment, feedback, or roadmap mutation. The scoped gate for
this kind has an allowed-read set and no write branch, which is strictly less machinery
than the PM kind's target-bound field allowlist. Terminal success needs no product
mutation: `finishInterviewProcessing()` already records `SUCCEEDED` independently, and
the durable artifact is the `ResearchSynthesis` row plus the persisted assistant message.

**Phase 2 — unscoped.** Promotion happens when the researcher continues the
conversation as themselves. That turn carries the user's ordinary credential and
ordinary permissions, so `promote_research_finding_to_evidence` is subject to the same
authorization as any other mutation the user could perform. Human review is thereby a
property of the authority model rather than a bespoke approval screen, and ADR-0002
invariant 6 is satisfied without building one.

### Provenance schema (additive, DSQL-safe)

- `Evidence.researchSynthesisId` — nullable; records the synthesis that proposed this
  evidence.
- `EvidenceResearchSource` — `evidenceId`, `researchTurnId`, optional
  `researchAttachmentId`; records the exact underlying sources. A separate table rather
  than a column because one finding legitimately cites several quotes across sessions.
- `Evidence.findingKey` — nullable; a deterministic hash of synthesis id plus the
  finding's stable identifier, with a unique constraint scoped to the workspace, so
  re-promoting the same finding converges instead of duplicating.
- Synthesis JSON must give every finding and quote a stable identifier and a source-turn
  reference. The existing verbatim-substring grounding check in
  `parseAnalysisResult()` is retained and becomes the guarantee that
  `EvidenceResearchSource` rows can always be resolved.

No `ResearchFinding` table is introduced. Findings live inside the versioned synthesis
document until promoted. A normalized model is warranted only if findings later need
their own lifecycle, ownership, or commenting — recorded as a revisit trigger.

### Tool surface

New, all workspace-member gated in `lib/mcp-tool-gates.ts` alongside the existing
default-deny research list:

- `list_research_sessions`, `get_research_session` — new reads. Must apply the same
  participant-identity discipline as `get_research_study`.
- `generate_research_synthesis` — wraps the existing `generateStudySynthesis()`,
  preserving its lease, zod contract, and quote grounding. Replaces the sandboxed
  `runResearchAnalysisAgent()` path.
- `list_research_syntheses` — reads the existing versioned history.
- `promote_research_finding_to_evidence` — writes `Evidence` plus
  `EvidenceResearchSource` in one transaction, reusing the payload-hash replay
  behaviour of `withInterviewMutation()` so retries are idempotent. Unscoped turns only.

### Retired surfaces

Once parity is verified: `lib/research-analysis-agent.ts`,
`scripts/agent/research-analysis-entry.ts`, and the synthesis dispatch in
`app/api/research/analysis/route.ts`. `lib/research-analysis.ts` is retained for its
prompt-assembly and validation logic, which the MCP tool continues to use.
"Generate synthesis" navigates into the linked conversation, matching PM Gather's
completion behaviour; the synthesis history view in `components/research/analysis-results.tsx`
remains as a read surface.

## Delivery sequence

1. **(External dependency)** PR #190 merges. It is currently draft and conflicting.
2. Generalize the handoff machinery — `kind` discriminator and per-kind policy lookup.
   No behaviour change; #190's tests unmodified and green.
3. Research read tools: `list_research_sessions`, `get_research_session`.
4. `generate_research_synthesis` plus the `RESEARCH_SYNTHESIS` handoff kind and its
   read-only gate; "Generate synthesis" becomes an entry point into the conversation.
5. Provenance migration and `promote_research_finding_to_evidence`.
6. Retire the standalone pipeline files after parity verification.

Each step is independently deployable and reversible. Migration numbering continues
after #190's `051_pm_agent_handoff`; the repository already contains duplicate
migration numbers and further duplicates should be avoided.

## Consequences

Compass gains one research reasoning stack instead of two, and the research-to-decision
provenance chain ADR-0002 specified becomes real and queryable. Synthesis methodology
becomes updatable by shipping a new capability-pack version rather than by deploying
Compass. The agent can relate research to the rest of the workspace, which the isolated
pipeline could never do.

The costs are a hard dependency on #190, a larger per-turn context (pack instructions
are eagerly compiled under ADR-0008), and a synthesis latency profile that now includes
agent turn overhead rather than a single bounded call. Workspaces without the curated
pack installed will get materially weaker synthesis than the bespoke prompt gave them —
that regression must be measured at step 4 and is a revisit trigger.

## Risks

- **#190 stalls.** It is draft and conflicting; everything here is blocked behind it.
  If research work must start first, the generalization order inverts and the
  abstraction should then be designed against both consumers at once.
- **Prompt injection through transcripts.** Participant text is now read by an agent
  holding a workspace-scoped MCP credential, which the tool-free pipeline never was.
  The scoped phase's no-discovery-write boundary is the primary control and must be
  tested adversarially, not assumed.
- **Quality regression** for workspaces without the pack, as above.
- **Provenance rot.** `EvidenceResearchSource` rows reference turns without database
  foreign keys; deletion behaviour is an application responsibility.
- **Gate ordering.** `gateInterviewTool` currently runs before the service-actor early
  return in `applyToolGate`; adding a kind means service credentials traverse the new
  branch. Verify deliberately.

## Verification

- Cross-workspace denial for every new tool and for promotion.
- Scoped-phase negative tests: every discovery mutation tool rejected under a
  `RESEARCH_SYNTHESIS` claim, including via aliasing and unexpected arguments.
- Adversarial transcript injection attempting to induce a discovery write or
  cross-study read during the scoped phase.
- Idempotency: duplicate "Generate synthesis" clicks and reloads converge on one
  conversation and one synthesis; duplicate promotion of one finding converges on one
  `Evidence` row.
- PM-interview behaviour unchanged after generalization — #190's tests green, unmodified.
- Every promoted `Evidence` row resolves to real `ResearchTurn` rows whose text
  contains the cited verbatim.
- Parity comparison of agent-produced synthesis against the retired pipeline on the
  same study before deleting it, with and without the curated pack installed.
- Participant routes, Capture URLs, voice, and attachments unchanged.

## Downstream gates

Shipping this closes the last product gap ADR-0002 identified — the research-to-insight
bridge. It does **not** authorize Helio retirement. Once step 6 is verified in
production, a separate decision covers the final Helio data and traffic delta, the
redirect-only observation window, removal of active compute and secrets, and repository
archival. That decision is raised at ship time and is not granted by this ADR.

## Revisit Triggers

- Findings need their own lifecycle, ownership, or commenting before promotion —
  introduce `ResearchFinding`.
- Synthesis quality without the curated pack proves unacceptable.
- Agent turn latency makes synthesis feel worse than the bounded pipeline did.
- A third handoff domain appears, indicating the per-kind policy lookup should become
  a registry rather than a table.
- Guide generation needs workspace context, bringing it into scope after all.
