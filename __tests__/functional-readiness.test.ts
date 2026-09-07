import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { afterEach, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it("waits for login HTTP readiness rather than admitting a TCP-ready 404 server", async () => {
  vi.stubEnv("E2E_FUNCTIONAL", "1")
  const config = (await import("../playwright.config")).default
  const webServer = config.webServer as { url?: string; port?: number; timeout: number }
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const directory = mkdtempSync(join(tmpdir(), "compass-login-readiness-"))
  try {
    // First /login request sees the same genuine 404 as cold CI. Only the
    // readiness probe should encounter it; the auth test must start after 200.
    writeFileSync(join(directory, "server.cjs"), `let first=true;require('node:http').createServer((req,res)=>{res.statusCode=req.url==='/login'&&first?404:200;first=false;res.end('login');}).listen(${port},'127.0.0.1');`)
    writeFileSync(join(directory, "login.spec.cjs"), `const {test,expect}=require(${JSON.stringify(require.resolve("@playwright/test"))});test('login is ready',async({request})=>{expect((await request.get('http://127.0.0.1:${port}/login')).status()).toBe(200)});`)
    const readiness = webServer.url ? { url: `http://127.0.0.1:${port}${new URL(webServer.url).pathname}` } : { port }
    writeFileSync(join(directory, "playwright.config.cjs"), `module.exports=${JSON.stringify({ testDir: directory, testMatch: "login.spec.cjs", workers: 1, retries: 0, reporter: "line", webServer: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(directory, "server.cjs"))}`, ...readiness, timeout: 10_000 } })};`)
    const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", join(directory, "playwright.config.cjs")], { cwd: directory, encoding: "utf8", timeout: 20_000 })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(webServer.url).toMatch(/\/login$/)
    expect(webServer.port).toBeUndefined()
    expect(webServer.timeout).toBe(120_000)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 25_000)
