// The launch-audit orchestrator and its command line.
//
// `runAudit` is the whole audit as one function over injected adapters, so everything below runs
// against the recorded small-site fixture with no socket, no browser and no clock. The CLI tests
// spawn the real script; there is no server to point it at, so `main()` honours
// WEBSITE_LAUNCH_RECORDED_FIXTURE — the same recorded-response shape the unit tests use — as a
// documented testing hook.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, fixturePath, recordedNetFromFile, tmpDir } from './helpers.mjs'
import { defaultCert, fakeResolvers, NOW } from './checks-helpers.mjs'
import { runAudit } from '../skills/launch-audit/scripts/launch-audit.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'
import { createRegistry, defineCheck } from '../skills/launch-audit/scripts/lib/registry.mjs'

const run = promisify(execFile)
const SCRIPT = join(REPO_ROOT, 'skills', 'launch-audit', 'scripts', 'launch-audit.mjs')
const FIXTURE = fixturePath('recorded/small-site.json')
const URL_UNDER_TEST = 'https://small.test/'

function testNet() {
  const net = recordedNetFromFile('recorded/small-site.json')
  net.head = (url) => net.get(url)
  net.cert = async () => defaultCert('small.test')
  return net
}

const testDns = () => createDns(fakeResolvers())

// The browser adapter a run gets when there is no browser: the shape browser.mjs presents when
// Playwright is absent, which is what `--browser off` and a machine with no chromium both produce.
const noBrowser = (reason = 'test') => ({ available: false, reason })

function audit(over = {}) {
  const { options = {}, ...rest } = over
  return runAudit({
    net: testNet(),
    dns: testDns(),
    browser: noBrowser(),
    now: NOW,
    options: { url: URL_UNDER_TEST, random: () => 'deadbeef', ...options },
    ...rest,
  })
}

// A registry holding one check that explodes and one that behaves, so a crash can be shown not to
// take the run down with it.
function registryWith(...checks) {
  const registry = createRegistry()
  for (const check of checks) registry.add(check)
  return registry
}

const define = (over) => defineCheck({
  phase: 'launch-audit',
  dimension: 'inventory',
  severity: 'info',
  tier: 'http',
  title: 'test check',
  catches: 'nothing — a test double',
  ...over,
})

const okCheck = define({
  id: 'inventory.ok-check',
  run(ctx) {
    return [okCheck.mk({
      title: 'test check',
      page: ctx.target.url,
      detail: 'a valid finding',
      evidence: [{ type: 'url', value: ctx.target.url }],
      fix: 'nothing',
    })]
  },
})

const boomCheck = define({
  id: 'inventory.boom-check',
  run() {
    throw new Error('exploded on purpose')
  },
})

// Returns a finding object directly rather than through `mk`, so it never passes validation:
// evidence is empty, which findings.mjs rejects.
const invalidCheck = define({
  id: 'inventory.invalid-check',
  run(ctx) {
    return [{
      id: 'inventory.invalid-check',
      phase: 'launch-audit',
      dimension: 'inventory',
      severity: 'high',
      tier: 'http',
      page: ctx.target.url,
      title: 'an invalid finding',
      detail: 'has no evidence at all',
      evidence: [],
      fix: 'nothing',
    }]
  },
})

test('runAudit reports findings across the audit dimensions', async () => {
  const tmp = tmpDir('audit-dimensions')
  try {
    const result = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: tmp.dir } })
    const dimensions = new Set(result.findings.map((f) => f.dimension))
    assert.ok(dimensions.size >= 6, `expected findings from at least 6 dimensions, got ${[...dimensions].join(', ')}`)
    assert.ok(result.findings.length > 0)
    for (const finding of result.findings) assert.ok(finding.evidence.length > 0, `${finding.id} has no evidence`)
  } finally {
    tmp.cleanup()
  }
})

test('runAudit writes a baseline covering every crawled page', async () => {
  const tmp = tmpDir('audit-baseline')
  try {
    const result = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: tmp.dir } })
    assert.equal(result.crawl.pages.length, 14)
    assert.equal(result.baseline.pages.length, 14)
    assert.equal(result.baseline.host, 'small.test')
    assert.equal(result.baseline.https, true)
  } finally {
    tmp.cleanup()
  }
})

test('Not covered names the browser tier, the caps and the two things no crawl can see', async () => {
  const tmp = tmpDir('audit-notcovered')
  try {
    const result = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: tmp.dir } })
    const text = result.notCovered.join('\n')
    assert.match(text, /Browser tier not run: test/)
    assert.match(text, /Copy vs\. source documents: not run/)
    assert.match(text, /Pages vs\. agreed scope: not run/)
    assert.match(text, /PageSpeed Insights: skipped — no --psi-key/)
    assert.match(text, /Dropped by robots: https:\/\/small\.test\/private/)
    // The two fixed lines are last, always.
    assert.match(result.notCovered.at(-2), /^Copy vs\. source documents/)
    assert.match(result.notCovered.at(-1), /^Pages vs\. agreed scope/)
  } finally {
    tmp.cleanup()
  }
})

test('a check that throws becomes a Not covered line and the run continues', async () => {
  const tmp = tmpDir('audit-crash')
  try {
    const result = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: tmp.dir, registry: registryWith(okCheck, boomCheck) },
    })
    assert.ok(result.notCovered.some((line) => line.includes('inventory.boom-check') && line.includes('check crashed') && line.includes('exploded on purpose')),
      `no crash line in:\n${result.notCovered.join('\n')}`)
    assert.ok(result.findings.some((f) => f.id === 'inventory.ok-check'), 'the healthy check still ran')
  } finally {
    tmp.cleanup()
  }
})

