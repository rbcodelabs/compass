import { build } from "esbuild"
import { fileURLToPath } from "node:url"

export async function packageProbeWorker() {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))], bundle: true,
    platform: "node", target: "node22", format: "cjs", write: false, metafile: true, logLevel: "silent" })
  for (const output of Object.values(result.metafile!.outputs)) {
    if (output.imports.some((dependency) => dependency.external && !dependency.path.startsWith("node:") && !["assert", "buffer", "crypto", "diagnostics_channel", "events", "fs", "http", "https", "net", "os", "path", "perf_hooks", "stream", "string_decoder", "timers", "tls", "url", "util", "zlib"].includes(dependency.path))) throw new Error("UNBUNDLED_WORKER_DEPENDENCY")
  }
  return result.outputFiles[0].contents
}
