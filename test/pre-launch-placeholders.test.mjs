// Placeholders and leaks: the strings that mean the site is not finished, and the ones that mean
// it was built for somebody else's machine.
//
// The patterns themselves live in the shared detector (`detect/placeholders.mjs`) and are proved
// one by one in `detect.test.mjs`. What is under test here is the surface: which files the gate
// looks at, whether a hit in source and a hit in the build are both caught, and the one check
// whose severity a flag is allowed to raise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checks } from '../skills/pre-launch/scripts/lib/placeholders.mjs'
import { PASSING, FAILING, copyFixture } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'

const IDS = ['placeholders.analytics-id', 'placeholders.form-id', 'placeholders.copy', 'placeholders.required-env', 'placeholders.dev-host', 'placeholders.source-maps']

test('a finished site trips none of them', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of IDS) {
    const found = map.get(id)
    assert.ok(found !== undefined, `${id} did not run`)
    assert.notEqual(found.status, 'fail', `${id} failed on the passing fixture — ${found.detail}`)
  }
})

test('a placeholder analytics id fails with the file it was found in', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.analytics-id', 'fail', assert)
  assert.ok(found.evidence.some((e) => /G-XXXXXXXXXX/.test(e.value)), JSON.stringify(found.evidence))
})

test('a placeholder form id fails', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.form-id', 'fail', assert)
  assert.ok(found.evidence.some((e) => /your-form-id/.test(e.value)))
})

test('placeholder copy is caught in source and in the rendered text of the build', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.copy', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /REPLACE_ME/)
  assert.match(values, /[Ll]orem ipsum/)
})

test('a required env var that is defined nowhere fails; one in .env.production passes', async () => {
  const missing = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }))
  const found = assertStatus(missing, 'placeholders.required-env', 'fail', assert)
  assert.match(found.detail, /PUBLIC_API_BASE/)

  const { dir, cleanup } = copyFixture(FAILING, 'required-env')
  try {
    writeFileSync(join(dir, '.env.production'), 'PUBLIC_API_BASE=https://api.failing.test\n')
    const present = await group(checks, await ctxFor(dir, { requiredEnv: ['PUBLIC_API_BASE'], productionUrl: 'https://failing.test' }))
    assertStatus(present, 'placeholders.required-env', 'pass', assert)
  } finally { cleanup() }
})

test('with no --required-env names the check skips rather than passing', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  const found = assertStatus(map, 'placeholders.required-env', 'skip', assert)
  assert.match(found.detail, /--required-env/)
})

test('a dev host in the build output fails, and the production host itself never counts', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'placeholders.dev-host', 'fail', assert)
  assert.ok(found.evidence.some((e) => /localhost/.test(e.value)))

  const own = await group(checks, await ctxFor(PASSING, { devHosts: ['passing.test'] }))
  assertStatus(own, 'placeholders.dev-host', 'pass', assert)
})

test('an operator-named dev host is searched for too', async () => {
  const map = await group(checks, await ctxFor(FAILING, { devHosts: ['other.example'] }))
  const found = assertStatus(map, 'placeholders.dev-host', 'fail', assert)
  assert.ok(found.evidence.some((e) => /other\.example/.test(e.value)), JSON.stringify(found.evidence))
})

test('source maps are advisory by default and a blocker under --strict', async () => {
  const lenient = await group(checks, await ctxFor(FAILING))
  const advisory = assertStatus(lenient, 'placeholders.source-maps', 'advisory', assert)
  assert.equal(advisory.severity, 'low')

  const strict = await group(checks, await ctxFor(FAILING, { strict: true }))
  const blocking = assertStatus(strict, 'placeholders.source-maps', 'fail', assert)
  assert.equal(blocking.severity, 'blocker')
  assert.ok(blocking.evidence.some((e) => /sourceMappingURL/.test(e.value)))
})

test('the source directories that were scanned are declared by name', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of ['placeholders.analytics-id', 'placeholders.form-id', 'placeholders.copy']) {
    assert.deepEqual(map.get(id).notCovered, ['placeholders: source scan limited to src'], id)
  }
  // The checks that do not read source declare no such bound.
  assert.deepEqual(map.get('placeholders.dev-host').notCovered, [])
})

test('a repository with no recognised source directory says so rather than implying a full scan', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'no-source-dir')
  try {
    const { renameSync } = await import('node:fs')
    const { join } = await import('node:path')
    renameSync(join(dir, 'src'), join(dir, 'assembled-by-hand'))
    const map = await group(checks, await ctxFor(dir))
    // The line is read out loud to a person, so it has to be a sentence. The smoke run against a
    // real repository printed "source scan limited to (no known source directory is present…)",
    // which says the scan was limited to a parenthesis.
    const line = map.get('placeholders.copy').notCovered[0]
    assert.match(line, /^placeholders: no source directory was scanned — this repository has none of /)
    assert.match(line, /src, content, pages, app/)
    assert.match(line, /so only the build output was searched$/)
    assert.ok(!line.includes('limited to ('), 'the line must not say the scan was limited to a parenthesis')
  } finally { cleanup() }
})

test('--strict cannot turn any other placeholder failure into anything softer', async () => {
  const lenient = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'] }))
  const strict = await group(checks, await ctxFor(FAILING, { requiredEnv: ['PUBLIC_API_BASE'], strict: true }))
  for (const id of IDS) {
    if (id === 'placeholders.source-maps') continue
    assert.equal(strict.get(id).status, lenient.get(id).status, id)
  }
})