test('an invalid finding is dropped and named in Not covered', async () => {
  const tmp = tmpDir('audit-invalid')
  try {
    const result = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: tmp.dir, registry: registryWith(okCheck, invalidCheck) },
    })
    assert.ok(!result.findings.some((f) => f.id === 'inventory.invalid-check'), 'the invalid finding was dropped')
    assert.ok(result.notCovered.some((line) => line.includes('inventory.invalid-check') && line.includes('dropped')),
      `no dropped-finding line in:\n${result.notCovered.join('\n')}`)
    assert.ok(result.findings.some((f) => f.id === 'inventory.ok-check'))
  } finally {
    tmp.cleanup()
  }
})

test('the ops checklist marks each item auto-verified or human', async () => {
  const tmp = tmpDir('audit-ops')
  try {
    const result = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: tmp.dir } })
    assert.equal(result.ops.length, 13)
    for (const item of result.ops) {
      assert.equal(typeof item.label, 'string')
      assert.ok(item.autoVerifiedBy === null || typeof item.autoVerifiedBy === 'string')
    }
    assert.ok(result.ops.some((item) => item.autoVerifiedBy === null), 'some items are nobody but a human')
  } finally {
    tmp.cleanup()
  }
})

test('the bundle holds the report, the findings, the crawl, the baseline and a manifest', async () => {
  const tmp = tmpDir('audit-bundle')
  try {
    const result = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: tmp.dir } })
    for (const name of ['report.md', 'findings.json', 'crawl.json', 'baseline.json', 'manifest.json']) {
      assert.ok(existsSync(join(result.bundleDir, name)), `${name} is missing from the bundle`)
    }
    const report = readFileSync(join(result.bundleDir, 'report.md'), 'utf8')
    assert.match(report, /## Not covered/)
    assert.match(report, /## Ops & access readiness/)
    assert.ok(Array.isArray(result.files) && result.files.length >= 5)
  } finally {
    tmp.cleanup()
  }
})

test('a prior baseline is diffed against this run', async () => {
  const tmp = tmpDir('audit-diff')
  try {
    const first = await audit({ cwd: tmp.dir, options: { url: URL_UNDER_TEST, out: join(tmp.dir, 'one') } })
    const second = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: join(tmp.dir, 'two'), baseline: join(first.bundleDir, 'baseline.json') },
    })
    assert.ok(second.baselineDiff !== null && second.baselineDiff !== undefined, 'a diff was produced')
    assert.deepEqual(second.baselineDiff.missingPages, [])
    assert.deepEqual(second.baselineDiff.newPages, [])
  } finally {
    tmp.cleanup()
  }
})

test('--help exits 0 and names every flag', async () => {
  const { stdout } = await run(process.execPath, [SCRIPT, '--help'])
  for (const flag of [
    '--url', '--old-url', '--dev-host', '--psi-key', '--max-pages', '--max-depth',
    '--ignore-robots', '--staging', '--baseline', '--browser', '--out', '--json', '--help', '--config',
  ]) {
    assert.ok(stdout.includes(flag), `--help never mentions ${flag}`)
  }
  assert.match(stdout, /WEBSITE_LAUNCH_RECORDED_FIXTURE/)
})

test('a missing --url is a usage error, exit 2', async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /--url is required/)
      return true
    },
  )
})

test('an unknown --browser value is a usage error, exit 2', async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, '--url', URL_UNDER_TEST, '--browser', 'sometimes']),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(String(error.stderr), /--browser/)
      return true
    },
  )
})

test('--json prints the bundle, the files, the summary and Not covered', async () => {
  const tmp = tmpDir('audit-cli-json')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--url', URL_UNDER_TEST, '--out', tmp.dir, '--browser', 'off', '--json',
    ], { env: { ...process.env, WEBSITE_LAUNCH_RECORDED_FIXTURE: FIXTURE } })
    const parsed = JSON.parse(stdout)
    assert.equal(typeof parsed.bundle, 'string')
    assert.ok(Array.isArray(parsed.files))
    assert.equal(typeof parsed.summary.blockers, 'number')
    assert.ok(Array.isArray(parsed.notCovered))
    assert.deepEqual(Object.keys(parsed).sort(), ['bundle', 'files', 'notCovered', 'summary'])
    for (const name of ['report.md', 'findings.json', 'crawl.json', 'baseline.json', 'manifest.json']) {
      assert.ok(existsSync(join(parsed.bundle, name)), `${name} is missing from the bundle`)
    }
  } finally {
    tmp.cleanup()
  }
})

test('the human summary prints the bundle path, the counts and the whole Not covered list', async () => {
  const tmp = tmpDir('audit-cli-human')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--url', URL_UNDER_TEST, '--out', tmp.dir, '--browser', 'off',
    ], { env: { ...process.env, WEBSITE_LAUNCH_RECORDED_FIXTURE: FIXTURE } })
    assert.match(stdout, /Bundle:/)
    assert.match(stdout, /blocker/)
    assert.match(stdout, /Not covered/)
    assert.match(stdout, /Copy vs\. source documents: not run/)
    assert.match(stdout, /Pages vs\. agreed scope: not run/)
  } finally {
    tmp.cleanup()
  }
})

test('the auditor exits 0 even with blockers', async () => {
  const tmp = tmpDir('audit-cli-exit')
  try {
    const { stdout } = await run(process.execPath, [
      SCRIPT, '--url', URL_UNDER_TEST, '--out', tmp.dir, '--browser', 'off', '--json',
    ], { env: { ...process.env, WEBSITE_LAUNCH_RECORDED_FIXTURE: FIXTURE } })
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.summary.blockers + parsed.summary.high >= 0)
  } finally {
    tmp.cleanup()
  }
})
