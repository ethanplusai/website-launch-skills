// The post-launch command line, both modes, spawned for real.
//
// There is no site to point the script at in a test, so `main()` honours the same documented
// testing hooks the other two skills use — WEBSITE_LAUNCH_RECORDED_FIXTURE for the network, plus
// WEBSITE_LAUNCH_RESOLVERS_FIXTURE for the public-resolver sample that only cutover day needs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, fixturePath, tmpDir } from './helpers.mjs'

const run = promisify(execFile)
const SCRIPT = join(REPO_ROOT, 'skills', 'post-launch', 'scripts', 'post-launch.mjs')
const GOOD = fixturePath('recorded/cutover-good-site.json')
const BAD = fixturePath('recorded/cutover-bad-site.json')
const BASELINE = fixturePath('cutover/baseline-before.json')
const REDIRECTS = fixturePath('cutover/redirects-before.csv')
const RESOLVERS = fixturePath('cutover/resolvers.json')
const URL_UNDER_TEST = 'https://new.test/'

const env = (fixture, extra = {}) => ({
  ...process.env,
  WEBSITE_LAUNCH_RECORDED_FIXTURE: fixture,
  WEBSITE_LAUNCH_RESOLVERS_FIXTURE: RESOLVERS,
  ...extra,
})

const CUTOVER_ARGS = (out) => [
  SCRIPT, '--mode', 'cutover', '--url', URL_UNDER_TEST, '--out', out,
  '--baseline', BASELINE, '--redirects', REDIRECTS, '--old-url', 'https://old.test/',
  '--staging-url', 'https://staging.new.test/', '--expect-analytics', 'G-ABC123',
  '--expect-dns', 'apex=203.0.113.10,www=new.test', '--browser', 'off',
]

const BUNDLE_FILES = ['report.md', 'findings.json', 'crawl.json', 'baseline.json', 'manifest.json']

// ------------------------------------------------------------------------------------ usage

test('--help exits 0 and names every flag and testing hook', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, '--help'])
  for (const flag of [
    '--mode', '--url', '--baseline', '--old-url', '--redirects', '--expect-analytics',
    '--staging-url', '--expect-dns', '--day', '--dev-host', '--browser', '--out', '--json', '--help', '--config',
  ]) {
    assert.ok(stdout.includes(flag), `--help never mentions ${flag}`)
  }
  assert.match(stdout, /WEBSITE_LAUNCH_RECORDED_FIXTURE/)
  assert.match(stdout, /WEBSITE_LAUNCH_RESOLVERS_FIXTURE/)
  assert.match(stdout, /WEBSITE_LAUNCH_BROWSER_LOADER/)
})

test('a missing --mode is a usage error, exit 2', async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, '--url', URL_UNDER_TEST]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /--mode/)
      return true
    },
  )
})

test('an unknown --mode is a usage error, exit 2', async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, '--mode', 'someday', '--url', URL_UNDER_TEST]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /cutover/)
      return true
    },
  )
})

test('a missing --url is a usage error, exit 2', async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, '--mode', 'cutover']),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /--url is required/)
      return true
    },
  )
})

test('an --out that names an existing file exits 2 with one line, not a stack', async () => {
  const tmp = tmpDir('post-launch-bad-out')
  try {
    const file = join(tmp.dir, 'not-a-directory')
    writeFileSync(file, 'i am a file\n')
    await assert.rejects(
      run(process.execPath, CUTOVER_ARGS(file), { env: env(GOOD) }),
      (error) => {
        assert.equal(error.code, 2)
        assert.match(String(error.stderr), /^error: /)
        assert.ok(!String(error.stderr).includes('    at '), 'no stack trace without WEBSITE_LAUNCH_DEBUG')
        return true
      },
    )
  } finally {
    tmp.cleanup()
  }
})

// --------------------------------------------------------------------------------- cutover mode

test('cutover mode on a clean fixture prints the counts, the human items and the whole Not covered list', async () => {
  const tmp = tmpDir('post-launch-cutover-good')
  try {
    const { stdout } = await run(process.execPath, CUTOVER_ARGS(tmp.dir), { env: env(GOOD) })
    assert.match(stdout, /Bundle:/)
    assert.match(stdout, /blocker 0/)
    assert.match(stdout, /Before you announce/)
    assert.match(stdout, /Search Console/)
    assert.match(stdout, /Not covered:/)
    assert.match(stdout, /Copy vs\. source documents: not run/)
    assert.match(stdout, /Pages vs\. agreed scope: not run/)
  } finally {
    tmp.cleanup()
  }
})

