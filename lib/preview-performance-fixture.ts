import fs from "node:fs";
import path from "node:path";

export const MAX_DSQL_TRANSACTION_ROWS = 3_000;

export const SEED_ORDER = [
  "users",
  "organizations",
  "organizationMembers",
  "workspaces",
  "workspaceMembers",
  "squads",
  "okrCycles",
  "objectives",
  "keyResults",
  "opportunities",
  "solutions",
  "assumptions",
  "evidence",
  "experiments",
  "roadmapItems",
  "feedback",
  "tasks",
  "sessions",
] as const;

export type PreviewFixtureKind = (typeof SEED_ORDER)[number];

export const CLEANUP_ORDER: readonly PreviewFixtureKind[] = [
  "roadmapItems",
  "evidence",
  "experiments",
  "feedback",
  "tasks",
  "assumptions",
  "solutions",
  "opportunities",
  "keyResults",
  "objectives",
  "okrCycles",
  "squads",
  "sessions",
  "workspaceMembers",
  "organizationMembers",
  "workspaces",
  "organizations",
  "users",
] as const;

export const FIXTURE_COUNTS: Record<PreviewFixtureKind, number> = {
  users: 10,
  organizations: 1,
  organizationMembers: 10,
  workspaces: 1,
  workspaceMembers: 10,
  squads: 5,
  okrCycles: 3,
  objectives: 15,
  keyResults: 60,
  opportunities: 40,
  solutions: 80,
  assumptions: 160,
  evidence: 320,
  experiments: 40,
  roadmapItems: 75,
  feedback: 250,
  tasks: 150,
  sessions: 1,
};

export type PreviewFixtureRow = { id: string; [key: string]: unknown };
export type PreviewFixtureRows = Record<PreviewFixtureKind, PreviewFixtureRow[]>;

export interface PreviewFixtureGuardInput {
  operation: "seed" | "cleanup";
  env: NodeJS.ProcessEnv;
  runId: string;
  requestedDeploymentSha: string;
  verifiedDeploymentSha: string;
  committedSha: string;
  cleanWorktree: boolean;
  deploymentUrl: string;
  deploymentId: string;
  activeSchema: string;
  manifestExists: boolean;
  authStateExists: boolean;
  manifestPathIgnored: boolean;
  authStatePathIgnored: boolean;
}

export interface BuildPreviewFixturePlanInput {
  runId: string;
  deploymentSha: string;
  deploymentUrl: string;
  deploymentId: string;
  schema: "compass_preview";
  createdAt: Date;
  expiresAt: Date;
  sessionToken: string;
  idFactory: () => string;
}

export interface PreviewFixturePlan {
  identity: PreviewFixtureIdentity;
  rows: PreviewFixtureRows;
  sessionToken: string;
}

export interface PreviewFixtureIdentity {
  version: 1;
  runId: string;
  deploymentSha: string;
  deploymentUrl: string;
  deploymentId: string;
  schema: "compass_preview";
  createdAt: string;
  expiresAt: string;
  sentinel: {
    ownerEmail: string;
    organizationSlug: string;
    workspaceSlug: string;
  };
  targets: {
    opportunityTitle: "Performance Opportunity Target";
    roadmapItemTitle: "Performance Roadmap Target";
  };
}

export interface PreviewFixtureManifest {
  identity: PreviewFixtureIdentity;
  status: "seeding" | "ready" | "cleaning";
  counts: Record<PreviewFixtureKind, number>;
  plannedIds: Record<PreviewFixtureKind, string[]>;
  createdIds: Record<PreviewFixtureKind, string[]>;
}

export interface PreviewFixtureStore {
  insert(kind: PreviewFixtureKind, rows: readonly PreviewFixtureRow[]): Promise<void>;
  verifyOwnership(manifest: PreviewFixtureManifest): Promise<void>;
  deleteIds(kind: PreviewFixtureKind, ids: readonly string[]): Promise<void>;
  countResidue(manifest: PreviewFixtureManifest): Promise<number>;
}

interface FixturePaths {
  manifestPath: string;
  authStatePath: string;
}

