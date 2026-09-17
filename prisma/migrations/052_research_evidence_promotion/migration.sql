-- 052_research_evidence_promotion — ADR-0012 step 5.
--
-- Closes the gap ADR-0002 invariant 6 named: a synthesis finding could not become
-- a linked, source-attributed Evidence record, because Evidence carried only
-- opportunity_id / solution_id / assumption_id and a free-text source_url.
--
-- Aurora DSQL rules (CLAUDE.md, ADR-0012 Constraints): additive only, no foreign
-- keys, no triggers, updated_at maintained in application code, exactly one DDL
-- statement per transaction (no BEGIN/COMMIT wrapper — each statement below is its
-- own implicit transaction), and every new index created ASYNC. Every statement is
-- IF NOT EXISTS so a partially applied attempt resumes instead of failing.

-- Which synthesis proposed this evidence. Nullable: every Evidence row written
-- before this migration, and every row still created by add_evidence, has no
-- research provenance and must stay valid.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS research_synthesis_id UUID;

-- The idempotency key: a sha256 of the synthesis id plus the promoted finding's
-- content (researchFindingKey in lib/research-evidence-promotion.ts). Nullable for
-- the same reason, which also makes the unique index below inert for every
-- non-promoted row — Postgres and DSQL both treat NULLs as distinct in a unique
-- index by default, so unlimited NULL finding_key rows coexist.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS finding_key CHAR(64);

-- One finding legitimately cites several quotes across several sessions, so the
-- sources are rows rather than a column on evidence. No FOREIGN KEY clauses:
-- DSQL does not support them, so evidence_id / research_turn_id integrity is the
-- service layer's responsibility (see the model comment in prisma/schema.prisma).
CREATE TABLE IF NOT EXISTS evidence_research_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  evidence_id UUID NOT NULL,
  research_turn_id UUID NOT NULL,
  research_attachment_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT evidence_research_sources_pkey PRIMARY KEY (id)
);

-- Idempotency lookup, scoped to the workspace rather than globally unique.
-- finding_key is a content hash, so a cross-workspace collision is not a real
-- risk; the reason for the workspace column is authorization, not collision. A
-- global unique would let a write in workspace A fail because of a row in
-- workspace B that the caller cannot see — a cross-tenant oracle and a
-- cross-tenant denial of service. Scoping the constraint to workspace_id keeps
-- both the constraint and its failure mode inside one tenant boundary, and it is
-- the exact (workspace_id, finding_key) lookup the promotion path performs.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_evidence_workspace_finding_key ON evidence (workspace_id, finding_key);

-- Reading the provenance chain forward: everything one synthesis proposed.
CREATE INDEX ASYNC IF NOT EXISTS idx_evidence_research_synthesis ON evidence (research_synthesis_id);

-- One source row per (evidence, turn): a finding that quotes the same turn twice
-- still cites it once, and a retry cannot double-write a source row.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_evidence_research_sources_evidence_turn ON evidence_research_sources (evidence_id, research_turn_id);

-- Reading the chain backward: which evidence cites this turn. Without database
-- foreign keys this is how the application answers the deletion question
-- ADR-0012 records under "Provenance rot".
CREATE INDEX ASYNC IF NOT EXISTS idx_evidence_research_sources_turn ON evidence_research_sources (research_turn_id);
