import { resolveTarget, required } from "./resolve";
import { runManagedMigration, releaseManagedClaim } from "./managed-driver";

async function main() {
  const operation = process.argv[2];
  const releasing = operation === "release-claim";
  if (!operation || process.argv.length !== (releasing ? 5 : 3)) throw new Error("Use managed.ts status|initialize|<exact-migration>|release-claim <exact-migration> <claim-id>");
  const target = await resolveTarget();
  // Exact expected SHA is operator-supplied and must match both live providers.
  if (target.sha !== required("PREVIEW_EXPECTED_SHA")) throw new Error("Expected revision changed");
  const secret = required("COMPASS_PREVIEW_MIGRATION_SECRET"), bypass = required("COMPASS_VERCEL_BYPASS_SECRET");
  const result = releasing ? await releaseManagedClaim(target, process.argv[3], process.argv[4], secret, bypass) : await runManagedMigration(target, operation, secret, bypass);
  console.log(JSON.stringify({ target, ...result }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Managed migration driver failed"); process.exitCode = 1; });
