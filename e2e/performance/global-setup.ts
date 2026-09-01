import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { assertSafeLocalPerformanceDatabase } from "../../lib/performance-baseline";

const statePath = path.resolve(".performance-baseline/run.json");

function withSchema(connectionString: string, schema: string) {
  const url = new URL(connectionString);
  url.searchParams.set("schema", schema);
  return url.toString();
}

export async function setupPerformanceDatabase() {
  if (process.env.PERF_SERVER_KIND !== "local-production") return;
  if (process.env.PERF_EXTERNALLY_MANAGED !== "1") throw new Error("Local performance setup requires the external runner");
  process.loadEnvFile?.(path.resolve(".env.local"));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the local performance lane");
  const runToken = crypto.randomUUID();
  const schema = `compass_perf_${runToken.replaceAll("-", "").slice(0, 16)}`;
  assertSafeLocalPerformanceDatabase(databaseUrl, schema);
  const scopedUrl = withSchema(databaseUrl, schema);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    execFileSync("pnpm", ["prisma", "db", "push", "--skip-generate"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: scopedUrl } });
  } catch (error) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    throw error;
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  try {
    await pool.query(`CREATE TABLE "${schema}"."_compass_perf_sentinel" (run_token text PRIMARY KEY)`);
    await pool.query(`INSERT INTO "${schema}"."_compass_perf_sentinel" (run_token) VALUES ($1)`, [runToken]);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ schema, runToken }));
    const user = await prisma.user.create({ data: { email: "perf@localhost.dev", name: "Performance User" } });
    const org = await prisma.organization.create({ data: { slug: "perf-org", name: "Performance Org" } });
    const workspace = await prisma.workspace.create({ data: { organizationId: org.id, slug: "perf-workspace", name: "Performance Workspace" } });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER" } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    for (let i = 2; i <= 10; i++) {
      const member = await prisma.user.create({ data: { email: `perf-member-${i}@localhost.dev`, name: `Performance Member ${i}` } });
      await prisma.organizationMember.create({ data: { organizationId: org.id, userId: member.id, role: "MEMBER" } });
      await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: member.id, role: "MEMBER" } });
    }
    const sessionToken = crypto.randomUUID();
    await prisma.session.create({ data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 86_400_000) } });
    const squads = await Promise.all(Array.from({ length: 5 }, (_, i) => prisma.squad.create({ data: { workspaceId: workspace.id, name: `Perf Squad ${i + 1}` } })));
    const cycles = await Promise.all(Array.from({ length: 3 }, (_, i) => prisma.oKRCycle.create({ data: { workspaceId: workspace.id, title: `Perf Cycle ${i + 1}`, startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), status: "ACTIVE" } })));
    const objectives: Array<{ id: string }> = [];
    for (let i = 0; i < 15; i++) objectives.push(await prisma.objective.create({ data: { cycleId: cycles[i % 3].id, squadId: squads[i % 5].id, title: `Perf Objective ${i + 1}`, sortOrder: i } }));
    const keyResults: Array<{ id: string }> = [];
    for (let i = 0; i < 60; i++) keyResults.push(await prisma.keyResult.create({ data: { objectiveId: objectives[i % 15].id, title: `Perf KR ${i + 1}`, target: 100, current: i, sortOrder: i } }));
    const opportunities: Array<{ id: string }> = [];
    for (let i = 0; i < 40; i++) opportunities.push(await prisma.opportunity.create({ data: { workspaceId: workspace.id, squadId: squads[i % 5].id, linkedKeyResultId: keyResults[i % 60].id, title: i === 0 ? "Performance Opportunity Target" : `Perf Opportunity ${i + 1}`, status: i >= 30 ? "ARCHIVED" : "EXPLORING", sortOrder: i } }));
    const solutions: Array<{ id: string }> = [];
    for (let i = 0; i < 80; i++) solutions.push(await prisma.solution.create({ data: { opportunityId: opportunities[i % 40].id, title: `Perf Solution ${i + 1}`, sortOrder: i } }));
    const assumptions: Array<{ id: string }> = [];
    for (let i = 0; i < 160; i++) assumptions.push(await prisma.assumption.create({ data: { solutionId: solutions[i % 80].id, title: `Perf Assumption ${i + 1}`, sortOrder: i } }));
    await prisma.evidence.createMany({ data: Array.from({ length: 320 }, (_, i) => ({ workspaceId: workspace.id, opportunityId: opportunities[i % 40].id, solutionId: solutions[i % 80].id, assumptionId: assumptions[i % 160].id, sourceType: "interview", excerpt: `Deterministic performance evidence ${i + 1}` })) });
    await prisma.experiment.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ workspaceId: workspace.id, squadId: squads[i % 5].id, assumptionId: assumptions[i % 160].id, title: `Perf Experiment ${i + 1}`, hypothesis: "Deterministic hypothesis", method: "Prototype", killCondition: "No signal", sortOrder: i })) });
    await prisma.roadmapItem.createMany({ data: Array.from({ length: 75 }, (_, i) => ({ workspaceId: workspace.id, squadId: squads[i % 5].id, opportunityId: opportunities[i % 40].id, solutionId: solutions[i % 80].id, keyResultId: keyResults[i % 60].id, title: i === 0 ? "Performance Roadmap Target" : `Perf Roadmap ${i + 1}`, horizon: ["NOW","NEXT","LATER"][i % 3], sortOrder: i })) });
    await prisma.feedbackItem.createMany({ data: Array.from({ length: 250 }, (_, i) => ({ workspaceId: workspace.id, opportunityId: opportunities[i % 40].id, title: `Perf Feedback ${i + 1}`, description: "Deterministic feedback", type: i % 4 === 0 ? "BUG" : "IDEA", voteCount: i % 20 })) });
    await prisma.task.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ workspaceId: workspace.id, squadId: squads[i % 5].id, title: `Perf Task ${i + 1}`, status: ["BACKLOG","TODO","IN_PROGRESS","DONE"][i % 4], sortOrder: i })) });
    const authPath = path.resolve("e2e/performance/.auth/user.json");
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ cookies: [{ name: "authjs.session-token", value: sessionToken, domain: "localhost", path: "/", expires: Math.floor(Date.now()/1000)+86400, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
    fs.chmodSync(authPath, 0o600);
    process.env.PERF_ORG_SLUG = "perf-org";
    process.env.PERF_WORKSPACE_SLUG = "perf-workspace";
    process.env.PERF_OPPORTUNITY_TITLE = "Performance Opportunity Target";
    process.env.PERF_ROADMAP_ITEM_TITLE = "Performance Roadmap Target";
  } catch (error) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    fs.rmSync(statePath, { force: true });
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
  return { schema, runToken };
}

export default async function globalSetup() {
  if (process.env.PERF_EXTERNALLY_MANAGED === "1") return;
  await setupPerformanceDatabase();
}
