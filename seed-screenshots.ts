#!/usr/bin/env node
/**
 * Seed the compass_dev schema with realistic demo data for screenshot generation.
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass node seed-screenshots.ts
 *
 * The per-entity seed*() functions below are exported so other callers (e.g.
 * lib/preview-automation/scenarios.ts, which seeds an optional fixture into
 * a bootstrapped preview-automation run) can reuse the exact same fixture
 * shapes against a different workspace, without duplicating this logic.
 * They're parameterized on a `SqlExec` — a thin function shape that either a
 * raw `pg.Pool` (this script, local-only) or Prisma's `$queryRawUnsafe` (the
 * app, works against both local Postgres and Aurora DSQL on Preview) can
 * satisfy. Every INSERT uses Postgres-style `$1, $2, ...` placeholders,
 * which both callers understand identically.
 */

import pg from "pg";

/** A SQL executor: runs `sql` with positional `$1, $2, ...` params, returns rows. */
export type SqlExec = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;

async function one(exec: SqlExec, sql: string, params: unknown[] = []) {
  const rows = await exec(sql, params);
  return rows[0];
}

// ─── Squads ───────────────────────────────────────────────────────────────────

const SQUAD_DEFS = [
  { name: "Growth", color: "#6366f1" },
  { name: "Platform", color: "#0ea5e9" },
  { name: "Core Product", color: "#10b981" },
];

export async function seedSquads(
  exec: SqlExec,
  schema: string,
  workspaceId: string
): Promise<Record<string, string>> {
  const squads: Record<string, string> = {};
  for (const s of SQUAD_DEFS) {
    const existing = await one(
      exec,
      `SELECT id FROM "${schema}".squads WHERE workspace_id = $1 AND name = $2`,
      [workspaceId, s.name]
    );
    if (existing) {
      squads[s.name] = existing.id;
      continue;
    }
    const r = await one(
      exec,
      `INSERT INTO "${schema}".squads (workspace_id, name, color) VALUES ($1,$2,$3) RETURNING id`,
      [workspaceId, s.name, s.color]
    );
    squads[s.name] = r.id;
  }
  return squads;
}

// ─── OKR Cycle, Objectives, Key Results ────────────────────────────────────────

const OBJECTIVE_DEFS = [
  { title: "Become the go-to tool for continuous discovery teams", status: "ON_TRACK" },
  { title: "Drive viral adoption through exceptional DX", status: "AT_RISK" },
];

const KR_DEFS = [
  { objIdx: 0, title: "Reach 500 active workspaces", target: 500, unit: "workspaces", current: 187 },
  { objIdx: 0, title: "Achieve NPS score of 65+", target: 65, unit: "points", current: 52 },
  { objIdx: 0, title: "Reduce time-to-first-discovery to < 10 min", target: 10, unit: "minutes", current: 14 },
  { objIdx: 1, title: "MCP API used by 100+ AI agents monthly", target: 100, unit: "agents", current: 23 },
  { objIdx: 1, title: "100% of features have matching docs", target: 100, unit: "%", current: 68 },
];

export interface OkrCycleSeedResult {
  cycleId: string;
  objectiveIds: string[];
  krIds: string[];
}

export async function seedOkrCycleAndObjectives(
  exec: SqlExec,
  schema: string,
  workspaceId: string
): Promise<OkrCycleSeedResult> {
  let cycle = await one(
    exec,
    `SELECT id FROM "${schema}".okr_cycles WHERE workspace_id = $1 AND title = 'Q3 2026'`,
    [workspaceId]
  );
  if (!cycle) {
    cycle = await one(
      exec,
      `INSERT INTO "${schema}".okr_cycles (workspace_id, title, status, start_date, end_date)
       VALUES ($1, 'Q3 2026', 'ACTIVE', '2026-07-01', '2026-09-30') RETURNING id`,
      [workspaceId]
    );
  }

  const objectiveIds: string[] = [];
  for (const o of OBJECTIVE_DEFS) {
    let obj = await one(
      exec,
      `SELECT id FROM "${schema}".objectives WHERE cycle_id = $1 AND title = $2`,
      [cycle.id, o.title]
    );
    if (!obj) {
      obj = await one(
        exec,
        `INSERT INTO "${schema}".objectives (cycle_id, title, status, description)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [cycle.id, o.title, o.status, "Drive the product forward with clear, measurable goals."]
      );
    }
    objectiveIds.push(obj.id);
  }

  const krIds: string[] = [];
  for (const kr of KR_DEFS) {
    let r = await one(
      exec,
      `SELECT id FROM "${schema}".key_results WHERE objective_id = $1 AND title = $2`,
      [objectiveIds[kr.objIdx], kr.title]
    );
    if (!r) {
      r = await one(
        exec,
        `INSERT INTO "${schema}".key_results (objective_id, title, target, current, unit)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [objectiveIds[kr.objIdx], kr.title, kr.target, kr.current, kr.unit]
      );
    }
    krIds.push(r.id);
  }

  return { cycleId: cycle.id, objectiveIds, krIds };
}