export function assertPreviewFixtureGuards(input: PreviewFixtureGuardInput): void {
  const { env } = input;
  if (env.VERCEL_ENV !== "preview") throw new Error("Preview fixture requires VERCEL_ENV=preview");
  if (env.COMPASS_PERF_BASELINE !== "1") throw new Error("Preview fixture requires COMPASS_PERF_BASELINE=1");
  if (env.PERF_SERVER_KIND !== "vercel-preview") throw new Error("Preview fixture requires PERF_SERVER_KIND=vercel-preview");
  if (input.activeSchema !== "compass_preview") throw new Error("Active schema must be exactly compass_preview");
  if ((env.PGSCHEMA ?? "compass") !== "compass") throw new Error("PGSCHEMA must resolve exactly to compass_preview");
  if (env.DATABASE_URL) throw new Error("DATABASE_URL is forbidden for the preview DSQL fixture");
  if (env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN) {
    throw new Error("AWS profiles and static AWS credentials are forbidden; Vercel OIDC is required");
  }
  if (!env.PGHOST || !/^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/.test(env.PGHOST)) {
    throw new Error("PGHOST must be an Aurora DSQL endpoint");
  }
  if (!env.AWS_ROLE_ARN) throw new Error("AWS_ROLE_ARN is required for dynamic DSQL credentials");
  if (!env.AWS_REGION) throw new Error("AWS_REGION is required for dynamic DSQL credentials");
  if (!env.VERCEL_OIDC_TOKEN) throw new Error("VERCEL_OIDC_TOKEN is required for dynamic DSQL credentials");
  if (!/^perf_preview_[a-f0-9]{32}$/.test(input.runId)) {
    throw new Error("Preview fixture run ID must contain 128 bits of lowercase randomized hex");
  }
  if (!input.cleanWorktree) throw new Error("Preview fixture requires a clean committed worktree");

  const shas = [
    input.requestedDeploymentSha,
    input.verifiedDeploymentSha,
    input.committedSha,
    env.VERCEL_GIT_COMMIT_SHA,
  ];
  if (shas.some((sha) => !sha || !/^[a-f0-9]{40}$/.test(sha)) || new Set(shas).size !== 1) {
    throw new Error("Requested, verified, Vercel, and clean committed SHA must match exactly");
  }

  let deploymentUrl: URL;
  try {
    deploymentUrl = new URL(input.deploymentUrl);
  } catch {
    throw new Error("Invalid exact preview deployment URL");
  }
  const allowedHost = /^compass-[a-z0-9]+-rbcodelabs-team\.vercel\.app$/;
  if (
    deploymentUrl.protocol !== "https:" ||
    !allowedHost.test(deploymentUrl.hostname) ||
    deploymentUrl.username ||
    deploymentUrl.password ||
    deploymentUrl.port ||
    deploymentUrl.pathname !== "/" ||
    deploymentUrl.search ||
    deploymentUrl.hash
  ) {
    throw new Error("Invalid exact preview deployment URL or host allowlist mismatch");
  }
  if (!/^dpl_[A-Za-z0-9]{20,}$/.test(input.deploymentId)) {
    throw new Error("Invalid exact preview deployment ID");
  }
  if (input.operation === "seed" && input.manifestExists) throw new Error("Recovery manifest already exists; run cleanup instead");
  if (input.operation === "seed" && input.authStateExists) throw new Error("Preview auth state already exists; run cleanup instead");
  if (input.operation === "cleanup" && !input.manifestExists) throw new Error("Cleanup requires an existing recovery manifest");
  if (!input.manifestPathIgnored || !input.authStatePathIgnored) {
    throw new Error("Preview recovery and auth paths must both be ignored by git");
  }
}

export function createConnectorAfterPreviewFixtureGuards<T>(
  input: PreviewFixtureGuardInput,
  createConnector: () => T
): T {
  assertPreviewFixtureGuards(input);
  return createConnector();
}

function createRows(count: number, idFactory: () => string, build: (index: number, id: string) => Omit<PreviewFixtureRow, "id">): PreviewFixtureRow[] {
  return Array.from({ length: count }, (_, index) => {
    const id = idFactory();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
      throw new Error("Fixture ID factory must return UUIDs");
    }
    return { id, ...build(index, id) };
  });
}

