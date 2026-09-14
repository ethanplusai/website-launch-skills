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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, fixturePath, recordedNetFromFile, tmpDir } from './helpers.mjs'
import { defaultCert, fakeResolvers, NOW } from './checks-helpers.mjs'
import { runAudit, buildOps, insertBeforeFixed } from '../skills/launch-audit/scripts/launch-audit.mjs'
import { createDns } from '../skills/launch-audit/scripts/lib/dns.mjs'
import { createRegistry, defineCheck, SkipCheck } from '../skills/launch-audit/scripts/lib/registry.mjs'

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

// A check that skips itself is not a check that crashed and not a check that passed, and the
// orchestrator has to keep those three apart in the one section a reader is told to repeat
// verbatim. I1 turned three always-emit checks into conditional skips on the strength of this.
const skippingCheck = define({
  id: 'inventory.skipping-check',
  run() {
    throw new SkipCheck('the thing it needed was never fetched')
  },
})

test('a check that skips itself becomes a Not covered line naming the check and the reason', async () => {
  const tmp = tmpDir('audit-skip-line')
  try {
    const result = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: tmp.dir, registry: registryWith(okCheck, skippingCheck) },
    })
    assert.ok(
      result.notCovered.includes('inventory.skipping-check: skipped — the thing it needed was never fetched'),
      `Not covered was: ${result.notCovered.join(' | ')}`,
    )
    // A skip is not a crash: the crash wording must not also appear for it.
    assert.ok(!result.notCovered.some((line) => line.includes('inventory.skipping-check') && line.includes('crashed')))
  } finally {
    tmp.cleanup()
  }
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
    assert.match(text, /Dropped by robots: 1 url not fetched — all listed in crawl\.json under "dropped"; first 20: https:\/\/small\.test\/private/)
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

// Spawns the script and returns the exit code as well as the output, whatever the code is.
// `promisify(execFile)` rejects on a non-zero exit, and a test that only reads the resolved value
// therefore proves the exit code was 0 by never being able to see any other one — which is how
// the old version of the test below asserted `blockers + high >= 0`, a tautology, and would have
// stayed green on an auditor that exited 1 with no findings at all.
function runScript(argv, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

test('the auditor exits 0 with a report full of blockers', async () => {
  const tmp = tmpDir('audit-cli-exit')
  try {
    // noindex-site is site-wide `noindex` on production, which is the auditor's own blocker.
    const { code, stdout, stderr } = await runScript(
      [SCRIPT, '--url', 'https://noindex.test/', '--out', tmp.dir, '--browser', 'off', '--json'],
      { WEBSITE_LAUNCH_RECORDED_FIXTURE: fixturePath('recorded/noindex-site.json') },
    )
    assert.equal(code, 0, `expected exit 0, got ${code}: ${stderr}`)
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.summary.blockers >= 1, `expected at least one blocker, got ${parsed.summary.blockers}`)
  } finally {
    tmp.cleanup()
  }
})

// C2: a host that is not there used to produce `blocker 0` and a page of green, which reads
// exactly like a clean audit. An empty recording is a host that answers nothing.
test('an audit of a site that never answered exits 0 and reports a blocker', async () => {
  const tmp = tmpDir('audit-cli-dead')
  try {
    const { code, stdout, stderr } = await runScript(
      [SCRIPT, '--url', 'https://gone.test/', '--out', tmp.dir, '--browser', 'off', '--json'],
      { WEBSITE_LAUNCH_RECORDED_FIXTURE: fixturePath('recorded/unreachable-site.json') },
    )
    assert.equal(code, 0, `expected exit 0, got ${code}: ${stderr}`)
    const parsed = JSON.parse(stdout)
    assert.ok(parsed.summary.blockers >= 1, `expected at least one blocker, got ${parsed.summary.blockers}`)
    assert.ok(parsed.notCovered.some((line) => /never answered/.test(line)))
    const report = readFileSync(join(tmp.dir, 'report.md'), 'utf8')
    assert.match(report, /inventory\.target-unreachable|never answered/)
  } finally {
    tmp.cleanup()
  }
})

// ------------------------------------------------------------- checks that never produced an answer

