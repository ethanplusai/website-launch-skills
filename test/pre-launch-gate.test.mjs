// The gate runner: what a check's return value means, what the verdict is, and the one rule the
// whole skill rests on — that no flag turns a failure into anything else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCheck, SkipCheck } from '../skills/launch-audit/scripts/lib/registry.mjs'
import { buildRegistry, runGate, GROUP_ORDER, runChecks } from '../skills/pre-launch/scripts/lib/gate.mjs'
import { normalizeOptions } from '../skills/pre-launch/scripts/lib/context.mjs'
import {
  PASSING, FAILING, PASSING_URL, FAILING_URL, cleanGit, dirtyGit, noGit, fakeNet, outsideRepoDir, copyFixture, byId,
} from './pre-launch-helpers.mjs'
import { fixturePath } from './helpers.mjs'

const OLD = 'https://old.test'
const predecessorNet = (name) => fakeNet({
  'https://old.test/robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nSitemap: https://old.test/sitemap.xml\n' },
  'https://old.test/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: readFileSync(fixturePath(`sitemaps/${name}`), 'utf8') },
})

async function gateOn(dir, over = {}, { exec = noGit(), net = null, env = {} } = {}) {
  const { dir: out, cleanup } = outsideRepoDir('bundle')
  const productionUrl = over.productionUrl ?? (dir === FAILING ? FAILING_URL : PASSING_URL)
  const results = await runGate({
    dir,
    options: { skipBuild: true, ...over, productionUrl, out: join(out, 'bundle') },
    exec,
    net,
    env,
    now: new Date('2026-09-14T00:00:00Z'),
    cwd: out,
  })
  return { results, cleanup }
}

// ------------------------------------------------------------------------------- the mapping

const finding = (id, severity = 'blocker') => ({
  id, phase: 'pre-launch', dimension: id.split('.')[0], severity, tier: 'repo',
  title: 'a stub finding', detail: 'a stub finding', evidence: [{ type: 'text', value: 'evidence' }], fix: 'fix it',
})

const stub = (id, run, severity = 'blocker') => defineCheck({
  id, phase: 'pre-launch', dimension: id.split('.')[0], severity, tier: 'repo',
  title: `stub ${id}`, catches: 'a stub, for the runner tests', run,
})

test('SkipCheck is a skip with its reason; an empty array is a pass; findings are a fail', async () => {
  const results = await runChecks([
    stub('hygiene.a', () => { throw new SkipCheck('nothing to check here') }),
    stub('hygiene.b', () => []),
    stub('hygiene.c', () => [finding('hygiene.c')]),
  ], {})
  assert.deepEqual(results.map((r) => r.status), ['skip', 'pass', 'fail'])
  assert.equal(results[0].detail, 'nothing to check here')
  assert.deepEqual(results[2].evidence, [{ type: 'text', value: 'evidence' }])
})

test('a check that crashes fails closed, and says it crashed', async () => {
  const [result] = await runChecks([stub('hygiene.boom', () => { throw new TypeError('cannot read x of undefined') })], {})
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /check crashed — cannot read x of undefined/)
})

test('a check returning only non-blocker findings is advisory, not a failure', async () => {
  const [result] = await runChecks([stub('hygiene.soft', () => [finding('hygiene.soft', 'low')], 'low')], {})
  assert.equal(result.status, 'advisory')
  assert.equal(result.severity, 'low')
})

// ------------------------------------------------------------------------------- the verdict

test('the passing fixture passes the whole gate and exits with nothing failing', async () => {
  const { results, cleanup } = await gateOn(PASSING, {}, { exec: cleanGit(), env: { NODE_VERSION_OVERRIDE: 'v22.0.0' } })
  try {
    const failing = results.checks.filter((c) => c.status === 'fail')
    assert.deepEqual(failing.map((c) => `${c.id}: ${c.detail}`), [])
    assert.equal(results.gate, 'pass')
  } finally { cleanup() }
})

test('the failing fixture fails, and every registered check id fires on it', async () => {
  const { results, cleanup } = await gateOn(FAILING, {
    requiredEnv: ['PUBLIC_API_BASE'], predecessorUrl: OLD,
  }, { exec: dirtyGit(), net: predecessorNet('predecessor.xml'), env: { NODE_VERSION_OVERRIDE: 'v22.0.0' } })
  try {
    assert.equal(results.gate, 'fail')
    const quiet = results.checks
      .filter((c) => c.status === 'pass' || c.status === 'skip')
      .filter((c) => c.id !== 'build.succeeds' && c.id !== 'hygiene.nested-git')
      .map((c) => `${c.id} (${c.status})`)
    assert.deepEqual(quiet, [], 'these checks found nothing in a fixture seeded for every failure class')
  } finally { cleanup() }
})

