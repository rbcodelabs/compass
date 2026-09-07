import { Pool } from "pg"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { assertSchema } from "./database"
import { assertPermissionReport, probePasswords } from "./permissions"
import { required } from "./resolve"
async function main() {
  const schema = required("PREVIEW_SCHEMA"); assertSchema(schema)
  const signer = new DsqlSigner({ hostname: required("PGHOST"), region: required("AWS_REGION"), expiresIn: 900 })
  const passwords = probePasswords(signer)
  const options = { host: required("PGHOST"), database: "postgres", ssl: true, max: 1, connectionTimeoutMillis: 15_000 }
  const runtime = new Pool({ ...options, user: `${schema}_runtime`, password: passwords.runtime })
  const admin = new Pool({ ...options, user: "admin", password: passwords.admin })
  try {
    const identity = (await runtime.query("SELECT current_user AS identity, has_schema_privilege(current_user,$1,'CREATE') AS can_create", [schema])).rows[0]
    const outside = await runtime.query("SELECT COUNT(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ($1,'pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE'))", [schema])
    const production = await runtime.query("SELECT COUNT(*) AS count FROM pg_namespace WHERE nspname LIKE '%\\_prod' ESCAPE '\\' AND (has_schema_privilege(current_user,oid,'USAGE') OR has_schema_privilege(current_user,oid,'CREATE'))")
    let adminConnected = false
    try { await admin.query("SELECT current_user"); adminConnected = true } catch (error) {
      // A timeout/network error is not evidence of denied authorization.
      if (!error || typeof error !== "object" || !("code" in error) || !["28000", "28P01", "42501"].includes(String(error.code))) throw error
    }
    assertPermissionReport(schema, { currentUser: identity.identity, canCreate: identity.can_create, outsidePrivileges: Number(outside.rows[0].count), productionSchemaPrivileges: Number(production.rows[0].count), adminConnected })
    console.log("Preview runtime permission boundary verified")
  } finally { await runtime.end(); await admin.end() }
}
main().catch(() => { console.error("Preview permission probe failed; bootstrap must not proceed"); process.exitCode = 1 })
