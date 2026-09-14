// The pre-launch command line, end to end, as a person or an agent runs it.
//
// Every run here happens in a copy of a fixture placed outside this repository, for one reason:
// three of the hygiene checks shell out to git, and a fixture sitting inside this working tree
// would report *this* repository's state — a dirty tree here would fail a test about a fixture.
// Outside any work tree those three skip with a reason, which is the honest answer and the one the
// rest of the gate is asserted around.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { REPO_ROOT } from './helpers.mjs'
import { PASSING, FAILING, PASSING_URL, FAILING_URL, copyFixture } from './pre-launch-helpers.mjs'

const run = promisify(execFile)
const SCRIPT = join(REPO_ROOT, 'skills', 'pre-launch', 'scripts', 'pre-launch.mjs')

async function cli(args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: cwd ?? REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }
  }
}

test('--help lists every flag and the testing hooks, and exits 0', async () => {
  const { code, stdout } = await cli(['--help'])
  assert.equal(code, 0)
  for (const flag of ['--dir', '--production-url', '--predecessor-url', '--build-dir', '--required-env', '--dev-host', '--strict', '--skip-build', '--confirm', '--progress', '--reset-progress', '--out', '--json', '--config']) {
    assert.ok(stdout.includes(flag), `--help does not mention ${flag}`)
  }
  assert.match(stdout, /NODE_VERSION_OVERRIDE/)
  assert.match(stdout, /Exit codes/)
})

test('a missing --production-url is a usage error, exit 2', async () => {
  const { code, stderr } = await cli(['--dir', PASSING, '--skip-build'])
  assert.equal(code, 2)
  assert.match(stderr, /--production-url/)
})

test('a --production-url that is not a url is a usage error, exit 2', async () => {
  const { code, stderr } = await cli(['--dir', PASSING, '--production-url', 'passing.test', '--skip-build'])
  assert.equal(code, 2)
  assert.match(stderr, /url/i)
})

test('the passing fixture exits 0 and leads with the verdict', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-pass')
  try {
    const out = join(dir, 'bundle')
    const { code, stdout } = await cli(['--dir', dir, '--production-url', PASSING_URL, '--skip-build', '--out', out])
    assert.equal(code, 0, stdout)
    assert.match(stdout.split('\n')[0], /^GATE: PASS/)
    assert.match(stdout, /Not covered/)
    assert.match(stdout, /Next human item/)
    assert.ok(existsSync(join(out, 'report.md')))
  } finally { cleanup() }
})

test('the real build runs when --skip-build is absent, and the gate still passes', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-build')
  try {
    rmSync(join(dir, 'dist'), { recursive: true, force: true })
    const { code, stdout } = await cli(['--dir', dir, '--production-url', PASSING_URL, '--out', join(dir, 'bundle')])
    assert.equal(code, 0, `${stdout}`)
    assert.equal(stdout.includes('build.succeeds'), false, 'the build check did not fire')
    assert.ok(existsSync(join(dir, 'dist', 'index.html')), 'the build wrote the output the gate then read')
  } finally { cleanup() }
})

test('the failing fixture exits 1 and says how many checks failed', async () => {
  const { dir, cleanup } = copyFixture(FAILING, 'cli-fail')
  try {
    const { code, stdout } = await cli(['--dir', dir, '--production-url', FAILING_URL, '--skip-build', '--required-env', 'PUBLIC_API_BASE', '--out', join(dir, 'bundle')])
    assert.equal(code, 1)
    assert.match(stdout.split('\n')[0], /^GATE: FAIL — \d+ failing checks?/)
    assert.match(stdout, /output\.index-html/)
    assert.match(stdout, /placeholders\.required-env/)
  } finally { cleanup() }
})

test('--json prints the results object and nothing else', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-json')
  try {
    const { code, stdout } = await cli(['--dir', dir, '--production-url', PASSING_URL, '--skip-build', '--json', '--out', join(dir, 'bundle')])
    assert.equal(code, 0)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.gate, 'pass')
    assert.ok(Array.isArray(parsed.checks))
    assert.ok(Array.isArray(parsed.human_items))
    assert.ok(Array.isArray(parsed.notCovered))
    assert.equal(typeof parsed.bundleDir, 'string')
    assert.equal(parsed.pm, 'npm')
    assert.equal(parsed.framework.name, 'astro')
  } finally { cleanup() }
})

