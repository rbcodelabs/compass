# Roll out agent-message run IDs

Migration `129_agent_message_run_id` ships separately from this runtime. It
adds the nullable `agent_messages.run_id` column and its index. A finalizer
can commit terminal status before a transcript insert fails. A repeat callback
for a terminal run does not repair the transcript.

1. Arrange a [staged Vercel production deployment](https://vercel.com/docs/deployments/promoting-a-deployment)
   for the approved integrated revision. Keep public traffic and normal cron on
   the current release. Capture the staged deployment ID, commit, rollback
   target, and production schema.
2. Verify the completed migration 129 receipt and valid index on that schema
   before moving traffic. Use the authenticated migration status GET and catalog
   evidence. This application rollout does not submit a migration POST.
3. Confirm which deployment receives the worker callback
   (`/api/internal/agent/runs/:id/events`) for each staged test. Continuations use
   the configured production origin via `trustedCompassBaseUrl().origin`, which
   can still reach the old revision when initiated from a staged URL. Route or
   isolate the test so the callback demonstrably reaches the staged revision.
4. In a designated fixture workspace, read a legacy transcript and complete
   a controlled detached turn. Read back the single assistant message directly
   and compare its stored run ID to the finalized run ID. Record the run ID and
   callback revision. Workspace bundle smoke is general regression coverage.
   The bundle excludes tiered messages and ephemeral runs.
5. Promote only after the receipt and readback checks pass. Confirm traffic,
   callbacks, and cron reach the intended revision. Drain old instances and
   detached workers before choosing a spend-reporting cutoff. If the application
   rolls back, retain the additive schema and reassess the reporting cutoff.
