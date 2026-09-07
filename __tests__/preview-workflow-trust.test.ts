import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
const workflow = readFileSync(".github/workflows/preview-validation.yml", "utf8")
it("never runs privileged jobs directly from deployment_status YAML", () => {
  expect(workflow).not.toContain("  deployment_status:")
  expect(workflow).toContain("  workflow_run:")
  expect(workflow).toContain("github.ref == 'refs/heads/main'")
})
it("publishes validation status against the validated PR head", () => {
  expect(workflow).toContain("statuses: write")
  expect(workflow).toContain("needs.validate.outputs.sha")
  expect(workflow).toContain("scripts/preview-automation/status.ts")
})
it("keeps the deployment-revision relay unprivileged and treats artifacts only as data", () => {
  const relay = readFileSync(".github/workflows/preview-relay.yml", "utf8")
  expect(relay).not.toMatch(/\$\{\{[^}]*secrets\./)
  expect(relay).not.toMatch(/^\s+environment:/m)
  expect(relay).not.toContain("actions/checkout")
  expect(relay).toContain("process.env.DEPLOYMENT_URL")
  expect(workflow).toContain("github.event.workflow_run.head_repository.full_name == 'rbcodelabs/compass'")
  expect(workflow).toContain("path: relay-input")
  expect(workflow).not.toContain("ref: relay-input")
})
