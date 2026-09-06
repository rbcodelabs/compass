import { assertSchema } from "./database"
export function probePasswords(signer: { getDbConnectAuthToken(): Promise<string>; getDbConnectAdminAuthToken(): Promise<string> }) {
  return { runtime: () => signer.getDbConnectAuthToken(), admin: () => signer.getDbConnectAdminAuthToken() }
}
export function assertPermissionReport(schema: string, report: { currentUser: string; canCreate: boolean; outsidePrivileges: number; productionSchemaPrivileges: number; adminConnected: boolean }) {
  assertSchema(schema)
  if (report.currentUser !== `${schema}_runtime` || report.canCreate !== false || report.outsidePrivileges !== 0 || report.productionSchemaPrivileges !== 0 || report.adminConnected !== false) throw new Error("Preview runtime permission boundary failed")
}
