import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete environment[key]
let temporaryRoot
let repository

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repository, env: environment, encoding: 'utf8', ...options })
}

function git(...args) {
  const result = run('git', args)
  assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function stage(content, filename = 'config.ts') {
  writeFileSync(join(repository, filename), content)
  git('add', filename)
}

function commit() {
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic fixture')
}

function hook(options) {
  return run('sh', [join(sourceRoot, 'scripts/hooks/pre-commit')], options)
}

function scanHistory(extra = []) {
  return run('gitleaks', ['git', '.', '--log-opts=--all', '--config', '.gitleaks.toml', '--redact', '--no-banner', '--log-level', 'error', ...extra])
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'compass-secret-test-'))
  repository = join(temporaryRoot, 'repo')
  mkdirSync(repository)
  git('init', '-q')
  git('config', 'user.name', 'Synthetic test')
  git('config', 'user.email', 'test@example.invalid')
  copyFileSync(join(sourceRoot, '.gitleaks.toml'), join(repository, '.gitleaks.toml'))
  stage('export const ready = true\n')
  git('add', '.gitleaks.toml')
  commit()
})

afterEach(() => rmSync(temporaryRoot, { recursive: true, force: true }))

// Construct disposable values at runtime: the test source itself contains no credentials.
const syntheticSecret = () => randomBytes(16).toString('hex')
const header = 'x-vercel-protection-bypass'
const variable = 'VERCEL_AUTOMATION_BYPASS_SECRET'

for (const [name, render] of [
  ['single-quoted header', value => `'${header}': '${value}'`],
  ['double-quoted header', value => `"${header}": "${value}"`],
  ['multiline header', value => `'${header}':\n  '${value}'`],
  ['template literal header', value => `'${header}': \`${value}\``],
  ['Headers.set literal', value => `headers.set('${header}', '${value}')`],
  ['curl header literal', value => `curl -H "${header}: ${value}" https://example.invalid`],
  ['quoted environment assignment', value => `${variable}="${value}"`],
  ['unquoted environment assignment', value => `${variable}=${value}`],
  ['multiline environment assignment', value => `${variable} =\n '${value}'`],
  ['Compass harness environment assignment', value => `COMPASS_VERCEL_BYPASS_SECRET='${value}'`],
  ['MCP bypass environment assignment', value => `MCP_BYPASS_SECRET='${value}'`],
]) {
  test(`blocks ${name} locally and in history`, () => {
    const value = syntheticSecret()
    stage(`${render(value)}\n`)
    const result = hook()
    assert.equal(result.status, 1, 'pre-commit must reject the synthetic bypass credential')
    assert.ok(!(result.stdout + result.stderr).includes(value), 'hook must redact values')
    commit()
    const historical = scanHistory()
    assert.equal(historical.status, 1, 'history scan must reject the synthetic bypass credential')
    assert.ok(!(historical.stdout + historical.stderr).includes(value), 'CI must redact values')
  })
}

test('allows environment references and empty values', () => {
  stage(`const headers = { '${header}': process.env.${variable} }\nconst secret = process.env.${variable}\n${variable}=''\n${variable}=\nconst env = { MCP_BYPASS_SECRET: syntheticRuntimeSecretReference, SPIKE_MCP_BYPASS_SECRET: syntheticRuntimeSecretReference }\n`)
  assert.equal(hook().status, 0)
  commit()
  assert.equal(scanHistory().status, 0)
})

test('scans tracked files even when their names are gitignored', () => {
  stage('config.ts\n', '.gitignore')
  stage(`'${header}': '${syntheticSecret()}'\n`)
  assert.equal(hook().status, 1)
})

test('retains default token detection and narrow fixture exceptions', () => {
  mkdirSync(join(repository, '__tests__'))
  const fixtureKey = ['voice', 'hangup', '0001'].join('-')
  stage(`const fixture = { idempotencyKey: "${fixtureKey}" }\n`, '__tests__/fixture.ts')
  assert.equal(hook().status, 0, 'the existing idempotency fixture exception remains valid')
  const token = 'ghp_' + randomBytes(18).toString('hex')
  stage(`const credential = '${token}'\n`, '__tests__/fixture.ts')
  const result = hook()
  assert.equal(result.status, 1, 'a provider token in a test file must still be detected')
  assert.ok(!(result.stdout + result.stderr).includes(token))
})

test('scans the index when an unstaged edit hides a staged secret', () => {
  stage(`'${header}': '${syntheticSecret()}'\n`)
  writeFileSync(join(repository, 'config.ts'), `export const secret = process.env.${variable}\n`)
  assert.equal(hook().status, 1)
})

test('ignores an unstaged secret when the staged content is safe', () => {
  stage(`export const secret = process.env.${variable}\n`)
  writeFileSync(join(repository, 'config.ts'), `'${header}': '${syntheticSecret()}'\n`)
  assert.equal(hook().status, 0)
})

test('detects a value added far below an existing multiline header', () => {
  stage(`'${header}':\n${'\n'.repeat(12)}process.env.${variable}\n`)
  commit()
  stage(`'${header}':\n${'\n'.repeat(12)}'${syntheticSecret()}'\n`)
  assert.equal(hook().status, 1)
})

test('blocks when gitleaks is missing', () => {
  const binaryDirectory = join(temporaryRoot, 'bin')
  mkdirSync(binaryDirectory)
  for (const name of ['git', 'mktemp', 'rm']) symlinkSync(`/usr/bin/${name}`, join(binaryDirectory, name))
  const result = run('/bin/sh', [join(sourceRoot, 'scripts/hooks/pre-commit')], { env: { ...environment, PATH: binaryDirectory } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not installed/)
})

test('blocks scanner errors such as invalid configuration', () => {
  stage('not valid TOML [[', '.gitleaks.toml')
  assert.equal(hook().status, 1)
})

test('unstaged configuration cannot disable staged detection', () => {
  stage(`'${header}': '${syntheticSecret()}'\n`)
  writeFileSync(join(repository, '.gitleaks.toml'), 'title = "empty rules"\n[[rules]]\nid = "never"\nregex = "impossible-secret-match"\n')
  assert.equal(hook().status, 1)
})

test('a historical fingerprint exception does not allow the same value in a new commit', () => {
  const content = `'${header}': '${syntheticSecret()}'\n`
  stage(content)
  commit()
  const reportPath = join(temporaryRoot, 'findings.json')
  assert.equal(scanHistory(['--report-format', 'json', '--report-path', reportPath]).status, 1)
  const findings = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.ok(findings.length > 0)
  writeFileSync(join(repository, '.gitleaksignore'), findings.map(finding => finding.Fingerprint).join('\n') + '\n')
  assert.equal(scanHistory().status, 0, 'the exact historical findings may be acknowledged')
  stage('export const safe = true\n')
  commit()
  stage(content)
  assert.equal(hook().status, 1, 'historical exceptions must not excuse a staged reintroduction')
  commit()
  assert.equal(scanHistory().status, 1, 'the same value in a different commit must still fail CI')
})