test('cutover mode on a bad cutover leads with the blocker and still exits 0', async () => {
  const tmp = tmpDir('post-launch-cutover-bad')
  try {
    const { stdout } = await run(process.execPath, CUTOVER_ARGS(tmp.dir), { env: env(BAD) })
    const lines = stdout.split('\n')
    const blockerAt = lines.findIndex((line) => line.includes('**BLOCKER**'))
    const highAt = lines.findIndex((line) => line.startsWith('  [high]'))
    assert.ok(blockerAt >= 0, `no bolded blocker line in:\n${stdout}`)
    assert.ok(highAt === -1 || blockerAt < highAt, 'a high finding printed above the blocker')
    assert.match(stdout, /search engines not to index it/, 'the blocker line does not say what the blocker is')
  } finally {
    tmp.cleanup()
  }
})

test('--json prints the bundle, the files, the summary and Not covered, and the bundle is on disk', async () => {
  const tmp = tmpDir('post-launch-json')
  try {
    const { stdout } = await run(process.execPath, [...CUTOVER_ARGS(tmp.dir), '--json'], { env: env(GOOD) })
    const parsed = JSON.parse(stdout)
    assert.deepEqual(Object.keys(parsed).sort(), ['bundle', 'files', 'notCovered', 'summary'])
    assert.equal(typeof parsed.bundle, 'string')
    assert.ok(Array.isArray(parsed.files))
    assert.equal(parsed.summary.blockers, 0)
    assert.ok(Array.isArray(parsed.notCovered))
    for (const name of [...BUNDLE_FILES, 'baseline-diff.json']) {
      assert.ok(existsSync(join(parsed.bundle, name)), `${name} is missing from the bundle`)
    }
    const report = readFileSync(join(parsed.bundle, 'report.md'), 'utf8')
    assert.match(report, /## Cutover verification/)
    assert.match(report, /## Not covered/)
  } finally {
    tmp.cleanup()
  }
})

test('a cutover run with no --baseline writes no diff and says so in Not covered', async () => {
  const tmp = tmpDir('post-launch-no-baseline')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--mode', 'cutover', '--url', URL_UNDER_TEST, '--out', tmp.dir,
      '--expect-analytics', 'G-ABC123', '--browser', 'off', '--json',
    ], { env: env(GOOD) })
    const parsed = JSON.parse(stdout)
    assert.equal(existsSync(join(parsed.bundle, 'baseline-diff.json')), false)
    assert.ok(parsed.notCovered.some((line) => /baseline/i.test(line)), `no baseline line in:\n${parsed.notCovered.join('\n')}`)
  } finally {
    tmp.cleanup()
  }
})

// ----------------------------------------------------------------------------------- watch mode

test('watch mode prints what is due today first, and writes plan.json and watch.json', async () => {
  const tmp = tmpDir('post-launch-watch')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--mode', 'watch', '--url', URL_UNDER_TEST, '--out', tmp.dir, '--day', '1',
      '--baseline', BASELINE, '--browser', 'off',
    ], { env: env(GOOD) })
    assert.match(stdout, /Day 1 of 30/)
    const dueAt = stdout.indexOf('Due today')
    const bundleAt = stdout.indexOf('Bundle:')
    assert.ok(dueAt >= 0, `no due list in:\n${stdout}`)
    assert.ok(dueAt < bundleAt, 'the due list has to come first on a watch day')
    for (const name of [...BUNDLE_FILES, 'plan.json', 'watch.json']) {
      assert.ok(existsSync(join(tmp.dir, name)), `${name} is missing from the watch bundle`)
    }
  } finally {
    tmp.cleanup()
  }
})

test('watch mode --json carries the plan alongside the bundle', async () => {
  const tmp = tmpDir('post-launch-watch-json')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--mode', 'watch', '--url', URL_UNDER_TEST, '--out', tmp.dir, '--day', '9',
      '--baseline', BASELINE, '--browser', 'off', '--json',
    ], { env: env(GOOD) })
    const parsed = JSON.parse(stdout)
    assert.deepEqual(Object.keys(parsed).sort(), ['bundle', 'files', 'notCovered', 'plan', 'summary'])
    assert.ok(parsed.plan.some((entry) => entry.due === 'overdue'), 'day 9 with no prior run has overdue work')
    const state = JSON.parse(readFileSync(join(tmp.dir, 'watch.json'), 'utf8'))
    assert.deepEqual(state.runs.map((r) => r.day), [9])
  } finally {
    tmp.cleanup()
  }
})

test('the watch defaults to day 1 when no day is given and no watch has started', async () => {
  const tmp = tmpDir('post-launch-watch-default')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--mode', 'watch', '--url', URL_UNDER_TEST, '--out', tmp.dir, '--browser', 'off', '--json',
    ], { env: env(GOOD) })
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.plan.some((entry) => entry.due === 'today' && entry.day === 1))
  } finally {
    tmp.cleanup()
  }
})

test('post-launch exits 0 even when the cutover is broken', async () => {
  const tmp = tmpDir('post-launch-exit')
  try {
    const { stdout } = await run(process.execPath, [...CUTOVER_ARGS(tmp.dir), '--json'], { env: env(BAD) })
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.summary.blockers >= 1, 'the bad fixture has a blocker')
  } finally {
    tmp.cleanup()
  }
})
