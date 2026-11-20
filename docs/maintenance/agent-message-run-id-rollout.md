# Roll out agent-message run IDs

Migration `129_agent_message_run_id` adds the nullable `agent_messages.run_id`
column and its index. The runtime Prisma client reads the column, and the
detached finalizer writes it. A finalizer can record terminal status before an
old schema rejects the transcript insert, so complete the schema change before
the application, callback, or cron paths from the new build receive traffic.

1. Arrange a [staged Vercel production deployment](https://vercel.com/docs/deployments/promoting-a-deployment)
   for the approved integrated revision. Set up the traffic barrier before merging
   into any branch that automatically promotes. Confirm that the public domains,
   cron targets, and existing detached-worker callback URLs still point to the
   current release. Protect the staged URL so only the release operators can use
   it for the checks below. Capture its deployment ID, commit, and rollback target.
2. On the staged URL, use the release credential for an authenticated
   `GET /api/admin/migrate`. Confirm the production environment, database backend,
   target schema, registered migration name, and any preceding pending or
   unresolved receipts. On plain Postgres, use the configured session-pooler
   connection and account for the index build's write-lock window.
3. After separate production migration approval, send
   `POST /api/admin/migrate` to the staged URL with the same authentication and
   body `{"script":"129_agent_message_run_id"}`. Require HTTP 200 and a completed
   receipt on a fresh status read. The runner checks the writable nullable column
   and the ready, valid index before it records completion. Resolve any failed
   attempt and verify the exact receipt before advancing.
4. Use a designated test workspace on the staged URL. Verify an existing
   conversation and its prior messages still load. Complete one controlled
   detached turn and verify its single assistant message is linked to the run.
   Check that workspace bundle export and import still pass in the designated
   fixture. Promote the reviewed deployment only after these checks pass and
   confirm normal traffic and callbacks use the intended revision.
5. Set any spend-reporting cutoff after old application instances and detached
   workers that can omit the linkage or failed-run usage have drained. If
   promotion needs to be rolled back, move traffic back and retain the additive
   column and index. Reassess the cutoff before using spend totals after rollback.

If the target project cannot isolate the staged build, prepare a separately
reviewed migration-only release containing the runner registration, catalog
assertion, and pins with the current runtime Prisma schema. Apply and verify
its targeted migration before promoting the runtime changes.
