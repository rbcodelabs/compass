# 113 entity_links backfill: agent conversation links (RM-19)

Migration `113_entity_links_backfill_conversation` (hook: `lib/migrations/entity-links-conversation-backfill.ts`). No DDL, explicit-only.

- Source: `task_links` rows with `linked_type = 'AGENT_CONVERSATION'` (every task the agent made with `TaskCreate`).
- Target: `entity_links` `CONVERSATION_CREATED` (conversation -> TASK), origin `MIGRATION`, source `AGENT`, `created_at` copied.
- `task_links` stays the source of truth for the plan card and task screen. Nothing is deleted. A `CONVERSATION_MENTIONS` row for a backfilled pair is removed.
- Quarantined (left unlinked, reported by id in the POST log and in `GET /api/admin/migrate` under `entityLinksConversationBackfill`): `dangling` (conversation or task gone) and `crossWorkspace`.

Run: deploy the code that writes `CONVERSATION_CREATED` / `CONVERSATION_MENTIONS` first, then `GET /api/admin/migrate` (confirm `unmatched`), then `POST {"script":"113_entity_links_backfill_conversation"}`, then GET again (`unmatched` is 0). Idempotent and resumable: a failed postcondition leaves no receipt and a re-POST continues.