test('--strict turns the source-map advisory into a failure and nothing else', async () => {
  const { dir, cleanup } = copyFixture(FAILING, 'cli-strict')
  try {
    const args = ['--dir', dir, '--production-url', FAILING_URL, '--skip-build', '--json', '--out', join(dir, 'bundle')]
    const lenient = JSON.parse((await cli(args)).stdout)
    const strict = JSON.parse((await cli([...args, '--strict'])).stdout)
    const status = (results, id) => results.checks.find((c) => c.id === id).status
    assert.equal(status(lenient, 'placeholders.source-maps'), 'advisory')
    assert.equal(status(strict, 'placeholders.source-maps'), 'fail')
    for (const check of lenient.checks) {
      if (check.id === 'placeholders.source-maps') continue
      assert.equal(status(strict, check.id), check.status, check.id)
    }
  } finally { cleanup() }
})

test('a .launch.json in the directory supplies the flags', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-config')
  try {
    const { code, stdout } = await cli(['--config', join(dir, '.launch.json'), '--dir', dir, '--skip-build', '--json', '--out', join(dir, 'bundle')])
    assert.equal(code, 0)
    assert.equal(JSON.parse(stdout).gate, 'pass')
  } finally { cleanup() }
})

test('--progress, --confirm and --reset-progress round-trip without running the gate', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-progress')
  try {
    const empty = await cli(['--dir', dir, '--progress'])
    assert.equal(empty.code, 0)
    assert.match(empty.stdout, /☐ forms/)

    const confirmed = await cli(['--dir', dir, '--confirm', 'forms'])
    assert.equal(confirmed.code, 0)
    assert.match(confirmed.stdout, /✓ forms/)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.launch-progress.json'), 'utf8')).confirmed, ['forms'])

    const bad = await cli(['--dir', dir, '--confirm', 'nonsense'])
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /nonsense/)

    const reset = await cli(['--dir', dir, '--reset-progress'])
    assert.equal(reset.code, 0)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.launch-progress.json'), 'utf8')).confirmed, [])
  } finally { cleanup() }
})

test('a confirmed item shows as confirmed in the next gate run and is not the next item offered', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-confirmed')
  try {
    await cli(['--dir', dir, '--confirm', 'forms'])
    const { stdout } = await cli(['--dir', dir, '--production-url', PASSING_URL, '--skip-build', '--out', join(dir, 'bundle')])
    assert.match(stdout, /Next human item: analytics/)
  } finally { cleanup() }
})

test('NODE_VERSION_OVERRIDE is honoured, so the engines check is testable', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-node')
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, '--dir', dir, '--production-url', PASSING_URL, '--skip-build', '--json', '--out', join(dir, 'bundle')], {
      env: { ...process.env, NODE_VERSION_OVERRIDE: 'v18.0.0' },
      maxBuffer: 32 * 1024 * 1024,
    }).catch((e) => ({ stdout: e.stdout }))
    const results = JSON.parse(stdout)
    assert.equal(results.checks.find((c) => c.id === 'hygiene.node-version').status, 'fail')
  } finally { cleanup() }
})

test('a bad --dir is an IO error, exit 2', async () => {
  const { code, stderr } = await cli(['--dir', join(REPO_ROOT, 'no', 'such', 'place'), '--production-url', PASSING_URL, '--skip-build'])
  assert.equal(code, 2)
  assert.match(stderr, /error:/)
})

test('the script never writes into the repository it is auditing beyond its two outputs', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'cli-readonly')
  try {
    const before = readFileSync(join(dir, 'dist', 'index.html'), 'utf8')
    await cli(['--dir', dir, '--production-url', PASSING_URL, '--skip-build', '--out', join(dir, 'bundle')])
    assert.equal(readFileSync(join(dir, 'dist', 'index.html'), 'utf8'), before)
    assert.equal(existsSync(join(dir, '.launch-progress.json')), false, 'a gate run alone does not write progress')
  } finally { cleanup() }
})

test('the SKILL.md tells an agent to run the script that exists', () => {
  const skill = readFileSync(join(REPO_ROOT, 'skills', 'pre-launch', 'SKILL.md'), 'utf8')
  assert.match(skill, /scripts\/pre-launch\.mjs/)
  assert.match(skill, /never declare (the site |a site )?ready while any check fails/i)
  assert.match(skill, /never reorder/i)
  for (const ref of ['human-checklist', 'predecessor-redirects', 'framework-hints', 'config', 'reading-the-gate']) {
    assert.ok(existsSync(join(REPO_ROOT, 'skills', 'pre-launch', 'references', `${ref}.md`)), `references/${ref}.md is missing`)
  }
})
