import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertIsolatedE2EDatabase, isolatedE2EConnectionString } from "./isolated-database";

/** Synthetic Updates fixtures, confined to the wrapper's disposable workspace. */
export async function updatesFixture() {
  await assertIsolatedE2EDatabase();
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const { rows: [workspace] } = await pool.query<{ id: string }>(
    `SELECT w.id FROM compass_dev.workspaces w
     JOIN compass_dev.organizations o ON o.id=w.organization_id
     WHERE o.slug='e2e-test-org' AND w.slug='e2e-workspace'`,
  );
  if (!workspace) { await pool.end(); throw new Error("Missing guarded E2E workspace"); }
  const taskIds: string[] = [];
  const clear = async () => {
    for (const table of ["workspace_update_events", "workspace_updates_read_state", "workspace_updates_state"]) {
      await pool.query(`DELETE FROM compass_dev.${table} WHERE workspace_id=$1`, [workspace.id]);
    }
  };
  await clear();
  return {
    workspaceId: workspace.id,
    async task(title: string, parentTaskId?: string) {
      const id = randomUUID();
      await pool.query(`INSERT INTO compass_dev.tasks
        (id, workspace_id, title, parent_task_id) VALUES ($1,$2,$3,$4)`,
      [id, workspace.id, title, parentTaskId ?? null]);
      taskIds.push(id);
      return id;
    },
    async event(taskId: string, options: { groupId?: string; kind?: string; after?: string; daysAgo?: number } = {}) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [state] } = await client.query<{ revision: number }>(
          `INSERT INTO compass_dev.workspace_updates_state (workspace_id,revision) VALUES ($1,1)
           ON CONFLICT (workspace_id) DO UPDATE SET revision=compass_dev.workspace_updates_state.revision+1
           RETURNING revision`, [workspace.id],
        );
        await client.query(`INSERT INTO compass_dev.workspace_update_events
          (id,workspace_id,revision,entity_type,entity_id,group_type,group_id,kind,actor_type,"after",created_at)
          VALUES ($1,$2,$3,'TASK',$4,'TASK',$5,$6,'SYSTEM',$7,$8)`,
        [randomUUID(), workspace.id, state.revision, taskId, options.groupId ?? taskId,
          options.kind ?? "CREATED", options.after ?? null,
          new Date(Date.now() - (options.daysAgo ?? 0) * 86_400_000)]);
        await client.query("COMMIT");
        return state.revision;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async readState() {
      return (await pool.query<{ caught_up_revision: number; version: string }>(
        `SELECT caught_up_revision,version FROM compass_dev.workspace_updates_read_state WHERE workspace_id=$1`,
        [workspace.id],
      )).rows;
    },
    async cleanup() {
      try {
        await clear();
        await pool.query("DELETE FROM compass_dev.tasks WHERE id=ANY($1::uuid[])", [taskIds]);
      } finally { await pool.end(); }
    },
  };
}
