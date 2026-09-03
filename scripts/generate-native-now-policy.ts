import { runNativePolicyCli } from "../lib/native-policy-cli"

runNativePolicyCli(process.argv.slice(2)).then((paths) => {
  process.stdout.write(`${JSON.stringify(paths)}\n`)
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Policy generation failed."}\n`)
  process.exitCode = 1
})
