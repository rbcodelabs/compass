import { expect, it, vi } from "vitest"
import { assertPermissionReport, probePasswords } from "../scripts/preview-automation/permissions"
it("tests admin authorization with the admin action using the same identity", async () => {
  const signer = { getDbConnectAuthToken: vi.fn().mockResolvedValue("runtime"), getDbConnectAdminAuthToken: vi.fn().mockResolvedValue("admin") }
  const passwords = probePasswords(signer)
  expect(await passwords.runtime()).toBe("runtime")
  expect(await passwords.admin()).toBe("admin")
  expect(signer.getDbConnectAuthToken).toHaveBeenCalledTimes(1)
  expect(signer.getDbConnectAdminAuthToken).toHaveBeenCalledTimes(1)
})
it("requires exact runtime identity, no DDL, no outside-schema table privilege, and denied admin login", () => {
  const schema = "compass_pr_1_aaaaaaaaaaaa"
  const report = { currentUser: `${schema}_runtime`, canCreate: false, outsidePrivileges: 0, productionSchemaPrivileges: 0, adminConnected: false }
  expect(() => assertPermissionReport(schema, report)).not.toThrow()
  for (const patch of [{ currentUser: "admin" }, { canCreate: true }, { outsidePrivileges: 1 }, { productionSchemaPrivileges: 1 }, { adminConnected: true }]) expect(() => assertPermissionReport(schema, { ...report, ...patch })).toThrow()
})