export function buildPreviewFixturePlan(input: BuildPreviewFixturePlanInput): PreviewFixturePlan {
  if (!/^perf_preview_[a-f0-9]{32}$/.test(input.runId)) throw new Error("Invalid randomized preview fixture run ID");
  if (input.schema !== "compass_preview") throw new Error("Preview fixture plan requires compass_preview");
  const lifetimeMs = input.expiresAt.getTime() - input.createdAt.getTime();
  if (lifetimeMs < 15 * 60_000 || lifetimeMs > 4 * 60 * 60_000) {
    throw new Error("Preview fixture expiry must be between 15 minutes and 4 hours");
  }
  if (!input.sessionToken) throw new Error("A generated session token is required");

  const slug = input.runId.replaceAll("_", "-");
  const workspaceSlug = `${slug}-workspace`;
  const ownerEmail = `${input.runId}@performance.invalid`;
  const rows = {} as PreviewFixtureRows;

  rows.users = createRows(FIXTURE_COUNTS.users, input.idFactory, (index) => ({
    email: index === 0 ? ownerEmail : `${input.runId}-member-${index + 1}@performance.invalid`,
    name: index === 0 ? `Performance Preview Owner ${input.runId}` : `Performance Preview Member ${index + 1} ${input.runId}`,
  }));
  rows.organizations = createRows(1, input.idFactory, () => ({ slug, name: `Performance Preview Organization ${input.runId}` }));
  rows.organizationMembers = createRows(FIXTURE_COUNTS.organizationMembers, input.idFactory, (index) => ({
    organizationId: rows.organizations[0].id,
    userId: rows.users[index].id,
    role: index === 0 ? "OWNER" : "MEMBER",
  }));
  rows.workspaces = createRows(1, input.idFactory, () => ({
    organizationId: rows.organizations[0].id,
    slug: workspaceSlug,
    name: `Performance Preview Workspace ${input.runId}`,
  }));
  rows.workspaceMembers = createRows(FIXTURE_COUNTS.workspaceMembers, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    userId: rows.users[index].id,
    role: index === 0 ? "OWNER" : "MEMBER",
  }));
  rows.squads = createRows(FIXTURE_COUNTS.squads, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    name: `Perf Squad ${index + 1} ${input.runId}`,
  }));
  rows.okrCycles = createRows(FIXTURE_COUNTS.okrCycles, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    title: `Perf Cycle ${index + 1} ${input.runId}`,
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-12-31T00:00:00.000Z"),
    status: "ACTIVE",
  }));
  rows.objectives = createRows(FIXTURE_COUNTS.objectives, input.idFactory, (index) => ({
    cycleId: rows.okrCycles[index % rows.okrCycles.length].id,
    squadId: rows.squads[index % rows.squads.length].id,
    title: `Perf Objective ${index + 1} ${input.runId}`,
    sortOrder: index,
  }));
  rows.keyResults = createRows(FIXTURE_COUNTS.keyResults, input.idFactory, (index) => ({
    objectiveId: rows.objectives[index % rows.objectives.length].id,
    title: `Perf KR ${index + 1} ${input.runId}`,
    target: 100,
    current: index,
    sortOrder: index,
  }));
  rows.opportunities = createRows(FIXTURE_COUNTS.opportunities, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    squadId: rows.squads[index % rows.squads.length].id,
    linkedKeyResultId: rows.keyResults[index % rows.keyResults.length].id,
    title: index === 0 ? "Performance Opportunity Target" : `Perf Opportunity ${index + 1} ${input.runId}`,
    status: index >= 30 ? "ARCHIVED" : "EXPLORING",
    sortOrder: index,
  }));
  rows.solutions = createRows(FIXTURE_COUNTS.solutions, input.idFactory, (index) => ({
    opportunityId: rows.opportunities[index % rows.opportunities.length].id,
    title: `Perf Solution ${index + 1} ${input.runId}`,
    sortOrder: index,
  }));
  rows.assumptions = createRows(FIXTURE_COUNTS.assumptions, input.idFactory, (index) => ({
    solutionId: rows.solutions[index % rows.solutions.length].id,
    title: `Perf Assumption ${index + 1} ${input.runId}`,
    sortOrder: index,
  }));
  rows.evidence = createRows(FIXTURE_COUNTS.evidence, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    opportunityId: rows.opportunities[index % rows.opportunities.length].id,
    solutionId: rows.solutions[index % rows.solutions.length].id,
    assumptionId: rows.assumptions[index % rows.assumptions.length].id,
    sourceType: "interview",
    excerpt: `Deterministic performance evidence ${index + 1} ${input.runId}`,
  }));
  rows.experiments = createRows(FIXTURE_COUNTS.experiments, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    squadId: rows.squads[index % rows.squads.length].id,
    assumptionId: rows.assumptions[index % rows.assumptions.length].id,
    title: `Perf Experiment ${index + 1} ${input.runId}`,
    hypothesis: "Deterministic hypothesis",
    method: "Prototype",
    killCondition: "No signal",
    sortOrder: index,
  }));
  rows.roadmapItems = createRows(FIXTURE_COUNTS.roadmapItems, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    squadId: rows.squads[index % rows.squads.length].id,
    opportunityId: rows.opportunities[index % rows.opportunities.length].id,
    solutionId: rows.solutions[index % rows.solutions.length].id,
    keyResultId: rows.keyResults[index % rows.keyResults.length].id,
    title: index === 0 ? "Performance Roadmap Target" : `Perf Roadmap ${index + 1} ${input.runId}`,
    horizon: ["NOW", "NEXT", "LATER"][index % 3],
    sortOrder: index,
  }));
  rows.feedback = createRows(FIXTURE_COUNTS.feedback, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    opportunityId: rows.opportunities[index % rows.opportunities.length].id,
    title: `Perf Feedback ${index + 1} ${input.runId}`,
    description: "Deterministic feedback",
    type: index % 4 === 0 ? "BUG" : "IDEA",
    voteCount: index % 20,
  }));
  rows.tasks = createRows(FIXTURE_COUNTS.tasks, input.idFactory, (index) => ({
    workspaceId: rows.workspaces[0].id,
    squadId: rows.squads[index % rows.squads.length].id,
    title: `Perf Task ${index + 1} ${input.runId}`,
    status: ["BACKLOG", "TODO", "IN_PROGRESS", "DONE"][index % 4],
    sortOrder: index,
  }));
  rows.sessions = createRows(1, input.idFactory, () => ({
    sessionToken: input.sessionToken,
    userId: rows.users[0].id,
    expires: input.expiresAt,
  }));

  const ids = Object.values(rows).flatMap((kindRows) => kindRows.map(({ id }) => id));
  if (new Set(ids).size !== ids.length) throw new Error("Fixture ID factory produced duplicate IDs");

  return {
    identity: {
      version: 1,
      runId: input.runId,
      deploymentSha: input.deploymentSha,
      deploymentUrl: input.deploymentUrl,
      deploymentId: input.deploymentId,
      schema: input.schema,
      createdAt: input.createdAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      sentinel: { ownerEmail, organizationSlug: slug, workspaceSlug },
      targets: {
        opportunityTitle: "Performance Opportunity Target",
        roadmapItemTitle: "Performance Roadmap Target",
      },
    },
    rows,
    sessionToken: input.sessionToken,
  };
}

