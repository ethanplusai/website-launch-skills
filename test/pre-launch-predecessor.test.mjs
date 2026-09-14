// Predecessor coverage: the part of the gate that decides whether a domain move will take its
// rankings with it.
//
// The live sitemap of the site being replaced is the source of truth, and it is the one thing the
// gate fetches. Every test here injects a `net`, because a check that fails closed on an
// unreachable child sitemap has to be provable without an unreachable server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checks } from '../skills/pre-launch/scripts/lib/predecessor.mjs'
import { PASSING, FAILING, fakeNet } from './pre-launch-helpers.mjs'
import { ctxFor, group, assertStatus } from './pre-launch-check-helpers.mjs'
import { fixturePath } from './helpers.mjs'

const sitemap = (name) => readFileSync(fixturePath(`sitemaps/${name}`), 'utf8')

const OLD = 'https://old.test'
const ROBOTS = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\nSitemap: https://old.test/sitemap.xml\n' }

const netWith = (body) => fakeNet({
  'https://old.test/robots.txt': ROBOTS,
  'https://old.test/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body },
})

const ALL = ['predecessor.coverage', 'predecessor.wildcard-redirects', 'predecessor.redirect-chains']

test('with no --predecessor-url all three skip with the same named reason', async () => {
  const map = await group(checks, await ctxFor(PASSING))
  for (const id of ALL) {
    const found = assertStatus(map, id, 'skip', assert)
    assert.match(found.detail, /--predecessor-url/)
  }
})

test('an old path that exists at the same path, or has an explicit redirect, is covered', async () => {
  const ctx = await ctxFor(PASSING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor-covered.xml')) })
  const map = await group(checks, ctx)
  assertStatus(map, 'predecessor.coverage', 'pass', assert)
  assertStatus(map, 'predecessor.wildcard-redirects', 'pass', assert)
  assertStatus(map, 'predecessor.redirect-chains', 'pass', assert)
})

test('leftover old paths fail, one per evidence line', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  const values = found.evidence.map((e) => e.value)
  assert.ok(values.some((v) => v.includes('/gone-forever')), JSON.stringify(values))
  assert.ok(values.some((v) => v.includes('/legacy/pricing')))
  assert.equal(values.some((v) => v.includes('/about')), false, '/about resolves in the build')
})

test('a wildcard redirect covering old content paths fails with the rule quoted', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.wildcard-redirects', 'fail', assert)
  const text = found.evidence.map((e) => e.value).join(' | ')
  assert.match(text, /\/legacy\/:path\*/)
  assert.match(text, /\/legacy\/pricing/)
})

test('a redirect chain fails, and a cycle fails as a cycle', async () => {
  const ctx = await ctxFor(FAILING, { predecessorUrl: OLD, net: netWith(sitemap('predecessor.xml')) })
  const map = await group(checks, ctx)
  const found = assertStatus(map, 'predecessor.redirect-chains', 'fail', assert)
  const text = found.evidence.map((e) => e.value).join(' | ')
  assert.match(text, /\/old-team/)
  assert.match(text, /\/team/)
})

test('an unfetchable child sitemap fails closed and names the child', async () => {
  const index = '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://old.test/sitemap-posts.xml</loc></sitemap></sitemapindex>'
  const net = fakeNet({
    'https://old.test/robots.txt': ROBOTS,
    'https://old.test/sitemap.xml': { status: 200, headers: { 'content-type': 'application/xml' }, body: index },
    'https://old.test/sitemap-posts.xml': { status: 503, body: null },
  })
  const map = await group(checks, await ctxFor(PASSING, { predecessorUrl: OLD, net }))
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  assert.match(found.evidence.map((e) => e.value).join(' '), /sitemap-posts\.xml/)
})

test('no sitemap at all on the predecessor fails rather than reporting full coverage', async () => {
  const net = fakeNet({ 'https://old.test/robots.txt': { status: 404, body: null } })
  const map = await group(checks, await ctxFor(PASSING, { predecessorUrl: OLD, net }))
  const found = assertStatus(map, 'predecessor.coverage', 'fail', assert)
  assert.match(found.detail, /sitemap/i)
})