test('a nested .git is the one failure class a fixture cannot carry, so it is planted', async () => {
  const { dir, cleanup: rm } = copyFixture(FAILING, 'nested-git')
  try {
    mkdirSync(join(dir, 'vendor', 'legacy', '.git'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'legacy', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const { results, cleanup } = await gateOn(dir, { productionUrl: FAILING_URL }, { exec: dirtyGit() })
    try {
      assert.equal(byId(results).get('hygiene.nested-git').status, 'fail')
    } finally { cleanup() }
  } finally { rm() }
})

test('groups come out in dependency order, build before output', async () => {
  const { results, cleanup } = await gateOn(PASSING, {}, { exec: cleanGit() })
  try {
    const seen = []
    for (const check of results.checks) if (!seen.includes(check.group)) seen.push(check.group)
    assert.deepEqual(seen, GROUP_ORDER)
    assert.deepEqual(GROUP_ORDER, ['hygiene', 'placeholders', 'build', 'output', 'framework', 'predecessor'])
  } finally { cleanup() }
})

test('no option turns a fail into anything else', async () => {
  const base = { requiredEnv: ['PUBLIC_API_BASE'], predecessorUrl: OLD }
  const run = (over) => gateOn(FAILING, { ...base, ...over }, { exec: dirtyGit(), net: predecessorNet('predecessor.xml') })

  const first = await run({})
  const baselineFails = new Set(first.results.checks.filter((c) => c.status === 'fail').map((c) => c.id))
  first.cleanup()
  assert.ok(baselineFails.size > 15, `only ${baselineFails.size} checks failed`)

  const toggles = [
    { strict: true },
    { skipBuild: false },
    { devHosts: ['nothing.invalid'] },
    { buildDir: 'dist' },
    { requiredEnv: [] },
    { predecessorUrl: null },
    { strict: true, skipBuild: true, devHosts: ['x.invalid'], buildDir: 'dist' },
  ]
  for (const toggle of toggles) {
    const { results, cleanup } = await run(toggle)
    try {
      const now = new Map(results.checks.map((c) => [c.id, c.status]))
      for (const id of baselineFails) {
        // A check that skips because its input was withdrawn (--required-env, --predecessor-url)
        // is not a softened failure; a check that reports pass or advisory would be.
        const status = now.get(id)
        assert.ok(status === 'fail' || status === 'skip', `${id} became "${status}" under ${JSON.stringify(toggle)}`)
        if (status === 'skip') {
          assert.ok(
            (id.startsWith('predecessor.') && toggle.predecessorUrl === null) ||
            (id === 'placeholders.required-env' && toggle.requiredEnv?.length === 0) ||
            (id === 'build.succeeds'),
            `${id} skipped under ${JSON.stringify(toggle)} with no input withdrawn`,
          )
        }
      }
      assert.equal(results.gate, 'fail')
    } finally { cleanup() }
  }
})

// ------------------------------------------------------------------------------- the bundle

test('the gate writes a bundle: report, findings, gate and a manifest', async () => {
  const { results, cleanup } = await gateOn(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }, { exec: dirtyGit() })
  try {
    for (const name of ['report.md', 'findings.json', 'gate.json', 'manifest.json']) {
      assert.ok(existsSync(join(results.bundleDir, name)), `${name} was not written`)
    }
    const report = readFileSync(join(results.bundleDir, 'report.md'), 'utf8')
    assert.match(report, /# Launch pre-launch report/)
    assert.match(report, /## Not covered/)
    assert.match(report, /## Human checklist/)
    const gate = JSON.parse(readFileSync(join(results.bundleDir, 'gate.json'), 'utf8'))
    assert.equal(gate.gate, 'fail')
    assert.ok(Array.isArray(gate.checks))
  } finally { cleanup() }
})

test('every skip lands in Not covered by name and reason, and the fixed lines stay last', async () => {
  const { results, cleanup } = await gateOn(PASSING, {}, { exec: noGit() })
  try {
    const skips = results.checks.filter((c) => c.status === 'skip')
    assert.ok(skips.length > 0)
    for (const skip of skips) {
      assert.ok(results.notCovered.includes(`${skip.id}: skipped — ${skip.detail}`), `${skip.id} is missing from Not covered`)
    }
    assert.match(results.notCovered.at(-2), /^Copy vs\. source documents/)
    assert.match(results.notCovered.at(-1), /^Pages vs\. agreed scope/)
  } finally { cleanup() }
})

test('a check may declare its own coverage bound, and the runner routes it into Not covered', async () => {
  const bounded = defineCheck({
    id: 'hygiene.bounded', phase: 'pre-launch', dimension: 'hygiene', severity: 'blocker', tier: 'repo',
    title: 'bounded', catches: 'a stub that declares a bound on what it read',
    run: () => ({ findings: [], notCovered: ['hygiene.bounded: 3 files skipped (over 1 MB or binary)'] }),
  })
  const [result] = await runChecks([bounded], {})
  assert.equal(result.status, 'pass')
  assert.deepEqual(result.notCovered, ['hygiene.bounded: 3 files skipped (over 1 MB or binary)'])

  const both = defineCheck({
    id: 'hygiene.bounded-fail', phase: 'pre-launch', dimension: 'hygiene', severity: 'blocker', tier: 'repo',
    title: 'bounded and failing', catches: 'a stub that both fails and declares a bound',
    run: () => ({ findings: [finding('hygiene.bounded-fail')], notCovered: ['hygiene.bounded-fail: one thing not verified'] }),
  })
  const [failed] = await runChecks([both], {})
  assert.equal(failed.status, 'fail')
  assert.deepEqual(failed.notCovered, ['hygiene.bounded-fail: one thing not verified'])

  const nonsense = defineCheck({
    id: 'hygiene.nonsense', phase: 'pre-launch', dimension: 'hygiene', severity: 'blocker', tier: 'repo',
    title: 'nonsense', catches: 'a stub returning neither shape',
    run: () => 'not a shape',
  })
  const [broken] = await runChecks([nonsense], {})
  assert.equal(broken.status, 'fail')
  assert.match(broken.detail, /check crashed/)
})

test('the bounds real checks declare reach Not covered, above the two fixed lines', async () => {
  const { results, cleanup } = await gateOn(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }, { exec: dirtyGit() })
  try {
    const expected = [
      'placeholders: source scan limited to src',
      'framework.redirect-targets: 1 templated destinations not verified',
    ]
    for (const line of expected) {
      assert.ok(results.notCovered.includes(line), `"${line}" is missing from Not covered:\n${results.notCovered.join('\n')}`)
      // De-duplicated: three placeholders checks emit the source-scan line, a reader sees it once.
      assert.equal(results.notCovered.filter((l) => l === line).length, 1, line)
    }
    const fixedAt = results.notCovered.findIndex((l) => l.startsWith('Copy vs. source documents'))
    for (const line of expected) assert.ok(results.notCovered.indexOf(line) < fixedAt, `${line} must come before the fixed lines`)
    assert.match(results.notCovered.at(-1), /^Pages vs\. agreed scope/)

    const report = readFileSync(join(results.bundleDir, 'report.md'), 'utf8')
    for (const line of expected) assert.ok(report.includes(line), `report.md is missing "${line}"`)
  } finally { cleanup() }
})

test('the human checklist ships with the results and marks what is confirmed', async () => {
  const { dir, cleanup: rm } = copyFixture(PASSING, 'gate-human')
  try {
    writeFileSync(join(dir, '.launch-progress.json'), JSON.stringify({ confirmed: ['forms'], updatedAt: '2026-09-13T00:00:00Z' }))
    const { results, cleanup } = await gateOn(dir, {}, { exec: cleanGit() })
    try {
      assert.equal(results.human_items[0].id, 'forms')
      assert.equal(results.human_items[0].confirmed, true)
      assert.equal(results.human_items[1].confirmed, false)
      const report = readFileSync(join(results.bundleDir, 'report.md'), 'utf8')
      assert.match(report, /✓.*forms|forms.*✓/i)
    } finally { cleanup() }
  } finally { rm() }
})

test('every registered pre-launch check is unique, prefixed by its group, and blocker or advisory', () => {
  const registry = buildRegistry()
  const list = registry.byPhase('pre-launch')
  assert.ok(list.length >= 35, `only ${list.length} checks are registered`)
  for (const check of list) {
    assert.equal(check.tier, 'repo')
    assert.ok(GROUP_ORDER.includes(check.dimension), `${check.id} is in no known group`)
    assert.ok(['blocker', 'low', 'info'].includes(check.severity), `${check.id} declares ${check.severity}`)
    assert.ok(typeof check.catches === 'string' && check.catches.length > 10, `${check.id} does not say what it catches`)
  }
})
