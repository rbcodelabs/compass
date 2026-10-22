import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of migration 103 (no DDL): create the shared "Compass Agent" in explicitly named workspaces.
 *
 * EXPLICIT-ONLY and TARGETED. The operator names the workspaces in COMPASS_SHARED_AGENT_WORKSPACE_IDS (comma-separated ids);
 * with none named the hook refuses, so it cannot be applied to "all workspaces" by accident and a receipt is never written
 * for a run that did nothing. Every named workspace is validated BEFORE anything is written (it exists, it has an
 * administrator to issue the grant), so a typo cannot leave a half-bootstrapped set.
 *
 * Per workspace, in this order, each step idempotent (find, then write; no ON CONFLICT, which is unproven against DSQL's async
 * unique indexes):
 *   1. the agent   CLOUD, owner_type WORKSPACE, owner_workspace_id = the workspace, named "Compass Agent". Reused if present.
 *   2. the grant   WRITE, granted_by_user_id = a current administrator. A REVOKED grant is left revoked and reported.
 *   3. the default workspace_default_agents row, only if the workspace has none.
 * One statement per write and small transactions of their own: DSQL caps a write transaction at 3,000 rows and this writes at
 * most three.
 *
 * Before the receipt the postcondition proves, for each named workspace: exactly one such agent exists, and a grant row for it
 * in that workspace exists.
 */
export const SHARED_COMPASS_AGENT_BOOTSTRAP_MIGRATION = "103_shared_compass_agent_bootstrap"
export const SHARED_COMPASS_AGENT_NAME = "Compass Agent"
export const SHARED_COMPASS_AGENT_WORKSPACES_ENV = "COMPASS_SHARED_AGENT_WORKSPACE_IDS"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${SHARED_COMPASS_AGENT_BOOTSTRAP_MIGRATION}: ${message}`)

/** The named workspace ids, de-duplicated and lower-cased. Refuses an empty list or a malformed id. */
export function parseBootstrapWorkspaceIds(raw: string | undefined): string[] {
  const ids = (raw ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (ids.length === 0) throw refuse(`name the workspaces to bootstrap in ${SHARED_COMPASS_AGENT_WORKSPACES_ENV} (comma-separated workspace ids); this migration never runs on all workspaces`)
  for (const id of ids) if (!UUID.test(id)) throw refuse(`${SHARED_COMPASS_AGENT_WORKSPACES_ENV} contains a value that is not a workspace id`)
  return [...new Set(ids)]
}

export type BootstrapOutcome = { workspaceId: string; agentId: string; createdAgent: boolean; createdGrant: boolean; grantRevoked: boolean; setDefault: boolean }

/** A current administrator of the workspace: a workspace ADMIN/OWNER member, else an ADMIN/OWNER of its organization. */
async function findAdministrator(client: PoolClient, schema: string, workspaceId: string): Promise<string | null> {
  const member = await client.query<{ user_id: string }>(
    `SELECT user_id FROM "${schema}"."workspace_members" WHERE workspace_id=$1 AND UPPER(role) IN ('ADMIN','OWNER') ORDER BY created_at, user_id LIMIT 1`,
    [workspaceId],
  )
  if (member.rows[0]) return member.rows[0].user_id
  const org = await client.query<{ user_id: string }>(
    `SELECT om.user_id FROM "${schema}"."organization_members" om JOIN "${schema}"."workspaces" w ON w.organization_id=om.organization_id
      WHERE w.id=$1 AND UPPER(om.role) IN ('ADMIN','OWNER') ORDER BY om.created_at, om.user_id LIMIT 1`,
    [workspaceId],
  )
  return org.rows[0]?.user_id ?? null
}

/** Refuses unless the schema has what the bootstrap writes to: migrations 098, 099 and 101. */
async function assertPrerequisites(client: PoolClient, schema: string) {
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND
      ((table_name='agents' AND column_name IN ('kind','owner_type','owner_workspace_id','invoke_policy','owner_user_id')) OR table_name='workspace_default_agents')`,
    [schema],
  )
  const have = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`))
  for (const column of ["kind", "owner_type", "owner_workspace_id", "invoke_policy"]) if (!have.has(`agents.${column}`)) throw refuse("apply migration 098 first")
  if (columns.rows.find((row) => row.table_name === "agents" && row.column_name === "owner_user_id")?.is_nullable !== "YES") throw refuse("apply migration 099 first")
  if (![...have].some((key) => key.startsWith("workspace_default_agents."))) throw refuse("apply migration 101 first")
}

export async function bootstrapSharedCompassAgent(client: PoolClient, schema: string, log: string[], workspaceIds = parseBootstrapWorkspaceIds(process.env[SHARED_COMPASS_AGENT_WORKSPACES_ENV])): Promise<BootstrapOutcome[]> {
  await assertPrerequisites(client, schema)

  // Validate everything first: nothing is written for any workspace unless every named workspace can be bootstrapped.
  const admins = new Map<string, string>()
  for (const workspaceId of workspaceIds) {
    const exists = await client.query(`SELECT 1 FROM "${schema}"."workspaces" WHERE id=$1`, [workspaceId])
    if (exists.rows.length === 0) throw refuse(`workspace ${workspaceId} does not exist`)
    const admin = await findAdministrator(client, schema, workspaceId)
    if (!admin) throw refuse(`workspace ${workspaceId} has no administrator to issue the agent's grant`)
    admins.set(workspaceId, admin)
  }

  const outcomes: BootstrapOutcome[] = []
  for (const workspaceId of workspaceIds) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM "${schema}"."agents" WHERE owner_type='WORKSPACE' AND owner_workspace_id=$1 AND kind='CLOUD' AND name=$2 ORDER BY created_at, id`,
      [workspaceId, SHARED_COMPASS_AGENT_NAME],
    )
    if (existing.rows.length > 1) throw refuse(`workspace ${workspaceId} already has ${existing.rows.length} agents named "${SHARED_COMPASS_AGENT_NAME}"; resolve that by hand`)
    let agentId = existing.rows[0]?.id
    const createdAgent = !agentId
    if (!agentId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO "${schema}"."agents" (name, description, status, kind, owner_type, owner_workspace_id, invoke_policy, created_at, updated_at)
          VALUES ($1, $2, 'ACTIVE', 'CLOUD', 'WORKSPACE', $3, 'WORKSPACE_MEMBERS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
        [SHARED_COMPASS_AGENT_NAME, "The workspace's shared assistant.", workspaceId],
      )
      agentId = created.rows[0].id
    }

    const grant = await client.query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM "${schema}"."agent_workspace_grants" WHERE agent_id=$1 AND workspace_id=$2`, [agentId, workspaceId])
    let createdGrant = false
    if (grant.rows.length === 0) {
      await client.query(
        `INSERT INTO "${schema}"."agent_workspace_grants" (agent_id, workspace_id, access, granted_by_user_id, created_at, updated_at)
          VALUES ($1, $2, 'WRITE', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [agentId, workspaceId, admins.get(workspaceId)],
      )
      createdGrant = true
    }
    const grantRevoked = grant.rows.length > 0 && grant.rows[0].revoked_at !== null

    let setDefault = false
    // A revoked grant means an administrator took the agent away on purpose; making it the default would only hide that.
    if (!grantRevoked) {
      const current = await client.query(`SELECT 1 FROM "${schema}"."workspace_default_agents" WHERE workspace_id=$1`, [workspaceId])
      if (current.rows.length === 0) {
        await client.query(
          `INSERT INTO "${schema}"."workspace_default_agents" (workspace_id, agent_id, set_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [workspaceId, agentId, admins.get(workspaceId)],
        )
        setDefault = true
      }
    }
    outcomes.push({ workspaceId, agentId, createdAgent, createdGrant, grantRevoked, setDefault })
    log.push(`  ${workspaceId}: agent ${createdAgent ? "created" : "reused"}, grant ${createdGrant ? "created" : grantRevoked ? "left REVOKED" : "kept"}, default ${setDefault ? "set" : "unchanged"}`)
  }
  return outcomes
}