// ─── Opportunities, Solutions, Assumptions ─────────────────────────────────────

const OPPORTUNITY_DEFS = [
  {
    title: "Teams struggle to maintain a living OST as the product evolves",
    desc: "PMs update the OST after major decisions, but the tree quickly goes stale between planning cycles. Solutions get orphaned from their parent opportunities.",
    status: "ACTIVE", segment: "Product Teams", krIdx: 0,
  },
  {
    title: "Onboarding is confusing — first OST takes too long to create",
    desc: "New users don't understand the OST hierarchy and get stuck on the difference between assumptions and solutions.",
    status: "VALIDATING", segment: "New Users", krIdx: 2,
  },
  {
    title: "No way to share discovery context with engineering",
    desc: "Engineers see roadmap items but not the reasoning behind them. The OST context lives in Compass but isn't surfaced during implementation.",
    status: "EXPLORING", segment: "Cross-functional Teams", krIdx: 0,
  },
  {
    title: "Experiments lack structure — teams can't replicate methodology",
    desc: "Different PMs run experiments differently. No shared template leads to inconsistent conclusions and difficulty comparing results.",
    status: "PRIORITIZED", segment: "Discovery Teams", krIdx: 1,
  },
];

export async function seedOpportunities(
  exec: SqlExec,
  schema: string,
  workspaceId: string,
  krIds: string[],
  growthSquadId: string
): Promise<string[]> {
  const oppIds: string[] = [];
  for (const o of OPPORTUNITY_DEFS) {
    let r = await one(
      exec,
      `SELECT id FROM "${schema}".opportunities WHERE workspace_id = $1 AND title = $2`,
      [workspaceId, o.title]
    );
    if (!r) {
      r = await one(
        exec,
        `INSERT INTO "${schema}".opportunities
         (workspace_id, title, description, status, customer_segment, linked_key_result_id, squad_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [workspaceId, o.title, o.desc, o.status, o.segment, krIds[o.krIdx], growthSquadId]
      );
    }
    oppIds.push(r.id);
  }
  return oppIds;
}

const SOLUTION_DEFS = [
  { oppIdx: 0, title: "Auto-archive solutions when parent opportunity moves to ARCHIVED", status: "IDEA" },
  { oppIdx: 0, title: "OST health score — flag stale branches with no activity in 30 days", status: "VALIDATED" },
  { oppIdx: 0, title: "Bulk re-link mode — reassign orphaned solutions via drag interface", status: "IN_DELIVERY" },
  { oppIdx: 3, title: "Experiment template library with pre-filled hypothesis formats", status: "IDEA" },
  { oppIdx: 3, title: "Experiment brief wizard — step-by-step guided flow", status: "VALIDATED" },
];

export async function seedSolutions(
  exec: SqlExec,
  schema: string,
  oppIds: string[]
): Promise<string[]> {
  const solutionIds: string[] = [];
  for (const s of SOLUTION_DEFS) {
    let r = await one(
      exec,
      `SELECT id FROM "${schema}".solutions WHERE opportunity_id = $1 AND title = $2`,
      [oppIds[s.oppIdx], s.title]
    );
    if (!r) {
      r = await one(
        exec,
        `INSERT INTO "${schema}".solutions (opportunity_id, title, status, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [oppIds[s.oppIdx], s.title, s.status, solutionIds.length]
      );
    }
    solutionIds.push(r.id);
  }
  return solutionIds;
}

const ASSUMPTION_DEFS = [
  { solIdx: 1, title: "PMs notice the health score on the tree view within 1 week", risk: "MEDIUM", status: "TESTING" },
  { solIdx: 1, title: "Teams will take action on flagged branches within 2 days", risk: "HIGH", status: "UNTESTED" },
  { solIdx: 2, title: "Drag-to-relink is discoverable without onboarding", risk: "HIGH", status: "VALIDATED" },
  { solIdx: 4, title: "A 5-step wizard reduces experiment setup time by 50%", risk: "MEDIUM", status: "TESTING" },
  { solIdx: 4, title: "Pre-filled templates are used rather than overwritten", risk: "LOW", status: "UNTESTED" },
];

export async function seedAssumptions(
  exec: SqlExec,
  schema: string,
  solutionIds: string[]
): Promise<string[]> {
  const assumptionIds: string[] = [];
  for (const a of ASSUMPTION_DEFS) {
    let r = await one(
      exec,
      `SELECT id FROM "${schema}".assumptions WHERE solution_id = $1 AND title = $2`,
      [solutionIds[a.solIdx], a.title]
    );
    if (!r) {
      r = await one(
        exec,
        `INSERT INTO "${schema}".assumptions (solution_id, title, risk_level, status, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [solutionIds[a.solIdx], a.title, a.risk, a.status, assumptionIds.length]
      );
    }
    assumptionIds.push(r.id);
  }
  return assumptionIds;
}

// ─── Experiments ────────────────────────────────────────────────────────────────

const EXPERIMENT_DEFS = [
  {
    assumIdx: 0,
    title: "Health score banner A/B test — does seeing the score drive OST updates?",
    hypothesis: "If we show a health score on stale OST branches, PMs will update 40% more nodes within 7 days",
    status: "RUNNING", method: "A/B test with 50/50 split across Growth cohort",
    killCondition: "If <10% of PMs interact with the score after 14 days",
    startDate: "2026-07-01", endDate: "2026-07-14",
  },
  {
    assumIdx: 2,
    title: "Drag-to-relink user test — 5 PMs, moderated session",
    hypothesis: "If we add a drag-to-relink affordance, 80% of users discover it without prompting",
    status: "COMPLETE", method: "Moderated usability test with 5 participants",
    killCondition: "If <3/5 users discover the feature unaided",
    startDate: "2026-06-10", endDate: "2026-06-20",
    conclusion: "PROCEED", result: "4/5 participants discovered drag-to-relink without prompting. Proceeding to build."
  },
  {
    assumIdx: 3,
    title: "Wizard prototype — measure time-to-first-experiment",
    hypothesis: "A 5-step guided wizard reduces experiment setup from 18 min avg to under 9 min",
    status: "DESIGNING", method: "Time-on-task measurement with 8 participants in Maze prototype test",
    killCondition: "If average setup time doesn't drop below 12 min",
  },
];

export async function seedExperiments(
  exec: SqlExec,
  schema: string,
  workspaceId: string,
  assumptionIds: string[],
  growthSquadId: string
): Promise<string[]> {
  const expIds: string[] = [];
  for (const e of EXPERIMENT_DEFS) {
    let r = await one(
      exec,
      `SELECT id FROM "${schema}".experiments WHERE workspace_id = $1 AND title = $2`,
      [workspaceId, e.title]
    );
    if (!r) {
      r = await one(
        exec,
        `INSERT INTO "${schema}".experiments
         (workspace_id, assumption_id, title, hypothesis, status, method, kill_condition,
          start_date, end_date, conclusion, squad_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          workspaceId, assumptionIds[e.assumIdx], e.title, e.hypothesis, e.status,
          e.method, e.killCondition,
          (e as any).startDate ?? null, (e as any).endDate ?? null,
          (e as any).conclusion ?? null,
          growthSquadId,
        ]
      );
    }
    expIds.push(r.id);
  }
  return expIds;
}

// ─── Roadmap Items ───────────────────────────────────────────────────────────────

const ROADMAP_DEFS = [
  {
    title: "OST health score + staleness indicator",
    desc: "Visual health score on the OST tree view with automated staleness detection for inactive branches.",
    horizon: "NOW", status: "ACTIVE", oppIdx: 0, solIdx: 1, krIdx: 0,
  },
  {
    title: "Drag-to-relink orphaned solutions",
    desc: "Allow PMs to reassign solutions to different opportunities via drag-and-drop in the tree view.",
    horizon: "NOW", status: "ACTIVE", oppIdx: 0, solIdx: 2, krIdx: 0,
  },
  {
    title: "Experiment brief wizard",
    desc: "Step-by-step guided flow for setting up experiments with pre-filled templates and validation.",
    horizon: "NEXT", status: "ACTIVE", oppIdx: 3, solIdx: 4, krIdx: 1,
  },
  {
    title: "Public OST sharing with stakeholder view",
    desc: "Read-only shareable link to the OST tree for async engineering handoff.",
    horizon: "NEXT", status: "ACTIVE", oppIdx: 2, krIdx: 0,
  },
  {
    title: "AI-powered opportunity clustering",
    desc: "Automatically group similar customer opportunities using semantic similarity.",
    horizon: "LATER", status: "ACTIVE", krIdx: 0,
  },
  {
    title: "Slack integration — opportunity digest",
    desc: "Weekly digest of active opportunities, experiments running, and upcoming deadlines.",
    horizon: "LATER", status: "ACTIVE", krIdx: 3,
  },
];

export async function seedRoadmapItems(
  exec: SqlExec,
  schema: string,
  workspaceId: string,
  oppIds: string[],
  solutionIds: string[],
  krIds: string[]
): Promise<void> {
  for (let i = 0; i < ROADMAP_DEFS.length; i++) {
    const r = ROADMAP_DEFS[i];
    const exists = await one(
      exec,
      `SELECT id FROM "${schema}".roadmap_items WHERE workspace_id = $1 AND title = $2`,
      [workspaceId, r.title]
    );
    if (exists) continue;
    await one(
      exec,
      `INSERT INTO "${schema}".roadmap_items
       (workspace_id, title, description, horizon, status, opportunity_id, solution_id, key_result_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        workspaceId, r.title, r.desc, r.horizon, r.status,
        (r as any).oppIdx != null ? oppIds[(r as any).oppIdx] : null,
        (r as any).solIdx != null ? solutionIds[(r as any).solIdx] : null,
        krIds[(r as any).krIdx],
        i,
      ]
    );
  }
}

// ─── Feedback ─────────────────────────────────────────────────────────────────────

const FEEDBACK_DEFS = [
  { title: "Allow exporting the OST tree as a PDF", desc: "We share discovery context in team meetings and need a printable version of the tree.", votes: 24, status: "OPEN" },
  { title: "Slack notification when assumption status changes", desc: "Would love to get pinged in our PM channel when an experiment concludes.", votes: 18, status: "OPEN" },
  { title: "Dark mode", desc: "Long sessions are hard on the eyes — please add a dark mode.", votes: 41, status: "PLANNED" },
  { title: "Bulk import opportunities from CSV", desc: "We ran a large discovery sprint and need to import 50+ opportunities at once.", votes: 12, status: "OPEN" },
];

export async function seedFeedback(exec: SqlExec, schema: string, workspaceId: string): Promise<void> {
  for (const f of FEEDBACK_DEFS) {
    const exists = await one(
      exec,
      `SELECT id FROM "${schema}".feedback WHERE workspace_id = $1 AND title = $2`,
      [workspaceId, f.title]
    );
    if (exists) continue;
    await one(
      exec,
      `INSERT INTO "${schema}".feedback (workspace_id, title, description, vote_count, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [workspaceId, f.title, f.desc, f.votes, f.status]
    );
  }
}

// ─── Tasks + Task Links ─────────────────────────────────────────────────────────

const TASK_DEFS = [
  { title: "Design health score visual treatment for OST branches", status: "DONE", priority: "MEDIUM", squad: "Growth", points: 3 },
  { title: "Implement staleness detection query", status: "IN_PROGRESS", priority: "HIGH", squad: "Growth", points: 5, owner: "Priya Shah" },
  { title: "Wire health score banner into OST tree view", status: "TODO", priority: "HIGH", squad: "Growth", points: 3 },
  { title: "Investigate flaky staleness-detection test in CI", status: "BLOCKED", priority: "URGENT", squad: "Platform", points: 2 },
  { title: "Write launch announcement for drag-to-relink", status: "IN_REVIEW", priority: "MEDIUM", squad: "Core Product", points: 1 },
  { title: "Spike: bulk re-link drag interaction prototype", status: "BACKLOG", priority: "LOW", squad: "Core Product", points: 8 },
  { title: "Q3 onboarding revamp", status: "TODO", priority: "HIGH", owner: "Rick Bowman", iteration: "Q3 Initiatives" },
];

export async function seedTasksAndLinks(
  exec: SqlExec,
  schema: string,
  workspaceId: string,
  squadIds: Record<string, string>,
  solutionIds: string[],
  oppIds: string[]
): Promise<string[]> {
  const taskIds: string[] = [];
  for (let i = 0; i < TASK_DEFS.length; i++) {
    const t = TASK_DEFS[i] as (typeof TASK_DEFS)[number] & { squad?: string; owner?: string; iteration?: string };
    const exists = await one(
      exec,
      `SELECT id FROM "${schema}".tasks WHERE workspace_id = $1 AND title = $2`,
      [workspaceId, t.title]
    );
    if (exists) {
      taskIds.push(exists.id);
      continue;
    }
    const r = await one(
      exec,
      `INSERT INTO "${schema}".tasks (workspace_id, squad_id, title, status, priority, story_points, owner_name, iteration, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [workspaceId, t.squad ? squadIds[t.squad] : null, t.title, t.status, t.priority, (t as any).points ?? null, t.owner ?? null, t.iteration ?? null, i]
    );
    taskIds.push(r.id);
  }

  // Link the first task to the health-score Solution and the Growth
  // Opportunity it originated from, so the Links tab has real content.
  const taskLinkDefs = [
    { taskIdx: 0, linkedType: "SOLUTION", linkedId: solutionIds[1] },
    { taskIdx: 1, linkedType: "OPPORTUNITY", linkedId: oppIds[0] },
  ];
  for (const l of taskLinkDefs) {
    const exists = await one(
      exec,
      `SELECT id FROM "${schema}".task_links WHERE task_id = $1 AND linked_type = $2 AND linked_id = $3`,
      [taskIds[l.taskIdx], l.linkedType, l.linkedId]
    );
    if (exists) continue;
    await one(
      exec,
      `INSERT INTO "${schema}".task_links (task_id, linked_type, linked_id) VALUES ($1,$2,$3) RETURNING id`,
      [taskIds[l.taskIdx], l.linkedType, l.linkedId]
    );
  }

  return taskIds;
}

// ─── Docs ─────────────────────────────────────────────────────────────────────────

const DOC_TITLE = "PRD: AI-Powered Opportunity Clustering";
const DOC_CONTENT = `## Problem

PMs manually scan the Discovery board looking for opportunities that describe
the same underlying customer pain in different words. As the OST grows past
a few dozen nodes, duplicate or near-duplicate opportunities get created
independently by different PMs, fragmenting evidence and vote counts across
several nodes instead of one strong signal.

## Proposed Approach

Run a semantic similarity pass over opportunity titles and descriptions
whenever a new opportunity is created. Surface a "Similar opportunities"
suggestion in the creation flow so the PM can link evidence to an existing
node instead of creating a duplicate, or merge two opportunities after the
fact from the tree view.

## Success Metrics

- Reduce duplicate opportunity creation rate by 60% within one quarter
- Cut median time-to-triage for new feedback from 4 days to under 1 day
- At least 70% of surfaced suggestions are accepted (merged or linked) by PMs

## Open Questions

- Do we cluster on title only, or title + description + linked evidence?
- Should clustering run synchronously on create, or as a nightly batch job?
`;
const DOC_METADATA = {
  status: "In Review",
  owner: "Priya Shah",
  tags: ["ai", "discovery", "q4-planning"],
  targetDate: "2026-09-30",
};

export async function seedDocs(exec: SqlExec, schema: string, workspaceId: string): Promise<void> {
  // sort_order -1 so this doc wins the docs-index "firstDoc" redirect
  // (orderBy sortOrder asc, createdAt asc) ahead of any pre-existing empty
  // Untitled docs in this workspace, so /docs opens on real content.
  const existingDoc = await one(
    exec,
    `SELECT id FROM "${schema}".docs WHERE workspace_id = $1 AND title = $2`,
    [workspaceId, DOC_TITLE]
  );
  if (existingDoc) return;
  await one(
    exec,
    `INSERT INTO "${schema}".docs (workspace_id, title, content, metadata, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [workspaceId, DOC_TITLE, DOC_CONTENT, JSON.stringify(DOC_METADATA), -1]
  );
}

// ─── Orchestration ───────────────────────────────────────────────────────────────

/**
 * Seeds the full realistic demo dataset (squads, an active OKR cycle,
 * opportunities/solutions/assumptions, experiments, roadmap items, feedback,
 * tasks, and a doc) into an existing workspace. Idempotent — safe to call
 * repeatedly against the same workspace.
 */
export async function seedFullDemoData(
  exec: SqlExec,
  schema: string,
  workspaceId: string
): Promise<void> {
  const squads = await seedSquads(exec, schema, workspaceId);
  const { krIds } = await seedOkrCycleAndObjectives(exec, schema, workspaceId);
  const oppIds = await seedOpportunities(exec, schema, workspaceId, krIds, squads["Growth"]);
  const solutionIds = await seedSolutions(exec, schema, oppIds);
  const assumptionIds = await seedAssumptions(exec, schema, solutionIds);
  await seedExperiments(exec, schema, workspaceId, assumptionIds, squads["Growth"]);
  await seedRoadmapItems(exec, schema, workspaceId, oppIds, solutionIds, krIds);
  await seedFeedback(exec, schema, workspaceId);
  await seedTasksAndLinks(exec, schema, workspaceId, squads, solutionIds, oppIds);
  await seedDocs(exec, schema, workspaceId);
}

// ─── CLI entrypoint (unchanged behaviour — screenshot demo data) ─────────────────

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const exec: SqlExec = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const S = "compass_dev";

  console.log("Seeding compass_dev...");

  const user = await one(exec, `SELECT id, email FROM "${S}".users WHERE email = $1`, ["rick@rbcodelabs.com"]);
  if (!user) { console.error("User not found — log in first!"); process.exit(1); }
  console.log("User:", user.email, user.id);

  const org = await one(exec, `SELECT id, slug FROM "${S}".organizations WHERE slug = $1`, ["rbcodelabs"]);
  if (!org) { console.error("Org not found"); process.exit(1); }
  console.log("Org:", org.slug, org.id);

  const ws = await one(exec, `SELECT id, slug FROM "${S}".workspaces WHERE slug = $1 AND organization_id = $2`, ["compass", org.id]);
  if (!ws) { console.error("Workspace not found"); process.exit(1); }
  console.log("Workspace:", ws.slug, ws.id);

  await seedFullDemoData(exec, S, ws.id);

  await pool.end();
  console.log("\n✅ Seed complete!");
}

// Cross-runtime "run only if invoked directly" check, deliberately not the
// usual `import.meta.url === file://${process.argv[1]}`. This file is a
// script but is now also imported for its seed*() exports, and this repo
// has no "type": "module". Loaders that resolve a transitively-imported .ts
// file through Node's CommonJS path reject a literal `import.meta` with
// "Cannot use 'import.meta' outside a module" when the module is evaluated
// — a syntax error, so guarding it behind a condition does not help. Next's
// bundler and Vitest both load this as ESM today, so nothing currently
// breaks; this plain string comparison just keeps the file safe to import
// from any runtime rather than making that a trap for the next caller.
if (process.argv[1]?.endsWith("seed-screenshots.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
