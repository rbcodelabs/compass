# 0021. Agents may request release authorization

Status: accepted

## Context

ADR 0020 kept request_release_authorization human-only, treating it as an attestation recorded under the delegating human's name. In practice that blocked agents from preparing release reviews, even though raising the request attests nothing: the immutable packet pins the exact PR, head SHA, policy and Tasks, and the decision itself requires a signed-in workspace admin (requiredRole ADMIN on the revision) and revalidation against GitHub at queue time.

## Decision

- request_release_authorization is an agent WRITE. Agents need workspace write access (membership gate), not org-admin rights. People still need to be a workspace admin.
- The request records requestedByAgentId (as request_decision does) so the review shows the agent as requester.
- Approving or rejecting a release stays human-only. approve_solution_plan, reject_solution_plan and comment edits are unchanged from ADR 0020.

## Consequences

An agent can queue a review for a human to approve; it cannot approve, merge or deploy. Reverting is a one-line policy change in AGENT_TOOL_POLICY.