// A check with a real checklist id, so the ops list has something to look for.
const crashingEmailAuth = defineCheck({
  phase: 'launch-audit',
  dimension: 'ops',
  severity: 'medium',
  tier: 'http',
  id: 'ops.email-auth',
  title: 'email auth',
  catches: 'nothing — a test double',
  run() {
    throw new Error('resolver blew up')
  },
})

const quietEmailAuth = defineCheck({
  phase: 'launch-audit',
  dimension: 'ops',
  severity: 'medium',
  tier: 'http',
  id: 'ops.email-auth',
  title: 'email auth',
  catches: 'nothing — a test double',
  run() {
    return []
  },
})

const opsItem = (ops) => ops.find((item) => item.label.startsWith('Email authentication'))

test('a check that produced no findings because it ran clean marks its ops item auto-verified', async () => {
  const tmp = tmpDir('audit-ops-clean')
  try {
    const result = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: tmp.dir, registry: registryWith(quietEmailAuth) },
    })
    assert.equal(opsItem(result.ops).autoVerifiedBy, 'ops.email-auth')
  } finally {
    tmp.cleanup()
  }
})

test('a check that crashed never marks its ops item auto-verified', async () => {
  const tmp = tmpDir('audit-ops-crash')
  try {
    const result = await audit({
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, out: tmp.dir, registry: registryWith(crashingEmailAuth) },
    })
    assert.ok(result.notCovered.some((line) => line.includes('ops.email-auth') && line.includes('check crashed')))
    assert.equal(opsItem(result.ops).autoVerifiedBy, null, 'a crash is not a pass')
    const report = readFileSync(join(result.bundleDir, 'report.md'), 'utf8')
    assert.match(report, /- \[human\] Email authentication/)
  } finally {
    tmp.cleanup()
  }
})

test('buildOps treats a skipped check the same as a crashed one', () => {
  const clean = buildOps([])
  assert.equal(opsItem(clean).autoVerifiedBy, 'ops.email-auth')
  const skipped = buildOps([], new Set(['ops.email-auth']))
  assert.equal(opsItem(skipped).autoVerifiedBy, null)
})

// ------------------------------------------------------------------------------ Not covered order

test('insertBeforeFixed refuses to append after the two fixed lines', () => {
  const withFixed = ['a', 'Copy vs. source documents: not run', 'Pages vs. agreed scope: not run']
  assert.deepEqual(insertBeforeFixed(withFixed, ['b']), [
    'a', 'b', 'Copy vs. source documents: not run', 'Pages vs. agreed scope: not run',
  ])
  assert.deepEqual(insertBeforeFixed(['a'], []), ['a'])
  assert.throws(() => insertBeforeFixed(['a'], ['b']), /fixed trailing lines/)
})

// ------------------------------------------------------------------------------------ probe caps

test('a tripped probe cap is named with its set, its count and its cap', async () => {
  const tmp = tmpDir('audit-caps')
  try {
    const net = recordedNetFromFile('recorded/capped-site.json')
    net.head = (url) => net.get(url)
    net.cert = async () => defaultCert('capped.test')
    const result = await runAudit({
      net,
      dns: testDns(),
      browser: noBrowser(),
      now: NOW,
      cwd: tmp.dir,
      options: { url: 'https://capped.test/', random: () => 'deadbeef', out: tmp.dir, caps: { images: 2 } },
    })
    assert.ok(result.notCovered.includes('images: 2 of 4 not probed (cap 2)'),
      `no cap line in:\n${result.notCovered.join('\n')}`)
  } finally {
    tmp.cleanup()
  }
})

// --------------------------------------------------------------------------------- the browser tier

const fakeRender = (url) => ({
  url,
  finalUrl: url,
  status: 200,
  screenshots: { desktop: `/shots/${encodeURIComponent(url)}/desktop.png`, tablet: null, mobile: null },
  consoleErrors: [],
  failedRequests: [],
  collectorHits: [],
  horizontalOverflow: { desktop: false, tablet: false, mobile: false },
  navCollapsed: null,
  renderedHead: { title: null, description: null, canonical: null, robots: null },
  cookiesBeforeInteraction: [],
  consentBannerVisible: false,
  error: null,
})

