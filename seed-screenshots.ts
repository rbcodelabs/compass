#!/usr/bin/env node
/**
 * Seed the compass_dev schema with realistic demo data for screenshot generation.
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass node seed-screenshots.ts
 */

import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const S = "compass_dev";

async function q(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function one(sql: string, params: unknown[] = []) {
  const rows = await q(sql, params);
  return rows[0];
}

async function main() {
  console.log("Seeding compass_dev...");

  // Get existing user and workspace
  const user = await one(`SELECT id, email FROM "${S}".users WHERE email = $1`, ["rick@rbcodelabs.com"]);
  if (!user) { console.error("User not found — log in first!"); process.exit(1); }
  console.log("User:", user.email, user.id);

  const org = await one(`SELECT id, slug FROM "${S}".organizations WHERE slug = $1`, ["rbcodelabs"]);
  if (!org) { console.error("Org not found"); process.exit(1); }
  console.log("Org:", org.slug, org.id);

  const ws = await one(`SELECT id, slug FROM "${S}".workspaces WHERE slug = $1 AND organization_id = $2`, ["compass", org.id]);
  if (!ws) { console.error("Workspace not found"); process.exit(1); }
  console.log("Workspace:", ws.slug, ws.id);

  // ── Squads ──────────────────────────────────────────────────────────────────
  const squadNames = [
    { name: "Growth", color: "#6366f1" },
    { name: "Platform", color: "#0ea5e9" },
    { name: "Core Product", color: "#10b981" },
  ];
  const squads: Record<string, string> = {};
  for (const s of squadNames) {
    const existing = await one(`SELECT id FROM "${S}".squads WHERE workspace_id = $1 AND name = $2`, [ws.id, s.name]);
    if (existing) { squads[s.name] = existing.id; continue; }
    const r = await one(`INSERT INTO "${S}".squads (workspace_id, name, color) VALUES ($1,$2,$3) RETURNING id`, [ws.id, s.name, s.color]);
    squads[s.name] = r.id;
  }
  console.log("Squads:", Object.keys(squads).join(", "));

  // ── OKR Cycle ───────────────────────────────────────────────────────────────
  let cycle = await one(`SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1 AND title = 'Q3 2026'`, [ws.id]);
  if (!cycle) {
    cycle = await one(
      `INSERT INTO "${S}".okr_cycles (workspace_id, title, status, start_date, end_date)
       VALUES ($1, 'Q3 2026', 'ACTIVE', '2026-07-01', '2026-09-30') RETURNING id`,
      [ws.id]
    );
  }

  // ── Objectives ──────────────────────────────────────────────────────────────
  const objDefs = [
    { title: "Become the go-to tool for continuous discovery teams", status: "ON_TRACK" },
    { title: "Drive viral adoption through exceptional DX", status: "AT_RISK" },
  ];
  const objectives: string[] = [];
  for (const o of objDefs) {
    let obj = await one(`SELECT id FROM "${S}".objectives WHERE cycle_id = $1 AND title = $2`, [cycle.id, o.title]);
    if (!obj) {
      obj = await one(
        `INSERT INTO "${S}".objectives (cycle_id, title, status, description)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [cycle.id, o.title, o.status, "Drive the product forward with clear, measurable goals."]
      );
    }
    objectives.push(obj.id);
  }

  // ── Key Results ─────────────────────────────────────────────────────────────
  const krDefs = [
    { objIdx: 0, title: "Reach 500 active workspaces", target: 500, unit: "workspaces", current: 187 },
    { objIdx: 0, title: "Achieve NPS score of 65+", target: 65, unit: "points", current: 52 },
    { objIdx: 0, title: "Reduce time-to-first-discovery to < 10 min", target: 10, unit: "minutes", current: 14 },
    { objIdx: 1, title: "MCP API used by 100+ AI agents monthly", target: 100, unit: "agents", current: 23 },
    { objIdx: 1, title: "100% of features have matching docs", target: 100, unit: "%", current: 68 },
  ];
  const krs: string[] = [];
  for (const kr of krDefs) {
    let r = await one(`SELECT id FROM "${S}".key_results WHERE objective_id = $1 AND title = $2`, [objectives[kr.objIdx], kr.title]);
    if (!r) {
      r = await one(
        `INSERT INTO "${S}".key_results (objective_id, title, target, current, unit)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [objectives[kr.objIdx], kr.title, kr.target, kr.current, kr.unit]
      );
    }
    krs.push(r.id);
  }
  console.log("OKRs seeded:", objectives.length, "objectives,", krs.length, "KRs");

  // ── Opportunities ────────────────────────────────────────────────────────────
  const oppDefs = [
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
  const opps: string[] = [];
  for (const o of oppDefs) {
    let r = await one(`SELECT id FROM "${S}".opportunities WHERE workspace_id = $1 AND title = $2`, [ws.id, o.title]);
    if (!r) {
      r = await one(
        `INSERT INTO "${S}".opportunities (workspace_id, title, description, status, customer_segment, linked_key_result_id, squad_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ws.id, o.title, o.desc, o.status, o.segment, krs[o.krIdx], squads["Growth"]]
      );
    }
    opps.push(r.id);
  }
  console.log("Opportunities:", opps.length);

  // ── Solutions for first opportunity ─────────────────────────────────────────
  const solDefs = [
    { oppIdx: 0, title: "Auto-archive solutions when parent opportunity moves to ARCHIVED", status: "IDEA" },
    { oppIdx: 0, title: "OST health score — flag stale branches with no activity in 30 days", status: "VALIDATED" },
    { oppIdx: 0, title: "Bulk re-link mode — reassign orphaned solutions via drag interface", status: "IN_DELIVERY" },
    { oppIdx: 3, title: "Experiment template library with pre-filled hypothesis formats", status: "IDEA" },
    { oppIdx: 3, title: "Experiment brief wizard — step-by-step guided flow", status: "VALIDATED" },
  ];
  const solutions: string[] = [];
  for (const s of solDefs) {
    let r = await one(`SELECT id FROM "${S}".solutions WHERE opportunity_id = $1 AND title = $2`, [opps[s.oppIdx], s.title]);
    if (!r) {
      r = await one(
        `INSERT INTO "${S}".solutions (opportunity_id, title, status, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [opps[s.oppIdx], s.title, s.status, solutions.length]
      );
    }
    solutions.push(r.id);
  }

  // ── Assumptions for solutions ─────────────────────────────────────────────
  const assumDefs = [
    { solIdx: 1, title: "PMs notice the health score on the tree view within 1 week", risk: "MEDIUM", status: "TESTING" },
    { solIdx: 1, title: "Teams will take action on flagged branches within 2 days", risk: "HIGH", status: "UNTESTED" },
    { solIdx: 2, title: "Drag-to-relink is discoverable without onboarding", risk: "HIGH", status: "VALIDATED" },
    { solIdx: 4, title: "A 5-step wizard reduces experiment setup time by 50%", risk: "MEDIUM", status: "TESTING" },
    { solIdx: 4, title: "Pre-filled templates are used rather than overwritten", risk: "LOW", status: "UNTESTED" },
  ];
  const assumptions: string[] = [];
  for (const a of assumDefs) {
    let r = await one(`SELECT id FROM "${S}".assumptions WHERE solution_id = $1 AND title = $2`, [solutions[a.solIdx], a.title]);
    if (!r) {
      r = await one(
        `INSERT INTO "${S}".assumptions (solution_id, title, risk_level, status, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [solutions[a.solIdx], a.title, a.risk, a.status, assumptions.length]
      );
    }
    assumptions.push(r.id);
  }

  // ── Experiments ───────────────────────────────────────────────────────────
  const expDefs = [
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
  const exps: string[] = [];
  for (const e of expDefs) {
    let r = await one(`SELECT id FROM "${S}".experiments WHERE workspace_id = $1 AND title = $2`, [ws.id, e.title]);
    if (!r) {
      r = await one(
        `INSERT INTO "${S}".experiments
         (workspace_id, assumption_id, title, hypothesis, status, method, kill_condition,
          start_date, end_date, conclusion, squad_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          ws.id, assumptions[e.assumIdx], e.title, e.hypothesis, e.status,
          e.method, e.killCondition,
          (e as any).startDate ?? null, (e as any).endDate ?? null,
          (e as any).conclusion ?? null,
          squads["Growth"]
        ]
      );
    }
    exps.push(r.id);
  }
  console.log("Experiments:", exps.length);

  // ── Roadmap Items ─────────────────────────────────────────────────────────
  const roadmapDefs = [
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
  for (let i = 0; i < roadmapDefs.length; i++) {
    const r = roadmapDefs[i];
    const exists = await one(`SELECT id FROM "${S}".roadmap_items WHERE workspace_id = $1 AND title = $2`, [ws.id, r.title]);
    if (exists) continue;
    await one(
      `INSERT INTO "${S}".roadmap_items
       (workspace_id, title, description, horizon, status, opportunity_id, solution_id, key_result_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        ws.id, r.title, r.desc, r.horizon, r.status,
        (r as any).oppIdx != null ? opps[(r as any).oppIdx] : null,
        (r as any).solIdx != null ? solutions[(r as any).solIdx] : null,
        krs[(r as any).krIdx],
        i,
      ]
    );
  }
  console.log("Roadmap items:", roadmapDefs.length);

  // ── Feedback ──────────────────────────────────────────────────────────────
  const feedbackDefs = [
    { title: "Allow exporting the OST tree as a PDF", desc: "We share discovery context in team meetings and need a printable version of the tree.", votes: 24, status: "OPEN" },
    { title: "Slack notification when assumption status changes", desc: "Would love to get pinged in our PM channel when an experiment concludes.", votes: 18, status: "OPEN" },
    { title: "Dark mode", desc: "Long sessions are hard on the eyes — please add a dark mode.", votes: 41, status: "PLANNED" },
    { title: "Bulk import opportunities from CSV", desc: "We ran a large discovery sprint and need to import 50+ opportunities at once.", votes: 12, status: "OPEN" },
  ];
  for (const f of feedbackDefs) {
    const exists = await one(`SELECT id FROM "${S}".feedback WHERE workspace_id = $1 AND title = $2`, [ws.id, f.title]);
    if (exists) continue;
    await one(
      `INSERT INTO "${S}".feedback (workspace_id, title, description, vote_count, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ws.id, f.title, f.desc, f.votes, f.status]
    );
  }
  console.log("Feedback:", feedbackDefs.length);

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const taskDefs = [
    { title: "Design health score visual treatment for OST branches", status: "DONE", priority: "MEDIUM", squad: "Growth", points: 3 },
    { title: "Implement staleness detection query", status: "IN_PROGRESS", priority: "HIGH", squad: "Growth", points: 5, owner: "Priya Shah" },
    { title: "Wire health score banner into OST tree view", status: "TODO", priority: "HIGH", squad: "Growth", points: 3 },
    { title: "Investigate flaky staleness-detection test in CI", status: "BLOCKED", priority: "URGENT", squad: "Platform", points: 2 },
    { title: "Write launch announcement for drag-to-relink", status: "IN_REVIEW", priority: "MEDIUM", squad: "Core Product", points: 1 },
    { title: "Spike: bulk re-link drag interaction prototype", status: "BACKLOG", priority: "LOW", squad: "Core Product", points: 8 },
    { title: "Q3 onboarding revamp", status: "TODO", priority: "HIGH", owner: "Rick Bowman", iteration: "Q3 Initiatives" },
  ];
  const tasks: string[] = [];
  for (let i = 0; i < taskDefs.length; i++) {
    const t = taskDefs[i] as (typeof taskDefs)[number] & { squad?: string; owner?: string; iteration?: string };
    const exists = await one(`SELECT id FROM "${S}".tasks WHERE workspace_id = $1 AND title = $2`, [ws.id, t.title]);
    if (exists) { tasks.push(exists.id); continue; }
    const r = await one(
      `INSERT INTO "${S}".tasks (workspace_id, squad_id, title, status, priority, story_points, owner_name, iteration, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ws.id, t.squad ? squads[t.squad] : null, t.title, t.status, t.priority, (t as any).points ?? null, t.owner ?? null, t.iteration ?? null, i]
    );
    tasks.push(r.id);
  }
  // Link the first task to the health-score Solution and the Growth
  // Opportunity it originated from, so the Links tab has real content to screenshot.
  const taskLinkDefs = [
    { taskIdx: 0, linkedType: "SOLUTION", linkedId: solutions[1] },
    { taskIdx: 1, linkedType: "OPPORTUNITY", linkedId: opps[0] },
  ];
  for (const l of taskLinkDefs) {
    const exists = await one(
      `SELECT id FROM "${S}".task_links WHERE task_id = $1 AND linked_type = $2 AND linked_id = $3`,
      [tasks[l.taskIdx], l.linkedType, l.linkedId]
    );
    if (exists) continue;
    await one(
      `INSERT INTO "${S}".task_links (task_id, linked_type, linked_id) VALUES ($1,$2,$3) RETURNING id`,
      [tasks[l.taskIdx], l.linkedType, l.linkedId]
    );
  }
  console.log("Tasks:", tasks.length);

  // ── Docs ──────────────────────────────────────────────────────────────────
  // sort_order -1 so this doc wins the docs-index "firstDoc" redirect
  // (orderBy sortOrder asc, createdAt asc) ahead of any pre-existing empty
  // Untitled docs in this workspace, so /docs opens on real content.
  const docTitle = "PRD: AI-Powered Opportunity Clustering";
  const docContent = `## Problem

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
  const docMetadata = {
    status: "In Review",
    owner: "Priya Shah",
    tags: ["ai", "discovery", "q4-planning"],
    targetDate: "2026-09-30",
  };
  const existingDoc = await one(`SELECT id FROM "${S}".docs WHERE workspace_id = $1 AND title = $2`, [ws.id, docTitle]);
  if (!existingDoc) {
    await one(
      `INSERT INTO "${S}".docs (workspace_id, title, content, metadata, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ws.id, docTitle, docContent, JSON.stringify(docMetadata), -1]
    );
  }
  console.log("Docs seeded: 1");

  await pool.end();
  console.log("\n✅ Seed complete!");
}

main().catch((e) => { console.error(e); process.exit(1); });
