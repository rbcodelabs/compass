# ADR 0002 — Dedicated MCP Mutation for Solution Lifecycle Status

- **Status:** Accepted
- **Date:** 2026-08-30
- **Scope:** Add the smallest authenticated MCP capability needed to change a
  Solution's lifecycle status. This decision does not change the data model,
  automate transitions, or authorize any production data mutation.

## Context

Compass exposes `add_solution`, but its MCP catalog has no way to update an
existing Solution's lifecycle status. Agents therefore cannot reconcile a
Solution with completed delivery work. The existing UI already permits manual
status changes, and Compass defines exactly five Solution states: `IDEA`,
`VALIDATED`, `IN_DELIVERY`, `SHIPPED`, and `KILLED`.

The MCP route validates inputs with Zod, runs every tool through a fail-closed
authorization gate, and scopes child entities with `assertEntityAccess`.
Existing status mutations return both human-readable and structured output.

## Decision

Add a dedicated first-class MCP tool named `update_solution_status`.

- Input is exactly `{ solutionId, status }`: a UUID and an explicit enum of the
  five supported states.
- The tool gate must call `assertEntityAccess(actor, "solution", solutionId)`.
  This preserves workspace membership and scoped-key boundaries, keeps research
  credentials read-only, and retains the existing trusted service-key behavior.
- The handler reads the Solution before writing. A missing Solution returns the
  established non-success MCP result and performs no write. Per-user callers
  continue to receive the gate's indistinguishable "not found or access denied"
  error so the API does not disclose cross-workspace entity existence.
- A real transition updates only `status` and `updatedAt`, and returns structured
  data containing `id`, `title`, `previousStatus`, and `status`.
- Setting the current status again succeeds as a no-op, returns the same
  structured shape, and does not advance `updatedAt`.
- Any valid state may transition directly to any other valid state, including
  backward transitions and recovery from `KILLED`. The MCP tool does not add a
  lifecycle state machine that the UI does not enforce.
- The tool requires focused catalog/schema, handler, authorization-gate, valid
  enum, invalid/missing input, not-found, no-op, and write-path tests, plus an
  MCP catalog documentation update.

## Options Considered

| Option | Benefits | Costs |
|---|---|---|
| Dedicated `update_solution_status` tool | Least privilege, explicit schema, consistent with existing lifecycle mutations | A future editable Solution field needs another deliberate API change |
| Generic `update_solution` tool | Extensible for future fields | Broadens write authority beyond the current need and complicates validation |
| Enforce forward-only transitions | Encodes a strict workflow | Conflicts with current UI behavior and blocks corrective reconciliation |

## Consequences

Agents can safely reconcile Solution lifecycle state without gaining general
Solution-editing authority. Direct transitions remain a manual correction
mechanism; they do not update linked roadmap items, experiments, or assumptions.
The reported `previousStatus` is the value observed immediately before the
write, not an audit record. Concurrent callers retain the repository's existing
last-write-wins behavior.

## Risks and Revisit Triggers

The riskiest assumption is that unrestricted manual correction is intentional,
especially backward transitions and recovery from `KILLED`. Revisit this
decision if Compass introduces transition-dependent automation, approvals,
compliance history, or invariants between Solution and roadmap state. At that
point, lifecycle rules should be centralized for both UI and MCP callers rather
than added only to this tool.
