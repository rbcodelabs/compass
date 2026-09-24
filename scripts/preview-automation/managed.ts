import { resolveTarget, required } from "./resolve";
import { runManagedMigration } from "./managed-driver";

async function main() {
  const operation = process.argv[2];
  if (!operation || process.argv.length !== 3) throw new Error("Use managed.ts status|initialize|<exact-migration>");
  const target = await resolveTarget();
  // Exact expected SHA is operator-supplied and must match both live providers.
  if (target.sha !== required("PREVIEW_EXPECTED_SHA")) throw new Error("Expected revision changed");
  const result = await runManagedMigration(target, operation, required("COMPASS_PREVIEW_MIGRATION_SECRET"), required("COMPASS_VERCEL_BYPASS_SECRET"));
  console.log(JSON.stringify({ target, ...result }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Managed migration driver failed"); process.exitCode = 1; });
