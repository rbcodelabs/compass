# Roll out persistent sandbox fencing

Migration `130_agent_sandbox_operations` adds the conversation coordination
column and operation and generation tables. All detached run starts use the
coordination column. Provider work stays outside database transactions.

## Cutover and rollback

1. Verify completed production receipts for `129_agent_message_run_id` and
   `130_agent_sandbox_operations` and the expected catalog shape. Confirm the
   valid 129 index, writable 130 coordination column, and operation and
   generation tables. Record the staged revision, backend, and schema. Both
   migrations are already applied. Use read-only status and catalog checks.
2. Keep public traffic off the fenced staged runtime. Quiesce old persistent
   starts, continuations, worker callbacks and cron, including traffic using
   deployment-specific URLs. Drain in-flight provider launches and stops.
   Confirm that old callers can no longer act on the named sandboxes.
3. After the drain, route only isolated fixture traffic and its callbacks to the
   staged revision. Verify the linked transcript readback, then persistent
   launch, idle pause, snapshot resume, and scheduled wake-up retry. Confirm
   the callback receiver is the staged revision and verify both sandbox
   classes. Promote public traffic, callbacks and cron only after smoke passes.
4. To roll back, quiesce the new launch and stop paths. Wait for active calls and
   reconcile outstanding operations before allowing old callers to access the
   named sandboxes. Retain the additive schema and receipts.

## Recovery

An operation record supplies the affected conversation, run, sandbox name,
phase and provider session ID when a stop was dispatched. The sweeper retries
pre-dispatch lookup failures and receipt writes in a separate bounded page from
fresh stops. It can retire an expired launch reservation that never progressed
to dispatch, or a launch whose successful settlement was persisted.

Stop recovery reads the operation record even after the owning run is deleted.
A confirmed stop can finish bookkeeping from its durable receipt. A dispatched
stop requires the provider to identify the recorded session as stopped and
confirm either its saved snapshot or that the advertised snapshot is gone.
A missing sandbox name, missing snapshot metadata after dispatch, an unrelated
session or snapshot, and elapsed time leave the operation fenced. Before
dispatch, a verified stopped session without an advertised snapshot can proceed
to the existing launch fallback. An ambiguous name-based launch remains fenced
for investigation if the coordinator exited before persisting the result.

When a fence remains, correlate the operation with the provider's session and
snapshot history and the application invocation logs. Before approving a
recovery, establish that all requests which held the matching token have
terminated, no provider mutation from them can still arrive, and the saved disk
is accounted for. Leave the fence in place while any result is indeterminate.
Never clear operation records based on age alone. Release and rollback are
separate review decisions if they require intervening on a real environment.