/** Postcondition run before the receipt: each named workspace has exactly one shared Compass Agent and a grant row for it. */
export async function assertSharedCompassAgentBootstrap(client: PoolClient, schema: string, workspaceIds = parseBootstrapWorkspaceIds(process.env[SHARED_COMPASS_AGENT_WORKSPACES_ENV])) {
  for (const workspaceId of workspaceIds) {
    const agents = await client.query<{ id: string }>(
      `SELECT id FROM "${schema}"."agents" WHERE owner_type='WORKSPACE' AND owner_workspace_id=$1 AND kind='CLOUD' AND name=$2`,
      [workspaceId, SHARED_COMPASS_AGENT_NAME],
    )
    if (agents.rows.length !== 1) throw new Error(`Migration 103 postcondition failed: workspace ${workspaceId} has ${agents.rows.length} shared "${SHARED_COMPASS_AGENT_NAME}" agents, expected 1`)
    const grants = await client.query(`SELECT 1 FROM "${schema}"."agent_workspace_grants" WHERE agent_id=$1 AND workspace_id=$2`, [agents.rows[0].id, workspaceId])
    if (grants.rows.length !== 1) throw new Error(`Migration 103 postcondition failed: workspace ${workspaceId} has no grant row for its shared agent`)
  }
}

/**
 * What the runner calls. With workspaces named: bootstrap them, then prove it. With none named: refuse, EXCEPT on a schema that
 * has no workspaces at all (a freshly provisioned preview applies explicit-only migrations in order, and there is nothing to
 * bootstrap there). A schema with workspaces and no names is exactly the "all workspaces by accident" case this guards against.
 */
export async function runSharedCompassAgentBootstrap(client: PoolClient, schema: string, log: string[], env: Record<string, string | undefined> = process.env) {
  const named = env[SHARED_COMPASS_AGENT_WORKSPACES_ENV]
  if (!named?.trim()) {
    const workspaces = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${schema}"."workspaces"`)
    if (Number(workspaces.rows[0]?.n ?? "0") === 0) {
      log.push("  no workspaces in this schema: nothing to bootstrap")
      return
    }
  }
  const workspaceIds = parseBootstrapWorkspaceIds(named)
  await bootstrapSharedCompassAgent(client, schema, log, workspaceIds)
  await assertSharedCompassAgentBootstrap(client, schema, workspaceIds)
}