// A browser adapter that behaves, except where a test asks it not to. `state` records what it was
// asked for, so a test can assert close() happened however the run ended.
function fakeBrowser({ failRenderOnCall = null, withLighthouse = false } = {}) {
  const state = { renders: 0, closed: 0 }
  return {
    state,
    available: true,
    reason: null,
    async open() { return true },
    async render(url) {
      state.renders++
      if (state.renders === failRenderOnCall) throw new Error('newContext failed')
      return fakeRender(url)
    },
    async axe() { return { available: false, reason: 'axe-core not installed' } },
    async lighthouse(url, { formFactor }) {
      if (!withLighthouse) return { available: false, reason: 'lighthouse not installed' }
      return {
        available: true,
        formFactor,
        scores: { performance: 95, accessibility: 90, bestPractices: 90, seo: 100 },
        metrics: { lcp: 1200, cls: 0.01, tbt: 40, inp: null, fcp: 800, si: 1100 },
      }
    },
    async close() { state.closed++ },
  }
}

test('a browser call that throws costs one page of one tool, not the run', async () => {
  const tmp = tmpDir('audit-browser-throw')
  try {
    const browser = fakeBrowser({ failRenderOnCall: 2 })
    const result = await runAudit({
      net: testNet(),
      dns: testDns(),
      browser,
      now: NOW,
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, random: () => 'deadbeef', out: tmp.dir },
    })
    const failures = result.notCovered.filter((line) => line.startsWith('Browser tier: ') && line.includes('render failed — newContext failed'))
    assert.equal(failures.length, 1, `expected one render failure line, got:\n${result.notCovered.join('\n')}`)
    assert.ok(result.findings.some((f) => f.id === 'browser.screenshots-for-review'), 'the pages that rendered still produced findings')
    assert.ok(result.notCovered.some((line) => /^Browser tier rendered \d+ of \d+ pages$/.test(line)))
    assert.equal(browser.state.closed, 1, 'the browser was closed')
  } finally {
    tmp.cleanup()
  }
})

test('lighthouse results are written into the bundle and listed in the manifest', async () => {
  const tmp = tmpDir('audit-lighthouse')
  try {
    const browser = fakeBrowser({ withLighthouse: true })
    const result = await runAudit({
      net: testNet(),
      dns: testDns(),
      browser,
      now: NOW,
      cwd: tmp.dir,
      options: { url: URL_UNDER_TEST, random: () => 'deadbeef', out: tmp.dir },
    })
    const manifest = JSON.parse(readFileSync(join(result.bundleDir, 'manifest.json'), 'utf8'))
    for (const name of ['lighthouse/small-test-mobile.json', 'lighthouse/small-test-desktop.json']) {
      assert.ok(existsSync(join(result.bundleDir, name)), `${name} is missing from the bundle`)
      assert.ok(manifest.files.includes(name), `${name} is missing from the manifest`)
    }
    const saved = JSON.parse(readFileSync(join(result.bundleDir, 'lighthouse/small-test-mobile.json'), 'utf8'))
    assert.equal(saved.url, URL_UNDER_TEST)
    assert.equal(saved.formFactor, 'mobile')
    assert.equal(saved.scores.performance, 95)
    assert.equal(browser.state.closed, 1)
  } finally {
    tmp.cleanup()
  }
})

// ----------------------------------------------------------------------------- unexpected failures

test('an --out that names an existing file exits 2 with one line, not a stack', async () => {
  const tmp = tmpDir('audit-bad-out')
  try {
    const file = join(tmp.dir, 'not-a-directory')
    writeFileSync(file, 'i am a file\n')
    await assert.rejects(
      run(process.execPath, [SCRIPT, '--url', URL_UNDER_TEST, '--out', file, '--browser', 'off'],
        { env: { ...process.env, WEBSITE_LAUNCH_RECORDED_FIXTURE: FIXTURE } }),
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

test('--browser on exits 2 with the install hint when the loader fails', async () => {
  const tmp = tmpDir('audit-browser-on')
  try {
    await assert.rejects(
      run(process.execPath, [SCRIPT, '--url', URL_UNDER_TEST, '--out', tmp.dir, '--browser', 'on'],
        { env: { ...process.env, WEBSITE_LAUNCH_RECORDED_FIXTURE: FIXTURE, WEBSITE_LAUNCH_BROWSER_LOADER: 'fail' } }),
      (error) => {
        assert.equal(error.code, 2)
        assert.match(String(error.stderr), /--browser on/)
        assert.match(String(error.stderr), /npx playwright install chromium/)
        return true
      },
    )
  } finally {
    tmp.cleanup()
  }
})
