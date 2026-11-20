# Roll out persistent sandbox fencing

Migration `130_agent_sandbox_operations` adds the conversation coordination
column and operation and generation tables. All detached run starts use the
coordination column. Provider work stays outside database transactions.

## Cutover and rollback

1. Use the staged deployment procedure for [migration 129](agent-message-run-id-rollout.md).
   Verify the exact staged revision, backend, schema and receipts. With separate
   approval, apply and verify `129_agent_message_run_id` and then
   `130_agent_sandbox_operations` before enabling the staged runtime.
2. Quiesce persistent starts, continuations and cron on the prior deployment.
   Drain old in-flight launch and stop requests, including requests using
   deployment-specific URLs. Old code ignores operation records. Require
   evidence that it can neither launch into nor stop a persistent sandbox after
   cutover. Route the application, callbacks and cron to the reviewed build when
   this barrier is established.
3. Verify a single persistent conversation can launch, become idle, pause,
   resume from its snapshot and run again. Check that a scheduled wake-up remains
   pending during a temporary fence and starts after the operation settles.
   Verify both sandbox classes with isolated fixtures before enabling traffic.
4. To roll back, quiesce the new launch and stop paths. Wait for active calls and
   resolve outstanding operations before allowing any old caller to access the
   named sandboxes. Keep the additive schema and receipts during code rollback.

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
