import { describe, expect, it } from "vitest";
import { cleanupAccountDeletionMember } from "../e2e/functional/fixtures/account-deletion-cleanup";

function fixtureDatabase(failingTable?: string) {
  const users = new Set(["leaving@localhost.dev", "teammate@localhost.dev"]);
  const memberships = {
    workspace_members: new Set(users),
    organization_members: new Set(users),
  };
  return {
    users,
    memberships,
    async query(sql: string, [email]: string[]) {
      const table = sql.match(/DELETE FROM "compass_dev"\.(\w+)/)?.[1];
      if (table === failingTable) throw new Error("cleanup unavailable");
      if (table === "users") users.delete(email);
      else if (table === "workspace_members" || table === "organization_members") {
        if (users.has(email)) memberships[table].delete(email);
      } else throw new Error(`Unexpected cleanup SQL: ${sql}`);
    },
  };
}

describe("account-deletion fixture cleanup", () => {
  it("leaves no orphan shared membership when the test fails before account deletion", async () => {
    const database = fixtureDatabase();
    await cleanupAccountDeletionMember(database, "leaving@localhost.dev");
    expect([...database.users]).toEqual(["teammate@localhost.dev"]);
    for (const members of Object.values(database.memberships)) {
      expect([...members]).toEqual(["teammate@localhost.dev"]);
    }
    await cleanupAccountDeletionMember(database, "leaving@localhost.dev");
    expect([...database.users]).toEqual(["teammate@localhost.dev"]);
  });

  it("preserves the user and reports a membership cleanup failure", async () => {
    const database = fixtureDatabase("organization_members");
    await expect(cleanupAccountDeletionMember(database, "leaving@localhost.dev")).rejects.toThrow("cleanup unavailable");
    expect(database.users.has("leaving@localhost.dev")).toBe(true);
  });
});
