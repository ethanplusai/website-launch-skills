// Framework hints: four checks that compare what the generator was told to do against what it
// actually produced.
//
// Every one of them skips when the detector could not name a framework, because a hint derived
// from a guess is worse than no hint: it sends somebody looking for a sitemap integration that was
// never configured.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { checks } from '../skills/pre-launch/scripts/lib/framework.mjs'
import { PASSING, FAILING, copyFixture, outsideRepoDir } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'

const ALL = ['framework.site-url', 'framework.sitemap-integration', 'framework.trailing-slash', 'framework.redirect-targets']

test('the passing fixture agrees with its own config', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of ALL) assertStatus(map, id, 'pass', assert)
})

test('every framework check fires on the failing fixture', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  for (const id of ALL) assertStatus(map, id, 'fail', assert)
})

test('a site url that is not the production url fails, quoting both', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'framework.site-url', 'fail', assert)
  const text = `${found.detail} ${found.evidence.map((e) => e.value).join(' ')}`
  assert.match(text, /staging\.example\.com/)
  assert.match(text, /failing\.test/)
})

test('a trailing slash on the production url does not make the site url wrong', async () => {
  const map = await group(checks, await ctxFor(PASSING, { productionUrl: 'https://passing.test/' }))
  assertStatus(map, 'framework.site-url', 'pass', assert)
})

test('a sitemap integration that promises a file the build does not have fails', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'framework.sitemap-integration', 'fail', assert)
  assert.match(found.detail, /sitemap-index\.xml/)
})

test('a trailing-slash policy the generated links contradict fails', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'framework.trailing-slash', 'fail', assert)
  assert.match(found.detail, /always/)
})

test('a redirect whose destination resolves to nothing fails; one pointing at another rule does not', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'framework.redirect-targets', 'fail', assert)
  const values = found.evidence.map((e) => e.value).join(' | ')
  assert.match(values, /\/gone/)
  assert.equal(/-> \/about/.test(values), false, 'a destination that resolves is not reported')
  assert.equal(/\/old-team/.test(values), false, 'a destination that is another rule\'s source is not reported')
})

test('templated redirect destinations are declared as unverified rather than dropped', async () => {
  const map = await group(checks, await ctxFor(FAILING))
  const found = assertStatus(map, 'framework.redirect-targets', 'fail', assert)
  assert.deepEqual(found.notCovered, ['framework.redirect-targets: 1 templated destinations not verified'])
})

test('an unknown framework skips the three config-derived checks with a reason', async () => {
  const { dir, cleanup } = outsideRepoDir('noframework')
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><h1>h</h1></body></html>')
    const map = await group(checks, await ctxFor(dir))
    for (const id of ['framework.site-url', 'framework.sitemap-integration', 'framework.trailing-slash']) {
      const found = assertStatus(map, id, 'skip', assert)
      assert.match(found.detail, /framework/i)
    }
    const redirects = assertStatus(map, 'framework.redirect-targets', 'skip', assert)
    assert.match(redirects.detail, /redirect/i)
  } finally { cleanup() }
})

test('a framework with no site url configured skips rather than inventing one', async () => {
  const { dir, cleanup } = copyFixture(PASSING, 'nosite')
  try {
    writeFileSync(join(dir, 'astro.config.mjs'), 'export default { integrations: [] }\n')
    const map = await group(checks, await ctxFor(dir))
    const found = assertStatus(map, 'framework.site-url', 'skip', assert)
    assert.match(found.detail, /site/i)
    assertStatus(map, 'framework.trailing-slash', 'skip', assert)
  } finally { cleanup() }
})
