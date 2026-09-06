// No dependencies or target-revision code are needed to report a trusted controller result.
export {}
async function main() {
  const sha = process.env.PREVIEW_STATUS_SHA ?? "", state = process.env.PREVIEW_STATUS_STATE ?? ""
  if (!/^[a-f0-9]{40}$/.test(sha) || /\s/.test(sha) || !["pending", "success", "failure"].includes(state)) throw new Error("Invalid status identity")
  const response = await fetch(`https://api.github.com/repos/rbcodelabs/compass/statuses/${sha}`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ state, context: "compass/preview-validation", description: state === "pending" ? "Validating isolated authenticated preview" : `Authenticated preview validation: ${state}`, target_url: `https://github.com/rbcodelabs/compass/actions/runs/${process.env.GITHUB_RUN_ID}` }) })
  if (!response.ok) throw new Error("Could not publish preview result")
}
main().catch(() => { console.error("Preview status update failed"); process.exitCode = 1 })