function emptyIds(): Record<PreviewFixtureKind, string[]> {
  return Object.fromEntries(SEED_ORDER.map((kind) => [kind, []])) as unknown as Record<PreviewFixtureKind, string[]>;
}

export function createPreviewFixtureManifest(plan: PreviewFixturePlan): PreviewFixtureManifest {
  for (const kind of SEED_ORDER) {
    if (plan.rows[kind].length !== FIXTURE_COUNTS[kind]) throw new Error(`Preview fixture plan count mismatch for ${kind}`);
  }
  return {
    identity: plan.identity,
    status: "seeding",
    counts: { ...FIXTURE_COUNTS },
    plannedIds: Object.fromEntries(SEED_ORDER.map((kind) => [kind, plan.rows[kind].map(({ id }) => id)])) as Record<PreviewFixtureKind, string[]>,
    createdIds: emptyIds(),
  };
}

function assertPrivateRegularFile(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Private fixture file must be a regular non-symlink: ${filePath}`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`Private fixture file must be owner-only mode 0600: ${filePath}`);
}

export function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) assertPrivateRegularFile(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function readPrivateManifest(filePath: string): unknown {
  assertPrivateRegularFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertManifestShape(value: unknown): asserts value is PreviewFixtureManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid preview fixture manifest");
  const manifest = value as Partial<PreviewFixtureManifest>;
  if (manifest.identity?.version !== 1 || manifest.identity.schema !== "compass_preview") throw new Error("Invalid preview fixture manifest identity");
  if (!manifest.plannedIds || !manifest.createdIds || !manifest.counts) throw new Error("Invalid preview fixture manifest records");
  for (const kind of SEED_ORDER) {
    const planned = manifest.plannedIds[kind];
    const created = manifest.createdIds[kind];
    if (!Array.isArray(planned) || !Array.isArray(created) || manifest.counts[kind] !== FIXTURE_COUNTS[kind]) {
      throw new Error(`Invalid preview fixture manifest records for ${kind}`);
    }
    if (planned.length !== FIXTURE_COUNTS[kind] || created.some((id) => !planned.includes(id))) {
      throw new Error(`Preview fixture manifest cannot prove cleanup targets for ${kind}`);
    }
  }
}

export function parsePreviewFixtureManifest(value: unknown): PreviewFixtureManifest {
  assertManifestShape(value);
  return value;
}

export function createPreviewFixtureAuthState(plan: PreviewFixturePlan): unknown {
  const deployment = new URL(plan.identity.deploymentUrl);
  return {
    cookies: [{
      name: "__Secure-authjs.session-token",
      value: plan.sessionToken,
      domain: deployment.hostname,
      path: "/",
      expires: Math.floor(new Date(plan.identity.expiresAt).getTime() / 1000),
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }],
    origins: [],
  };
}

export async function seedPreviewFixture(options: FixturePaths & { plan: PreviewFixturePlan; store: PreviewFixtureStore }): Promise<void> {
  if (fs.existsSync(options.manifestPath)) throw new Error("Recovery manifest already exists; cleanup is required");
  if (fs.existsSync(options.authStatePath)) throw new Error("Preview auth state already exists; cleanup is required");
  const manifest = createPreviewFixtureManifest(options.plan);
  writePrivateJson(options.manifestPath, manifest);

  try {
    for (const kind of SEED_ORDER) {
      const rows = options.plan.rows[kind];
      if (rows.length > MAX_DSQL_TRANSACTION_ROWS) throw new Error(`${kind} exceeds the DSQL transaction row limit`);
      await options.store.insert(kind, rows);
      manifest.createdIds[kind] = manifest.plannedIds[kind].slice();
      writePrivateJson(options.manifestPath, manifest);
    }
    manifest.status = "ready";
    writePrivateJson(options.manifestPath, manifest);
    writePrivateJson(options.authStatePath, createPreviewFixtureAuthState(options.plan));
  } catch (seedError) {
    const seedMessage = redactSensitiveText(String(seedError), [options.plan.sessionToken]);
    try {
      await cleanupPreviewFixture({
        store: options.store,
        manifestPath: options.manifestPath,
        authStatePath: options.authStatePath,
      });
    } catch (cleanupError) {
      throw new Error(`Preview fixture seed failed: ${seedMessage}; cleanup failed: ${redactSensitiveText(String(cleanupError), [options.plan.sessionToken])}`, { cause: seedError });
    }
    throw new Error(`Preview fixture seed failed: ${seedMessage}`, { cause: seedError });
  }
}

export function redactSensitiveText(text: string, sensitiveValues: readonly (string | undefined)[]): string {
  let redacted = text;
  for (const value of sensitiveValues) if (value) redacted = redacted.replaceAll(value, "[REDACTED]");
  return redacted;
}

export async function cleanupPreviewFixture(options: FixturePaths & { store: PreviewFixtureStore }): Promise<void> {
  if (!fs.existsSync(options.manifestPath)) {
    if (fs.existsSync(options.authStatePath)) throw new Error("Auth state exists without a recovery manifest; refusing unproven cleanup");
    return;
  }
  const manifest = parsePreviewFixtureManifest(readPrivateManifest(options.manifestPath));
  if (fs.existsSync(options.authStatePath)) assertPrivateRegularFile(options.authStatePath);
  await options.store.verifyOwnership(manifest);
  manifest.status = "cleaning";
  writePrivateJson(options.manifestPath, manifest);

  for (const kind of CLEANUP_ORDER) {
    const ids = manifest.plannedIds[kind];
    for (let offset = 0; offset < ids.length; offset += MAX_DSQL_TRANSACTION_ROWS) {
      await options.store.deleteIds(kind, ids.slice(offset, offset + MAX_DSQL_TRANSACTION_ROWS));
    }
  }
  const residue = await options.store.countResidue(manifest);
  if (residue !== 0) throw new Error(`Preview fixture cleanup left ${residue} residue record(s)`);
  fs.rmSync(options.authStatePath, { force: true });
  fs.rmSync(options.manifestPath, { force: true });
}

export function assertManifestMatchesGuard(manifest: PreviewFixtureManifest, guard: PreviewFixtureGuardInput): void {
  const { identity } = manifest;
  if (
    identity.runId !== guard.runId ||
    identity.deploymentSha !== guard.requestedDeploymentSha ||
    identity.deploymentSha !== guard.verifiedDeploymentSha ||
    identity.deploymentSha !== guard.committedSha ||
    identity.deploymentUrl !== guard.deploymentUrl ||
    identity.deploymentId !== guard.deploymentId ||
    identity.schema !== guard.activeSchema
  ) {
    throw new Error("Recovery manifest does not match the re-proven deployment identity");
  }
}
