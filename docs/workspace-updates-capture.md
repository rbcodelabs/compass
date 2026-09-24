# Workspace Updates capture coverage

Capture starts only after `WORKSPACE_UPDATES_ENABLED=1` and the registered
Updates tables are available. No historical transitions are reconstructed.
All integrations below are explicit call sites, not a database interceptor.
The adapter reads before-state, writes the record, and writes metadata-only
events in the same transaction. Existing compound transactions append directly.

| Family | UI entry points | MCP entry points | Captured events |
| --- | --- | --- | --- |
| Tasks | `tasks/actions.ts`: addTask, addLinkedTask, moveTaskStatus, cancelTask; inline `entity-mutations.ts`; `decision-followthrough.ts` | `task-tool-handlers.ts`: createTask, moveTaskStatus | Creation; actual status changes; direct parent task grouping |
| Opportunity | `discovery/actions.ts`: createOpportunity, updateOpportunityStatus, archiveOpportunity, moveOpportunity; inline entity edits | `api/mcp/route.ts`: create_opportunity, update_opportunity_status | Creation and actual status changes |
| Solution | `discovery/actions.ts`: addSolution, updateSolutionStatus, archiveSolution, moveSolutionStatus; inline entity edits | `api/mcp/route.ts`: add_solution; `solution-status-tool-handlers.ts` | Creation and actual status changes |
| Assumption | `discovery/actions.ts`: addAssumption, updateAssumptionStatus; inline entity edits; experiment conclusion side effect | `api/mcp/route.ts`: add_assumption, experiment conclusion; `assumption-tool-handlers.ts`: updateAssumption status path | Creation and actual status changes |
| Roadmap | `roadmap/actions.ts`: addRoadmapItem, updateRoadmapItem, editRoadmapItem, moveItem, archiveItem, promoteToRoadmap, promoteFeedbackToRoadmap, rescheduleRoadmapItem; inline entity edits; `launch-checklist.ts` | `api/mcp/route.ts`: creation, promotion, update; `feedback-tool-handlers.ts` promotion; `roadmap-tool-handlers.ts` launch tier | Creation, actual stored status and horizon transitions |
| Experiment | `experiments/actions.ts`: createExperiment, startExperiment, logResult, concludeExperiment, archiveExperiment, moveExperiment; inline entity edits | `api/mcp/route.ts`: create_experiment, log_experiment_result, conclude_experiment | Creation, actual status transitions, new results grouped under experiment |
| Evidence | `discovery/actions.ts`: addEvidence, linkEvidence | `evidence-tool-handlers.ts`: addEvidence, linkEvidence | New evidence and changed nonempty target attachment, grouped under explicit target |
| Decision | `decision-service.ts`: recordDecision | Same shared service; only authenticated human actors can decide | New actual decision; idempotent replays emit nothing |
| Discussion | `comments.ts`: createComment, including legacy solution compatibility mirroring | Same shared service | Nonempty root comments on Task, Opportunity, Solution, Assumption, Experiment, RoadmapItem, tracked Decision; explicit solution plans labeled proposed |

## Exclusions and boundaries

- Research evidence promotion (`research-evidence-promotion.ts`) is not captured.
- Docs/artifacts, research internals, OKR check-ins and feedback triage are not
  feed sources. Promoting feedback to a roadmap item captures the new roadmap item.
- Derived roadmap delivery state from task links has no separate stored
  transition event; the underlying task status is captured.
- Descriptive edits, sorting, replies, comment edits, migration imports, deleted
  records and repeated status assignments do not generate stories.
- Evidence reattachment is a new event for the destination; prior events retain
  their original group reference. Current source authorization still applies.
- UI experiment conclusion and its assumption update share one transaction with
  both events. MCP conclusion retains its existing two-write workflow; each write
  is atomic with its own event.
- Existing legacy solution-comment writes retain compensating cleanup around
  shared-comment mirroring; the shared comment and its event commit atomically.
- Capture records the authenticated actor; it is not a replacement for source
  mutation authorization. Feed access independently enforces workspace membership
  and resolves sources within that workspace.

## Verification evidence

- Enabled UI/MCP task creation parity and denied UI mutation:
  `__tests__/workspace-update-entrypoints.test.ts`.
- Enabled agent task transition: `__tests__/task-tool-handlers.test.ts` (test
  first failed with zero capture calls before wiring).
- Metadata minimization, ancestor workspace resolution, experiment result
  grouping, roadmap horizon changes, repeated-status/sort/title exclusion,
  service identity and failure propagation: `lib/workspace-update-mutations.test.ts`.
- Root plan labeling and reply/import exclusion: `__tests__/comments.test.ts`.
- Actual decision capture inside its transaction: `__tests__/decision-service.test.ts`.
- Existing mutation regression suites run with capture disabled. These do not
  establish enabled event-capture parity for every row above; additional browser
  and database verification is required before rollout.
