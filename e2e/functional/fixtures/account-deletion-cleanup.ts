interface CleanupDatabase {
  query(sql: string, values: string[]): Promise<unknown>;
}

/** Remove shared memberships before deleting a failed account-deletion fixture. */
export async function cleanupAccountDeletionMember(database: CleanupDatabase, email: string) {
  // The isolated schema has no database foreign keys/cascades. Keep the user
  // until both membership deletes succeed, including when an assertion failed.
  for (const table of ["workspace_members", "organization_members"]) {
    await database.query(
      `DELETE FROM "compass_dev".${table} WHERE user_id IN (SELECT id FROM "compass_dev".users WHERE email = $1)`,
      [email],
    );
  }
  await database.query('DELETE FROM "compass_dev".users WHERE email = $1', [email]);
}
